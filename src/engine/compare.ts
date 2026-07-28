import { assembleSystemPrompt } from "../prompt";
import type { Runner, RunnerRunOptions, RunResult } from "../types";
import type { ArmConfig, CompareConfig, EvalCaseConfig, ScenarioKind } from "./config";
import { renderStrict, type RenderVars } from "./render";
import { gradeRun, type GradeResult } from "./grader";
import { prepareSandbox } from "./sandbox";
import { installSkills } from "./skill-install";

export interface ArmRunSummary {
  run: number;
  pass: boolean;
  grade: GradeResult;
  costUsd: number;
  turns: number;
  durationMs: number;
  sandboxDir: string;
  output: string;
}

export interface ArmSummary {
  name: "baseline" | "proposed";
  passes: number;
  totalRuns: number;
  passRate: number;
  totalCostUsd: number;
  runs: ArmRunSummary[];
}

export interface CaseSummary {
  name: string;
  kind: ScenarioKind;
  baseline: ArmSummary;
  proposed: ArmSummary;
  assertions: string[];
}

export interface CompareSummary {
  name: string;
  arms: { baseline: ArmConfig; proposed: ArmConfig };
  cases: CaseSummary[];
  failedAssertions: string[];
  totalCostUsd: number;
}

export interface CompareRunOptions {
  config: CompareConfig;
  runners: { baseline: Runner; proposed: Runner };
  onProgress?: (message: string) => void;
}

export async function runCompare(options: CompareRunOptions): Promise<CompareSummary> {
  const { config, runners, onProgress } = options;
  // Validate each arm against its own runner — a mixed comparison fails on the
  // violating arm before either arm's paid runs.
  validateRunnerSupport(config, runners.baseline);
  validateRunnerSupport(config, runners.proposed);
  // Install delivery keeps skill text out of the system prompt entirely — the
  // arms differ only by which skill directory lands in the sandbox registry.
  const inline = config.delivery !== "install";
  const baselinePrompt = assembleSystemPrompt(config.agent, inline ? config.baselineSkills : []);
  const proposedPrompt = assembleSystemPrompt(config.agent, inline ? config.proposedSkills : []);
  // Rendering all cases up front means an unbound placeholder in scenario 3
  // fails here — before scenario 1 spends anything.
  const renderedCases = config.cases.map((evalCase) => renderCase(evalCase, baselinePrompt, proposedPrompt, config));
  const cases: CaseSummary[] = [];

  for (const { evalCase, baselineSystem, proposedSystem } of renderedCases) {
    onProgress?.(`scenario ${evalCase.name} (${evalCase.kind})`);
    const baseline = await runArm(config, evalCase, "baseline", baselineSystem, runners.baseline, onProgress);
    const proposed = await runArm(config, evalCase, "proposed", proposedSystem, runners.proposed, onProgress);
    cases.push({
      name: evalCase.name,
      kind: evalCase.kind,
      baseline,
      proposed,
      assertions: evaluateAssertions(evalCase, baseline, proposed),
    });
  }

  const failedAssertions = cases.flatMap((caseSummary) =>
    caseSummary.assertions.map((assertion) => `${caseSummary.name}: ${assertion}`),
  );
  const totalCostUsd = cases.reduce(
    (sum, caseSummary) => sum + caseSummary.baseline.totalCostUsd + caseSummary.proposed.totalCostUsd,
    0,
  );

  return {
    name: config.name,
    arms: config.arms,
    cases,
    failedAssertions,
    totalCostUsd,
  };
}

