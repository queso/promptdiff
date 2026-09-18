import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare, formatCompareSummary, type CompareSummary } from "../src/engine/compare";
import type { CompareConfig } from "../src/engine/config";
import type { Runner, RunnerRunOptions } from "../src/types";

interface CountingRunner extends Runner {
  counts: { baseline: number; proposed: number };
}

function makeCountingRunner(): CountingRunner {
  const counts = { baseline: 0, proposed: 0 };
  return {
    name: "mock",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false, streamEvents: false },
    counts,
    async run(options: RunnerRunOptions) {
      if (options.systemPrompt.includes("PROPOSED")) {
        counts.proposed += 1;
      } else {
        counts.baseline += 1;
      }
      return { output: "ok", costUsd: 0.1, turns: 1, durationMs: 10, models: ["sonnet"], raw: {} };
    },
  };
}

interface Fixture {
  dir: string;
  cacheDir: string;
  config: CompareConfig;
  baselineSkill: string;
  seed: string;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-cache-test-"));
  const agent = join(dir, "agent.md");
  const baselineSkill = join(dir, "baseline.md");
  const proposedSkill = join(dir, "proposed.md");
  const seed = join(dir, "seed");
  writeFileSync(agent, "Agent", "utf8");
  writeFileSync(baselineSkill, "BASELINE v1", "utf8");
  writeFileSync(proposedSkill, "PROPOSED v1", "utf8");
  mkdirSync(seed, { recursive: true });
  writeFileSync(join(seed, "fixture.txt"), "seed v1", "utf8");

  const config: CompareConfig = {
    name: "cache test",
    agent,
    baselineSkills: [baselineSkill],
    proposedSkills: [proposedSkill],
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
    sandboxSeed: seed,
    keepSandbox: false,
    cases: [
      {
        name: "case",
        kind: "regression",
        prompt: "do it",
        grader: { type: "text", contains: ["ok"] },
        images: [],
        addDirs: [],
      },
    ],
  };

  return { dir, cacheDir: join(dir, "cache"), config, baselineSkill, seed };
}

