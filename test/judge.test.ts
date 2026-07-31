import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import { loadCompareConfig } from "../src/engine/config";
import { gradeRun } from "../src/engine/grader";
import {
  assertJudgeCalibrated,
  calibrationRecordPath,
  formatCalibrationReport,
  parseJudgeVerdict,
  readCalibrationRecord,
  rubricSha256,
  runCalibration,
  setJudgeRunnerFactory,
  writeCalibrationRecord,
  type CalibrationRecord,
  type JudgeGraderSpec,
} from "../src/engine/judge";
import type { Runner, RunnerRunOptions } from "../src/types";

afterEach(() => setJudgeRunnerFactory(undefined));

// --- verdict parsing ---

test("parseJudgeVerdict reads a clean JSON verdict", () => {
  expect(parseJudgeVerdict('{"verdict": "pass", "reason": "clean"}')).toEqual({
    verdict: "pass",
    reason: "clean",
  });
  expect(parseJudgeVerdict('{"verdict": "fail", "reason": "negate-restate on line 2"}')).toEqual({
    verdict: "fail",
    reason: "negate-restate on line 2",
  });
});

test("parseJudgeVerdict takes the LAST balanced JSON object when reasoning prose surrounds it", () => {
  const reply = [
    "Let me think. The output uses {braces} loosely and mentions {\"verdict\": \"fail\", \"reason\": \"draft\"}.",
    "Considering the rubric again...",
    '{"verdict": "pass", "reason": "the construction is not present"}',
    "Done.",
  ].join("\n");
  expect(parseJudgeVerdict(reply)?.verdict).toBe("pass");
  // Braces inside JSON strings must not split the object.
  expect(parseJudgeVerdict('{"verdict": "fail", "reason": "uses {x} and }weird{ text"}')).toEqual({
    verdict: "fail",
    reason: "uses {x} and }weird{ text",
  });
});

test("parseJudgeVerdict returns undefined on garbage, wrong verdicts, and non-objects", () => {
  expect(parseJudgeVerdict("I think it passes.")).toBeUndefined();
  expect(parseJudgeVerdict('{"verdict": "maybe"}')).toBeUndefined();
  expect(parseJudgeVerdict('{"verdict": 1}')).toBeUndefined();
  expect(parseJudgeVerdict('["pass"]')).toBeUndefined();
  expect(parseJudgeVerdict("")).toBeUndefined();
});

// --- shared fixture scaffolding ---

interface JudgeTree {
  dir: string;
  rubric: string;
  scenario: string;
}

function makeJudgeTree(prefix: string): JudgeTree {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
  writeFileSync(join(dir, "baseline.md"), "BASELINE", "utf8");
  writeFileSync(join(dir, "proposed.md"), "PROPOSED", "utf8");
  const rubric = join(dir, "rubrics", "negate.md");
  mkdirSync(join(dir, "rubrics", "negate.fixtures", "pass"), { recursive: true });
  mkdirSync(join(dir, "rubrics", "negate.fixtures", "fail"), { recursive: true });
  writeFileSync(rubric, "RUBRIC v1: flag the negate-then-restate construction.", "utf8");
  writeFileSync(join(dir, "rubrics", "negate.fixtures", "pass", "clean-a.md"), "GOOD_A", "utf8");
  writeFileSync(join(dir, "rubrics", "negate.fixtures", "pass", "clean-b.md"), "TRICKY_B", "utf8");
  writeFileSync(join(dir, "rubrics", "negate.fixtures", "fail", "bad-a.md"), "BAD_A", "utf8");
  writeFileSync(join(dir, "rubrics", "negate.fixtures", "fail", "bad-b.md"), "BAD_B", "utf8");
  writeFileSync(join(dir, "rubrics", "negate.fixtures", "fail", "garbled.md"), "GARBLE_C", "utf8");

  const scenario = join(dir, "scenario.json");
  writeFileSync(
    scenario,
    JSON.stringify({
      agent: "./agent.md",
      baselineSkills: ["./baseline.md"],
      proposedSkills: ["./proposed.md"],
      model: "sonnet",
      runs: 1,
      scenarios: [
        {
          name: "style",
          kind: "compare",
          prompt: "write it",
          grader: { type: "judge", rubric: "./rubrics/negate.md", model: "judge-model" },
        },
      ],
    }),
    "utf8",
  );
  return { dir, rubric, scenario };
}

/**
 * Deterministic mock judge: pass when the graded text contains GOOD,
 * unparseable reply on GARBLE, fail otherwise. $0.02 per call.
 */
