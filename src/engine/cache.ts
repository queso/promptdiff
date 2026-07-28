import { createHash, type Hash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArmSummary } from "./compare";
import type { ArmConfig } from "./config";
import type { GraderSpec } from "./grader";
import type { Delivery } from "./skill-install";
import type { RunMode } from "../types";

/**
 * Everything that could change a baseline arm's outcome for one case. The key
 * hashes CONTENT (rendered prompts, fixture bytes), not paths — moving a
 * scenario file must not fake a miss, and editing a fixture must not fake a hit.
 */
export interface CacheKeyInput {
  /** Rendered baseline system prompt — covers agent text, inlined skill text, and render vars. */
  systemPrompt: string;
  /** Rendered case prompt. */
  casePrompt: string;
  arm: ArmConfig;
  /** Effective run count for the case (case runs ?? config runs). */
  runs: number;
  /** Effective tools string for the case. */
  tools: string;
  /** Effective run mode for the case. */
  mode: RunMode;
  delivery: Delivery;
  grader: GraderSpec;
  /** Per-case image file paths; their CONTENTS are hashed into the key. */
  images: string[];
  /** Effective sandbox seed directory (case seed ?? config seed), if any. */
  seedDir?: string;
  /**
   * Baseline skill paths. Install delivery copies these verbatim instead of
   * inlining them, so the system prompt does NOT cover their text — their
   * tree hashes enter the key only when delivery is "install".
   */
  baselineSkills: string[];
}

interface CacheRecord {
  key: string;
  createdAt: string;
  armSummary: ArmSummary;
}

export function buildCacheKey(input: CacheKeyInput): string {
  const material = stableStringify({
    version: 1,
    systemPrompt: input.systemPrompt,
    casePrompt: input.casePrompt,
    model: input.arm.model,
    runner: input.arm.runner,
    baseUrl: input.arm.baseUrl ?? "none",
    runs: input.runs,
    tools: input.tools,
    mode: input.mode,
    delivery: input.delivery,
    grader: input.grader,
    images: input.images.map((image) => sha256(readFileSync(image))),
    seedTree: input.seedDir === undefined ? "none" : hashTree(input.seedDir),
    baselineSkillTrees: input.delivery === "install" ? input.baselineSkills.map(hashTree) : [],
  });
  return sha256(material);
}

/** Stored summary for the key, or undefined on a miss. */
export function loadCachedArm(cacheDir: string, key: string): ArmSummary | undefined {
  const file = entryPath(cacheDir, key);
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`cache entry is not valid JSON: ${file} — delete it (or the cache dir) and re-run`);
  }
  if (!isCacheRecord(parsed)) {
    throw new Error(`cache entry has an unexpected shape: ${file} — delete it (or the cache dir) and re-run`);
  }
  return parsed.armSummary;
}

export function storeCachedArm(cacheDir: string, key: string, armSummary: ArmSummary): void {
  mkdirSync(cacheDir, { recursive: true });
  const record: CacheRecord = { key, createdAt: new Date().toISOString(), armSummary };
  writeFileSync(entryPath(cacheDir, key), JSON.stringify(record, null, 2) + "\n", "utf8");
}

function entryPath(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}

function isCacheRecord(value: unknown): value is CacheRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.key !== "string" || typeof record.createdAt !== "string") return false;
  const summary = record.armSummary;
  if (typeof summary !== "object" || summary === null) return false;
  const arm = summary as Record<string, unknown>;
  return (
    arm.name === "baseline" &&
    typeof arm.passes === "number" &&
    typeof arm.totalRuns === "number" &&
    typeof arm.passRate === "number" &&
    typeof arm.totalCostUsd === "number" &&
    Array.isArray(arm.runs)
  );
}

/**
 * Deterministic content hash of a fixture tree: sorted relative paths plus
 * file bytes. Accepts a lone file too (a baseline "skill" may be a SKILL.md
 * path rather than a directory).
 */
function hashTree(path: string): string {
  const hash = createHash("sha256");
  addTreeEntry(hash, path, "");
  return hash.digest("hex");
}

function addTreeEntry(hash: Hash, path: string, relative: string): void {
  if (statSync(path).isDirectory()) {
    for (const entry of [...readdirSync(path)].sort()) {
      addTreeEntry(hash, join(path, entry), relative === "" ? entry : `${relative}/${entry}`);
    }
    return;
  }
  hash.update(`${relative}\0`);
  hash.update(readFileSync(path));
  hash.update("\0");
}

/** JSON with recursively sorted object keys — key material must not depend on property order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, entry]) => `${JSON.stringify(name)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
