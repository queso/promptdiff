import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult } from "../types";
import { fileGraderCommand, NO_ARTIFACT_EXIT_CODE, type FileGraderSpec } from "./grader-file";
import { evaluateAssertion, extractLastJson, parseAssertion } from "./json-assert";
import { gradeWithJudge, type JudgeGraderSpec } from "./judge";

export type GraderSpec =
  | {
      type: "text";
      contains?: string[];
      notContains?: string[];
      regex?: string[];
    }
  | {
      type: "json";
      /** Path assertions over the run's last balanced JSON value; all must hold. */
      assert: string[];
    }
  | {
      type: "command";
      command: string;
      cwd?: string;
      timeoutMs?: number;
      expectExitCode?: number;
    }
  | FileGraderSpec
  | JudgeGraderSpec;

export interface GradeInput {
  run: RunResult;
  sandboxDir: string;
  /** Bounds for graders that bill a model call (judge); deterministic graders ignore them. */
  timeoutMs?: number;
  maxBudgetUsd?: number;
}

export interface GradeResult {
  pass: boolean;
  /**
   * The grader reported that the artifact it grades does not exist (exit
   * NO_ARTIFACT_EXIT_CODE). No signal: never a pass, and excluded from pass
   * rates rather than counted as a failure.
   */
  noArtifact?: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
  /** USD billed by the grader itself (judge graders); unset for deterministic graders. */
  costUsd?: number;
}

const DEFAULT_JUDGE_TIMEOUT_MS = 600_000;
const DEFAULT_JUDGE_BUDGET_USD = 1;

export async function gradeRun(spec: GraderSpec, input: GradeInput): Promise<GradeResult> {
  if (spec.type === "text") {
    return gradeText(spec, input.run.output);
  }
  if (spec.type === "json") {
    return gradeJson(spec, input.run.output);
  }
  if (spec.type === "judge") {
    return gradeWithJudge(spec, input.run.output, {
      cwd: input.sandboxDir,
      timeoutMs: input.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS,
      maxBudgetUsd: input.maxBudgetUsd ?? DEFAULT_JUDGE_BUDGET_USD,
    });
  }
  // Command graders judge sandbox files — but for completion-style runs the model's
  // text IS the artifact, so it lands in the sandbox too ($PROMPTDIFF_OUTPUT_FILE).
  const outputFile = join(input.sandboxDir, ".promptdiff-output.txt");
  writeFileSync(outputFile, input.run.output);
  if (spec.type === "file") {
    return gradeFile(spec, input.sandboxDir, outputFile);
  }
  return gradeCommand(spec, input.sandboxDir, outputFile);
}

/** A grader file is a command grader: same sandbox cwd, same exit-code contract. */
async function gradeFile(spec: FileGraderSpec, sandboxDir: string, outputFile: string): Promise<GradeResult> {
  const result = await gradeCommand(
    { type: "command", command: fileGraderCommand(spec), cwd: spec.cwd, timeoutMs: spec.timeoutMs },
    sandboxDir,
    outputFile,
    { verdictFromStderr: true },
  );
  return result.pass ? { ...result, message: "file grader passed" } : result;
}

function gradeText(spec: Extract<GraderSpec, { type: "text" }>, output: string): GradeResult {
  for (const expected of spec.contains ?? []) {
    if (!output.includes(expected)) {
      return { pass: false, message: `output did not contain ${JSON.stringify(expected)}` };
    }
  }

  for (const forbidden of spec.notContains ?? []) {
    if (output.includes(forbidden)) {
      return { pass: false, message: `output contained forbidden text ${JSON.stringify(forbidden)}` };
    }
  }

  for (const pattern of spec.regex ?? []) {
    if (!new RegExp(pattern).test(output)) {
      return { pass: false, message: `output did not match /${pattern}/` };
    }
  }

  return { pass: true, message: "text grader passed" };
}

function gradeJson(spec: Extract<GraderSpec, { type: "json" }>, output: string): GradeResult {
  const extracted = extractLastJson(output);
  if (extracted === undefined) {
    return { pass: false, message: "no JSON value found in output" };
  }
  for (const source of spec.assert) {
    // Assertion grammar was validated at config load; parsing here cannot throw.
    const failure = evaluateAssertion(parseAssertion(source), extracted.value);
    if (failure !== undefined) {
      return { pass: false, message: failure };
    }
  }
  return { pass: true, message: "json grader passed" };
}

async function gradeCommand(
  spec: Extract<GraderSpec, { type: "command" }>,
  sandboxDir: string,
  outputFile: string,
  options: { verdictFromStderr?: boolean } = {},
): Promise<GradeResult> {
  const cwd = resolve(sandboxDir, spec.cwd ?? ".");
  if (!existsSync(cwd)) {
    return { pass: false, message: `grader cwd does not exist: ${cwd}` };
  }

  const proc = Bun.spawn(["sh", "-lc", spec.command], {
    cwd,
    env: {
      ...process.env,
      PROMPTDIFF_OUTPUT_FILE: outputFile,
      PROMPTDIFF_NO_ARTIFACT_EXIT_CODE: String(NO_ARTIFACT_EXIT_CODE),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timeoutMs = spec.timeoutMs ?? 120_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2_000);
  }, timeoutMs);

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);

  if (timedOut) {
    return { pass: false, message: `grader timed out after ${timeoutMs}ms`, stdout, stderr };
  }

  const expected = spec.expectExitCode ?? 0;
  // File graders end stderr with a one-line verdict ("2 of 5 checks failed",
  // "no artifact: ..."), which says more than the bare exit code.
  const verdict = options.verdictFromStderr ? stderr.trim().split("\n").at(-1) || undefined : undefined;
  // An explicit expectExitCode of 77 keeps its old meaning; only unexpected
  // 77s are reclassified, so no existing grader flips between pass and fail.
  if (code === NO_ARTIFACT_EXIT_CODE && expected !== NO_ARTIFACT_EXIT_CODE) {
    return {
      pass: false,
      noArtifact: true,
      message: verdict ?? `no artifact (grader exited ${NO_ARTIFACT_EXIT_CODE})`,
      stdout,
      stderr,
    };
  }
  return {
    pass: code === expected,
    message: code === expected ? "command grader passed" : (verdict ?? `command exited ${code}, expected ${expected}`),
    stdout,
    stderr,
  };
}