function mockJudgeFactory(calls: RunnerRunOptions[], factoryArgs: unknown[][] = []): void {
  setJudgeRunnerFactory((name, options) => {
    factoryArgs.push([name, options]);
    const runner: Runner = {
      name,
      capabilities: { sandboxTools: false, skillRegistry: false, images: false },
      async run(runOptions: RunnerRunOptions) {
        calls.push(runOptions);
        const output = runOptions.userPrompt.includes("GARBLE")
          ? "no verdict here"
          : runOptions.userPrompt.includes("GOOD")
            ? 'Reasoning...\n{"verdict": "pass", "reason": "clean"}'
            : '{"verdict": "fail", "reason": "construction present"}';
        return { output, costUsd: 0.02, turns: 1, durationMs: 5, models: ["judge-model"], raw: {} };
      },
    };
    return runner;
  });
}

function judgeSpec(rubric: string, overrides: Partial<JudgeGraderSpec> = {}): JudgeGraderSpec {
  return { type: "judge", rubric, model: "judge-model", runner: "claude-p", minAccuracy: 0.9, ...overrides };
}

function goodRecord(rubric: string, overrides: Partial<CalibrationRecord> = {}): CalibrationRecord {
  return {
    rubricSha256: rubricSha256(readFileSync(rubric, "utf8")),
    model: "judge-model",
    runner: "claude-p",
    ranAt: new Date().toISOString(),
    fixtures: { pass: 2, fail: 3 },
    accuracy: { pass: 1, fail: 1 },
    verdicts: [],
    ...overrides,
  };
}

// --- calibration record read/write + staling ---

