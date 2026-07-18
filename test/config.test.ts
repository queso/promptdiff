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
