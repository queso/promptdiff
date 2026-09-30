import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "bun:test";
import { evaluateGrader, formatGraderOutcome, grade, graderOutcomePassed } from "../src/grade";
import { buildCacheKey } from "../src/engine/cache";
import { formatCompareSummary, formatMeasureSummary, runCompare, runMeasure } from "../src/engine/compare";
import { loadCompareConfig } from "../src/engine/config";
import { gradeRun } from "../src/engine/grader";
import { fisherExactTwoTailedP } from "../src/engine/stats";
import { NO_ARTIFACT_EXIT_CODE, runGraderFile } from "../src/engine/grader-file";
import type { Runner, RunnerRunOptions } from "../src/types";

const root = mkdtempSync(join(tmpdir(), "promptdiff-grade-file-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = { output: "", costUsd: 0, turns: 1, durationMs: 1, models: [], raw: {} };

// A grader file in the shape the docs lead with: a semantic assert first,
// sugar after. It imports the package by name, which the runner aliases.
const GRADER_SOURCE = `
import { grade } from "@theaiteam/promptdiff";

export default grade("out/plan.json", {
  "covers-8": ({ result }) => {
    const kept = result.json().a_roll;
    result.assert(
      kept.some((s) => s.source_in <= 8 && 8 <= s.source_out),
      "no kept range covers t=8.0",
      { ranges: kept },
    );
    result.shouldHave("cinema cutie");
    result.shouldNotHave("lorem");
  },
  "bare-name": ({ result }) => {
    result.shouldMatch(/cutie/);
  },
});
`;

function writeGraderFile(dir: string, source = GRADER_SOURCE): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "grade.eval.ts");
  writeFileSync(file, source, "utf8");
  return file;
}

function writeArtifact(sandbox: string, plan: unknown): void {
  mkdirSync(join(sandbox, "out"), { recursive: true });
  writeFileSync(join(sandbox, "out", "plan.json"), JSON.stringify(plan), "utf8");
}

const PASSING_PLAN = { a_roll: [{ source_in: 0, source_out: 9 }], note: "cinema cutie" };
const FAILING_PLAN = { a_roll: [{ source_in: 0, source_out: 7.5 }], note: "lorem ipsum" };

test("evaluateGrader collects every failed check instead of stopping at the first", async () => {
  const outcome = await evaluateGrader(
    ({ result }) => {
      result.assert(false, "first semantic failure", { seen: [1, 2] });
      result.shouldHave("absent");
      result.shouldNotHave("lorem");
      result.shouldMatch(/nope/);
      result.assert(true, "passes");
    },
    { path: "a.txt", text: "lorem ipsum" },
  );

  expect(outcome.checks).toBe(5);
  expect(outcome.failures.map((failure) => failure.message)).toEqual([
    "first semantic failure",
    'shouldHave("absent"): not found',
    'shouldNotHave("lorem"): found at offset 0',
    "shouldMatch(/nope/): no match",
  ]);
  expect(outcome.failures[0]?.detail).toBe('context: {"seen":[1,2]}');
  expect(outcome.failures[1]?.detail).toContain('starts "lorem ipsum"');
  expect(graderOutcomePassed(outcome)).toBe(false);
});

test("each check returns whether it passed, so graders can branch on it", async () => {
  const seen: boolean[] = [];
  await evaluateGrader(
    ({ result }) => {
      seen.push(result.shouldHave("ok"), result.shouldNotHave("ok"), result.assert(1, "truthy"), result.shouldMatch(/o+k/g));
      // A global regex must not carry lastIndex into a second check.
      seen.push(result.shouldMatch(/o+k/g));
    },
    { path: "a.txt", text: "ok" },
  );
  expect(seen).toEqual([true, false, true, true, true]);
});

test("invalid JSON and thrown errors become failures; earlier checks still count", async () => {
  const badJson = await evaluateGrader(
    ({ result }) => {
      result.shouldHave("x");
      result.json();
      result.shouldHave("never reached");
    },
    { path: "a.json", text: "x not json" },
  );
  expect(badJson.checks).toBe(2);
  expect(badJson.failures).toHaveLength(1);
  expect(badJson.failures[0]?.message).toStartWith("artifact is not valid JSON:");

  const thrown = await evaluateGrader(
    async ({ result }) => {
      result.assert(false, "recorded before the throw");
      throw new Error("kept is undefined");
    },
    { path: "a.json", text: "{}" },
  );
  expect(thrown.failures.map((failure) => failure.message)).toEqual([
    "recorded before the throw",
    "grader threw: kept is undefined",
  ]);
});

