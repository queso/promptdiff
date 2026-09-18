import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunResult, Runner, RunnerRunOptions } from "../types";

interface ClaudeJsonResult {
  type?: unknown;
  result?: unknown;
  subtype?: unknown;
  total_cost_usd?: unknown;
  num_turns?: unknown;
  duration_ms?: unknown;
  modelUsage?: unknown;
  errors?: unknown;
}

export function buildClaudeArgs(options: RunnerRunOptions & { systemPromptFile: string }): string[] {
  const systemPromptArgs =
    options.systemPromptMode === "append"
      ? options.systemPrompt.trim().length > 0
        ? ["--append-system-prompt", options.systemPrompt]
        : []
      : ["--system-prompt-file", options.systemPromptFile];

  // "--tools" controls availability only; an explicit tool list still hits
  // permission denials in headless mode (Bash especially). Granting the same
  // list via --allowedTools makes list-mode evals actually able to act.
  const toolArgs =
    options.tools === "" || options.tools === "default"
      ? ["--tools", options.tools]
      : ["--tools", options.tools, "--allowedTools", options.tools];

  // A transcript sink needs the per-event stream; the terminal event of that
  // stream is the same result object --output-format json prints on its own.
  // stream-json is only valid with --verbose under -p.
  const outputArgs =
    options.onStreamEvent === undefined
      ? ["--output-format", "json"]
      : ["--output-format", "stream-json", "--verbose"];

  const args = [
    "-p",
    options.userPrompt,
    ...systemPromptArgs,
    ...outputArgs,
    "--model",
    options.model,
    ...toolArgs,
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    ...(options.maxTurns === undefined ? [] : ["--max-turns", String(options.maxTurns)]),
    "--no-session-persistence",
    // Headless denies file edits without an explicit permission mode, which breaks
    // artifact-mode agents that must write outputs (e.g. findings.json) into the
    // sandbox. acceptEdits is safe: text mode passes --tools "" so nothing can write,
    // and artifact mode's cwd IS the disposable sandbox.
    "--permission-mode",
    "acceptEdits",
  ];

  if (options.addDirs.length > 0) {
    args.push("--add-dir", ...options.addDirs);
  }

  return args;
}

export class ClaudePrintRunner implements Runner {
  readonly name = "claude-p";
  readonly capabilities = { sandboxTools: true, skillRegistry: true, images: false, streamEvents: true };

  constructor(private readonly claudeBin = "claude") {}

  async run(options: RunnerRunOptions): Promise<RunResult> {
    const promptDir = mkdtempSync(join(tmpdir(), "promptdiff-prompt-"));
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

      const sink = options.onStreamEvent;
      const [out, stderr, code] = await Promise.all([
        sink === undefined ? readWholeStdout(proc.stdout) : consumeStreamJson(proc.stdout, sink),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timeout);

      if (timedOut) {
        throw new Error(`claude timed out after ${options.timeoutMs}ms`);
      }
      if (code !== 0) {
        // A turn-cap stop is a measured outcome, not a crash: claude may exit
        // non-zero with the full result JSON on stdout. Return it so the engine
        // can score the run as a failure instead of aborting the comparison.
        // Only a terminal event counts — a result-shaped event with more stream
        // after it says nothing about how the run ended, and scoring it would
        // turn a crash into a data point.
        const terminal = out.resultIsTerminal ? out.result : undefined;
        const capped = terminal ?? tryParseClaudeJson(out.text);
        if (capped?.subtype === "error_max_turns") {
          return normalizeClaudeResult(capped);
        }
        // A non-terminal event still beats a bare exit code in an error message,
        // and a message is not a score — so this one keeps using out.result.
        throw new Error(describeClaudeFailure(code, out.text, stderr, options.maxBudgetUsd, out.result));
      }

      if (sink !== undefined) {
        // A stream killed mid-flight (SIGTERM, a crashed CLI) ends without its
        // terminal event, so "the last line is the result" is not safe. Neither
        // is a result event that fired mid-stream and was then followed by more
        // output, even on a clean exit. Either way there is no outcome to score,
        // and the lines already written stay on disk as evidence. The two causes
        // get separate messages: a run that hard-fails here is only worth failing
        // loudly if whoever reads the message can tell which one happened.
        if (out.result === undefined) {
          throw new Error(`claude produced no terminal result event${tailForMessage(out.text)}`);
        }
        if (!out.resultIsTerminal) {
          throw new Error(
            `claude emitted a result event before the end of the stream — refusing to score a ` +
              `non-terminal event${tailForMessage(out.text)}`,
          );
        }
        return normalizeClaudeResult(out.result);
      }

      let parsed: ClaudeJsonResult;
      try {
        parsed = JSON.parse(out.text) as ClaudeJsonResult;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`claude returned invalid JSON: ${reason}\n${out.text.slice(0, 1_500)}`);
      }

      return normalizeClaudeResult(parsed);
    } finally {
      rmSync(promptDir, { recursive: true, force: true });
    }
  }
}

