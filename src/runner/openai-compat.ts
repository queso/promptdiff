import { readFileSync } from "node:fs";
import { extname } from "node:path";
import type { RunResult, Runner, RunnerRunOptions } from "../types";

export interface OpenAiCompatRunnerConfig {
  /** Defaults to $OPENAI_BASE_URL, then https://api.openai.com/v1. */
  baseUrl?: string;
  /** Defaults to $OPENAI_API_KEY. Optional — local servers often need none. */
  apiKey?: string;
  /** Extra attempts after a transient failure (timeout, connect error, 429/5xx). Default 2. */
  retries?: number;
  /** Backoff before retry attempt N (1-based); injectable for tests. */
  backoffMs?: (attempt: number) => number;
  fetchFn?: typeof fetch;
}

/** Failure modes worth retrying: the request produced nothing durable and the cause is time-bound. */
class TransientError extends Error {}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatRequest {
  model: string;
  messages: Array<{ role: "system" | "user"; content: string | ChatContentPart[] }>;
  [param: string]: unknown;
}

const IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** File path → data URI. Throws on unsupported extensions before any paid run. */
export function imageDataUri(path: string): string {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) {
    throw new Error(`unsupported image type "${extname(path)}" (${path}); supported: ${Object.keys(IMAGE_MIME).join(", ")}`);
  }
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

interface ChatCompletion {
  model?: unknown;
  choices?: unknown;
  usage?: unknown;
}

export function buildChatRequest(options: RunnerRunOptions): ChatRequest {
  if (options.systemPromptMode === "append") {
    throw new Error(
      'runner "openai" has no default harness prompt to append to (install delivery is claude-p only)',
    );
  }
  const messages: ChatRequest["messages"] = [];
  if (options.systemPrompt.trim().length > 0) {
    messages.push({ role: "system", content: options.systemPrompt });
  }
  const images = options.images ?? [];
  if (images.length > 0) {
    messages.push({
      role: "user",
      content: [
        ...images.map((path): ChatContentPart => ({ type: "image_url", image_url: { url: imageDataUri(path) } })),
        { type: "text", text: options.userPrompt },
      ],
    });
  } else {
    messages.push({ role: "user", content: options.userPrompt });
  }
  // Spread first so extra params can never clobber model or messages.
  return { ...(options.requestParams ?? {}), model: options.model, messages };
}

/**
 * Single-shot chat-completion runner for any OpenAI-compatible endpoint
 * (OpenAI, ollama, vLLM, llama.cpp, OpenRouter, ...). Text mode only: no
 * tools, no sandbox execution, no skill registry.
 */
export class OpenAiCompatRunner implements Runner {
  readonly name = "openai";
  readonly capabilities = { sandboxTools: false, skillRegistry: false, images: true };

  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly retries: number;
  private readonly backoffMs: (attempt: number) => number;
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenAiCompatRunnerConfig = {}) {
    this.baseUrl = (config.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;
    this.retries = config.retries ?? 2;
    this.backoffMs = config.backoffMs ?? ((attempt) => Math.min(4_000, 500 * 2 ** (attempt - 1)));
    this.fetchFn = config.fetchFn ?? fetch;
  }

  async run(options: RunnerRunOptions): Promise<RunResult> {
    // Transient failures (timeout, connect error, 429/5xx) retry with backoff —
    // one 503 at run 4-of-5 must not throw away a whole paid compare. Anything
    // deterministic (4xx, bad JSON, malformed completion) still throws at once.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      if (attempt > 0) {
        await Bun.sleep(this.backoffMs(attempt));
      }
      try {
        return await this.runOnce(options);
      } catch (error) {
        if (!(error instanceof TransientError)) throw error;
        lastError = error;
      }
    }
    throw new Error(`${lastError?.message} (after ${this.retries + 1} attempts)`);
  }

  private async runOnce(options: RunnerRunOptions): Promise<RunResult> {
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const started = Date.now();
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildChatRequest(options)),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new TransientError(`${url} timed out after ${options.timeoutMs}ms`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new TransientError(`request to ${url} failed: ${reason}`);
    }

    const body = await response.text();
    if (!response.ok) {
      const message = `${url} returned ${response.status}: ${body.slice(0, 1_500)}`;
      // 429/5xx are load conditions; other statuses are wrong requests.
      if (response.status === 429 || response.status >= 500) {
        throw new TransientError(message);
      }
      throw new Error(message);
    }

    let parsed: ChatCompletion;
    try {
      parsed = JSON.parse(body) as ChatCompletion;
    } catch {
      throw new Error(`${url} returned invalid JSON: ${body.slice(0, 1_500)}`);
    }

    return normalizeChatCompletion(parsed, options.model, Date.now() - started);
  }
}

function normalizeChatCompletion(result: ChatCompletion, requestedModel: string, durationMs: number): RunResult {
  const choice = Array.isArray(result.choices) ? result.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  const content = message?.content;
  if (typeof content !== "string") {
    throw new Error(`chat completion has no choices[0].message.content string: ${JSON.stringify(result).slice(0, 1_500)}`);
  }

  return {
    output: content,
    // OpenAI-compatible endpoints report tokens, not USD; usage stays in `raw`.
    costUsd: 0,
    turns: 1,
    durationMs,
    models: [typeof result.model === "string" ? result.model : requestedModel],
    raw: result,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