test("second compare with the same config serves baseline from cache and runs zero baseline calls", async () => {
  const fixture = makeFixture();
  try {
    const cache = { dir: fixture.cacheDir };
    const first = makeCountingRunner();
    const warm = await runCompare({ config: fixture.config, runners: { baseline: first, proposed: first }, cache });
    expect(first.counts).toEqual({ baseline: 2, proposed: 2 });
    expect(warm.cases[0]?.baseline.cached).toBeUndefined();

    const second = makeCountingRunner();
    const progress: string[] = [];
    const summary = await runCompare({
      config: fixture.config,
      runners: { baseline: second, proposed: second },
      cache,
      onProgress: (message) => progress.push(message),
    });
    expect(second.counts).toEqual({ baseline: 0, proposed: 2 });
    expect(summary.cases[0]?.baseline.cached).toBe(true);
    expect(summary.cases[0]?.baseline.passRate).toBe(1);
    expect(summary.cases[0]?.baseline.totalCostUsd).toBeCloseTo(0.2);
    expect(progress.some((line) => /^ {2}baseline: cache hit \([0-9a-f]{12}\)$/.test(line))).toBe(true);
    // The formatter marks the served-from-cache baseline on the receipt.
    expect(formatCompareSummary(summary)).toContain("baseline: 2/2 pass (100%) | $0.2000 (cached)");
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("cache misses when baseline skill content, run count, or seed tree changes", async () => {
  const fixture = makeFixture();
  try {
    const cache = { dir: fixture.cacheDir };
    const warm = makeCountingRunner();
    await runCompare({ config: fixture.config, runners: { baseline: warm, proposed: warm }, cache });
    expect(warm.counts.baseline).toBe(2);
    expect(readdirSync(fixture.cacheDir)).toHaveLength(1);

    // Editing the baseline skill changes the rendered system prompt → miss.
    writeFileSync(fixture.baselineSkill, "BASELINE v2", "utf8");
    const afterSkillEdit = makeCountingRunner();
    await runCompare({ config: fixture.config, runners: { baseline: afterSkillEdit, proposed: afterSkillEdit }, cache });
    expect(afterSkillEdit.counts.baseline).toBe(2);

    // Same content, more runs → miss (2 recorded runs cannot stand in for 3).
    const afterRunsChange = makeCountingRunner();
    await runCompare({
      config: { ...fixture.config, runs: 3 },
      runners: { baseline: afterRunsChange, proposed: afterRunsChange },
      cache,
    });
    expect(afterRunsChange.counts.baseline).toBe(3);

    // Editing a seed fixture file changes the sandbox every run starts from → miss.
    writeFileSync(join(fixture.seed, "fixture.txt"), "seed v2", "utf8");
    const afterSeedEdit = makeCountingRunner();
    await runCompare({
      config: { ...fixture.config, runs: 3 },
      runners: { baseline: afterSeedEdit, proposed: afterSeedEdit },
      cache,
    });
    expect(afterSeedEdit.counts.baseline).toBe(3);

    // Every variation above landed its own entry.
    expect(readdirSync(fixture.cacheDir)).toHaveLength(4);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("formatCompareSummary suffixes only the cached baseline line", () => {
  const arm = (name: "baseline" | "proposed", cached?: boolean) => ({
    name,
    passes: 1,
    totalRuns: 2,
    passRate: 0.5,
    totalCostUsd: 0.2,
    runs: [],
    cached,
  });
  const summary: CompareSummary = {
    name: "cached format",
    arms: {
      baseline: { model: "sonnet", runner: "claude-p" },
      proposed: { model: "sonnet", runner: "claude-p" },
    },
    cases: [
      {
        name: "case",
        kind: "compare",
        baseline: arm("baseline", true),
        proposed: arm("proposed"),
        assertions: [],
      },
    ],
    failedAssertions: [],
    totalCostUsd: 0.4,
  };

  const text = formatCompareSummary(summary);
  expect(text).toContain("  baseline: 1/2 pass (50%) | $0.2000 (cached)");
  expect(text).toContain("  proposed: 1/2 pass (50%) | $0.2000\n");
});

test("compare rejects --cache-dir without --cache before doing any work", () => {
  const result = Bun.spawnSync(
    ["./promptdiff", "compare", "--scenario", "./does-not-exist.json", "--cache-dir", "/tmp/nope"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode).toBe(2);
  expect(result.stderr.toString()).toContain("--cache-dir requires --cache");
});

test("a cached baseline arm says it has no transcript to write instead of writing an empty one", async () => {
  const fixture = makeFixture();
  try {
    const cache = { dir: fixture.cacheDir };
    // The counting runner stands in for claude-p here: capture demands a
    // streamEvents runner, which the engine checks before any run.
    const streamingRunner = (): CountingRunner => {
      const runner = makeCountingRunner();
      return { ...runner, capabilities: { ...runner.capabilities, streamEvents: true } };
    };
    const first = streamingRunner();
    const firstTranscriptOut = { dir: join(fixture.dir, "transcripts-1") };
    await runCompare({
      config: fixture.config,
      runners: { baseline: first, proposed: first },
      cache,
      transcriptOut: firstTranscriptOut,
    });
    // Sanity check on the harness itself: a genuine (cache-miss) baseline run
    // does open transcript files, so the second run's directory is a fair test.
    expect(readdirSync(firstTranscriptOut.dir).some((name) => name.includes("_baseline_"))).toBe(true);

    // A fresh directory per run makes "no baseline file was created" directly
    // assertable, rather than inferring it from mtimes on a shared directory
    // that the proposed arm (never cached) also writes into on every run.
    const progress: string[] = [];
    const second = streamingRunner();
    const secondTranscriptOut = { dir: join(fixture.dir, "transcripts-2") };
    await runCompare({
      config: fixture.config,
      runners: { baseline: second, proposed: second },
      cache,
      transcriptOut: secondTranscriptOut,
      onProgress: (message) => progress.push(message),
    });

    // The arm ran in an earlier invocation; capture cannot reach back for it.
    expect(second.counts.baseline).toBe(0);
    expect(progress).toContain("  baseline: cache hit — no transcript to write");
    // The actual invariant the test name promises: a cache-served baseline
    // opens no transcript file at all, empty or otherwise. The proposed arm
    // (not cached) still writes its own, which also proves transcript capture
    // was live for this run and not just skipped wholesale.
    const secondRunFiles = readdirSync(secondTranscriptOut.dir);
    expect(secondRunFiles.some((name) => name.includes("_baseline_"))).toBe(false);
    expect(secondRunFiles.some((name) => name.includes("_proposed_"))).toBe(true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