/**
 * A budget abort exits 1 with EMPTY stderr but a full JSON result on stdout
 * ("subtype": "error_max_budget_usd") — without decoding it, the failure is
 * indistinguishable from a crash and has cost real debug cycles.
 */
export function describeClaudeFailure(
  code: number,
  stdout: string,
  stderr: string,
  maxBudgetUsd: number,
  /** Terminal result event, already decoded — stream-json stdout will not parse whole. */
  streamResult?: ClaudeJsonResult,
): string {
  const parsed = streamResult ?? tryParseClaudeJson(stdout);

  if (parsed && typeof parsed === "object") {
    if (parsed.subtype === "error_max_budget_usd") {
      const spent = typeof parsed.total_cost_usd === "number" ? ` after spending $${parsed.total_cost_usd.toFixed(4)}` : "";
      return `claude hit the $${maxBudgetUsd} max budget${spent} — raise --max-budget-usd / maxBudgetUsd (the cap is checked between turns, so artifact-mode runs need headroom)`;
    }
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      return `claude exited ${code}: ${parsed.errors.map(String).join("; ").slice(0, 1_500)}`;
    }
  }

  const detail = stderr.trim().length > 0 ? stderr : stdout;
  return `claude exited ${code}: ${detail.slice(0, 1_500)}`;
}

/** Bytes of stdout kept for diagnostics when the stream is too big to hold. */
const STDOUT_TAIL_CHARS = 4_000;

interface ClaudeStdout {
  /** stdout text for error messages: all of it in json mode, a tail in stream mode. */
  text: string;
  /** Terminal `result` event; only stream mode decodes one while reading. */
  result?: ClaudeJsonResult;
  /**
   * Whether `result` was the last line the stream produced, rather than a
   * result-shaped event with more stream (or a truncated fragment) after it.
   * Only a terminal event may be scored as a run's outcome.
   */
  resultIsTerminal: boolean;
}

async function readWholeStdout(stdout: ReadableStream<Uint8Array>): Promise<ClaudeStdout> {
  // json mode decodes no event stream, so it has no terminal result event;
  // its parse runs on the whole buffered text instead.
  return { text: await new Response(stdout).text(), resultIsTerminal: false };
}

/**
 * Reads NDJSON as it arrives, hands each line to the sink, and keeps only the
 * terminal `result` event. Buffering the whole verbose stream to parse it
 * afterwards is the memory cost transcript capture exists to avoid, and a
 * killed run would lose every line it had already printed.
 */
async function consumeStreamJson(
  stdout: ReadableStream<Uint8Array>,
  onStreamEvent: (line: string) => void,
): Promise<ClaudeStdout> {
  const decoder = new TextDecoder();
  let pending = "";
  let tail = "";
  let result: ClaudeJsonResult | undefined;
  let resultIsTerminal = false;

  const handleLine = (line: string): void => {
    if (line.trim().length === 0) return;
    onStreamEvent(line);
    tail = (tail + line + "\n").slice(-STDOUT_TAIL_CHARS);
    const event = tryParseClaudeJson(line);
    // The last result event wins when more than one appears. A subagent or
    // compaction could in principle emit one mid-stream, so callers get told
    // whether the stream ended on it: the success path trusts out.result only
    // after a clean exit, and the failure path only when it was terminal.
    // Any later line — another event, or a truncated trailing fragment —
    // demotes it.
    if (event?.type === "result") {
      result = event;
      resultIsTerminal = true;
    } else {
      resultIsTerminal = false;
    }
  };

  for await (const chunk of stdout) {
    // `pending` up to this length was already scanned for "\n" with none
    // found (that's why the previous iteration's while loop exited) — only
    // the newly appended bytes need to be searched. Once a line is sliced
    // off below, the remaining buffer is unscanned from its own start 0.
    // Accumulating into a string looks quadratic and measures linear: the
    // engine ropes the `+=` instead of copying, and this offset keeps the
    // scan off old bytes. A 16MB single line costs ~3ms, a 4MB one under 1ms,
    // so a byte-buffer rewrite would add UTF-8 boundary handling here for no
    // gain worth having.
    const scanned = pending.length;
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n", scanned);
    while (newline !== -1) {
      handleLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  pending += decoder.decode();
  // A kill mid-line leaves an unterminated fragment. It is not parseable, but
  // for a token-economics investigation a truncated event is still evidence.
  if (pending.length > 0) handleLine(pending);

  return { text: tail, result, resultIsTerminal };
}

function tailForMessage(text: string): string {
  return text.trim().length === 0 ? "" : ` (last output: ${text.slice(-500)})`;
}

function tryParseClaudeJson(stdout: string): ClaudeJsonResult | undefined {
  try {
    return JSON.parse(stdout) as ClaudeJsonResult;
  } catch {
    return undefined;
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
    ...(result.subtype === "error_max_turns" ? { exhaustedTurns: true } : {}),
    raw: result,
  };
}
