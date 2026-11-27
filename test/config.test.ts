import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import { loadCompareConfig, type CompareConfig } from "../src/engine/config";
import type { Runner, RunnerRunOptions } from "../src/types";

test("loadCompareConfig normalizes paths and rejects zero case runs", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-test-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "baseline.md"), "Baseline", "utf8");
    writeFileSync(join(dir, "proposed.md"), "Proposed", "utf8");
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./baseline.md"],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [
          {
            name: "target",
            prompt: "do it",
            grader: { type: "text", contains: ["ok"] },
          },
        ],
      }),
      "utf8",
    );

    const config = loadCompareConfig(join(dir, "scenario.json"));
    expect(config.agent).toBe(join(dir, "agent.md"));
    expect(config.baselineSkills).toEqual([join(dir, "baseline.md")]);
    expect(config.cases[0]?.kind).toBe("target");
    expect(config.arms.baseline.runner).toBe("claude-p");
    expect(config.arms.proposed.model).toBe("sonnet");
    expect(loadCompareConfig(join(dir, "scenario.json"), { runner: "openai" }).arms.proposed.runner).toBe("openai");

    writeFileSync(
      join(dir, "openai.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./baseline.md"],
        proposedSkills: ["./proposed.md"],
        model: "gpt-4o-mini",
        runner: "openai",
        baseUrl: "http://localhost:11434/v1",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    const openaiConfig = loadCompareConfig(join(dir, "openai.json"));
    expect(openaiConfig.arms.baseline.runner).toBe("openai");
    expect(openaiConfig.arms.baseline.baseUrl).toBe("http://localhost:11434/v1");

    writeFileSync(
      join(dir, "bad-runner.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./baseline.md"],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        runner: "gemini",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "bad-runner.json"))).toThrow(/runner must be one of/);

    writeFileSync(
      join(dir, "bad.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./baseline.md"],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [
          {
            name: "target",
            prompt: "do it",
            runs: 0,
            grader: { type: "text", contains: ["ok"] },
          },
        ],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "bad.json"))).toThrow("target.runs must be at least 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCompareConfig resolves per-arm models/runners and shared skills", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-arms-test-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "skill.md"), "Skill", "utf8");
    writeFileSync(
      join(dir, "models.json"),
      JSON.stringify({
        agent: "./agent.md",
        skills: ["./skill.md"],
        model: "sonnet",
        proposed: { model: "llama3.1", runner: "openai", baseUrl: "http://localhost:11434/v1" },
        scenarios: [
          { name: "t", kind: "compare", prompt: "p", grader: { type: "text", contains: ["ok"] } },
        ],
      }),
      "utf8",
    );

    const config = loadCompareConfig(join(dir, "models.json"));
    // Both arms inherit the shared skill set; only model/runner/baseUrl differ.
    expect(config.baselineSkills).toEqual([join(dir, "skill.md")]);
    expect(config.proposedSkills).toEqual([join(dir, "skill.md")]);
    expect(config.arms.baseline).toEqual({ model: "sonnet", runner: "claude-p", baseUrl: undefined });
    expect(config.arms.proposed).toEqual({
      model: "llama3.1",
      runner: "openai",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(config.cases[0]?.kind).toBe("compare");

    const overridden = loadCompareConfig(join(dir, "models.json"), {
      baselineModel: "haiku",
      proposedRunner: "claude-p",
    });
    expect(overridden.arms.baseline.model).toBe("haiku");
    expect(overridden.arms.proposed.runner).toBe("claude-p");

    writeFileSync(
      join(dir, "bad-arm-runner.json"),
      JSON.stringify({
        agent: "./agent.md",
        skills: ["./skill.md"],
        model: "sonnet",
        proposed: { runner: "gemini" },
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "bad-arm-runner.json"))).toThrow(/runner must be one of/);

    writeFileSync(
      join(dir, "no-skills.json"),
      JSON.stringify({
        agent: "./agent.md",
        model: "sonnet",
        proposed: { model: "llama3.1" },
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "no-skills.json"))).toThrow(/baseline skill paths/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pricing parses per-model rates and rejects gaps for openai arms", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-pricing-config-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "skill.md"), "Skill", "utf8");
    const base = {
      agent: "./agent.md",
      skills: ["./skill.md"],
      runner: "openai",
      model: "gpt-4o-mini",
      scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
    };

    writeFileSync(
      join(dir, "priced.json"),
      JSON.stringify({ ...base, pricing: { "gpt-4o-mini": { input: 0.15, output: 0.6 } } }),
      "utf8",
    );
    const config = loadCompareConfig(join(dir, "priced.json"));
    expect(config.pricing).toEqual({ "gpt-4o-mini": { input: 0.15, output: 0.6 } });

    // Pricing declared but missing the arm's model — silent $0 is the bug
    // this feature closes, so it fails at load.
    writeFileSync(
      join(dir, "gap.json"),
      JSON.stringify({ ...base, pricing: { "other-model": { input: 1, output: 1 } } }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "gap.json"))).toThrow(
      /pricing is declared but has no entry for baseline model "gpt-4o-mini"/,
    );

    // claude-p arms price themselves; a pricing map without their model is fine.
    writeFileSync(
      join(dir, "claude.json"),
      JSON.stringify({
        ...base,
        runner: "claude-p",
        model: "sonnet",
        pricing: { "gpt-4o-mini": { input: 1, output: 1 } },
      }),
      "utf8",
    );
    expect(loadCompareConfig(join(dir, "claude.json")).pricing).toBeDefined();

    writeFileSync(
      join(dir, "negative.json"),
      JSON.stringify({ ...base, pricing: { "gpt-4o-mini": { input: -1, output: 1 } } }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "negative.json"))).toThrow(/non-negative "input" and "output"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCompareConfig parses maxTurns at both levels and rejects bad caps", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-test-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "baseline.md"), "Baseline", "utf8");
    writeFileSync(join(dir, "proposed.md"), "Proposed", "utf8");
    const scenario = (extra: object, cases: object = {}) =>
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./baseline.md"],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] }, ...cases }],
        ...extra,
      });

    writeFileSync(join(dir, "capped.json"), scenario({ maxTurns: 25 }, { maxTurns: 10 }), "utf8");
    const config = loadCompareConfig(join(dir, "capped.json"));
    expect(config.maxTurns).toBe(25);
    expect(config.cases[0]?.maxTurns).toBe(10);
    // CLI override wins over the scenario file.
    expect(loadCompareConfig(join(dir, "capped.json"), { maxTurns: 5 }).maxTurns).toBe(5);

    writeFileSync(join(dir, "uncapped.json"), scenario({}), "utf8");
    expect(loadCompareConfig(join(dir, "uncapped.json")).maxTurns).toBeUndefined();

    writeFileSync(join(dir, "zero.json"), scenario({ maxTurns: 0 }), "utf8");
    expect(() => loadCompareConfig(join(dir, "zero.json"))).toThrow("maxTurns must be an integer of at least 1");

    writeFileSync(join(dir, "fractional-case.json"), scenario({}, { maxTurns: 2.5 }), "utf8");
    expect(() => loadCompareConfig(join(dir, "fractional-case.json"))).toThrow("t.maxTurns must be an integer of at least 1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCompareConfig accepts an explicit empty baselineSkills but still requires proposedSkills", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-empty-baseline-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "proposed.md"), "Proposed", "utf8");

    // An explicit `[]` answers "does adding this skill change anything at all"
    // and loads with an empty baseline arm.
    writeFileSync(
      join(dir, "empty-baseline.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: [],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    const config = loadCompareConfig(join(dir, "empty-baseline.json"));
    expect(config.baselineSkills).toEqual([]);
    expect(config.proposedSkills).toEqual([join(dir, "proposed.md")]);

    // A shared top-level `skills` set must not backfill an explicit `[]`:
    // normalizeSkills returns on the Array.isArray branch before it ever
    // reaches the shared-skills fallback, so pin that here.
    writeFileSync(join(dir, "shared.md"), "Shared", "utf8");
    writeFileSync(
      join(dir, "empty-baseline-with-shared.json"),
      JSON.stringify({
        agent: "./agent.md",
        skills: ["./shared.md"],
        baselineSkills: [],
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(loadCompareConfig(join(dir, "empty-baseline-with-shared.json")).baselineSkills).toEqual([]);

    // Omitting the key entirely is a different failure than supplying `[]`:
    // a typo'd or forgotten key must not silently become a no-skill baseline.
    writeFileSync(
      join(dir, "omitted-baseline.json"),
      JSON.stringify({
        agent: "./agent.md",
        proposedSkills: ["./proposed.md"],
        model: "sonnet",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "omitted-baseline.json"))).toThrow(/baseline skill paths/);

    // A compare with nothing proposed is meaningless even when the baseline is empty.
    writeFileSync(
      join(dir, "empty-proposed.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: [],
        proposedSkills: [],
        model: "sonnet",
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "empty-proposed.json"))).toThrow("compare requires at least one proposed skill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function toolsRecordingRunner(sandboxTools: boolean, toolsSeen: string[]): Runner {
  return {
    name: sandboxTools ? "claude-p" : "openai",
    capabilities: { sandboxTools, skillRegistry: sandboxTools, images: false, streamEvents: false },
    async run(options: RunnerRunOptions) {
      toolsSeen.push(options.tools);
      return { output: "ok", costUsd: 0, turns: 1, durationMs: 1, models: [options.model], raw: {} };
    },
  };
}

async function toolsSeenBy(config: CompareConfig, sandboxTools: boolean): Promise<string[]> {
  const toolsSeen: string[] = [];
  const runner = toolsRecordingRunner(sandboxTools, toolsSeen);
  await runCompare({ config, runners: { baseline: runner, proposed: runner } });
  return toolsSeen;
}

test('scenario "tools": "" means no tools, the same as --tools ""', async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-empty-tools-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "baseline.md"), "Baseline", "utf8");
    writeFileSync(join(dir, "proposed.md"), "Proposed", "utf8");
    const base = {
      agent: "./agent.md",
      baselineSkills: ["./baseline.md"],
      proposedSkills: ["./proposed.md"],
      model: "gpt-4o-mini",
      runner: "openai",
      runs: 1,
      sandbox: { root: "./runs" },
    };
    const textCase = { name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } };

    // The shape from issue #37: top-level text mode with an explicit empty tools list.
    writeFileSync(join(dir, "top-level.json"), JSON.stringify({ ...base, mode: "text", tools: "", scenarios: [textCase] }), "utf8");
    writeFileSync(join(dir, "no-tools-key.json"), JSON.stringify({ ...base, mode: "text", scenarios: [textCase] }), "utf8");
    const fromJson = loadCompareConfig(join(dir, "top-level.json"));
    const fromFlag = loadCompareConfig(join(dir, "no-tools-key.json"), { tools: "" });
    expect(fromJson.tools).toBe("");
    expect(fromJson.tools).toBe(fromFlag.tools!);
    // Runs on a text-only runner with no tools, exactly as the flag does.
    expect(await toolsSeenBy(fromJson, false)).toEqual(["", ""]);
    expect(await toolsSeenBy(fromFlag, false)).toEqual(["", ""]);

    // "" must not read as unset: artifact mode would otherwise fall back to "default".
    writeFileSync(
      join(dir, "artifact.json"),
      JSON.stringify({ ...base, runner: "claude-p", tools: "", scenarios: [{ ...textCase, mode: "artifact" }] }),
      "utf8",
    );
    expect(await toolsSeenBy(loadCompareConfig(join(dir, "artifact.json")), true)).toEqual(["", ""]);

    // A per-scenario "" overrides a top-level tools list, so the text-only runner accepts it.
    writeFileSync(
      join(dir, "per-case.json"),
      JSON.stringify({ ...base, tools: "Bash,Read", scenarios: [{ ...textCase, tools: "" }] }),
      "utf8",
    );
    const perCase = loadCompareConfig(join(dir, "per-case.json"));
    expect(perCase.cases[0]?.tools).toBe("");
    expect(await toolsSeenBy(perCase, false)).toEqual(["", ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a non-string tools value fails with a message naming the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-config-bad-tools-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    writeFileSync(join(dir, "baseline.md"), "Baseline", "utf8");
    writeFileSync(join(dir, "proposed.md"), "Proposed", "utf8");
    const base = {
      agent: "./agent.md",
      baselineSkills: ["./baseline.md"],
      proposedSkills: ["./proposed.md"],
      model: "sonnet",
    };
    const textCase = { name: "t", prompt: "p", grader: { type: "text", contains: ["ok"] } };

    writeFileSync(join(dir, "top-level.json"), JSON.stringify({ ...base, tools: ["Bash"], scenarios: [textCase] }), "utf8");
    expect(() => loadCompareConfig(join(dir, "top-level.json"))).toThrow(/^tools must be a string/);

    writeFileSync(join(dir, "per-case.json"), JSON.stringify({ ...base, scenarios: [{ ...textCase, tools: false }] }), "utf8");
    expect(() => loadCompareConfig(join(dir, "per-case.json"))).toThrow(/^t\.tools must be a string/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
