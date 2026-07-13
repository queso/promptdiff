import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import { loadCompareConfig, type CompareConfig } from "../src/engine/config";
import type { Runner, RunnerRunOptions } from "../src/types";

function makeSkillDir(root: string, dirName: string, name: string, marker: string): string {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${marker}\n---\n# ${marker}\n`,
    "utf8",
  );
  return dir;
}

test("install delivery puts arm skills in each sandbox registry and keeps them out of the prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-delivery-test-"));
  try {
    const agent = join(dir, "agent.md");
    writeFileSync(agent, "Agent persona", "utf8");
    const baseline = makeSkillDir(dir, "baseline-skill", "cortex", "BASELINE_MARKER");
    const proposed = makeSkillDir(dir, "proposed-skill", "cortex", "PROPOSED_MARKER");

    const seenPrompts: string[] = [];
    const runner: Runner = {
      async run(options: RunnerRunOptions) {
        seenPrompts.push(options.systemPrompt);
        expect(options.systemPromptMode).toBe("append");
        expect(options.tools).toBe("default");
        const installed = join(options.cwd, ".claude", "skills", "cortex", "SKILL.md");
        expect(existsSync(installed)).toBe(true);
        const marker = readFileSync(installed, "utf8").includes("PROPOSED_MARKER") ? "proposed" : "baseline";
        return { output: marker, costUsd: 0.1, turns: 1, durationMs: 10, models: ["sonnet"], raw: {} };
      },
    };

    const config: CompareConfig = {
      name: "install delivery",
      agent,
      baselineSkills: [baseline],
      proposedSkills: [proposed],
      delivery: "install",
      model: "sonnet",
      runs: 1,
      timeoutMs: 1_000,
      maxBudgetUsd: 1,
      addDirs: [],
      sandboxRoot: join(dir, "runs"),
      keepSandbox: false,
      cases: [
        {
          name: "target",
          kind: "target",
          prompt: "do the task",
          grader: { type: "text", contains: ["proposed"] },
          addDirs: [],
        },
      ],
    };

    const summary = await runCompare({ config, runner });
    expect(summary.cases[0]?.baseline.passRate).toBe(0);
    expect(summary.cases[0]?.proposed.passRate).toBe(1);
    // Arms differ only by the installed variant — no skill text leaks into prompts.
    for (const prompt of seenPrompts) {
      expect(prompt).not.toContain("BASELINE_MARKER");
      expect(prompt).not.toContain("PROPOSED_MARKER");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scenario files parse delivery and reject install with disabled tools", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-delivery-config-"));
  try {
    writeFileSync(join(dir, "agent.md"), "Agent", "utf8");
    makeSkillDir(dir, "baseline-skill", "cortex", "b");
    makeSkillDir(dir, "proposed-skill", "cortex", "p");
    const base = {
      agent: "./agent.md",
      baselineSkills: ["./baseline-skill"],
      proposedSkills: ["./proposed-skill"],
      model: "sonnet",
      scenarios: [{ name: "t", kind: "target", prompt: "p", grader: { type: "text", contains: ["x"] } }],
    };

    const okPath = join(dir, "ok.json");
    writeFileSync(okPath, JSON.stringify({ ...base, delivery: "install" }), "utf8");
    expect(loadCompareConfig(okPath).delivery).toBe("install");

    const defaultPath = join(dir, "default.json");
    writeFileSync(defaultPath, JSON.stringify(base), "utf8");
    expect(loadCompareConfig(defaultPath).delivery).toBe("inline");

    // The JSON parser already rejects a literal empty tools string; the CLI
    // --tools "" override is the path that can smuggle it in.
    expect(() => loadCompareConfig(okPath, { tools: "" })).toThrow(/tools enabled/);

    const badRegexPath = join(dir, "bad-regex.json");
    writeFileSync(
      badRegexPath,
      JSON.stringify({
        ...base,
        scenarios: [{ name: "t", kind: "target", prompt: "p", grader: { type: "text", regex: ["(?i)x"] } }],
      }),
      "utf8",
    );
    // Invalid patterns must fail at load time, not after a paid run.
    expect(() => loadCompareConfig(badRegexPath)).toThrow(/not a valid JS regex/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
