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
