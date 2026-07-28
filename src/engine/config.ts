import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { GraderSpec } from "./grader";
import { resolveRenderVars, type RenderVars } from "./render";
import { deliveryValue, type Delivery } from "./skill-install";
import { runnerNameValue, type RunnerName } from "../runner";
import type { RunMode } from "../types";

export type ScenarioKind = "target" | "regression" | "compare";

export interface EvalCaseConfig {
  name: string;
  kind: ScenarioKind;
  prompt: string;
  grader: GraderSpec;
  /** Image file paths attached to the user message (vision evals; openai runner only). */
  images: string[];
  /** Per-scenario template bindings; merged over the top-level set (scenario wins). */
  renderVars?: RenderVars;
  runs?: number;
  seed?: string;
  addDirs: string[];
  mode?: RunMode;
  tools?: string;
}

/** Model/runner/endpoint one arm runs against, resolved from per-arm and shared fields. */
export interface ArmConfig {
  model: string;
  runner: RunnerName;
  /** OpenAI-compatible endpoint base URL; only meaningful for the openai runner. */
  baseUrl?: string;
}

export interface CompareConfig {
  name: string;
  agent: string;
  baselineSkills: string[];
  proposedSkills: string[];
  delivery: Delivery;
  arms: { baseline: ArmConfig; proposed: ArmConfig };
  /** Extra chat-request body fields (max_tokens, temperature, ...); openai runner only. */
  requestParams?: Record<string, unknown>;
  /** Timeout retries per model call; openai runner only. Default 0. */
  retries?: number;
  /**
   * Template bindings for {{name}} placeholders in the agent, inlined skills,
   * and scenario prompts. Presence (even empty) turns on strict rendering:
   * unbound placeholders fail before any paid run.
   */
  renderVars?: RenderVars;
  /** Model that runs this prompt in production; arms testing a different model get flagged. */
  productionModel?: string;
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
  runner?: RunnerName;
  baselineRunner?: RunnerName;
  proposedRunner?: RunnerName;
  baseUrl?: string;
  model?: string;
  baselineModel?: string;
  proposedModel?: string;
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
  skills?: unknown;
  baselineSkills?: unknown;
  proposedSkills?: unknown;
  baseline?: unknown;
  proposed?: unknown;
  delivery?: unknown;
  runner?: unknown;
  baseUrl?: unknown;
  requestParams?: unknown;
  retries?: unknown;
  render?: unknown;
  model?: unknown;
  productionModel?: unknown;
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
  images?: unknown;
  render?: unknown;
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

  const sharedSkills = raw.skills === undefined ? undefined : stringArray(raw.skills, "skills");
  const rawBaseline = raw.baselineSkills ?? raw.baseline;
  const rawProposed = raw.proposedSkills ?? raw.proposed;
  const baselineSkills = overrides.baselineSkills ?? normalizeSkills(rawBaseline, "baseline", sharedSkills);
  const proposedSkills = overrides.proposedSkills ?? normalizeSkills(rawProposed, "proposed", sharedSkills);

  const rawSandbox = isRecord(raw.sandbox) ? raw.sandbox : {};
  const sandboxRoot = overrides.sandboxRoot ?? resolveFrom(baseDir, stringValue(rawSandbox.root, ".promptdiff/runs"));
  const sandboxSeed =
    overrides.sandboxSeed ??
    optionalPath(baseDir, stringValue(rawSandbox.seed, undefined));

  const topLevelCase = raw.prompt !== undefined || raw.promptFile !== undefined || raw.grader !== undefined;
  const rawCases = Array.isArray(raw.scenarios)
    ? raw.scenarios
    : topLevelCase
      ? [{ name: raw.name, prompt: raw.prompt, promptFile: raw.promptFile, grader: raw.grader, images: (raw as RawCase).images }]
      : [];

  if (rawCases.length === 0) {
    throw new Error("compare scenario must define `scenarios` or top-level `prompt` + `grader`");
  }

