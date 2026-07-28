import { expect, test } from "bun:test";
import { formatCompareSummary, type ArmRunSummary, type ArmSummary, type CompareSummary } from "../src/engine/compare";
import type { GradeResult } from "../src/engine/grader";

function run(runNumber: number, pass: boolean, grade: Partial<GradeResult> = {}): ArmRunSummary {
  return {
    run: runNumber,
    pass,
    grade: { pass, message: pass ? "command grader passed" : "command exited 1, expected 0", ...grade },
    costUsd: 0.1,
    turns: 1,
    durationMs: 10,
    sandboxDir: "/tmp/sb",
    output: "",
  };
}

function arm(name: "baseline" | "proposed", runs: ArmRunSummary[]): ArmSummary {
  const passes = runs.filter((r) => r.pass).length;
  return {
    name,
    passes,
    totalRuns: runs.length,
    passRate: runs.length === 0 ? 0 : passes / runs.length,
    totalCostUsd: runs.reduce((sum, r) => sum + r.costUsd, 0),
    runs,
  };
}

function summary(overrides: Partial<CompareSummary> = {}): CompareSummary {
  return {
    name: "test",
    arms: {
      baseline: { model: "sonnet", runner: "claude-p", baseUrl: undefined },
      proposed: { model: "sonnet", runner: "claude-p", baseUrl: undefined },
    },
    cases: [],
    failedAssertions: [],
    totalCostUsd: 0,
    ...overrides,
  };
}

test("failing runs surface their grader message and stream tails in the summary", () => {
  const failing = run(2, false, {
    stdout: ["line1", "line2", "line3", "line4", "line5", "line6", "line7", "7 planted, 5 caught"].join("\n"),
    stderr: "answer key: missed defects 3, 7",
  });
  const text = formatCompareSummary(
    summary({
      cases: [
        {
          name: "target",
          kind: "target",
          baseline: arm("baseline", [run(1, true), failing]),
          proposed: arm("proposed", [run(1, true), run(2, true)]),
          assertions: [],
        },
      ],
    }),
  );

  expect(text).toContain("baseline run 2 failed: command exited 1, expected 0");
  expect(text).toContain("grader stdout:");
  expect(text).toContain("7 planted, 5 caught");
  expect(text).toContain("grader stderr:");
  expect(text).toContain("answer key: missed defects 3, 7");
  // Only the last 6 lines of a stream are kept.
  expect(text).not.toContain("line1");
  expect(text).toContain("line3");
  // Passing runs contribute no evidence blocks.
  expect(text).not.toContain("run 1 failed");
});

test("summaries without failing runs carry no grader evidence blocks", () => {
  const text = formatCompareSummary(
    summary({
      cases: [
        {
          name: "clean",
          kind: "regression",
          baseline: arm("baseline", [run(1, true)]),
          proposed: arm("proposed", [run(1, true)]),
          assertions: [],
        },
      ],
    }),
  );
  expect(text).not.toContain("grader stdout");
  expect(text).not.toContain("failed:");
});