test("a grader that checks nothing does not pass", async () => {
  const outcome = await evaluateGrader(() => {}, { path: "a.txt", text: "anything" });
  expect(graderOutcomePassed(outcome)).toBe(false);
  expect(formatGraderOutcome("empty", "a.txt", outcome)).toEqual([
    'grade "empty" (a.txt): made no checks; a grader that checks nothing cannot pass',
  ]);
});

test("the report puts one line per failure and the verdict last", async () => {
  const outcome = await evaluateGrader(
    ({ result }) => {
      result.assert(false, "no kept range covers t=8.0", { ranges: [[0, 7.5]] });
      result.shouldHave("cinema");
      result.assert(true, "fine");
    },
    { path: "plan.json", text: "{}" },
  );
  const lines = formatGraderOutcome("covers-8", "plan.json", outcome);
  expect(lines).toEqual([
    'FAIL no kept range covers t=8.0 | context: {"ranges":[[0,7.5]]}',
    'FAIL shouldHave("cinema"): not found | artifact: 2 chars, starts "{}"',
    'grade "covers-8" (plan.json): 2 of 3 checks failed',
  ]);
});

test("grade() rejects an empty or non-function grader map", () => {
  expect(() => grade("a.json", {})).toThrow(/at least one named grader/);
  expect(() => grade("a.json", { x: "nope" as never })).toThrow(/"x" must be a function/);
});

test("runGraderFile resolves the artifact against the grader cwd and maps outcomes to exit codes", async () => {
  const dir = join(root, "run-grader-file");
  const file = writeGraderFile(dir);
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });

  const missing = await runGraderFile(file, "covers-8", sandbox);
  expect(missing.exitCode).toBe(NO_ARTIFACT_EXIT_CODE);
  expect(missing.stderr.join("\n")).toContain("no artifact: out/plan.json does not exist");

  writeArtifact(sandbox, FAILING_PLAN);
  const failing = await runGraderFile(file, "covers-8", sandbox);
  expect(failing.exitCode).toBe(1);
  expect(failing.stderr).toHaveLength(4);
  expect(failing.stderr.at(-1)).toBe('grade "covers-8" (out/plan.json): 3 of 3 checks failed');

  writeArtifact(sandbox, PASSING_PLAN);
  const passing = await runGraderFile(file, "covers-8", sandbox);
  expect(passing.exitCode).toBe(0);
  expect(passing.stdout).toEqual(['grade "covers-8" (out/plan.json): 3 of 3 checks passed']);

  const unknown = await runGraderFile(file, "nope", sandbox);
  expect(unknown.exitCode).toBe(2);
  expect(unknown.stderr[0]).toContain('no grader named "nope" (has: covers-8, bare-name)');
});

test("inherited Object.prototype names are not graders", async () => {
  const dir = join(root, "inherited-names");
  const file = writeGraderFile(dir);
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeArtifact(sandbox, PASSING_PLAN);

  for (const name of ["constructor", "toString", "hasOwnProperty"]) {
    const result = await runGraderFile(file, name, sandbox);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain(`no grader named "${name}"`);
  }
  // A scenario naming one fails at load, before any paid run.
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "constructor" });
  expect(() => loadCompareConfig(path, {}, { singleArm: true })).toThrow(/has no grader named "constructor"/);
});

