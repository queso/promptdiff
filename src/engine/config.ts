import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GraderSpec } from "./grader";
import { deliveryValue, type Delivery } from "./skill-install";
import type { RunMode } from "../types";

export type ScenarioKind = "target" | "regression";

export interface EvalCaseConfig {
  name: string;
  kind: ScenarioKind;
  prompt: string;
  grader: GraderSpec;
  runs?: number;
  seed?: string;
  addDirs: string[];
  mode?: RunMode;
  tools?: string;
}

export interface CompareConfig {
  name: string;
  agent: string;
  baselineSkills: string[];
  proposedSkills: string[];
  delivery: Delivery;
  model: string;
  runs: number;
  timeoutMs: number;
  maxBudgetUsd: number;
  mode?: RunMode;
  tools?: string;
  addDirs: string[];
  sandboxRoot: string;
  sandboxSeed?: string;
  keepSandbox: boolean;
  cases: EvalCaseConfig[];
}

export interface CompareOverrides {
  agent?: string;
  baselineSkills?: string[];
  proposedSkills?: string[];
  delivery?: Delivery;
  model?: string;
  runs?: number;
  timeoutMs?: number;
  maxBudgetUsd?: number;
  mode?: RunMode;
  tools?: string;
  addDirs?: string[];
  sandboxRoot?: string;
  sandboxSeed?: string;
  keepSandbox?: boolean;
}

interface RawCompareConfig {
  name?: unknown;
  agent?: unknown;
  baselineSkills?: unknown;
  proposedSkills?: unknown;
  baseline?: unknown;
  proposed?: unknown;
  delivery?: unknown;
  model?: unknown;
  runs?: unknown;
  timeoutMs?: unknown;
  maxBudgetUsd?: unknown;
  mode?: unknown;
  tools?: unknown;
  addDirs?: unknown;
  sandbox?: unknown;
  prompt?: unknown;
  promptFile?: unknown;
  grader?: unknown;
  scenarios?: unknown;
}

interface RawCase {
  name?: unknown;
  kind?: unknown;
  prompt?: unknown;
  promptFile?: unknown;
  grader?: unknown;
  runs?: unknown;
  seed?: unknown;
  addDirs?: unknown;
  mode?: unknown;
  tools?: unknown;
}

export function loadCompareConfig(path: string, overrides: CompareOverrides = {}): CompareConfig {
  const configPath = resolve(path);
  const baseDir = dirname(configPath);
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as RawCompareConfig;

  const baselineSkills = overrides.baselineSkills ?? normalizeSkills(raw.baselineSkills ?? raw.baseline, "baseline");
  const proposedSkills = overrides.proposedSkills ?? normalizeSkills(raw.proposedSkills ?? raw.proposed, "proposed");

  const rawSandbox = isRecord(raw.sandbox) ? raw.sandbox : {};
  const sandboxRoot = overrides.sandboxRoot ?? resolveFrom(baseDir, stringValue(rawSandbox.root, ".skill-eval/runs"));
  const sandboxSeed =
    overrides.sandboxSeed ??
    optionalPath(baseDir, stringValue(rawSandbox.seed, undefined));

  const topLevelCase = raw.prompt !== undefined || raw.promptFile !== undefined || raw.grader !== undefined;
  const rawCases = Array.isArray(raw.scenarios)
    ? raw.scenarios
    : topLevelCase
      ? [{ name: raw.name, prompt: raw.prompt, promptFile: raw.promptFile, grader: raw.grader }]
      : [];

  if (rawCases.length === 0) {
    throw new Error("compare scenario must define `scenarios` or top-level `prompt` + `grader`");
  }

  const config: CompareConfig = {
    name: stringValue(raw.name, "skill-eval comparison"),
    agent: resolveRequired(baseDir, overrides.agent ?? stringValue(raw.agent, undefined), "agent"),
    baselineSkills: baselineSkills.map((skill) => resolveFrom(baseDir, skill)),
    proposedSkills: proposedSkills.map((skill) => resolveFrom(baseDir, skill)),
    delivery: overrides.delivery ?? deliveryValue(raw.delivery, "inline"),
    model: overrides.model ?? requiredString(raw.model, "model"),
    runs: overrides.runs ?? numberValue(raw.runs, 5),
    timeoutMs: overrides.timeoutMs ?? numberValue(raw.timeoutMs, 600_000),
    maxBudgetUsd: overrides.maxBudgetUsd ?? numberValue(raw.maxBudgetUsd, 1),
    mode: overrides.mode ?? modeValue(raw.mode, undefined),
    tools: overrides.tools ?? stringValue(raw.tools, undefined),
    addDirs: (overrides.addDirs ?? stringArray(raw.addDirs, "addDirs")).map((dir) => resolveFrom(baseDir, dir)),
    sandboxRoot,
    sandboxSeed,
    keepSandbox: overrides.keepSandbox ?? booleanValue(rawSandbox.keep, false),
    cases: rawCases.map((rawCase, index) => normalizeCase(baseDir, recordValue(rawCase, `scenarios[${index}]`), index)),
  };

  validateCompareConfig(config);
  return config;
}