  const config: CompareConfig = {
    name: stringValue(raw.name, "promptdiff comparison"),
    agent: resolveRequired(baseDir, overrides.agent ?? stringValue(raw.agent, undefined), "agent"),
    baselineSkills: baselineSkills.map((skill) => resolveFrom(baseDir, skill)),
    proposedSkills: proposedSkills.map((skill) => resolveFrom(baseDir, skill)),
    delivery: overrides.delivery ?? deliveryValue(raw.delivery, "inline"),
    arms: {
      baseline: resolveArm("baseline", armRecord(rawBaseline), raw, overrides),
      proposed: resolveArm("proposed", armRecord(rawProposed), raw, overrides),
    },
    requestParams: raw.requestParams === undefined ? undefined : recordOf(raw.requestParams, "requestParams"),
    retries: raw.retries === undefined ? undefined : numberValue(raw.retries, 0),
    renderVars: renderValue(raw.render, baseDir, "render"),
    productionModel: stringValue(raw.productionModel, undefined),
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
    images: stringArray(raw.images, `${name}.images`).map((image) => resolveFrom(baseDir, image)),
    renderVars: renderValue(raw.render, baseDir, `${name}.render`),
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
    for (const image of evalCase.images) {
      // A missing image must fail at load time, not after the other arm's paid runs.
      if (!existsSync(image)) {
        throw new Error(`${evalCase.name}.images: file not found: ${image}`);
      }
    }
  }
  if (config.delivery === "install") {
    if (config.tools === "" || config.cases.some((evalCase) => evalCase.tools === "")) {
      throw new Error('delivery "install" needs tools enabled: skills are invoked via the Skill tool, so tools "" can never trigger them');
    }
    if (config.renderVars !== undefined || config.cases.some((evalCase) => evalCase.renderVars !== undefined)) {
      throw new Error('render applies to inlined prompt text; delivery "install" copies skill files verbatim, so placeholders cannot be bound');
    }
  }
}

function renderValue(value: unknown, baseDir: string, label: string): RenderVars | undefined {
  if (value === undefined) return undefined;
  const record = recordOf(value, label);
  return resolveRenderVars(recordOf(record.vars ?? {}, `${label}.vars`), baseDir, `${label}.vars`);
}

function normalizeSkills(value: unknown, label: string, sharedSkills: string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => requiredString(item, `${label} skill`));
  if (isRecord(value) && Array.isArray(value.skills)) {
    return value.skills.map((item) => requiredString(item, `${label}.skills item`));
  }
  // An arm without its own skills inherits the shared top-level set (model diffs).
  if (sharedSkills !== undefined && (value === undefined || (isRecord(value) && value.skills === undefined))) {
    return sharedSkills;
  }
  throw new Error(`compare requires ${label} skill paths`);
}

/** Resolves one arm's model/runner/baseUrl: per-arm override, per-arm field, shared override, shared field. */
function resolveArm(
  arm: "baseline" | "proposed",
  rawArm: Record<string, unknown>,
  raw: RawCompareConfig,
  overrides: CompareOverrides,
): ArmConfig {
  const modelOverride = arm === "baseline" ? overrides.baselineModel : overrides.proposedModel;
  const runnerOverride = arm === "baseline" ? overrides.baselineRunner : overrides.proposedRunner;
  const model = modelOverride ?? stringValue(rawArm.model, overrides.model ?? stringValue(raw.model, undefined));
  if (model === undefined) {
    throw new Error(`model is required (top-level "model" or ${arm}.model)`);
  }
  return {
    model,
    runner: runnerOverride ?? runnerNameValue(rawArm.runner, overrides.runner ?? runnerNameValue(raw.runner, "claude-p")),
    baseUrl: stringValue(rawArm.baseUrl, overrides.baseUrl ?? stringValue(raw.baseUrl, undefined)),
  };
}

function armRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) ? value : {};
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
  if (value === "target" || value === "regression" || value === "compare") return value;
  throw new Error(`scenario kind must be "target", "regression", or "compare"`);
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

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function recordValue(value: unknown, label: string): RawCase {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}
