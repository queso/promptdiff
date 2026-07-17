import type { Runner } from "../types";
import { ClaudePrintRunner } from "./claude-p";
import { OpenAiCompatRunner } from "./openai-compat";

export const RUNNER_NAMES = ["claude-p", "openai"] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];

export interface CreateRunnerOptions {
  /** OpenAI-compatible endpoint base URL; ignored by claude-p. */
  baseUrl?: string;
  /** Timeout retries for the openai runner; ignored by claude-p. */
  retries?: number;
}

export function createRunner(name: RunnerName, options: CreateRunnerOptions = {}): Runner {
  switch (name) {
    case "claude-p":
      return new ClaudePrintRunner();
    case "openai":
      return new OpenAiCompatRunner({ baseUrl: options.baseUrl, retries: options.retries });
  }
}

export function runnerNameValue(value: unknown, fallback: RunnerName): RunnerName {
  if (value === undefined) return fallback;
  if (value === "claude-p" || value === "openai") return value;
  throw new Error(`runner must be one of: ${RUNNER_NAMES.join(", ")}`);
}
