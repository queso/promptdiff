import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ArmConfig } from "./config";
import type { ArmSummary, CompareSummary } from "./compare";

/**
 * One NDJSON record per scenario per invocation, append-only: durable,
 * greppable history that can answer "has the catch rate drifted" without
 * hand-transcribing summaries into READMEs.
 */
export function buildReportRecords(summary: CompareSummary, timestamp: string): Array<Record<string, unknown>> {
  return summary.cases.map((caseSummary) => ({
    ts: timestamp,
    comparison: summary.name,
    scenario: caseSummary.name,
    kind: caseSummary.kind,
    baseline: armRecord(caseSummary.baseline, summary.arms.baseline),
    proposed: armRecord(caseSummary.proposed, summary.arms.proposed),
    deltaPassRate: caseSummary.proposed.passRate - caseSummary.baseline.passRate,
    samplingP: caseSummary.samplingP,
    failedAssertions: caseSummary.assertions,
    passed: caseSummary.assertions.length === 0,
    promptSha256: caseSummary.promptSha256,
    productionModel: summary.productionModel,
  }));
}

export function appendNdjsonReport(
  path: string,
  summary: CompareSummary,
  timestamp = new Date().toISOString(),
): number {
  const records = buildReportRecords(summary, timestamp);
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, records.map((record) => JSON.stringify(record) + "\n").join(""), "utf8");
  return records.length;
}

function armRecord(arm: ArmSummary, config: ArmConfig): Record<string, unknown> {
  return {
    model: config.model,
    runner: config.runner,
    passes: arm.passes,
    totalRuns: arm.totalRuns,
    passRate: arm.passRate,
    costUsd: arm.totalCostUsd,
  };
}
