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
