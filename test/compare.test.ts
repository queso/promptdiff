import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import type { CompareConfig } from "../src/engine/config";
import type { Runner, RunnerRunOptions } from "../src/types";

test("runCompare verifies target improvement and regression preservation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-compare-test-"));
  try {
    const agent = join(dir, "agent.md");
    const baseline = join(dir, "baseline.md");
    const proposed = join(dir, "proposed.md");
    writeFileSync(agent, "Agent", "utf8");
    writeFileSync(baseline, "BASELINE", "utf8");
    writeFileSync(proposed, "PROPOSED", "utf8");

    const runner: Runner = {
      name: "mock",
      capabilities: { sandboxTools: true, skillRegistry: true, images: false },
      async run(options: RunnerRunOptions) {
        const isProposed = options.systemPrompt.includes("PROPOSED");
        const isRegression = options.userPrompt.includes("regression");
        return {
          output: isProposed || isRegression ? "ok" : "bad",
          costUsd: 0.1,
          turns: 1,
          durationMs: 10,
          models: ["sonnet"],
          raw: {},
        };
      },
    };

    const config: CompareConfig = {
      name: "test compare",
      agent,
      baselineSkills: [baseline],
      proposedSkills: [proposed],
      delivery: "inline",
      runner: "claude-p",
      model: "sonnet",
      runs: 2,
      timeoutMs: 1_000,
      maxBudgetUsd: 1,
      addDirs: [],
      sandboxRoot: join(dir, "runs"),
      keepSandbox: false,
      cases: [
        {
          name: "target",
          kind: "target",
          prompt: "target",
          grader: { type: "text", contains: ["ok"] },
          images: [],
          addDirs: [],
        },
        {
          name: "regression",
          kind: "regression",
          prompt: "regression",
          grader: { type: "text", contains: ["ok"] },
          images: [],
          addDirs: [],
        },
      ],
    };

    const summary = await runCompare({ config, runner });
    expect(summary.failedAssertions).toEqual([]);
    expect(summary.totalCostUsd).toBeCloseTo(0.8);
    expect(summary.cases[0]?.baseline.passRate).toBe(0);
    expect(summary.cases[0]?.proposed.passRate).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