test("a grader file that prints while loading still validates at scenario load", () => {
  const dir = join(root, "noisy");
  writeGraderFile(dir, `console.log("loading graders");\n${GRADER_SOURCE}`);
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8" });
  expect(() => loadCompareConfig(path, {}, { singleArm: true })).not.toThrow();
  const missing = writeScenario(dir, { file: "./grade.eval.ts", name: "nope" });
  expect(() => loadCompareConfig(missing, {}, { singleArm: true })).toThrow(/has no grader named "nope" \(has: covers-8/);
});

test("a file grader that hangs is killed at timeoutMs and fails as a timeout, not no-artifact", async () => {
  const dir = join(root, "timeout");
  const file = writeGraderFile(
    dir,
    `import { grade } from "@theaiteam/promptdiff";
export default grade("out/plan.json", {
  hang: async () => { await new Promise((r) => setTimeout(r, 10_000)); },
});
`,
  );
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  writeArtifact(sandbox, PASSING_PLAN);

  const started = Date.now();
  const result = await gradeRun({ type: "file", file, name: "hang", timeoutMs: 1_500 }, { run, sandboxDir: sandbox });
  expect(result.pass).toBe(false);
  expect(result.noArtifact).toBeUndefined();
  expect(result.message).toBe("grader timed out after 1500ms");
  expect(Date.now() - started).toBeLessThan(8_000);
}, 15_000);

test("a file grader runs as a command in the sandbox and reports no-artifact distinctly", async () => {
  const dir = join(root, "grade-run");
  const file = writeGraderFile(dir);
  const sandbox = join(dir, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  const spec = { type: "file" as const, file, name: "covers-8", timeoutMs: 30_000 };

  const missing = await gradeRun(spec, { run, sandboxDir: sandbox });
  expect(missing).toMatchObject({ pass: false, noArtifact: true });
  expect(missing.message).toStartWith("no artifact: out/plan.json does not exist");

  writeArtifact(sandbox, FAILING_PLAN);
  const failing = await gradeRun(spec, { run, sandboxDir: sandbox });
  expect(failing.pass).toBe(false);
  expect(failing.noArtifact).toBeUndefined();
  // The verdict line replaces "command exited 1"; the failures stay in stderr.
  expect(failing.message).toBe('grade "covers-8" (out/plan.json): 3 of 3 checks failed');
  expect(failing.stderr).toContain("FAIL no kept range covers t=8.0");

  writeArtifact(sandbox, PASSING_PLAN);
  const passing = await gradeRun(spec, { run, sandboxDir: sandbox });
  expect(passing).toMatchObject({ pass: true, message: "file grader passed" });
});

test("command graders signal no-artifact with the reserved exit code", async () => {
  const sandbox = join(root, "command-no-artifact");
  mkdirSync(sandbox, { recursive: true });
  const script = 'test -f draft.json || exit "$PROMPTDIFF_NO_ARTIFACT_EXIT_CODE"; grep -q ok draft.json';

  const missing = await gradeRun({ type: "command", command: script }, { run, sandboxDir: sandbox });
  expect(missing).toMatchObject({ pass: false, noArtifact: true, message: "no artifact (grader exited 77)" });

  writeFileSync(join(sandbox, "draft.json"), "not it", "utf8");
  const failing = await gradeRun({ type: "command", command: script }, { run, sandboxDir: sandbox });
  expect(failing).toMatchObject({ pass: false, message: "command exited 1, expected 0" });
  expect(failing.noArtifact).toBeUndefined();

  // An explicit expectExitCode of 77 keeps meaning "77 is a pass".
  const expected = await gradeRun({ type: "command", command: "exit 77", expectExitCode: 77 }, { run, sandboxDir: sandbox });
  expect(expected).toMatchObject({ pass: true });
  expect(expected.noArtifact).toBeUndefined();
});

function writeScenario(dir: string, grader: unknown, extra: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), "Agent.", "utf8");
  writeFileSync(join(dir, "skill.md"), "Skill.", "utf8");
  const path = join(dir, "scenario.json");
  writeFileSync(
    path,
    JSON.stringify({
      agent: "./agent.md",
      skills: ["./skill.md"],
      model: "sonnet",
      runs: 4,
      scenarios: [{ name: "probe", prompt: "write the plan", grader }],
      ...extra,
    }),
    "utf8",
  );
  return path;
}

test("scenario loading accepts the grader-file shape and resolves the file from the scenario", () => {
  const dir = join(root, "config-ok");
  writeGraderFile(dir);
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8", timeoutMs: 5_000 });
  const config = loadCompareConfig(path, {}, { singleArm: true });
  expect(config.cases[0]?.grader).toEqual({
    type: "file",
    file: join(dir, "grade.eval.ts"),
    name: "covers-8",
    cwd: undefined,
    timeoutMs: 5_000,
  });
  // An explicit "type": "file" is the same shape.
  const typed = writeScenario(join(dir, "typed"), { type: "file", file: "../grade.eval.ts", name: "bare-name" });
  expect(loadCompareConfig(typed, {}, { singleArm: true }).cases[0]?.grader).toMatchObject({ type: "file", name: "bare-name" });
});

