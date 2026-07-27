import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g;

export type RenderVars = Record<string, string>;

/**
 * Resolves raw `render.vars` values: a value naming an existing file (relative
 * to baseDir) becomes that file's contents; anything else stays a literal.
 * File reads happen at load time so a missing fixture fails before any paid run.
 */
export function resolveRenderVars(
  raw: Record<string, unknown>,
  baseDir: string,
  label: string,
): RenderVars {
  // Null prototype so a var named "__proto__" binds as a normal own property
  // instead of silently vanishing into a prototype assignment.
  const vars: RenderVars = Object.create(null) as RenderVars;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${name} must be a string (file path or literal)`);
    }
    const path = resolve(baseDir, value);
    vars[name] = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : value;
  }
  return vars;
}

export function placeholderNames(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))];
}

/**
 * Substitutes {{name}} placeholders and fails on any left unbound — sending a
 * literal `{{draft}}` to a model produces a confusing pass/fail, not an error.
 * Unbound detection runs on the ORIGINAL text: substituted values are never
 * re-scanned, so a fixture that itself contains braces cannot false-positive
 * (and there is no recursive expansion). Own-property checks throughout:
 * `in`/bracket lookups would let an unbound {{toString}} or {{constructor}}
 * pass the strict check and inject native-function source into a paid prompt.
 */
export function renderStrict(
  text: string,
  vars: RenderVars,
  label: string,
  hint = "bind them in render.vars",
): string {
  const unbound = placeholderNames(text).filter((name) => !Object.hasOwn(vars, name));
  if (unbound.length > 0) {
    throw new Error(
      `unbound template placeholder(s) in ${label}: ${unbound.map((name) => `{{${name}}}`).join(", ")} — ${hint}`,
    );
  }
  return text.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(vars, name) ? vars[name] : match,
  );
}
