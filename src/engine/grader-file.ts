import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { plugin } from "bun";
import * as packageEntry from "../index";
import { evaluateGrader, formatGraderOutcome, graderOutcomePassed, isGraderFile, type GraderFile } from "../grade";

/**
 * Reserved grader exit code meaning "the artifact to grade does not exist":
 * no signal, neither a pass nor an assertion failure. Any command grader may
 * exit with it; file graders exit with it when their artifact is missing.
 * 77 is the automake "skipped" code, chosen because nothing else in the
 * command-grader contract uses it.
 */
export const NO_ARTIFACT_EXIT_CODE = 77;

/** Exit code for a grader file that cannot run at all (bad export, unknown name). */
const GRADER_USAGE_EXIT_CODE = 2;

/** The executable shim at the package root; file graders run as `bun <shim> grade ...`. */
const PROMPTDIFF_BIN = resolve(import.meta.dir, "..", "..", "promptdiff");

export interface FileGraderSpec {
  type: "file";
  /** Absolute path of the grader file. */
  file: string;
  /** Which named grader in the file to run. */
  name: string;
  cwd?: string;
  timeoutMs?: number;
}

/**
 * The file grader compiled down to the command-grader contract: a shell
 * command that runs in the sandbox, exits 0/1/77, and writes diagnostics to
 * stderr. The same command can be run by hand inside a kept sandbox.
 */
export function fileGraderCommand(spec: FileGraderSpec): string {
  return [process.execPath, PROMPTDIFF_BIN, "grade", "--file", spec.file, "--name", spec.name].map(shellQuote).join(" ");
}

let aliasRegistered = false;

/**
 * Grader files import `grade` from "@theaiteam/promptdiff" (or "promptdiff").
 * Resolving that to this running copy means a grader file works without the
 * package installed next to it, and always matches the runner's version.
 */
export function registerPackageAlias(): void {
  if (aliasRegistered) return;
  aliasRegistered = true;
  plugin({
    name: "promptdiff-grader-alias",
    setup(build) {
      for (const specifier of ["@theaiteam/promptdiff", "promptdiff"]) {
        build.module(specifier, () => ({ exports: { ...packageEntry }, loader: "object" }));
      }
    },
  });
}

export class GraderFileError extends Error {}

/** Imports a grader file and returns its default export; throws GraderFileError on a bad shape. */
export async function loadGraderFile(file: string): Promise<GraderFile> {
  registerPackageAlias();
  const path = resolve(file);
  if (!existsSync(path)) {
    throw new GraderFileError(`grader file not found: ${path}`);
  }
  const mod = (await import(path)) as { default?: unknown };
  if (!isGraderFile(mod.default)) {
    throw new GraderFileError(`${path}: default export must be grade(artifactPath, { name: ({ result }) => ... })`);
  }
  return mod.default;
}

export interface GraderFileRun {
  exitCode: number;
  stdout: string[];
  stderr: string[];
}

/**
 * Runs one named grader. The artifact path resolves against `cwd`, which is
 * the grader's working directory: the run sandbox, or the grader's `cwd`
 * inside it, the same place a command grader would look.
 */
export async function runGraderFile(file: string, name: string, cwd: string = process.cwd()): Promise<GraderFileRun> {
  const loaded = await loadGraderFile(file);
  const fn = loaded.graders[name];
  if (fn === undefined) {
    return {
      exitCode: GRADER_USAGE_EXIT_CODE,
      stdout: [],
      stderr: [`${resolve(file)}: no grader named ${JSON.stringify(name)} (has: ${Object.keys(loaded.graders).join(", ")})`],
    };
  }
  if (typeof loaded.artifact !== "string" || loaded.artifact.length === 0) {
    return {
      exitCode: GRADER_USAGE_EXIT_CODE,
      stdout: [],
      stderr: [`${resolve(file)}: grade() needs a non-empty artifact path, got ${JSON.stringify(loaded.artifact)}`],
    };
  }

  const artifactPath = resolve(cwd, loaded.artifact);
  if (!existsSync(artifactPath)) {
    return {
      exitCode: NO_ARTIFACT_EXIT_CODE,
      stdout: [],
      stderr: [`no artifact: ${loaded.artifact} does not exist in the grader's working directory`],
    };
  }
  if (statSync(artifactPath).isDirectory()) {
    return { exitCode: 1, stdout: [], stderr: [`artifact ${loaded.artifact} is a directory, not a file`] };
  }

  const text = await Bun.file(artifactPath).text();
  const outcome = await evaluateGrader(fn, { path: loaded.artifact, text });
  const report = formatGraderOutcome(name, loaded.artifact, outcome);
  return graderOutcomePassed(outcome)
    ? { exitCode: 0, stdout: report, stderr: [] }
    : { exitCode: 1, stdout: [], stderr: report };
}

/**
 * Load-time check that `name` exists in `file`, run in a child process so a
 * scenario load never executes grader code in the engine's own process.
 * Throws with the scenario label on any problem, before any paid run.
 */
export function assertGraderFileHasName(file: string, name: string, label: string): void {
  if (!existsSync(file)) {
    throw new Error(`${label}.file: file not found: ${file}`);
  }
  const proc = Bun.spawnSync([process.execPath, PROMPTDIFF_BIN, "grade", "--file", file, "--list"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const reason = proc.stderr.toString().trim() || `exit ${proc.exitCode}`;
    throw new Error(`${label}.file: cannot load ${file}: ${reason}`);
  }
  const names = JSON.parse(proc.stdout.toString()) as string[];
  if (!names.includes(name)) {
    throw new Error(`${label}.name: ${file} has no grader named ${JSON.stringify(name)} (has: ${names.join(", ")})`);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
