export type RunMode = "text" | "artifact";

export interface RunResult {
  output: string;
  /** USD cost when the runner reports one; 0 when the provider only reports tokens. */
  costUsd: number;
  /** Agentic turns; plain completion runners always report 1. */
  turns: number;
  durationMs: number;
  models: string[];
  raw: unknown;
}

/**
 * What a runner can do beyond "system prompt + user prompt in, text out".
 * The engine validates a scenario's demands against these before any paid run.
 */
export interface RunnerCapabilities {
  /**
   * The runner executes tools inside the sandbox cwd — required for artifact
   * mode, command graders, and any non-empty `tools` value.
   */
  sandboxTools: boolean;
  /**
   * The runner has a harness-managed skill registry and a default system
   * prompt that can be appended to — required for install delivery.
   */
  skillRegistry: boolean;
  /**
   * The runner can attach image files to the user message (vision models) —
   * required for scenarios with `images`.
   */
  images: boolean;
}

export interface RunnerRunOptions {
  systemPrompt: string;
  /**
   * "replace" (default) swaps the whole system prompt — right for controlled
   * inline evals. "append" layers the text on top of the runner's default
   * harness prompt, preserving harness machinery like the skill registry;
   * required for install-delivery evals (skillRegistry runners only).
   */
  systemPromptMode?: "replace" | "append";
  userPrompt: string;
  /** Image file paths attached to the user message (vision evals). */
  images?: string[];
  /** Extra request-body fields for completion runners (e.g. max_tokens, temperature). */
  requestParams?: Record<string, unknown>;
  model: string;
  /** Sandbox directory; graders run here. Agentic runners also execute in it. */
  cwd: string;
  timeoutMs: number;
  // The remaining fields only apply to sandboxTools runners; the engine
  // guarantees they hold their defaults ("", [], any budget) otherwise.
  tools: string;
  addDirs: string[];
  maxBudgetUsd: number;
}

export interface Runner {
  readonly name: string;
  readonly capabilities: RunnerCapabilities;
  run(options: RunnerRunOptions): Promise<RunResult>;
}
