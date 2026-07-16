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
    expect(config.runner).toBe("claude-p");
    expect(loadCompareConfig(join(dir, "scenario.json"), { runner: "openai" }).runner).toBe("openai");

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
    expect(openaiConfig.runner).toBe("openai");
    expect(openaiConfig.baseUrl).toBe("http://localhost:11434/v1");

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
