import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { CompareSummary } from "../src/engine/compare";
import { appendNdjsonReport, buildReportRecords } from "../src/engine/report";

function makeSummary(): CompareSummary {
  return {
    name: "editorial gate",
    arms: {
      baseline: { model: "sonnet", runner: "claude-p", baseUrl: undefined },
      proposed: { model: "llama3.1", runner: "openai", baseUrl: "http://localhost:11434/v1" },
    },
    productionModel: "gpt-5.5",
    cases: [
      {
        name: "scope",
        kind: "target",
        baseline: { name: "baseline", passes: 0, totalRuns: 3, passRate: 0, totalCostUsd: 0.85, runs: [] },
        proposed: { name: "proposed", passes: 2, totalRuns: 3, passRate: 2 / 3, totalCostUsd: 1.76, runs: [] },
        assertions: [],
        samplingP: 0.4,
        promptSha256: { baseline: "a".repeat(64), proposed: "b".repeat(64) },
      },
    ],
    failedAssertions: [],
    totalCostUsd: 2.61,
  };
}

test("buildReportRecords emits one complete record per scenario", () => {
  const records = buildReportRecords(makeSummary(), "2026-07-28T00:00:00.000Z");
  expect(records).toHaveLength(1);
  const record = records[0] as Record<string, any>;
  expect(record.ts).toBe("2026-07-28T00:00:00.000Z");
  expect(record.scenario).toBe("scope");
  expect(record.baseline).toEqual({
    model: "sonnet", runner: "claude-p", passes: 0, totalRuns: 3, passRate: 0, costUsd: 0.85,
  });
  expect(record.proposed.model).toBe("llama3.1");
  expect(record.deltaPassRate).toBeCloseTo(2 / 3);
  expect(record.samplingP).toBe(0.4);
  expect(record.passed).toBe(true);
  expect(record.promptSha256.baseline).toBe("a".repeat(64));
  expect(record.productionModel).toBe("gpt-5.5");
});

test("appendNdjsonReport appends across invocations and creates parent dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-report-"));
  try {
    const out = join(dir, "nested", "runs.ndjson");
    expect(appendNdjsonReport(out, makeSummary(), "t1")).toBe(1);
    expect(appendNdjsonReport(out, makeSummary(), "t2")).toBe(1);

    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed[0]?.ts).toBe("t1");
    expect(parsed[1]?.ts).toBe("t2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
