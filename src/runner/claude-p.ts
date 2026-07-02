import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, Runner, RunnerRunOptions } from "../types";

interface ClaudeJsonResult {
  result?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
  modelUsage?: unknown;
}

export function buildClaudeArgs(options: RunnerRunOptions & { systemPromptFile: string }): string[] {
  const args = [
    "-p",
    options.userPrompt,
    "--system-prompt-file",
    options.systemPromptFile,
    "--output-format",
    "json",
    "--model",
    options.model,
    "--tools",
    options.tools,
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    "--no-session-persistence",
  ];

  if (options.addDirs.length > 0) {
    args.push("--add-dir", ...options.addDirs);
  }

  return args;
}

export class ClaudePrintRunner implements Runner {
  constructor(private readonly claudeBin = "claude") {}

  async run(options: RunnerRunOptions): Promise<RunResult> {
    const promptDir = mkdtempSync(join(tmpdir(), "skill-eval-prompt-"));
    const systemPromptFile = join(promptDir, "system-prompt.md");
    writeFileSync(systemPromptFile, options.systemPrompt, "utf8");

    try {
      const args = buildClaudeArgs({ ...options, systemPromptFile });
      const proc = Bun.spawn([this.claudeBin, ...args], {
        cwd: options.cwd,
        stdout: "pipe",
        stderr: "pipe",
      });

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");
        setTimeout(() => proc.kill("SIGKILL"), 2_000);
      }, options.timeoutMs);

      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeout);

      if (timedOut) {
        throw new Error(`claude timed out after ${options.timeoutMs}ms`);
      }
      if (code !== 0) {
        throw new Error(`claude exited ${code}: ${stderr.slice(0, 1_500)}`);
      }

      let parsed: ClaudeJsonResult;
      try {
        parsed = JSON.parse(stdout) as ClaudeJsonResult;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`claude returned invalid JSON: ${reason}\n${stdout.slice(0, 1_500)}`);
      }

      return normalizeClaudeResult(parsed);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}

function normalizeClaudeResult(result: ClaudeJsonResult): RunResult {
  const modelUsage = result.modelUsage;
  return {
    output: typeof result.result === "string" ? result.result : "",
    costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
    turns: typeof result.num_turns === "number" ? result.num_turns : 0,
    durationMs: typeof result.duration_ms === "number" ? result.duration_ms : 0,
    models: modelUsage && typeof modelUsage === "object" ? Object.keys(modelUsage) : [],
    raw: result,
  };
}
