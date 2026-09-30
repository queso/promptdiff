/**
 * Package entry point for grader files:
 *
 *   import { grade } from "@theaiteam/promptdiff";
 *
 * Grader files run under `promptdiff grade`, which also resolves the bare
 * "promptdiff" specifier to this module.
 */
export { grade } from "./grade";
export type { ArtifactResult, GradeContext, GraderFile, GraderFn } from "./grade";
