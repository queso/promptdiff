/**
 * Path assertions over a JSON value, for the json grader.
 *
 * Grammar (one assertion): `<path> <op> <literal>` with whitespace around the
 * operator. Paths are dot-separated identifiers with `[<index>]` and `[*]`
 * steps; a trailing `.length` on an array or string reads its length. `[*]`
 * is existential: the assertion passes if ANY element satisfies it.
 */

export type JsonPathSegment =
  | { kind: "key"; name: string }
  | { kind: "index"; index: number }
  | { kind: "any" };

export type JsonOp = "==" | "!=" | ">" | ">=" | "<" | "<=" | "contains";

export type JsonScalar = string | number | boolean | null;

export interface JsonAssertion {
  source: string;
  path: JsonPathSegment[];
  op: JsonOp;
  literal: JsonScalar;
}

const ASSERTION_RE = /^(\S+)\s+(==|!=|>=|<=|>|<|contains)\s+(\S.*)$/;
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const RELATIONAL_OPS: ReadonlySet<JsonOp> = new Set([">", ">=", "<", "<="]);

/** Parses one assertion string; throws with a grammar-naming message on invalid input. */
export function parseAssertion(source: string): JsonAssertion {
  const match = ASSERTION_RE.exec(source.trim());
  if (!match) {
    throw new Error(
      'expected `<path> <op> <literal>` with spaces around the operator (ops: == != > >= < <= contains)',
    );
  }
  const [, pathText = "", rawOp = "", literalText = ""] = match;
  // The regex alternation only admits the seven operators.
  const op = rawOp as JsonOp;
  const path = parsePath(pathText);
  const literal = parseLiteral(literalText);
  if (RELATIONAL_OPS.has(op) && typeof literal !== "number") {
    throw new Error(`operator ${op} needs a number literal, got ${literalText}`);
  }
  return { source, path, op, literal };
}

function parsePath(text: string): JsonPathSegment[] {
  const segments: JsonPathSegment[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (segments.length === 0) {
      const match = IDENT_RE.exec(text);
      if (!match) {
        throw new Error(`path must start with an identifier, got ${JSON.stringify(text)}`);
      }
      segments.push({ kind: "key", name: match[0] });
      index = match[0].length;
    } else if (char === ".") {
      const match = IDENT_RE.exec(text.slice(index + 1));
      if (!match) {
        throw new Error(`expected an identifier after "." in path ${JSON.stringify(text)}`);
      }
      segments.push({ kind: "key", name: match[0] });
      index += 1 + match[0].length;
    } else if (char === "[") {
      const close = text.indexOf("]", index);
      if (close === -1) {
        throw new Error(`unclosed "[" in path ${JSON.stringify(text)}`);
      }
      const inner = text.slice(index + 1, close);
      if (inner === "*") {
        segments.push({ kind: "any" });
      } else if (/^\d+$/.test(inner)) {
        segments.push({ kind: "index", index: Number(inner) });
      } else {
        throw new Error(`brackets take a non-negative integer or *, got "[${inner}]"`);
      }
      index = close + 1;
    } else {
      throw new Error(`unexpected ${JSON.stringify(char)} in path ${JSON.stringify(text)}`);
    }
  }
  return segments;
}

function parseLiteral(text: string): JsonScalar {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `literal must be a JSON scalar — a quoted string like "correctness", a number, true, false, or null — got ${text}`,
    );
  }
  if (parsed !== null && typeof parsed === "object") {
    throw new Error(`literal must be a JSON scalar (string, number, boolean, or null), got ${text}`);
  }
  return parsed as JsonScalar;
}

/**
 * Evaluates one parsed assertion against a JSON value. Returns undefined on
 * pass, or a failure message naming the assertion and what was found. Never
 * throws: missing paths and type mismatches are grading failures.
 */
export function evaluateAssertion(assertion: JsonAssertion, root: unknown): string | undefined {
  const { candidates, missing } = resolvePath(root, assertion.path);
  if (candidates.length === 0) {
    return `${assertion.source}: ${missing ?? "path matched no values"}`;
  }
  const details: string[] = [];
  for (const candidate of candidates) {
    const detail = compare(candidate, assertion.op, assertion.literal);
    if (detail === undefined) return undefined;
    details.push(detail);
  }
  if (candidates.length === 1) {
    return `${assertion.source}: ${details[0]}`;
  }
  return `${assertion.source}: no element satisfied (${candidates.length} checked; e.g. ${details[0]})`;
}