export function formatCompareSummary(summary: CompareSummary): string {
  const lines = [`promptdiff compare: ${summary.name}`];
  const baselineLabel = armLabel("baseline", summary.arms);
  const proposedLabel = armLabel("proposed", summary.arms);

  for (const caseSummary of summary.cases) {
    const deltaPass = caseSummary.proposed.passRate - caseSummary.baseline.passRate;
    const deltaCost = caseSummary.proposed.totalCostUsd - caseSummary.baseline.totalCostUsd;
    lines.push(
      "",
      `${caseSummary.name} (${caseSummary.kind})`,
      `  ${baselineLabel}: ${caseSummary.baseline.passes}/${caseSummary.baseline.totalRuns} pass (${formatPct(caseSummary.baseline.passRate)}) | $${caseSummary.baseline.totalCostUsd.toFixed(4)}`,
      `  ${proposedLabel}: ${caseSummary.proposed.passes}/${caseSummary.proposed.totalRuns} pass (${formatPct(caseSummary.proposed.passRate)}) | $${caseSummary.proposed.totalCostUsd.toFixed(4)}`,
      `  delta: ${deltaPass >= 0 ? "+" : ""}${formatPct(deltaPass)} pass | ${deltaCost >= 0 ? "+" : ""}$${deltaCost.toFixed(4)}`,
    );

    if (caseSummary.assertions.length > 0) {
      for (const assertion of caseSummary.assertions) {
        lines.push(`  FAIL: ${assertion}`);
      }
    } else if (caseSummary.kind === "compare") {
      lines.push("  INFO: no assertion (kind \"compare\")");
    } else {
      lines.push("  PASS: assertions satisfied");
    }

    // Failing runs carry their grader evidence into the summary — diagnosing
    // WHICH check missed used to require re-running with --keep-sandbox.
    for (const arm of [caseSummary.baseline, caseSummary.proposed]) {
      for (const run of arm.runs) {
        if (run.pass) continue;
        lines.push(`  ${arm.name} run ${run.run} failed: ${run.grade.message}`);
        lines.push(...graderEvidence(run.grade));
      }
    }
  }

  lines.push("", `total cost: $${summary.totalCostUsd.toFixed(4)}`);
  if ((summary.arms.baseline.runner === "openai") !== (summary.arms.proposed.runner === "openai")) {
    lines.push("note: cost columns are not comparable — the openai runner reports $0 (tokens only)");
  }
  if (summary.failedAssertions.length > 0) {
    lines.push("failed assertions:");
    for (const assertion of summary.failedAssertions) {
      lines.push(`  - ${assertion}`);
    }
  }

  return lines.join("\n");
}

const EVIDENCE_TAIL_LINES = 6;
const EVIDENCE_MAX_CHARS = 700;

/** Last few lines of a failing run's grader stdout/stderr, indented for the summary. */
function graderEvidence(grade: GradeResult): string[] {
  const streams: Array<[string, string | undefined]> = [
    ["stdout", grade.stdout],
    ["stderr", grade.stderr],
  ];
  const lines: string[] = [];
  for (const [stream, content] of streams) {
    const trimmed = content?.trim();
    if (!trimmed) continue;
    const tail = trimmed.split("\n").slice(-EVIDENCE_TAIL_LINES).join("\n").slice(-EVIDENCE_MAX_CHARS);
    lines.push(`    grader ${stream}:`);
    lines.push(...tail.split("\n").map((line) => `      ${line}`));
  }
  return lines;
}

/** Bare arm name when the arms match; annotated with model (and runner when runners differ) otherwise. */
function armLabel(name: "baseline" | "proposed", arms: { baseline: ArmConfig; proposed: ArmConfig }): string {
  const runnersDiffer = arms.baseline.runner !== arms.proposed.runner;
  if (!runnersDiffer && arms.baseline.model === arms.proposed.model) return name;
  const arm = arms[name];
  return runnersDiffer ? `${name} (${arm.model} via ${arm.runner})` : `${name} (${arm.model})`;
}

/**
 * Rejects scenario demands the runner cannot honor — before any paid run,
 * instead of mid-comparison or (worse) via a silently tool-less arm.
 */
export function validateRunnerSupport(config: CompareConfig, runner: Runner): void {
  if (config.delivery === "install" && !runner.capabilities.skillRegistry) {
    throw new Error(
      `delivery "install" needs a runner with a skill registry; runner "${runner.name}" has none (use claude-p)`,
    );
  }
  for (const evalCase of config.cases) {
    if (evalCase.images.length > 0 && !runner.capabilities.images) {
      throw new Error(
        `runner "${runner.name}" cannot attach images, but scenario "${evalCase.name}" has \`images\` — use the openai runner with a vision model`,
      );
    }
  }
  if (runner.capabilities.sandboxTools) return;
  for (const evalCase of config.cases) {
    if (effectiveTools(config, evalCase) !== "") {
      throw new Error(
        `runner "${runner.name}" is text-only, but scenario "${evalCase.name}" needs sandbox tools ` +
          `(artifact mode, a command grader, or an explicit tools list) — use claude-p or make the scenario text-graded`,
      );
    }
  }
}

interface RenderedCase {
  evalCase: EvalCaseConfig;
  baselineSystem: string;
  proposedSystem: string;
}

/** Applies merged render vars (scenario over top-level) to both arms' system prompts and the scenario prompt. */
function renderCase(
  evalCase: EvalCaseConfig,
  baselinePrompt: string,
  proposedPrompt: string,
  config: CompareConfig,
): RenderedCase {
  const vars = mergedRenderVars(config, evalCase);
  if (vars === undefined) {
    return { evalCase, baselineSystem: baselinePrompt, proposedSystem: proposedPrompt };
  }
  return {
    evalCase: { ...evalCase, prompt: renderStrict(evalCase.prompt, vars, `scenario "${evalCase.name}" prompt`) },
    baselineSystem: renderStrict(baselinePrompt, vars, `scenario "${evalCase.name}" baseline system prompt`),
    proposedSystem: renderStrict(proposedPrompt, vars, `scenario "${evalCase.name}" proposed system prompt`),
  };
}