test("scenario loading rejects a missing grader file, an unknown name, and a bad default export", () => {
  const dir = join(root, "config-bad");
  writeGraderFile(dir);
  writeGraderFile(join(dir, "plain"), "export default { graders: {} };\n");

  const load = (grader: unknown) => () => loadCompareConfig(writeScenario(dir, grader), {}, { singleArm: true });
  expect(load({ file: "./missing.eval.ts", name: "x" })).toThrow(/probe\.grader\.file: file not found: .*missing\.eval\.ts/);
  expect(load({ file: "./grade.eval.ts", name: "covers-9" })).toThrow(
    /probe\.grader\.name: .* has no grader named "covers-9" \(has: covers-8, bare-name\)/,
  );
  expect(load({ file: "./grade.eval.ts" })).toThrow(/probe\.grader\.name must be a non-empty string/);
  expect(load({ file: "./plain/grade.eval.ts", name: "x" })).toThrow(/default export must be grade\(/);
  expect(load({ type: "nope" })).toThrow(/or omit "type" and set "file" \+ "name"/);
});

test("compare on a baseline-only scenario points at measure", () => {
  const dir = join(root, "compare-hint");
  writeGraderFile(dir);
  // The reproduction-probe shape: one instruction set, no proposed arm.
  const path = writeScenario(
    dir,
    { file: "./grade.eval.ts", name: "covers-8" },
    { skills: undefined, baselineSkills: ["./skill.md"] },
  );
  expect(() => loadCompareConfig(path)).toThrow(
    "compare requires proposed skill paths; to run one instruction set without a proposed arm, use `promptdiff measure`",
  );
});

/** Writes the plan into the sandbox on the listed (1-based) calls only; the rest produce nothing. */
function artifactRunner(plans: Array<unknown | undefined>): Runner {
  let call = 0;
  return {
    name: "mock",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false, streamEvents: false },
    async run(options: RunnerRunOptions) {
      const plan = plans[call % plans.length];
      call += 1;
      if (plan !== undefined) writeArtifact(options.cwd, plan);
      return { output: "done", costUsd: 0.01, turns: 1, durationMs: 1, models: ["m"], raw: {} };
    },
  };
}

test("measure reports no-artifact runs apart from passes and failures", async () => {
  const dir = join(root, "measure");
  writeGraderFile(dir);
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8" });
  const config = loadCompareConfig(path, { sandboxRoot: join(dir, "runs") }, { singleArm: true });

  // The field report from the issue: four real passes and one run that wrote
  // nothing. The honest tally is 4/4 pass, 1 no-artifact, not 4/5.
  const summary = await runMeasure({
    config: { ...config, runs: 5 },
    runner: artifactRunner([PASSING_PLAN, PASSING_PLAN, undefined, PASSING_PLAN, PASSING_PLAN]),
  });
  const result = summary.cases[0]!.result;
  expect(result).toMatchObject({ passes: 4, totalRuns: 5, noArtifact: 1, passRate: 1 });

  const text = formatMeasureSummary(summary);
  expect(text).toContain("4/4 pass (100%), 1 no-artifact");
  expect(text).toContain("run 3 no artifact: out/plan.json does not exist");
  expect(text).not.toContain("failed");
});

test("measure with failures and no-artifact runs keeps the two apart", async () => {
  const dir = join(root, "measure-mixed");
  writeGraderFile(dir);
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8" });
  const config = loadCompareConfig(path, { sandboxRoot: join(dir, "runs"), runs: 3 }, { singleArm: true });

  const summary = await runMeasure({ config, runner: artifactRunner([PASSING_PLAN, FAILING_PLAN, undefined]) });
  const text = formatMeasureSummary(summary);
  expect(text).toContain("1/2 pass (50%), 1 no-artifact");
  expect(text).toContain('run 2 failed: grade "covers-8" (out/plan.json): 3 of 3 checks failed');
  // The per-failure lines reach the summary as grader evidence.
  expect(text).toContain("FAIL no kept range covers t=8.0 | context:");
  expect(text).toContain("run 3 no artifact:");
});

