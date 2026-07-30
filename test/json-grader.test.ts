import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import { loadCompareConfig, type CompareConfig } from "../src/engine/config";
import { gradeRun, type GraderSpec } from "../src/engine/grader";
import { evaluateAssertion, extractLastJson, parseAssertion } from "../src/engine/json-assert";
import type { Runner, RunnerRunOptions } from "../src/types";

// --- extraction ---

test("extractLastJson parses pure JSON output, including scalars", () => {
  expect(extractLastJson('{"verdict": "pass"}')?.value).toEqual({ verdict: "pass" });
  expect(extractLastJson('  [1, 2, 3]\n')?.value).toEqual([1, 2, 3]);
  expect(extractLastJson("42")?.value).toBe(42);
});

test("extractLastJson finds JSON after reasoning prose", () => {
  const output = 'Let me think about the findings here.\n\n{"items": [{"domain": "correctness"}]}';
  expect(extractLastJson(output)?.value).toEqual({ items: [{ domain: "correctness" }] });
});

test("extractLastJson takes the LAST balanced value when JSON appears before and after prose", () => {
  const output = 'First draft: {"verdict": "fail"} — but on reflection the answer is {"verdict": "pass"} done.';
  expect(extractLastJson(output)?.value).toEqual({ verdict: "pass" });
});

test("extractLastJson balances braces inside string literals", () => {
  const output = 'answer: {"note": "a } and { inside", "escaped": "quote \\" here", "ok": true} trailing';
  expect(extractLastJson(output)?.value).toEqual({
    note: "a } and { inside",
    escaped: 'quote " here',
    ok: true,
  });
});

test("extractLastJson skips prose braces and still finds real JSON inside them", () => {
  const output = "consider {not json but it mentions {\"inner\": 1} and balances}";
  expect(extractLastJson(output)?.value).toEqual({ inner: 1 });
});

test("json grader fails cleanly when the output holds no JSON", async () => {
  const spec: GraderSpec = { type: "json", assert: ["verdict == \"pass\""] };
  const grade = await gradeRun(spec, { run: run("no structured answer here"), sandboxDir: "/tmp" });
  expect(grade.pass).toBe(false);
  expect(grade.message).toBe("no JSON value found in output");
});

// --- assertion evaluation ---

const doc = {
  verdict: "pass",
  count: 2,
  findings: {
    items: [
      { domain: "correctness", severity: 3, tags: ["bug", "logic"] },
      { domain: "style", severity: 1, tags: [] },
    ],
  },
};

function failure(source: string, root: unknown = doc): string | undefined {
  return evaluateAssertion(parseAssertion(source), root);
}

test("== and != compare scalars", () => {
  expect(failure('verdict == "pass"')).toBeUndefined();
  expect(failure('verdict == "fail"')).toBe('verdict == "fail": found "pass"');
  expect(failure('verdict != "fail"')).toBeUndefined();
  expect(failure("count == 2")).toBeUndefined();
  expect(failure("verdict == null")).toBe('verdict == null: found "pass"');
});

test("numeric comparisons work on numbers and fail with a type message otherwise", () => {
  expect(failure("count > 1")).toBeUndefined();
  expect(failure("count >= 2")).toBeUndefined();
  expect(failure("count < 2")).toBe("count < 2: found 2");
  expect(failure("count <= 1")).toBe("count <= 1: found 2");
  expect(failure("verdict > 1")).toBe('verdict > 1: expected a number, found "pass"');
});

test("contains checks substring on strings and membership on arrays", () => {
  expect(failure('verdict contains "as"')).toBeUndefined();
  expect(failure('verdict contains "zz"')).toBe('verdict contains "zz": found "pass"');
  expect(failure('findings.items[0].tags contains "bug"')).toBeUndefined();
  expect(failure('findings.items[0].tags contains "typo"')).toBe(
    'findings.items[0].tags contains "typo": found ["bug","logic"]',
  );
  expect(failure('count contains "2"')).toBe('count contains "2": contains needs a string or array, found 2');
});

test(".length reads array and string lengths", () => {
  expect(failure("findings.items.length == 2")).toBeUndefined();
  expect(failure("findings.items.length == 0")).toBe("findings.items.length == 0: found 2");
  expect(failure("verdict.length == 4")).toBeUndefined();
});

test("[n] indexes and [*] quantifies existentially", () => {
  expect(failure('findings.items[0].domain == "correctness"')).toBeUndefined();
  expect(failure('findings.items[1].domain == "correctness"')).toBe(
    'findings.items[1].domain == "correctness": found "style"',
  );
  expect(failure('findings.items[*].domain contains "correct"')).toBeUndefined();
  expect(failure("findings.items[*].severity >= 3")).toBeUndefined();
  const noMatch = failure('findings.items[*].domain == "security"');
  expect(noMatch).toContain('findings.items[*].domain == "security"');
  expect(noMatch).toContain("no element satisfied (2 checked");
  // Existential != : passes because SOME element differs.
  expect(failure('findings.items[*].domain != "correctness"')).toBeUndefined();
});

test("missing paths fail cleanly, naming the missing segment", () => {
  const missing = failure("findings.blockers.length == 0");
  expect(missing).toContain("findings.blockers.length == 0: ");
  expect(missing).toContain('path segment "blockers" not found');
  expect(failure("findings.items[9].domain == \"x\"")).toBe(
    'findings.items[9].domain == "x": index [9] is out of range (2 elements)',
  );
  expect(failure("verdict[*] == 1")).toBe('verdict[*] == 1: [*] needs an array, found "pass"');
  expect(failure("items[*].x == 1", { items: [] })).toBe("items[*].x == 1: [*] found an empty array");
});