/**
 * Walks the path, fanning out at `[*]`. A branch that dead-ends is dropped
 * (existential semantics); the first dead end is kept for the failure message
 * used when NO branch survives.
 */
function resolvePath(
  root: unknown,
  segments: JsonPathSegment[],
): { candidates: unknown[]; missing?: string } {
  let current: unknown[] = [root];
  let missing: string | undefined;
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of current) {
      if (segment.kind === "any") {
        if (Array.isArray(value)) {
          next.push(...value);
          if (value.length === 0) missing ??= "[*] found an empty array";
        } else {
          missing ??= `[*] needs an array, found ${show(value)}`;
        }
      } else if (segment.kind === "index") {
        if (Array.isArray(value) && segment.index < value.length) {
          next.push(value[segment.index]);
        } else {
          missing ??= Array.isArray(value)
            ? `index [${segment.index}] is out of range (${value.length} elements)`
            : `index [${segment.index}] needs an array, found ${show(value)}`;
        }
      } else if (segment.name === "length" && (Array.isArray(value) || typeof value === "string")) {
        next.push(value.length);
      } else if (isRecord(value) && segment.name in value) {
        next.push(value[segment.name]);
      } else {
        missing ??= `path segment "${segment.name}" not found (at ${show(value)})`;
      }
    }
    current = next;
    if (current.length === 0) return { candidates: [], missing };
  }
  return { candidates: current, missing };
}

/** Undefined when the candidate satisfies the op; otherwise a short failure detail. */
function compare(candidate: unknown, op: JsonOp, literal: JsonScalar): string | undefined {
  switch (op) {
    case "==":
      return candidate === literal ? undefined : `found ${show(candidate)}`;
    case "!=":
      return candidate !== literal ? undefined : `found ${show(candidate)}`;
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (typeof candidate !== "number") {
        return `expected a number, found ${show(candidate)}`;
      }
      if (typeof literal !== "number") return `operator ${op} needs a number literal`;
      const pass =
        op === ">" ? candidate > literal
        : op === ">=" ? candidate >= literal
        : op === "<" ? candidate < literal
        : candidate <= literal;
      return pass ? undefined : `found ${show(candidate)}`;
    }
    case "contains": {
      if (typeof candidate === "string") {
        if (typeof literal !== "string") {
          return `contains on a string needs a string literal, got ${show(literal)}`;
        }
        return candidate.includes(literal) ? undefined : `found ${show(candidate)}`;
      }
      if (Array.isArray(candidate)) {
        return candidate.some((element) => element === literal) ? undefined : `found ${show(candidate)}`;
      }
      return `contains needs a string or array, found ${show(candidate)}`;
    }
  }
}

const SHOW_MAX_CHARS = 120;

function show(value: unknown): string {
  const text = value === undefined ? "undefined" : JSON.stringify(value);
  return text.length > SHOW_MAX_CHARS ? `${text.slice(0, SHOW_MAX_CHARS)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Finds the LAST parseable JSON value in the output — reasoning models emit
 * prose before, after, and around JSON, and the final value is the answer.
 * Balancing is string-aware: a `}` inside a string literal closes nothing.
 * Undefined when the output holds no JSON value at all.
 */
export function extractLastJson(output: string): { value: unknown } | undefined {
  const trimmed = output.trim();
  if (trimmed.length > 0) {
    try {
      return { value: JSON.parse(trimmed) };
    } catch {
      // Not pure JSON — scan for embedded values below.
    }
  }
  let last: { value: unknown } | undefined;
  let index = 0;
  while (index < output.length) {
    const char = output[index];
    if (char === "{" || char === "[") {
      const end = scanBalanced(output, index);
      if (end !== -1) {
        try {
          last = { value: JSON.parse(output.slice(index, end + 1)) };
          index = end + 1;
          continue;
        } catch {
          // Balanced but not JSON (prose braces) — step inside and keep scanning.
        }
      }
    }
    index += 1;
  }
  return last;
}

/** Index of the bracket closing the one at `start`, or -1 if never closed/mismatched. */
function scanBalanced(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return -1;
      if (stack.length === 0) return index;
    }
  }
  return -1;
}
