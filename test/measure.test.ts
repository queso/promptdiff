import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { formatMeasureSummary, runMeasure } from "../src/engine/compare";
import { loadCompareConfig } from "../src/engine/config";
import type { Runner, RunnerRunOptions } from "../src/types";

function mockRunner(outputs: string[]): { runner: Runner; seen: RunnerRunOptions[] } {
  const seen: RunnerRunOptions[] = [];
  let call = 0;
  const runner: Runner = {
    name: "mock",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false },
    async run(options: RunnerRunOptions) {
      seen.push(options);
      const output = outputs[call % outputs.length];
      call += 1;
      return { output, costUsd: 0.05, turns: 1, durationMs: 5, models: ["m"], raw: {} };
    },
  };
  return { runner, seen };
}

function writeFixture(dir: string): string {
  writeFileSync(join(dir, "agent.md"), "Agent.", "utf8");
  writeFileSync(join(dir, "skill.md"), "Current skill {{voice}}", "utf8");
  const scenario = {
    name: "survival",
    agent: "./agent.md",
    skills: ["./skill.md"],
    model: "sonnet",
    runs: 4,
    render: { vars: { voice: "VOICE" } },
    scenarios: [
      { name: "finding-survives", kind: "target", prompt: "probe", grader: { type: "text", contains: ["ok"] } },
    ],
  };
  const path = join(dir, "measure.json");
  writeFileSync(path, JSON.stringify(scenario), "utf8");
  return path;
}

test("runMeasure reports per-case rates for one arm with no assertions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-measure-"));
  try {
    const path = writeFixture(dir);
    const config = loadCompareConfig(path, { sandboxRoot: join(dir, "runs") }, { singleArm: true });
    // 1 pass in 4 runs — the exact shape that produced a nonsense
    // "proposed regressed below baseline" verdict when faked with
    // identical compare arms.
    const { runner, seen } = mockRunner(["ok", "bad", "bad", "bad"]);

    const summary = await runMeasure({ config, runner });
    expect(summary.cases).toHaveLength(1);
    expect(summary.cases[0]?.result.passes).toBe(1);
    expect(summary.cases[0]?.result.totalRuns).toBe(4);
    expect(summary.cases[0]?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(summary.totalCostUsd).toBeCloseTo(0.2);
    // One arm only: 4 runs total, all with the rendered system prompt.
    expect(seen).toHaveLength(4);
    expect(seen.every((options) => options.systemPrompt.includes("Current skill VOICE"))).toBe(true);

    const text = formatMeasureSummary(summary);
    expect(text).toContain("1/4 pass (25%)");
    expect(text).toContain("run 2 failed:");
    expect(text).not.toContain("FAIL:");
    expect(text).not.toContain("delta");
    expect(text).not.toContain("baseline");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("singleArm loading accepts baselineSkills-only scenarios; compare still requires both", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-measure-config-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent.", "utf8");
    writeFileSync(join(dir, "skill.md"), "Skill", "utf8");
    const scenario = {
      agent: "./agent.md",
      baselineSkills: ["./skill.md"],
      model: "sonnet",
      scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
    };
    const path = join(dir, "s.json");
    writeFileSync(path, JSON.stringify(scenario), "utf8");

    const config = loadCompareConfig(path, {}, { singleArm: true });
    expect(config.baselineSkills).toEqual([join(dir, "skill.md")]);
    expect(() => loadCompareConfig(path)).toThrow(/proposed skill paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measure warns when the measured model diverges from productionModel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-measure-prod-"));
  try {
    const path = writeFixture(dir);
    const config = loadCompareConfig(
      path,
      { sandboxRoot: join(dir, "runs"), runs: 1 },
      { singleArm: true },
    );
    const { runner } = mockRunner(["ok"]);
    const summary = await runMeasure({ config, runner: runner });
    const text = formatMeasureSummary({ ...summary, productionModel: "gpt-5.5" });
    expect(text).toContain('warning: measured "sonnet" but production model is "gpt-5.5"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