/** Undefined when neither level defines render — rendering (and its strictness) is opt-in. */
function mergedRenderVars(config: CompareConfig, evalCase: EvalCaseConfig): RenderVars | undefined {
  if (config.renderVars === undefined && evalCase.renderVars === undefined) return undefined;
  return { ...config.renderVars, ...evalCase.renderVars };
}

async function runArm(
  config: CompareConfig,
  evalCase: EvalCaseConfig,
  arm: "baseline" | "proposed",
  systemPrompt: string,
  runner: Runner,
  onProgress?: (message: string) => void,
): Promise<ArmSummary> {
  const runs = evalCase.runs ?? config.runs;
  const summaries: ArmRunSummary[] = [];
  const armSkills = arm === "baseline" ? config.baselineSkills : config.proposedSkills;

  for (let index = 0; index < runs; index += 1) {
    const sandbox = prepareSandbox({
      root: config.sandboxRoot,
      seed: evalCase.seed ?? config.sandboxSeed,
      prefix: `${evalCase.name}-${arm}-${index + 1}`,
      keep: config.keepSandbox,
    });

    try {
      onProgress?.(`  ${arm} run ${index + 1}/${runs}`);
      if (config.delivery === "install") {
        const { installed, warnings } = installSkills(armSkills, sandbox.dir);
        if (index === 0) {
          onProgress?.(`  ${arm} installed skills: ${installed.map((skill) => skill.name).join(", ")}`);
          for (const warning of warnings) {
            onProgress?.(`  WARNING: ${warning}`);
          }
        }
      }
      const run = await runner.run(buildRunnerOptions(config, evalCase, arm, systemPrompt, sandbox.dir));
      const grade = await gradeRun(evalCase.grader, { run, sandboxDir: sandbox.dir });
      summaries.push(toArmRunSummary(index + 1, run, grade, sandbox.dir));
    } finally {
      sandbox.cleanup();
    }
  }

  const passes = summaries.filter((summary) => summary.pass).length;
  const totalCostUsd = summaries.reduce((sum, summary) => sum + summary.costUsd, 0);
  return {
    name: arm,
    passes,
    totalRuns: runs,
    passRate: passes / runs,
    totalCostUsd,
    runs: summaries,
  };
}

function buildRunnerOptions(
  config: CompareConfig,
  evalCase: EvalCaseConfig,
  arm: "baseline" | "proposed",
  systemPrompt: string,
  cwd: string,
): RunnerRunOptions {
  return {
    systemPrompt,
    systemPromptMode: config.delivery === "install" ? "append" : "replace",
    userPrompt: evalCase.prompt,
    images: evalCase.images,
    requestParams: config.requestParams,
    model: config.arms[arm].model,
    cwd,
    addDirs: [...config.addDirs, ...evalCase.addDirs],
    tools: effectiveTools(config, evalCase),
    timeoutMs: config.timeoutMs,
    maxBudgetUsd: config.maxBudgetUsd,
  };
}

function effectiveTools(config: CompareConfig, evalCase: EvalCaseConfig): string {
  const mode = evalCase.mode ?? config.mode ?? inferMode(evalCase);
  // Install delivery always needs tools (the Skill tool does the triggering),
  // even when the grader is text-only and inline delivery would disable them.
  const fallbackTools = config.delivery === "install" ? "default" : defaultTools(mode);
  return evalCase.tools ?? config.tools ?? fallbackTools;
}

function toArmRunSummary(
  runNumber: number,
  run: RunResult,
  grade: GradeResult,
  sandboxDir: string,
): ArmRunSummary {
  return {
    run: runNumber,
    pass: grade.pass,
    grade,
    costUsd: run.costUsd,
    turns: run.turns,
    durationMs: run.durationMs,
    sandboxDir,
    output: run.output,
  };
}

function evaluateAssertions(
  evalCase: EvalCaseConfig,
  baseline: ArmSummary,
  proposed: ArmSummary,
): string[] {
  // "compare" scenarios report pass rates and the delta with no directional claim.
  if (evalCase.kind === "compare") {
    return [];
  }

  if (evalCase.kind === "target") {
    const failures = [];
    if (baseline.passRate >= 1) {
      failures.push("baseline fully passed; the target gap was not reproduced");
    }
    if (proposed.passRate <= baseline.passRate) {
      failures.push("proposed did not improve the target pass rate");
    }
    return failures;
  }

  if (proposed.passRate < baseline.passRate) {
    return ["proposed regressed below baseline pass rate"];
  }
  return [];
}

function inferMode(evalCase: EvalCaseConfig): "text" | "artifact" {
  return evalCase.grader.type === "command" ? "artifact" : "text";
}

function defaultTools(mode: "text" | "artifact"): string {
  return mode === "text" ? "" : "default";
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
