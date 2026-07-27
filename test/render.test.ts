import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { runCompare } from "../src/engine/compare";
import { loadCompareConfig } from "../src/engine/config";
import { placeholderNames, renderStrict, resolveRenderVars } from "../src/engine/render";
import type { Runner, RunnerRunOptions } from "../src/types";

test("renderStrict substitutes {{name}} placeholders, tolerating inner whitespace", () => {
  const vars = { draft: "DRAFT BODY", voice: "VOICE" };
  expect(renderStrict("a {{draft}} b {{ voice }} c {{draft}}", vars, "t")).toBe(
    "a DRAFT BODY b VOICE c DRAFT BODY",
  );
});

test("renderStrict fails on unbound placeholders, listing every missing name once", () => {
  expect(() => renderStrict("{{draft}} {{voice}} {{draft}}", { voice: "v" }, "baseline system prompt")).toThrow(
    /unbound template placeholder\(s\) in baseline system prompt: \{\{draft\}\} — bind them in render\.vars/,
  );
  expect(() => renderStrict("{{a}} {{b}}", {}, "t")).toThrow(/\{\{a\}\}, \{\{b\}\}/);
});

test("renderStrict never re-scans substituted content", () => {
  // A fixture draft that itself contains {{braces}} must not trip the unbound
  // check or expand recursively.
  const rendered = renderStrict("{{draft}}", { draft: "uses {{curly}} syntax", curly: "WRONG" }, "t");
  expect(rendered).toBe("uses {{curly}} syntax");
});

test("resolveRenderVars reads file values and passes literals through", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-render-vars-"));
  try {
    writeFileSync(join(dir, "draft.md"), "file contents", "utf8");
    const vars = resolveRenderVars({ draft: "./draft.md", tone: "casual" }, dir, "render.vars");
    expect(vars.draft).toBe("file contents");
    expect(vars.tone).toBe("casual");
    expect(() => resolveRenderVars({ n: 3 as unknown as string }, dir, "render.vars")).toThrow(
      /render\.vars\.n must be a string/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("placeholderNames dedupes and ignores malformed braces", () => {
  expect(placeholderNames("{{a}} {{ b }} {{a}} {not one} {{}}")).toEqual(["a", "b"]);
});

function writeScenarioFixture(dir: string): void {
  writeFileSync(join(dir, "agent.md"), "Review the draft.", "utf8");
  writeFileSync(join(dir, "editorial.md"), "GATE({{draft}}|{{voice}})", "utf8");
  writeFileSync(join(dir, "editorial.v2.md"), "GATE2({{draft}}|{{voice}})", "utf8");
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  writeFileSync(join(dir, "fixtures", "draft-a.md"), "DRAFT_A", "utf8");
  writeFileSync(join(dir, "fixtures", "draft-b.md"), "DRAFT_B", "utf8");
}

test("loadCompareConfig resolves render vars at both levels and rejects render with install delivery", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-render-config-"));
  try {
    writeScenarioFixture(dir);
    writeFileSync(
      join(dir, "scenario.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./editorial.md"],
        proposedSkills: ["./editorial.v2.md"],
        model: "sonnet",
        render: { vars: { voice: "PERSONAL" } },
        scenarios: [
          {
            name: "scope",
            kind: "target",
            prompt: "Gate it.",
            render: { vars: { draft: "./fixtures/draft-a.md" } },
            grader: { type: "text", contains: ["ok"] },
          },
        ],
      }),
      "utf8",
    );

    const config = loadCompareConfig(join(dir, "scenario.json"));
    expect(config.renderVars).toEqual({ voice: "PERSONAL" });
    expect(config.cases[0]?.renderVars).toEqual({ draft: "DRAFT_A" });

    writeFileSync(
      join(dir, "install.json"),
      JSON.stringify({
        agent: "./agent.md",
        baselineSkills: ["./editorial.md"],
        proposedSkills: ["./editorial.v2.md"],
        model: "sonnet",
        delivery: "install",
        render: { vars: { voice: "PERSONAL" } },
        scenarios: [{ name: "t", prompt: "p", grader: { type: "text", contains: ["x"] } }],
      }),
      "utf8",
    );
    expect(() => loadCompareConfig(join(dir, "install.json"))).toThrow(/copies skill files verbatim/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCompare renders per-case vars into both arms and fails unbound before any paid run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-render-compare-"));
  try {
    writeScenarioFixture(dir);
    const seenPrompts: Array<{ system: string; user: string }> = [];
    const runner: Runner = {
      name: "mock",
      capabilities: { sandboxTools: true, skillRegistry: true, images: false },
      async run(options: RunnerRunOptions) {
        seenPrompts.push({ system: options.systemPrompt, user: options.userPrompt });
        return { output: "ok", costUsd: 0, turns: 1, durationMs: 1, models: ["m"], raw: {} };
      },
    };

    const scenario = {
      agent: "./agent.md",
      baselineSkills: ["./editorial.md"],
      proposedSkills: ["./editorial.v2.md"],
      model: "sonnet",
      runs: 1,
      render: { vars: { voice: "PERSONAL" } },
      scenarios: [
        {
          name: "case-a",
          kind: "compare",
          prompt: "Gate {{draft}}.",
          render: { vars: { draft: "./fixtures/draft-a.md" } },
          grader: { type: "text", contains: ["ok"] },
        },
        {
          name: "case-b",
          kind: "compare",
          prompt: "Gate it.",
          render: { vars: { draft: "./fixtures/draft-b.md" } },
          grader: { type: "text", contains: ["ok"] },
        },
      ],
    };
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario), "utf8");
    const config = loadCompareConfig(join(dir, "scenario.json"), { sandboxRoot: join(dir, "runs") });

    await runCompare({ config, runners: { baseline: runner, proposed: runner } });
    // case-a: baseline + proposed; case-b: baseline + proposed.
    expect(seenPrompts).toHaveLength(4);
    expect(seenPrompts[0]?.system).toContain("GATE(DRAFT_A|PERSONAL)");
    expect(seenPrompts[0]?.user).toBe("Gate DRAFT_A.");
    expect(seenPrompts[1]?.system).toContain("GATE2(DRAFT_A|PERSONAL)");
    expect(seenPrompts[2]?.system).toContain("GATE(DRAFT_B|PERSONAL)");
    expect(seenPrompts.every(({ system }) => !system.includes("{{"))).toBe(true);

    // An unbound placeholder in the SECOND case must fail before the first
    // case spends anything.
    const broken = {
      ...scenario,
      scenarios: [scenario.scenarios[0], { ...scenario.scenarios[1], render: { vars: {} } }],
    };
    writeFileSync(join(dir, "broken.json"), JSON.stringify(broken), "utf8");
    const brokenConfig = loadCompareConfig(join(dir, "broken.json"), { sandboxRoot: join(dir, "runs") });
    seenPrompts.length = 0;
    await expect(
      runCompare({ config: brokenConfig, runners: { baseline: runner, proposed: runner } }),
    ).rejects.toThrow(/unbound template placeholder\(s\) in scenario "case-b"/);
    expect(seenPrompts).toHaveLength(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
