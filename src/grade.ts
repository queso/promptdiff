/**
 * The grader file format: one TS/JS file whose default export is
 * `grade(artifactPath, { name: ({ result }) => { ... } })`, referenced from a
 * scenario as `"grader": { "file": "./grade.eval.ts", "name": "..." }`.
 *
 * This module is the authoring side: what a grader file imports. The runner
 * side (reading the artifact, exit codes) lives in src/engine/grader-file.ts
 * and compiles down to the command-grader contract.
 */

/** What a named grader receives: the artifact under test. */
export interface GradeContext {
  result: ArtifactResult;
}

export type GraderFn = (context: GradeContext) => void | Promise<void>;

/**
 * The artifact plus the checks a grader runs against it. Every check records
 * a pass or a failure and returns whether it passed; a failed check never
 * stops the grader, so one run reports every failure at once.
 */
export interface ArtifactResult {
  /** The artifact path as given to grade(), relative to the grader's cwd (the run sandbox). */
  readonly path: string;
  /** The artifact's full contents. */
  readonly text: string;
  /**
   * The artifact parsed as JSON (parsed once, then cached). Invalid JSON
   * fails the grader with the parse error; checks recorded before it stay.
   */
  json<T = any>(): T;
  /**
   * The general check: passes when `condition` is truthy. `message` says what
   * went wrong; `context` (any JSON-serializable value) is printed with it,
   * so a failure shows the data it was judged on.
   */
  assert(condition: unknown, message: string, context?: unknown): boolean;
  /** Passes when the artifact text contains `expected`. */
  shouldHave(expected: string): boolean;
  /** Passes when the artifact text does not contain `forbidden`. */
  shouldNotHave(forbidden: string): boolean;
  /** Passes when the artifact text matches `pattern`. */
  shouldMatch(pattern: RegExp): boolean;
}

// Symbol.for, not Symbol(): a grader file and the runner may load separate
// copies of this module, and the brand must survive that.
const GRADER_FILE = Symbol.for("promptdiff.graderFile");

export interface GraderFile {
  readonly [GRADER_FILE]: true;
  /** Artifact path, relative to the grader's cwd (the run sandbox) unless absolute. */
  readonly artifact: string;
  readonly graders: Readonly<Record<string, GraderFn>>;
}

/**
 * Declares the named graders for one artifact. The return value must be the
 * file's default export.
 */
export function grade(artifact: string, graders: Record<string, GraderFn>): GraderFile {
  if (typeof graders !== "object" || graders === null || Array.isArray(graders)) {
    throw new Error("grade() needs an object of named grader functions as its second argument");
  }
  const names = Object.keys(graders);
  if (names.length === 0) {
    throw new Error("grade() needs at least one named grader");
  }
  for (const name of names) {
    if (typeof graders[name] !== "function") {
      throw new Error(`grade(): grader ${JSON.stringify(name)} must be a function`);
    }
  }
  // The artifact path is checked when a grader runs, not here: listing names
  // at config load must work even when the path comes from an env var such as
  // $PROMPTDIFF_OUTPUT_FILE, which only exists during a graded run.
  return { [GRADER_FILE]: true, artifact, graders: { ...graders } };
}

export function isGraderFile(value: unknown): value is GraderFile {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[GRADER_FILE] === true;
}

export interface CheckFailure {
  message: string;
  /** JSON-rendered context or a description of what the artifact held instead. */
  detail?: string;
}

export interface GraderOutcome {
  checks: number;
  failures: CheckFailure[];
}

const DETAIL_MAX_CHARS = 200;
const EXCERPT_CHARS = 60;

/**
 * Runs one named grader against artifact text and collects every check.
 * A throw inside the grader (a bug, or json() on invalid JSON) is recorded as
 * one more failure; the checks it made before throwing still count.
 */
export async function evaluateGrader(fn: GraderFn, artifact: { path: string; text: string }): Promise<GraderOutcome> {
  const outcome: GraderOutcome = { checks: 0, failures: [] };
  const record = (passed: boolean, failure: () => CheckFailure): boolean => {
    outcome.checks += 1;
    if (!passed) outcome.failures.push(failure());
    return passed;
  };

  const { text } = artifact;
  let parsed: { value: unknown } | undefined;
  const result: ArtifactResult = {
    path: artifact.path,
    text,
    json() {
      if (parsed === undefined) {
        try {
          parsed = { value: JSON.parse(text) };
        } catch (error) {
          throw new ArtifactJsonError(error instanceof Error ? error.message : String(error));
        }
      }
      return parsed.value as any;
    },
    assert(condition, message, context) {
      return record(Boolean(condition), () => ({
        message,
        detail: context === undefined ? undefined : `context: ${truncate(renderJson(context))}`,
      }));
    },
    shouldHave(expected) {
      return record(text.includes(expected), () => ({
        message: `shouldHave(${JSON.stringify(expected)}): not found`,
        detail: `artifact: ${text.length} chars, starts ${JSON.stringify(text.slice(0, EXCERPT_CHARS))}`,
      }));
    },
    shouldNotHave(forbidden) {
      const at = text.indexOf(forbidden);
      return record(at === -1, () => ({
        message: `shouldNotHave(${JSON.stringify(forbidden)}): found at offset ${at}`,
        detail: `around it: ${JSON.stringify(excerptAround(text, at, forbidden.length))}`,
      }));
    },
    shouldMatch(pattern) {
      // A global or sticky regex carries lastIndex between test() calls; a
      // fresh copy keeps the check independent of earlier use.
      const matched = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(text);
      return record(matched, () => ({
        message: `shouldMatch(${pattern}): no match`,
        detail: `artifact: ${text.length} chars, starts ${JSON.stringify(text.slice(0, EXCERPT_CHARS))}`,
      }));
    },
  };

  try {
    await fn({ result });
  } catch (error) {
    // Counted as a check so "N of M checks failed" stays consistent.
    outcome.checks += 1;
    outcome.failures.push(
      error instanceof ArtifactJsonError
        ? { message: `artifact is not valid JSON: ${error.message}`, detail: `starts ${JSON.stringify(text.slice(0, EXCERPT_CHARS))}` }
        : { message: `grader threw: ${error instanceof Error ? error.message : String(error)}` },
    );
  }
  return outcome;
}

/**
 * Report lines for one graded artifact. The summary line comes last on
 * purpose: compare/measure summaries show the tail of grader output, and the
 * engine uses the last stderr line as the run's grade message.
 */
export function formatGraderOutcome(name: string, artifactPath: string, outcome: GraderOutcome): string[] {
  const label = `grade ${JSON.stringify(name)} (${artifactPath})`;
  if (outcome.checks === 0) {
    return [`${label}: made no checks; a grader that checks nothing cannot pass`];
  }
  if (outcome.failures.length === 0) {
    return [`${label}: ${outcome.checks} of ${outcome.checks} checks passed`];
  }
  const lines: string[] = [];
  // One line per failure: summaries keep only the last few lines of grader
  // output, and a two-line format would push the first failures out of view.
  for (const failure of outcome.failures) {
    lines.push(failure.detail === undefined ? `FAIL ${failure.message}` : `FAIL ${failure.message} | ${failure.detail}`);
  }
  lines.push(`${label}: ${outcome.failures.length} of ${outcome.checks} checks failed`);
  return lines;
}

export function graderOutcomePassed(outcome: GraderOutcome): boolean {
  return outcome.checks > 0 && outcome.failures.length === 0;
}

class ArtifactJsonError extends Error {}

function renderJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  return text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS)}…`;
}

function excerptAround(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 30);
  return text.slice(start, at + length + 30);
}
