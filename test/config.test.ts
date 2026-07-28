import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadCompareConfig } from "../src/engine/config";

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