// --- assertion grammar (parse errors) ---

test("parseAssertion rejects bad grammar with messages naming the fix", () => {
  expect(() => parseAssertion("verdict")).toThrow(/<path> <op> <literal>/);
  expect(() => parseAssertion('verdict=="pass"')).toThrow(/<path> <op> <literal>/);
  expect(() => parseAssertion("verdict ~= 1")).toThrow(/<path> <op> <literal>/);
  expect(() => parseAssertion("verdict == pass")).toThrow(/literal must be a JSON scalar/);
  expect(() => parseAssertion("verdict == {}")).toThrow(/literal must be a JSON scalar/);
  expect(() => parseAssertion('items[a] == 1')).toThrow(/non-negative integer or \*/);
  expect(() => parseAssertion('items[0 == 1')).toThrow(/unclosed "\[/);
  expect(() => parseAssertion('[0] == 1')).toThrow(/must start with an identifier/);
  expect(() => parseAssertion('count > "high"')).toThrow(/needs a number literal/);
});

// --- load-time validation ---

test("loadCompareConfig validates json grader assertions before any paid run", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-json-grader-config-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "skill.md"), "Skill", "utf8");
    const base = {
      agent: "./agent.md",
      skills: ["./skill.md"],
      model: "gpt-4o-mini",
      runner: "openai",
    };

    writeFileSync(
      join(dir, "good.json"),
      JSON.stringify({
        ...base,
        scenarios: [
          {
            name: "nitpick",
            prompt: "review it",
            grader: { type: "json", assert: ["findings.items.length == 0"] },
          },
        ],
      }),
      "utf8",
    );
    const config = loadCompareConfig(join(dir, "good.json"));
    expect(config.cases[0]?.grader).toEqual({ type: "json", assert: ["findings.items.length == 0"] });

    writeFileSync(
      join(dir, "bad-grammar.json"),
      JSON.stringify({
        ...base,
        scenarios: [
          { name: "nitpick", prompt: "p", grader: { type: "json", assert: ["findings.items ==="] } },
        ],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "bad-grammar.json"))).toThrow(
      /nitpick\.grader\.assert "findings\.items ===" is invalid/,
    );

    writeFileSync(
      join(dir, "empty.json"),
      JSON.stringify({
        ...base,
        scenarios: [{ name: "nitpick", prompt: "p", grader: { type: "json", assert: [] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "empty.json"))).toThrow(
      /nitpick\.grader\.assert must list at least one assertion/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- end to end on a text-only runner ---

test("runCompare grades reasoning prose + trailing JSON with a json grader on a text-only runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-json-grader-e2e-"));
  try {
    const agent = join(dir, "agent.md");
    const skill = join(dir, "skill.md");
    writeFileSync(agent, "Agent", "utf8");
    writeFileSync(skill, "SKILL", "utf8");

    const toolsSeen: string[] = [];
    const runner: Runner = {
      name: "openai",
      capabilities: { sandboxTools: false, skillRegistry: false, images: false },
      async run(options: RunnerRunOptions) {
        toolsSeen.push(options.tools);
        const isProposed = options.systemPrompt.includes("PROPOSED");
        const output = isProposed
          ? 'Scanning the diff... early guess {"items": [{"domain": "style"}]} but the real report is:\n' +
            '{"findings": {"items": [{"domain": "correctness", "severity": 3}]}}'
          : "I looked carefully and found nothing worth reporting.";
        return { output, costUsd: 0, turns: 1, durationMs: 5, models: [options.model], raw: {} };
      },
    };

    const config: CompareConfig = {
      name: "json grader e2e",
      agent,
      baselineSkills: [skill],
      proposedSkills: [join(dir, "proposed.md")],
      delivery: "inline",
      arms: {
        baseline: { model: "gpt-4o-mini", runner: "openai" },
        proposed: { model: "gpt-4o-mini", runner: "openai" },
      },
      runs: 1,
      timeoutMs: 1_000,
      maxBudgetUsd: 1,
      addDirs: [],
      sandboxRoot: join(dir, "runs"),
      keepSandbox: false,
      cases: [
        {
          name: "nitpick",
          kind: "target",
          prompt: "review the diff",
          grader: {
            type: "json",
            assert: ["findings.items.length >= 1", 'findings.items[*].domain contains "correctness"'],
          },
          images: [],
          addDirs: [],
        },
      ],
    };
    writeFileSync(join(dir, "proposed.md"), "PROPOSED", "utf8");

    const summary = await runCompare({ config, runners: { baseline: runner, proposed: runner } });
    // json graders infer text mode: no tools demanded on the text-only runner.
    expect(toolsSeen).toEqual(["", ""]);
    expect(summary.cases[0]?.baseline.passRate).toBe(0);
    expect(summary.cases[0]?.baseline.runs[0]?.grade.message).toBe("no JSON value found in output");
    // The proposed arm's LAST balanced JSON value wins over the mid-reasoning one.
    expect(summary.cases[0]?.proposed.passRate).toBe(1);
    expect(summary.failedAssertions).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(output: string) {
  return { output, costUsd: 0, turns: 1, durationMs: 1, models: ["m"], raw: {} };
}
