export type RunMode = "text" | "artifact";

export interface RunResult {
  output: string;
  costUsd: number;
  turns: number;
  durationMs: number;
  models: string[];
  raw: unknown;
}

export interface RunnerRunOptions {
  systemPrompt: string;
  /**
   * "replace" (default) swaps the whole system prompt via --system-prompt-file —
   * right for controlled inline evals. "append" layers the text on top of the
   * default harness prompt via --append-system-prompt, preserving harness
   * machinery like the skill registry; required for install-delivery evals.
   */
  systemPromptMode?: "replace" | "append";
  userPrompt: string;
  model: string;
  cwd: string;
  addDirs: string[];
  tools: string;
  timeoutMs: number;
  maxBudgetUsd: number;
}

export interface Runner {
  run(options: RunnerRunOptions): Promise<RunResult>;
}