function normalizeCase(baseDir: string, raw: RawCase, index: number): EvalCaseConfig {
  const name = stringValue(raw.name, `scenario-${index + 1}`);
  const prompt = raw.promptFile
    ? readFileSync(resolveFrom(baseDir, requiredString(raw.promptFile, `${name}.promptFile`)), "utf8")
    : requiredString(raw.prompt, `${name}.prompt`);
  return {
    name,
    kind: kindValue(raw.kind, index === 0 ? "target" : "regression"),
    prompt,
    grader: graderValue(raw.grader, name),
    runs: optionalNumber(raw.runs, `${name}.runs`),
    seed: optionalPath(baseDir, stringValue(raw.seed, undefined)),
    addDirs: stringArray(raw.addDirs, `${name}.addDirs`).map((dir) => resolveFrom(baseDir, dir)),
    mode: modeValue(raw.mode, undefined),
    tools: stringValue(raw.tools, undefined),
  };
}

function validateCompareConfig(config: CompareConfig): void {
  if (config.baselineSkills.length === 0) {
    throw new Error("compare requires at least one baseline skill");
  }
  if (config.proposedSkills.length === 0) {
    throw new Error("compare requires at least one proposed skill");
  }
  if (config.runs < 1) {
    throw new Error("runs must be at least 1");
  }
  if (config.timeoutMs < 1) {
    throw new Error("timeoutMs must be positive");
  }
  if (config.maxBudgetUsd <= 0) {
    throw new Error("maxBudgetUsd must be positive");
  }
  for (const evalCase of config.cases) {
    if (evalCase.runs !== undefined && evalCase.runs < 1) {
      throw new Error(`${evalCase.name}.runs must be at least 1`);
    }
  }
  if (config.delivery === "install") {
    if (config.tools === "" || config.cases.some((evalCase) => evalCase.tools === "")) {
      throw new Error('delivery "install" needs tools enabled: skills are invoked via the Skill tool, so tools "" can never trigger them');
    }
  }
}

function normalizeSkills(value: unknown, label: string): string[] {
  if (Array.isArray(value)) return value.map((item) => requiredString(item, `${label} skill`));
  if (isRecord(value) && Array.isArray(value.skills)) {
    return value.skills.map((item) => requiredString(item, `${label}.skills item`));
  }
  throw new Error(`compare requires ${label} skill paths`);
}

function graderValue(value: unknown, scenarioName: string): GraderSpec {
  if (!isRecord(value)) {
    throw new Error(`${scenarioName}.grader must be an object`);
  }
  if (value.type === "text") {
    const regex = stringArray(value.regex, `${scenarioName}.grader.regex`);
    for (const pattern of regex) {
      try {
        new RegExp(pattern);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Validate up front — a bad pattern must fail here, not after a paid run.
        throw new Error(`${scenarioName}.grader.regex ${JSON.stringify(pattern)} is not a valid JS regex (${reason}); note inline flags like (?i) are unsupported`);
      }
    }
    return {
      type: "text",
      contains: stringArray(value.contains, `${scenarioName}.grader.contains`),
      notContains: stringArray(value.notContains, `${scenarioName}.grader.notContains`),
      regex,
    };
  }
  if (value.type === "command") {
    return {
      type: "command",
      command: requiredString(value.command, `${scenarioName}.grader.command`),
      cwd: stringValue(value.cwd, undefined),
      timeoutMs: optionalNumber(value.timeoutMs, `${scenarioName}.grader.timeoutMs`),
      expectExitCode: optionalNumber(value.expectExitCode, `${scenarioName}.grader.expectExitCode`),
    };
  }
  throw new Error(`${scenarioName}.grader.type must be "text" or "command"`);
}

function kindValue(value: unknown, fallback: ScenarioKind): ScenarioKind {
  if (value === undefined) return fallback;
  if (value === "target" || value === "regression") return value;
  throw new Error(`scenario kind must be "target" or "regression"`);
}

function modeValue(value: unknown, fallback: RunMode | undefined): RunMode | undefined {
  if (value === undefined) return fallback;
  if (value === "text" || value === "artifact") return value;
  throw new Error(`mode must be "text" or "artifact"`);
}

function stringValue(value: unknown, fallback: string): string;
function stringValue(value: unknown, fallback: string | undefined): string | undefined;
function stringValue(value: unknown, fallback: string | undefined): string | undefined {
  if (value === undefined) return fallback;
  return requiredString(value, "string value");
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  return value.map((item) => requiredString(item, `${label} item`));
}

function numberValue(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`expected number`);
  }
  return parsed;
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw new Error("boolean value expected");
  }
  return value;
}

function resolveRequired(baseDir: string, value: string | undefined, label: string): string {
  if (!value) throw new Error(`${label} is required`);
  return resolveFrom(baseDir, value);
}

function optionalPath(baseDir: string, value: string | undefined): string | undefined {
  return value ? resolveFrom(baseDir, value) : undefined;
}

function resolveFrom(baseDir: string, path: string): string {
  return resolve(baseDir, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordValue(value: unknown, label: string): RawCase {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
