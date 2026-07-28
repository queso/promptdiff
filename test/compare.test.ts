import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { formatCompareSummary, runCompare, type CompareSummary } from "../src/engine/compare";
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
      arms: {
        baseline: { model: "sonnet", runner: "claude-p" },
        proposed: { model: "sonnet", runner: "claude-p" },
      },
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

    const summary = await runCompare({ config, runners: { baseline: runner, proposed: runner } });
    expect(summary.failedAssertions).toEqual([]);
    expect(summary.totalCostUsd).toBeCloseTo(0.8);
    expect(summary.cases[0]?.baseline.passRate).toBe(0);
    expect(summary.cases[0]?.proposed.passRate).toBe(1);
    // Arms differ by skill text, so their rendered-prompt hashes must differ.
    const hashes = summary.cases[0]?.promptSha256;
    expect(hashes?.baseline).toMatch(/^[0-9a-f]{64}$/);
    expect(hashes?.baseline).not.toBe(hashes?.proposed);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCompare routes each arm to its own runner and model, and compare kind never fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-model-compare-test-"));
  try {
    const agent = join(dir, "agent.md");
    const skill = join(dir, "skill.md");
    writeFileSync(agent, "Agent", "utf8");
    writeFileSync(skill, "SKILL", "utf8");

    const makeRunner = (name: string, seen: string[], output: string): Runner => ({
      name,
      capabilities: { sandboxTools: false, skillRegistry: false, images: false },
      async run(options: RunnerRunOptions) {
        seen.push(options.model);
        return { output, costUsd: 0, turns: 1, durationMs: 10, models: [options.model], raw: {} };
      },
    });
    const baselineModels: string[] = [];
    const proposedModels: string[] = [];
    // The baseline arm always passes and the proposed arm always fails — the
    // worst directional outcome, which a "compare" scenario must still not fail.
    const baselineRunner = makeRunner("claude-p", baselineModels, "ok");
    const proposedRunner = makeRunner("openai", proposedModels, "bad");

    const config: CompareConfig = {
      name: "model compare",
      agent,
      baselineSkills: [skill],
      proposedSkills: [skill],
      delivery: "inline",
      arms: {
        baseline: { model: "sonnet", runner: "claude-p" },
        proposed: { model: "llama3.1", runner: "openai", baseUrl: "http://localhost:11434/v1" },
      },
      runs: 2,
      timeoutMs: 1_000,
      maxBudgetUsd: 1,
      addDirs: [],
      sandboxRoot: join(dir, "runs"),
      keepSandbox: false,
      cases: [
        {
          name: "model-diff",
          kind: "compare",
          prompt: "do it",
          grader: { type: "text", contains: ["ok"] },
          images: [],
          addDirs: [],
        },
      ],
    };

    const summary = await runCompare({
      config,
      runners: { baseline: baselineRunner, proposed: proposedRunner },
    });
    expect(baselineModels).toEqual(["sonnet", "sonnet"]);
    expect(proposedModels).toEqual(["llama3.1", "llama3.1"]);
    expect(summary.cases[0]?.baseline.passRate).toBe(1);
    expect(summary.cases[0]?.proposed.passRate).toBe(0);
    expect(summary.cases[0]?.assertions).toEqual([]);
    expect(summary.failedAssertions).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatCompareSummary labels arms when models differ and flags mixed-runner cost", () => {
  const arm = (name: "baseline" | "proposed", passes: number, costUsd: number) => ({
    name,
    passes,
    totalRuns: 5,
    passRate: passes / 5,
    totalCostUsd: costUsd,
    runs: [],
  });
  const summary: CompareSummary = {
    name: "model compare",
    arms: {
      baseline: { model: "sonnet", runner: "claude-p" },
      proposed: { model: "llama3.1", runner: "openai", baseUrl: "http://localhost:11434/v1" },
    },
    cases: [
      {
        name: "model-diff",
        kind: "compare",
        baseline: arm("baseline", 3, 0.5),
        proposed: arm("proposed", 4, 0),
        assertions: [],
      },
    ],
    failedAssertions: [],
    totalCostUsd: 0.5,
  };

  const text = formatCompareSummary(summary);
  expect(text).toContain("baseline (sonnet via claude-p): 3/5 pass");
  expect(text).toContain("proposed (llama3.1 via openai): 4/5 pass");
  expect(text).toContain('INFO: no assertion (kind "compare")');
  expect(text).toContain("note: cost columns are not comparable");

  // Same runner, different models: label with the model only, no cost note.
  const sameRunner: CompareSummary = {
    ...summary,
    arms: {
      baseline: { model: "sonnet", runner: "claude-p" },
      proposed: { model: "haiku", runner: "claude-p" },
    },
  };
  const sameRunnerText = formatCompareSummary(sameRunner);
  expect(sameRunnerText).toContain("baseline (sonnet): 3/5 pass");
  expect(sameRunnerText).toContain("proposed (haiku): 4/5 pass");
  expect(sameRunnerText).not.toContain("cost columns");

  // Identical arms keep the plain labels.
  const identical: CompareSummary = {
    ...summary,
    arms: {
      baseline: { model: "sonnet", runner: "claude-p" },
      proposed: { model: "sonnet", runner: "claude-p" },
    },
  };
  expect(formatCompareSummary(identical)).toContain("  baseline: 3/5 pass");
});
