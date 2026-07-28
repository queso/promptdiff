import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { createRunner, type CreateRunnerOptions, type RunnerName } from "../runner";
import type { Runner } from "../types";
import type { GradeResult } from "./grader";

/**
 * LLM-judge grader: an explicit judge model grades the run's output against a
 * markdown rubric. The judge model never defaults to the arm's model —
 * self-grading bias is the failure mode that explicitness closes.
 */
export interface JudgeGraderSpec {
  type: "judge";
  /** Absolute path to the rubric markdown (resolved at config load). */
  rubric: string;
  model: string;
  runner: RunnerName;
  /** OpenAI-compatible endpoint base URL for the judge; openai runner only. */
  baseUrl?: string;
  /** Per-class calibration accuracy the gate requires. Default 0.9. */
  minAccuracy: number;
}

export type JudgeRunnerFactory = (name: RunnerName, options: CreateRunnerOptions) => Runner;

let judgeRunnerFactory: JudgeRunnerFactory = createRunner;

/** Test seam: swap the judge's runner factory. Pass undefined to restore createRunner. */
export function setJudgeRunnerFactory(factory: JudgeRunnerFactory | undefined): void {
  judgeRunnerFactory = factory ?? createRunner;
}

// Appended verbatim after the rubric — the rubric author writes judgment
// criteria; the harness owns the reply contract.
const HARNESS_INSTRUCTION = [
  "",
  "---",
  "You are grading one output (the user message) against the rubric above.",
  'Reply with exactly one JSON object: {"verdict": "pass" | "fail", "reason": "<short>"}',
  '"pass" means the output is clean per the rubric; "fail" means the rubric flags it.',
].join("\n");

export function judgeSystemPrompt(rubricContent: string): string {
  return rubricContent + HARNESS_INSTRUCTION;
}

export interface JudgeVerdict {
  verdict: "pass" | "fail";
  reason: string;
}

/**
 * Extracts the judge's verdict from its reply. Reasoning models wrap the JSON
 * in prose, so the LAST balanced JSON object carrying a valid verdict wins.
 * No valid verdict → undefined; callers must fail the graded run, never pass it.
 */
export function parseJudgeVerdict(reply: string): JudgeVerdict | undefined {
  let last: JudgeVerdict | undefined;
  for (const candidate of balancedJsonObjects(reply)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const record = parsed as Record<string, unknown>;
    if (record.verdict !== "pass" && record.verdict !== "fail") continue;
    last = { verdict: record.verdict, reason: typeof record.reason === "string" ? record.reason : "" };
  }
  return last;
}

/** Top-level {...} spans, tracked with string/escape awareness so braces inside reasons don't split objects. */
function balancedJsonObjects(text: string): string[] {
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"' && depth > 0) inString = true;
    else if (char === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0) spans.push(text.slice(start, i + 1));
    }
  }
  return spans;
}

export interface JudgeFixture {
  /** "pass/clean-a.md" — class dir + file name, the identity used in reports. */
  name: string;
  expected: "pass" | "fail";
  content: string;
}

/** Sibling fixture dir: rubrics/negate-restate.md → rubrics/negate-restate.fixtures/{pass,fail}/*.md */
export function judgeFixturesDir(rubricPath: string): string {
  return join(dirname(rubricPath), `${basename(rubricPath, extname(rubricPath))}.fixtures`);
}

export function loadJudgeFixtures(rubricPath: string): JudgeFixture[] {
  const dir = judgeFixturesDir(rubricPath);
  const fixtures: JudgeFixture[] = [];
  for (const expected of ["pass", "fail"] as const) {
    const classDir = join(dir, expected);
    const files = existsSync(classDir)
      ? readdirSync(classDir).filter((file) => file.endsWith(".md")).sort()
      : [];
    // A one-sided fixture set cannot catch a judge that always agrees with it.
    if (files.length === 0) {
      const meaning = expected === "pass" ? "call clean" : "flag";
      throw new Error(
        `judge calibration needs at least one ${expected}-class fixture in ${classDir} (outputs the judge must ${meaning})`,
      );
    }
    for (const file of files) {
      fixtures.push({ name: `${expected}/${file}`, expected, content: readFileSync(join(classDir, file), "utf8") });
    }
  }
  return fixtures;
}

export interface CalibrationRecord {
  rubricSha256: string;
  model: string;
  runner: RunnerName;
  baseUrl?: string;
  ranAt: string;
  fixtures: { pass: number; fail: number };
  /** Per class: fraction of that class's fixtures the judge labeled correctly. */
  accuracy: { pass: number; fail: number };
  verdicts: CalibrationVerdict[];
}

