import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "bun:test";
import { runCompare, runMeasure } from "../src/engine/compare";
import { loadCompareConfig } from "../src/engine/config";
import { buildCompareReceipts, buildMeasureReceipts, contentHash, writeReceipts, type Receipt } from "../src/engine/receipt";
import type { Runner, RunnerRunOptions } from "../src/types";

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function mockRunner(decide: (options: RunnerRunOptions) => string): Runner {
  return {
    name: "mock",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false },
    async run(options: RunnerRunOptions) {
      return { output: decide(options), costUsd: 0.1, turns: 1, durationMs: 5, models: ["m"], raw: {} };
    },
  };
}

function writeFixture(dir: string): void {
  writeFileSync(join(dir, "agent.md"), "AGENT BODY", "utf8");
  writeFileSync(join(dir, "baseline.md"), "BASELINE SKILL", "utf8");
  writeFileSync(join(dir, "proposed.md"), "PROPOSED SKILL", "utf8");
  writeFileSync(
    join(dir, "scenario.json"),
    JSON.stringify({
      name: "receipt suite",
      agent: "./agent.md",
      baselineSkills: ["./baseline.md"],
      proposedSkills: ["./proposed.md"],
      model: "sonnet",
      runs: 2,
      productionModel: "gpt-5.5",
      scenarios: [
        { name: "Target Case!", kind: "target", prompt: "do it", grader: { type: "text", contains: ["PROPOSED"] } },
        { name: "no-claim", kind: "compare", prompt: "meh", grader: { type: "text", contains: ["never"] } },
      ],
    }),
    "utf8",
  );
}

test("compare receipts carry per-file hashes, verdicts, and results", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-receipt-"));
  try {
    writeFixture(dir);
    const config = loadCompareConfig(join(dir, "scenario.json"), { sandboxRoot: join(dir, "runs") });
    const runner = mockRunner((options) => (options.systemPrompt.includes("PROPOSED SKILL") ? "PROPOSED" : "nope"));
    const summary = await runCompare({ config, runners: { baseline: runner, proposed: runner } });

    const receipts = buildCompareReceipts(summary, config, "2026-07-28T02:00:00.000Z");
    expect(receipts).toHaveLength(2);

    const target = receipts[0] as Receipt;
    // Target passed: baseline 0/2 (gap reproduced), proposed 2/2.
    expect(target.verdict).toBe("pass");
    expect(target.results.baseline?.passes).toBe(0);
    expect(target.results.proposed?.passes).toBe(2);
    expect(target.prompts.agent.sha256).toBe(sha256("AGENT BODY"));
    expect(target.prompts.agent.path).toBe(relative(process.cwd(), join(dir, "agent.md")));
    expect(target.prompts.proposedSkills?.[0]?.sha256).toBe(sha256("PROPOSED SKILL"));
    expect(target.prompts.baselineSkills?.[0]?.sha256).toBe(sha256("BASELINE SKILL"));
    expect(target.productionModel).toBe("gpt-5.5");

    // "compare" kind makes no directional claim — its receipt can't say pass.
    expect((receipts[1] as Receipt).verdict).toBe("none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeReceipts slugs filenames and overwrites on re-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-receipt-write-"));
  try {
    writeFixture(dir);
    const config = loadCompareConfig(join(dir, "scenario.json"), { sandboxRoot: join(dir, "runs") });
    const runner = mockRunner((options) => (options.systemPrompt.includes("PROPOSED SKILL") ? "PROPOSED" : "nope"));
    const summary = await runCompare({ config, runners: { baseline: runner, proposed: runner } });

    const out = join(dir, "receipts");
    const first = writeReceipts(out, buildCompareReceipts(summary, config, "t1"));
    const second = writeReceipts(out, buildCompareReceipts(summary, config, "t2"));
    expect(first).toEqual(second);
    expect(readdirSync(out).sort()).toEqual(["no-claim.receipt.json", "target-case.receipt.json"]);

    const parsed = JSON.parse(readFileSync(join(out, "target-case.receipt.json"), "utf8")) as Receipt;
    expect(parsed.ranAt).toBe("t2");
    expect(parsed.command).toBe("compare");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("measure receipts use verdict 'measured' with a single result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-receipt-measure-"));
  try {
    writeFileSync(join(dir, "agent.md"), "AGENT", "utf8");
    writeFileSync(join(dir, "skill.md"), "SKILL", "utf8");
    writeFileSync(
      join(dir, "measure.json"),
      JSON.stringify({
        agent: "./agent.md",
        skills: ["./skill.md"],
        model: "sonnet",
        runs: 2,
        scenarios: [{ name: "survival", prompt: "p", grader: { type: "text", contains: ["ok"] } }],
      }),
      "utf8",
    );
    const config = loadCompareConfig(join(dir, "measure.json"), { sandboxRoot: join(dir, "runs") }, { singleArm: true });
    let call = 0;
    const runner = mockRunner(() => (call++ === 0 ? "ok" : "bad"));
    const summary = await runMeasure({ config, runner });

    const receipts = buildMeasureReceipts(summary, config, "t");
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0] as Receipt;
    expect(receipt.command).toBe("measure");
    expect(receipt.verdict).toBe("measured");
    expect(receipt.results.measured?.passes).toBe(1);
    expect(receipt.prompts.skills?.[0]?.sha256).toBe(sha256("SKILL"));
    expect(receipt.prompts.baselineSkills).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("directory skills get a deterministic tree hash that any file edit changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-receipt-tree-"));
  try {
    // Install-delivery skills are directories; their receipt hash must cover
    // supporting files, not just SKILL.md.
    mkdirSync(join(dir, "skill", "sub"), { recursive: true });
    writeFileSync(join(dir, "skill", "SKILL.md"), "---\nname: s\ndescription: d\n---\nbody", "utf8");
    writeFileSync(join(dir, "skill", "sub", "helper.md"), "HELPER", "utf8");

    const before = contentHash(join(dir, "skill"));
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: same tree, same hash.
    expect(contentHash(join(dir, "skill"))).toBe(before);

    writeFileSync(join(dir, "skill", "sub", "helper.md"), "HELPER CHANGED", "utf8");
    expect(contentHash(join(dir, "skill"))).not.toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