test("compare excludes no-artifact runs from pass rates, notes them, and refuses an arm with none graded", async () => {
  const dir = join(root, "compare");
  writeGraderFile(dir);
  writeFileSync(join(dir, "proposed.md"), "PROPOSED", "utf8");
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8" }, { proposedSkills: ["./proposed.md"] });
  const config = loadCompareConfig(path, { sandboxRoot: join(dir, "runs"), runs: 2 });
  const regression = { ...config, cases: config.cases.map((evalCase) => ({ ...evalCase, kind: "regression" as const })) };

  // Baseline passes twice; proposed passes once and writes nothing once.
  const plans = [PASSING_PLAN, PASSING_PLAN, PASSING_PLAN, undefined];
  const shared = artifactRunner(plans);
  const summary = await runCompare({ config: regression, runners: { baseline: shared, proposed: shared } });
  const caseSummary = summary.cases[0]!;
  expect(caseSummary.proposed).toMatchObject({ passes: 1, noArtifact: 1, passRate: 1 });
  // 1/1 against 2/2 is no pass-rate regression, but proposed wrote the
  // artifact in 1 of 2 runs against baseline's 2 of 2, and that is one.
  expect(caseSummary.assertions).toEqual([
    "proposed produced the artifact in 1/2 runs, less often than baseline (2/2)",
  ]);
  const text = formatCompareSummary(summary);
  expect(text).toContain("proposed: 1/1 pass (100%), 1 no-artifact");
  expect(text).toContain("NOTE: pass rates exclude runs with no artifact (baseline 0/2, proposed 1/2)");
  expect(text).toContain("proposed run 2 no artifact:");

  // Proposed writing the artifact as often as baseline, or more often, is fine.
  const flipped = await runCompare({
    config: regression,
    runners: { baseline: artifactRunner([PASSING_PLAN, undefined]), proposed: artifactRunner([PASSING_PLAN, PASSING_PLAN]) },
  });
  expect(flipped.cases[0]!.assertions).toEqual([]);

  // An arm that never produced the artifact has no pass rate to compare.
  const empty = artifactRunner([undefined]);
  const none = await runCompare({ config: regression, runners: { baseline: shared, proposed: empty } });
  expect(none.cases[0]!.assertions).toEqual(["proposed produced no artifact in any run; there is nothing to compare"]);
  expect(formatCompareSummary(none)).toContain("proposed: 0/0 pass (n/a), 2 no-artifact");
});

test("compare leaves samplingP undefined when an arm has no graded runs, and uses graded denominators otherwise", async () => {
  const dir = join(root, "sampling-p");
  writeGraderFile(dir);
  writeFileSync(join(dir, "proposed.md"), "PROPOSED", "utf8");
  const path = writeScenario(dir, { file: "./grade.eval.ts", name: "covers-8" }, { proposedSkills: ["./proposed.md"] });
  const config = loadCompareConfig(path, { sandboxRoot: join(dir, "runs"), runs: 2 });

  const shared = artifactRunner([PASSING_PLAN, PASSING_PLAN]);
  const none = await runCompare({ config, runners: { baseline: shared, proposed: artifactRunner([undefined]) } });
  expect(none.cases[0]!.samplingP).toBeUndefined();

  // Baseline 2/2 graded, proposed 1/1 graded plus one no-artifact run.
  const mixed = await runCompare({
    config,
    runners: { baseline: artifactRunner([PASSING_PLAN]), proposed: artifactRunner([PASSING_PLAN, undefined]) },
  });
  expect(mixed.cases[0]!.proposed).toMatchObject({ passes: 1, noArtifact: 1 });
  expect(mixed.cases[0]!.samplingP).toBe(fisherExactTwoTailedP(2, 2, 1, 1));
});

test("the baseline cache key covers the grader file's content", () => {
  const dir = join(root, "cache-key");
  const file = writeGraderFile(dir);
  const keyInput = {
    systemPrompt: "s",
    casePrompt: "p",
    arm: { model: "sonnet", runner: "claude-p" as const },
    runs: 2,
    tools: "default",
    mode: "artifact" as const,
    delivery: "inline" as const,
    grader: { type: "file" as const, file, name: "covers-8" },
    images: [],
    baselineSkills: [],
  };
  const before = buildCacheKey(keyInput);
  writeGraderFile(dir, GRADER_SOURCE.replace("t=8.0", "t=9.0"));
  expect(buildCacheKey(keyInput)).not.toBe(before);
});

test("grade --help documents the exit codes", () => {
  const result = Bun.spawnSync(["./promptdiff", "grade", "--help"], { stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("usage: promptdiff grade --file <grade.eval.ts> (--name <grader> | --list)");
  expect(stdout).toContain("77  no artifact");
});