test("calibration records round-trip and go stale when the rubric content changes", () => {
  const tree = makeJudgeTree("promptdiff-judge-record-");
  try {
    const record = goodRecord(tree.rubric);
    const path = writeCalibrationRecord(tree.rubric, record);
    expect(path).toBe(calibrationRecordPath(tree.rubric));
    expect(path).toBe(`${tree.rubric}.calibration.json`);
    expect(readCalibrationRecord(path)).toEqual(record);

    // Fresh record: the gate accepts.
    expect(() => assertJudgeCalibrated(judgeSpec(tree.rubric))).not.toThrow();

    // Edit the rubric: content hash mismatches, the record is stale.
    writeFileSync(tree.rubric, "RUBRIC v2: stricter.", "utf8");
    expect(() => assertJudgeCalibrated(judgeSpec(tree.rubric))).toThrow(/changed since calibration.*stale/);

    // A malformed record fails loudly, not silently.
    writeFileSync(path, '{"model": "judge-model"}', "utf8");
    expect(() => assertJudgeCalibrated(judgeSpec(tree.rubric))).toThrow(/malformed/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

// --- the gate refuses before any runner.run ---

async function expectGateRefusal(tree: JudgeTree, pattern: RegExp): Promise<void> {
  const armCalls: RunnerRunOptions[] = [];
  const armRunner: Runner = {
    name: "mock",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false },
    async run(options: RunnerRunOptions) {
      armCalls.push(options);
      return { output: "GOOD out", costUsd: 0.1, turns: 1, durationMs: 5, models: ["sonnet"], raw: {} };
    },
  };
  const judgeCalls: RunnerRunOptions[] = [];
  mockJudgeFactory(judgeCalls);

  const config = loadCompareConfig(tree.scenario, { sandboxRoot: join(tree.dir, "runs") });
  await expect(runCompare({ config, runners: { baseline: armRunner, proposed: armRunner } })).rejects.toThrow(pattern);
  // The refusal happens BEFORE any paid run — arm and judge alike.
  expect(armCalls).toHaveLength(0);
  expect(judgeCalls).toHaveLength(0);
}

test("gate: missing calibration record refuses with the calibrate fix", async () => {
  const tree = makeJudgeTree("promptdiff-judge-gate-missing-");
  try {
    await expectGateRefusal(tree, /no calibration record.*promptdiff calibrate --rubric/s);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("gate: stale rubric hash refuses", async () => {
  const tree = makeJudgeTree("promptdiff-judge-gate-stale-");
  try {
    writeCalibrationRecord(tree.rubric, goodRecord(tree.rubric));
    writeFileSync(tree.rubric, "RUBRIC v2: edited after calibration.", "utf8");
    await expectGateRefusal(tree, /changed since calibration/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("gate: record calibrated with a different judge model refuses", async () => {
  const tree = makeJudgeTree("promptdiff-judge-gate-model-");
  try {
    writeCalibrationRecord(tree.rubric, goodRecord(tree.rubric, { model: "other-judge" }));
    await expectGateRefusal(tree, /calibrated with model "other-judge".*grader specifies model "judge-model"/s);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("gate: per-class accuracy below the bar refuses, even with a perfect other class", async () => {
  const tree = makeJudgeTree("promptdiff-judge-gate-bar-");
  try {
    // The pass-everything judge: 100% pass class, 0% fail class. Overall
    // accuracy would look decent — the per-class bar is what catches it.
    writeCalibrationRecord(tree.rubric, goodRecord(tree.rubric, { accuracy: { pass: 1, fail: 0 } }));
    await expectGateRefusal(tree, /below the calibration bar on the fail class.*0% < minAccuracy 90%/s);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

// --- a calibrated judge grades real runs, and its cost counts ---

test("a passing gate lets runCompare proceed; judge verdicts grade runs and judge cost flows into totals", async () => {
  const tree = makeJudgeTree("promptdiff-judge-compare-");
  try {
    writeCalibrationRecord(tree.rubric, goodRecord(tree.rubric));
    const judgeCalls: RunnerRunOptions[] = [];
    const factoryArgs: unknown[][] = [];
    mockJudgeFactory(judgeCalls, factoryArgs);

    const makeArm = (output: string): Runner => ({
      name: "mock",
      capabilities: { sandboxTools: true, skillRegistry: true, images: false },
      async run() {
        return { output, costUsd: 0.1, turns: 1, durationMs: 5, models: ["sonnet"], raw: {} };
      },
    });

    const config = loadCompareConfig(tree.scenario, { sandboxRoot: join(tree.dir, "runs") });
    const summary = await runCompare({
      config,
      runners: { baseline: makeArm("GOOD output"), proposed: makeArm("BAD output") },
    });

    expect(summary.cases[0]?.baseline.passRate).toBe(1);
    expect(summary.cases[0]?.proposed.passRate).toBe(0);
    expect(summary.cases[0]?.proposed.runs[0]?.grade.message).toContain("judge verdict: fail — construction present");
    // Judge saw the arm output as its user prompt, text mode, explicit judge model.
    expect(judgeCalls).toHaveLength(2);
    expect(judgeCalls[0]?.userPrompt).toBe("GOOD output");
    expect(judgeCalls[0]?.model).toBe("judge-model");
    expect(judgeCalls[0]?.tools).toBe("");
    expect(judgeCalls[0]?.systemPrompt).toContain("RUBRIC v1");
    expect(judgeCalls[0]?.systemPrompt).toContain('{"verdict": "pass" | "fail", "reason": "<short>"}');
    expect(factoryArgs[0]).toEqual(["claude-p", { baseUrl: undefined }]);
    // Each run's cost = arm cost + judge cost, so totals stay honest.
    expect(summary.cases[0]?.baseline.runs[0]?.costUsd).toBeCloseTo(0.12);
    expect(summary.totalCostUsd).toBeCloseTo(0.24);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("an unparseable judge reply FAILS the graded run, never passes it", async () => {
  const tree = makeJudgeTree("promptdiff-judge-invalid-");
  try {
    mockJudgeFactory([]);
    const grade = await gradeRun(judgeSpec(tree.rubric), {
      run: { output: "GARBLE output", costUsd: 0, turns: 1, durationMs: 1, models: [], raw: {} },
      sandboxDir: tree.dir,
    });
    expect(grade.pass).toBe(false);
    expect(grade.message).toBe("judge returned no valid verdict");
    expect(grade.costUsd).toBeCloseTo(0.02);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("a judge transport failure fails the graded run with the error in the message", async () => {
  const tree = makeJudgeTree("promptdiff-judge-transport-");
  try {
    setJudgeRunnerFactory(() => ({
      name: "claude-p",
      capabilities: { sandboxTools: false, skillRegistry: false, images: false },
      async run(): Promise<never> {
        throw new Error("endpoint unreachable");
      },
    }));
    const grade = await gradeRun(judgeSpec(tree.rubric), {
      run: { output: "GOOD output", costUsd: 0, turns: 1, durationMs: 1, models: [], raw: {} },
      sandboxDir: tree.dir,
    });
    expect(grade.pass).toBe(false);
    expect(grade.message).toBe("judge error: endpoint unreachable");
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

// --- calibrate ---

test("runCalibration reports per-class accuracy, records misses (including invalid verdicts), and always writes the record", async () => {
  const tree = makeJudgeTree("promptdiff-judge-calibrate-");
  try {
    const judgeCalls: RunnerRunOptions[] = [];
    const factoryArgs: unknown[][] = [];
    mockJudgeFactory(judgeCalls, factoryArgs);

    // Mock judge: GOOD → pass, GARBLE → invalid, else fail.
    // pass class: clean-a (GOOD_A) correct, clean-b (TRICKY_B) missed → 1/2.
    // fail class: bad-a, bad-b correct; garbled.md invalid → 2/3.
    const result = await runCalibration({
      rubric: tree.rubric,
      model: "judge-model",
      runner: "openai",
      baseUrl: "http://localhost:11434/v1",
      timeoutMs: 1_000,
      maxBudgetUsd: 1,
    });

    expect(result.record.accuracy.pass).toBeCloseTo(1 / 2);
    expect(result.record.accuracy.fail).toBeCloseTo(2 / 3);
    expect(result.record.fixtures).toEqual({ pass: 2, fail: 3 });
    expect(result.record.rubricSha256).toBe(rubricSha256(readFileSync(tree.rubric, "utf8")));
    expect(result.record.model).toBe("judge-model");
    expect(result.record.runner).toBe("openai");
    expect(result.misses).toEqual([
      { fixture: "pass/clean-b.md", expected: "pass", got: "fail" },
      { fixture: "fail/garbled.md", expected: "fail", got: "invalid" },
    ]);
    expect(result.totalCostUsd).toBeCloseTo(0.1);

    // The record lands on disk even though this calibration is below any sane bar.
    const written = readCalibrationRecord(calibrationRecordPath(tree.rubric));
    expect(written.accuracy).toEqual(result.record.accuracy);

    // openai judges are pinned to temperature 0.
    expect(factoryArgs[0]).toEqual(["openai", { baseUrl: "http://localhost:11434/v1" }]);
    expect(judgeCalls[0]?.requestParams).toEqual({ temperature: 0 });

    const report = formatCalibrationReport(result);
    expect(report).toContain("pass class: 1/2 correct (50%)");
    expect(report).toContain("fail class: 2/3 correct (67%)");
    expect(report).toContain("pass/clean-b.md: expected pass, judge said fail");
    expect(report).toContain("fail/garbled.md: expected fail, judge said invalid");
    expect(report).toContain(calibrationRecordPath(tree.rubric));
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

test("runCalibration errors when either fixture class is empty", async () => {
  const tree = makeJudgeTree("promptdiff-judge-calibrate-empty-");
  try {
    mockJudgeFactory([]);
    rmSync(join(tree.dir, "rubrics", "negate.fixtures", "fail"), { recursive: true, force: true });
    await expect(
      runCalibration({ rubric: tree.rubric, model: "judge-model", runner: "claude-p", timeoutMs: 1_000, maxBudgetUsd: 1 }),
    ).rejects.toThrow(/at least one fail-class fixture/);
    expect(existsSync(calibrationRecordPath(tree.rubric))).toBe(false);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});

// --- config load validation ---

test("judge grader specs validate at load: rubric must exist, model is required, minAccuracy is bounded", () => {
  const tree = makeJudgeTree("promptdiff-judge-config-");
  try {
    const base = JSON.parse(readFileSync(tree.scenario, "utf8")) as Record<string, unknown>;
    const withGrader = (grader: Record<string, unknown>): string => {
      const path = join(tree.dir, "variant.json");
      writeFileSync(
        path,
        JSON.stringify({
          ...base,
          scenarios: [{ name: "style", kind: "compare", prompt: "p", grader }],
        }),
        "utf8",
      );
      return path;
    };

    // The happy path resolves the rubric relative to the scenario file and defaults.
    const config = loadCompareConfig(tree.scenario);
    const grader = config.cases[0]?.grader;
    if (grader?.type !== "judge") throw new Error("expected judge grader");
    expect(grader.rubric).toBe(tree.rubric);
    expect(grader.runner).toBe("claude-p");
    expect(grader.minAccuracy).toBe(0.9);

    expect(() =>
      loadCompareConfig(withGrader({ type: "judge", rubric: "./rubrics/missing.md", model: "j" })),
    ).toThrow(/rubric: file not found/);
    expect(() => loadCompareConfig(withGrader({ type: "judge", rubric: "./rubrics/negate.md" }))).toThrow(
      /grader\.model must be a non-empty string/,
    );
    expect(() =>
      loadCompareConfig(withGrader({ type: "judge", rubric: "./rubrics/negate.md", model: "j", minAccuracy: 1.5 })),
    ).toThrow(/minAccuracy must be between 0 and 1/);
    expect(() => loadCompareConfig(withGrader({ type: "nope" }))).toThrow(/"text", "json", "command", or "judge"/);
  } finally {
    rmSync(tree.dir, { recursive: true, force: true });
  }
});
