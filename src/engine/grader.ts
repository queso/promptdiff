import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RunResult } from "../types";

export type GraderSpec =
  | {
      type: "text";
      contains?: string[];
      notContains?: string[];
      regex?: string[];
    }
  | {
      type: "command";
      command: string;
      cwd?: string;
      timeoutMs?: number;
      expectExitCode?: number;
    };

export interface GradeInput {
  run: RunResult;
  sandboxDir: string;
}

export interface GradeResult {
  pass: boolean;
  message: string;
  stdout?: string;
  stderr?: string;
}

export async function gradeRun(spec: GraderSpec, input: GradeInput): Promise<GradeResult> {
  if (spec.type === "text") {
    return gradeText(spec, input.run.output);
  }
  // Command graders judge sandbox files — but for completion-style runs the model's
  // text IS the artifact, so it lands in the sandbox too ($PROMPTDIFF_OUTPUT_FILE).
  const outputFile = join(input.sandboxDir, ".promptdiff-output.txt");
  writeFileSync(outputFile, input.run.output);
  return gradeCommand(spec, input.sandboxDir, outputFile);
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

async function gradeCommand(
  spec: Extract<GraderSpec, { type: "command" }>,
  sandboxDir: string,
  outputFile: string,
): Promise<GradeResult> {
  const cwd = resolve(sandboxDir, spec.cwd ?? ".");
  if (!existsSync(cwd)) {
    return { pass: false, message: `grader cwd does not exist: ${cwd}` };
  }

  const proc = Bun.spawn(["sh", "-lc", spec.command], {
    cwd,
    env: { ...process.env, PROMPTDIFF_OUTPUT_FILE: outputFile },
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
  return {
    pass: code === expected,
    message: code === expected ? "command grader passed" : `command exited ${code}, expected ${expected}`,
    stdout,
    stderr,
  };
}
