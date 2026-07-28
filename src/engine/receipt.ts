import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CompareConfig } from "./config";
import type { CompareSummary, MeasureSummary } from "./compare";

/**
 * A receipt asserts "the prompt with THIS content hash produced THIS eval
 * result" — the content-addressed replacement for hand-maintained
 * prompt_version strings. A consuming repo's CI can check that every prompt
 * it ships has a passing receipt for its current hash; editing the prompt
 * changes the hash and stales the receipt, naming the scenario to re-run.
 */
export interface PromptDigest {
  path: string;
  sha256: string;
}

export interface Receipt {
  comparison: string;
  scenario: string;
  kind: string;
  command: "compare" | "measure";
  ranAt: string;
  verdict: "pass" | "fail" | "none" | "measured";
  prompts: {
    agent: PromptDigest;
    baselineSkills?: PromptDigest[];
    proposedSkills?: PromptDigest[];
    skills?: PromptDigest[];
  };
  /** Hash of the rendered system prompt(s) — also pins render-var fixtures. */
  renderedPromptSha256?: unknown;
  results: Record<string, { passes: number; totalRuns: number; passRate: number; costUsd: number }>;
  samplingP?: number;
  productionModel?: string;
}

export function buildCompareReceipts(
  summary: CompareSummary,
  config: CompareConfig,
  timestamp: string,
): Receipt[] {
  const agent = digestPath(config.agent);
  const baselineSkills = config.baselineSkills.map(digestPath);
  const proposedSkills = config.proposedSkills.map(digestPath);

  return summary.cases.map((caseSummary) => ({
    comparison: summary.name,
    scenario: caseSummary.name,
    kind: caseSummary.kind,
    command: "compare",
    ranAt: timestamp,
    // "compare" kind carries no directional claim, so its receipt cannot say pass.
    verdict:
      caseSummary.assertions.length > 0 ? "fail" : caseSummary.kind === "compare" ? "none" : "pass",
    prompts: { agent, baselineSkills, proposedSkills },
    renderedPromptSha256: caseSummary.promptSha256,
    results: {
      baseline: armResult(caseSummary.baseline),
      proposed: armResult(caseSummary.proposed),
    },
    samplingP: caseSummary.samplingP,
    productionModel: summary.productionModel,
  }));
}

export function buildMeasureReceipts(
  summary: MeasureSummary,
  config: CompareConfig,
  timestamp: string,
): Receipt[] {
  const agent = digestPath(config.agent);
  const skills = config.baselineSkills.map(digestPath);

  return summary.cases.map((caseSummary) => ({
    comparison: summary.name,
    scenario: caseSummary.name,
    kind: caseSummary.kind,
    command: "measure",
    ranAt: timestamp,
    verdict: "measured",
    prompts: { agent, skills },
    renderedPromptSha256: caseSummary.promptSha256,
    results: { measured: armResult(caseSummary.result) },
    productionModel: summary.productionModel,
  }));
}

/**
 * Writes one `<scenario-slug>.receipt.json` per receipt, overwriting — a
 * receipt is current state; append-only history is `--report ndjson`'s job.
 * Returns the written paths.
 */
export function writeReceipts(dir: string, receipts: Receipt[]): string[] {
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  return receipts.map((receipt) => {
    const path = join(target, `${slug(receipt.scenario)}.receipt.json`);
    writeFileSync(path, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    return path;
  });
}

function armResult(arm: { passes: number; totalRuns: number; passRate: number; totalCostUsd: number }) {
  return { passes: arm.passes, totalRuns: arm.totalRuns, passRate: arm.passRate, costUsd: arm.totalCostUsd };
}

/** Repo-relative path + content hash; install-delivery skill dirs get a deterministic tree hash. */
function digestPath(absolutePath: string): PromptDigest {
  return { path: relative(process.cwd(), absolutePath), sha256: hashPath(absolutePath) };
}

/** Content hash of a prompt file, or a deterministic tree hash for a skill directory. */
export function contentHash(path: string): string {
  return hashPath(path);
}

function hashPath(path: string): string {
  if (!statSync(path).isDirectory()) {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  // Directory (install-delivery skill): hash every file, sorted by relative
  // path, so any supporting-file edit stales the receipt too.
  const hash = createHash("sha256");
  for (const entry of walkSorted(path, path)) {
    hash.update(entry);
    hash.update("\0");
    hash.update(readFileSync(join(path, entry)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function walkSorted(root: string, dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      entries.push(...walkSorted(root, full));
    } else {
      entries.push(relative(root, full));
    }
  }
  return entries;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "scenario";
}