export interface CalibrationVerdict {
  fixture: string;
  expected: "pass" | "fail";
  got: "pass" | "fail" | "invalid";
}

/** The record commits next to the rubric so calibration travels with it. */
export function calibrationRecordPath(rubricPath: string): string {
  return `${rubricPath}.calibration.json`;
}

export function rubricSha256(rubricContent: string): string {
  return createHash("sha256").update(rubricContent).digest("hex");
}

export function writeCalibrationRecord(rubricPath: string, record: CalibrationRecord): string {
  const path = calibrationRecordPath(rubricPath);
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return path;
}

export function readCalibrationRecord(path: string): CalibrationRecord {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CalibrationRecord>;
  if (
    typeof raw.rubricSha256 !== "string" ||
    typeof raw.model !== "string" ||
    typeof raw.runner !== "string" ||
    typeof raw.accuracy !== "object" ||
    raw.accuracy === null ||
    typeof raw.accuracy.pass !== "number" ||
    typeof raw.accuracy.fail !== "number"
  ) {
    throw new Error(`calibration record ${path} is malformed — re-run promptdiff calibrate`);
  }
  return raw as CalibrationRecord;
}

/**
 * The refuse-to-grade gate. An uncalibrated judge is worse than the regex it
 * replaces — same wrongness, more confidence, higher cost — so every judge
 * grader must present a fresh, matching, above-bar calibration record before
 * any paid run. Per-class bars on purpose: a judge that passes everything is
 * 100% on the pass class and 0% on the fail class; overall accuracy hides it.
 */
export function assertJudgeCalibrated(spec: JudgeGraderSpec): void {
  const fix = `run: promptdiff calibrate --rubric ${spec.rubric} --model ${spec.model}${
    spec.runner === "claude-p" ? "" : ` --runner ${spec.runner}`
  }`;
  const recordPath = calibrationRecordPath(spec.rubric);
  if (!existsSync(recordPath)) {
    throw new Error(`judge rubric ${spec.rubric} has no calibration record (${recordPath}) — ${fix}`);
  }
  const record = readCalibrationRecord(recordPath);
  const currentSha = rubricSha256(readFileSync(spec.rubric, "utf8"));
  if (record.rubricSha256 !== currentSha) {
    throw new Error(
      `judge rubric ${spec.rubric} changed since calibration (sha256 mismatch) — the record is stale; ${fix}`,
    );
  }
  if (record.model !== spec.model || record.runner !== spec.runner) {
    throw new Error(
      `judge rubric ${spec.rubric} was calibrated with model "${record.model}" via ${record.runner}, ` +
        `but the grader specifies model "${spec.model}" via ${spec.runner} — ${fix}`,
    );
  }
  for (const cls of ["pass", "fail"] as const) {
    if (record.accuracy[cls] < spec.minAccuracy) {
      throw new Error(
        `judge rubric ${spec.rubric} is below the calibration bar on the ${cls} class ` +
          `(${formatPct(record.accuracy[cls])} < minAccuracy ${formatPct(spec.minAccuracy)}) — ` +
          `refusing to grade; improve the rubric or fixtures, then ${fix}`,
      );
    }
  }
}

interface JudgeCallBounds {
  cwd: string;
  timeoutMs: number;
  maxBudgetUsd: number;
}

interface JudgeCallResult {
  verdict: JudgeVerdict | undefined;
  costUsd: number;
  raw: string;
}

/** One judge invocation: rubric + harness contract as system prompt, the graded output as user prompt. */
async function callJudge(
  spec: Pick<JudgeGraderSpec, "rubric" | "model" | "runner" | "baseUrl">,
  output: string,
  bounds: JudgeCallBounds,
): Promise<JudgeCallResult> {
  const runner = judgeRunnerFactory(spec.runner, { baseUrl: spec.baseUrl });
  const result = await runner.run({
    systemPrompt: judgeSystemPrompt(readFileSync(spec.rubric, "utf8")),
    userPrompt: output,
    model: spec.model,
    cwd: bounds.cwd,
    timeoutMs: bounds.timeoutMs,
    maxBudgetUsd: bounds.maxBudgetUsd,
    tools: "",
    addDirs: [],
    // Pin the judge itself as close to deterministic as the endpoint allows —
    // pass-rate deltas should be about the prompt under test, not judge noise.
    requestParams: spec.runner === "openai" ? { temperature: 0 } : undefined,
  });
  return { verdict: parseJudgeVerdict(result.output), costUsd: result.costUsd, raw: result.output };
}

/**
 * Grades one real run with the judge. Any outcome that is not a valid verdict
 * — transport failure or unparseable reply — FAILS the graded run; a judge
 * problem must never silently count as a pass.
 */
export async function gradeWithJudge(
  spec: JudgeGraderSpec,
  output: string,
  bounds: JudgeCallBounds,
): Promise<GradeResult> {
  let call: JudgeCallResult;
  try {
    call = await callJudge(spec, output, bounds);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { pass: false, message: `judge error: ${reason}` };
  }
  if (call.verdict === undefined) {
    return { pass: false, message: "judge returned no valid verdict", stdout: call.raw, costUsd: call.costUsd };
  }
  const { verdict, reason } = call.verdict;
  return {
    pass: verdict === "pass",
    message: `judge verdict: ${verdict}${reason ? ` — ${reason}` : ""}`,
    costUsd: call.costUsd,
  };
}

export interface CalibrateOptions {
  /** Absolute rubric path. */
  rubric: string;
  model: string;
  runner: RunnerName;
  baseUrl?: string;
  timeoutMs: number;
  maxBudgetUsd: number;
  onProgress?: (message: string) => void;
}

export interface CalibrateResult {
  record: CalibrationRecord;
  recordPath: string;
  misses: CalibrationVerdict[];
  totalCostUsd: number;
}

/**
 * Runs the judge over every labeled fixture and writes the calibration record
 * next to the rubric — ALWAYS, including failing calibrations: calibrate
 * measures, the gate enforces. A below-bar record on disk is an honest "this
 * judge cannot be trusted yet", not an error.
 */
export async function runCalibration(options: CalibrateOptions): Promise<CalibrateResult> {
  if (!existsSync(options.rubric)) {
    throw new Error(`rubric file not found: ${options.rubric}`);
  }
  const fixtures = loadJudgeFixtures(options.rubric);
  const verdicts: CalibrationVerdict[] = [];
  let totalCostUsd = 0;

  for (const fixture of fixtures) {
    options.onProgress?.(`judging fixture ${fixture.name}`);
    const call = await callJudge(options, fixture.content, {
      cwd: dirname(options.rubric),
      timeoutMs: options.timeoutMs,
      maxBudgetUsd: options.maxBudgetUsd,
    });
    totalCostUsd += call.costUsd;
    verdicts.push({ fixture: fixture.name, expected: fixture.expected, got: call.verdict?.verdict ?? "invalid" });
  }

  const record: CalibrationRecord = {
    rubricSha256: rubricSha256(readFileSync(options.rubric, "utf8")),
    model: options.model,
    runner: options.runner,
    baseUrl: options.baseUrl,
    ranAt: new Date().toISOString(),
    fixtures: { pass: classCount(verdicts, "pass"), fail: classCount(verdicts, "fail") },
    accuracy: { pass: classAccuracy(verdicts, "pass"), fail: classAccuracy(verdicts, "fail") },
    verdicts,
  };
  const recordPath = writeCalibrationRecord(options.rubric, record);
  return {
    record,
    recordPath,
    misses: verdicts.filter((verdict) => verdict.got !== verdict.expected),
    totalCostUsd,
  };
}

function classCount(verdicts: CalibrationVerdict[], cls: "pass" | "fail"): number {
  return verdicts.filter((verdict) => verdict.expected === cls).length;
}

function classAccuracy(verdicts: CalibrationVerdict[], cls: "pass" | "fail"): number {
  const ofClass = verdicts.filter((verdict) => verdict.expected === cls);
  if (ofClass.length === 0) return 0;
  return ofClass.filter((verdict) => verdict.got === verdict.expected).length / ofClass.length;
}

export function formatCalibrationReport(result: CalibrateResult, minAccuracyHint = 0.9): string {
  const { record } = result;
  const lines = [
    `promptdiff calibrate: ${record.model} via ${record.runner}`,
    "",
    `pass class: ${correctOf(record, "pass")}/${record.fixtures.pass} correct (${formatPct(record.accuracy.pass)})`,
    `fail class: ${correctOf(record, "fail")}/${record.fixtures.fail} correct (${formatPct(record.accuracy.fail)})`,
  ];
  if (result.misses.length > 0) {
    lines.push("", "misses:");
    for (const miss of result.misses) {
      lines.push(`  ${miss.fixture}: expected ${miss.expected}, judge said ${miss.got}`);
    }
  }
  lines.push(
    "",
    `calibration record written: ${result.recordPath}`,
    `judge cost: $${result.totalCostUsd.toFixed(4)}`,
    `gate: compare/measure require BOTH classes >= minAccuracy (default ${formatPct(minAccuracyHint)})`,
  );
  return lines.join("\n");
}

function correctOf(record: CalibrationRecord, cls: "pass" | "fail"): number {
  return record.verdicts.filter((verdict) => verdict.expected === cls && verdict.got === cls).length;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}
