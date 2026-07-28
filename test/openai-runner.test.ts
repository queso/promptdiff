import { expect, test } from "bun:test";
import { createRunner } from "../src/runner";
import { buildChatRequest, OpenAiCompatRunner } from "../src/runner/openai-compat";

const baseOptions = {
  systemPrompt: "You are a careful assistant.",
  userPrompt: "do work",
  model: "gpt-4o-mini",
  cwd: "/tmp/sandbox",
  addDirs: [],
  tools: "",
  timeoutMs: 5_000,
  maxBudgetUsd: 1,
};

function completion(content: string, model = "gpt-4o-mini-2024"): string {
  return JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function mockFetch(handler: (url: string, init: RequestInit) => Response): {
  fetchFn: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchFn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as typeof fetch;
  return { fetchFn, calls };
}

test("buildChatRequest maps system and user prompts to chat messages", () => {
  const request = buildChatRequest(baseOptions);
  expect(request.model).toBe("gpt-4o-mini");
  expect(request.messages).toEqual([
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "do work" },
  ]);

  const noSystem = buildChatRequest({ ...baseOptions, systemPrompt: "   " });
  expect(noSystem.messages).toEqual([{ role: "user", content: "do work" }]);
});

test("buildChatRequest rejects append mode — there is no harness prompt to append to", () => {
  expect(() => buildChatRequest({ ...baseOptions, systemPromptMode: "append" })).toThrow(
    /no default harness prompt/,
  );
});

test("OpenAiCompatRunner posts to <baseUrl>/chat/completions and normalizes the result", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response(completion("all good")));
  const runner = new OpenAiCompatRunner({
    baseUrl: "http://localhost:11434/v1/",
    apiKey: "sk-test",
    fetchFn,
  });

  const result = await runner.run(baseOptions);
  expect(result.output).toBe("all good");
  expect(result.turns).toBe(1);
  expect(result.costUsd).toBe(0);
  expect(result.models).toEqual(["gpt-4o-mini-2024"]);

  expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(headers.authorization).toBe("Bearer sk-test");
  const body = JSON.parse(String(calls[0]?.init.body));
  expect(body.model).toBe("gpt-4o-mini");
  expect(body.messages).toHaveLength(2);
});

test("OpenAiCompatRunner omits the auth header when no API key is configured", async () => {
  const { fetchFn, calls } = mockFetch(() => new Response(completion("ok")));
  const runner = new OpenAiCompatRunner({ baseUrl: "http://localhost:8080/v1", apiKey: "", fetchFn });

  await runner.run(baseOptions);
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(headers.authorization).toBeUndefined();
});

test("OpenAiCompatRunner surfaces HTTP errors and malformed completions", async () => {
  const denied = new OpenAiCompatRunner({
    baseUrl: "http://localhost:8080/v1",
    apiKey: "sk-test",
    fetchFn: mockFetch(() => new Response("nope", { status: 401 })).fetchFn,
  });
  expect(denied.run(baseOptions)).rejects.toThrow(/returned 401/);

  const empty = new OpenAiCompatRunner({
    baseUrl: "http://localhost:8080/v1",
    apiKey: "sk-test",
    fetchFn: mockFetch(() => new Response(JSON.stringify({ choices: [] }))).fetchFn,
  });
  expect(empty.run(baseOptions)).rejects.toThrow(/no choices\[0\]\.message\.content/);
});

test("createRunner builds runners with the right capabilities", () => {
  const claude = createRunner("claude-p");
  expect(claude.name).toBe("claude-p");
  expect(claude.capabilities).toEqual({ sandboxTools: true, skillRegistry: true, images: false });

  const openai = createRunner("openai", { baseUrl: "http://localhost:8080/v1" });
  expect(openai.name).toBe("openai");
  expect(openai.capabilities).toEqual({ sandboxTools: false, skillRegistry: false, images: true });
});

test("buildChatRequest attaches images as data-URI content parts before the text", () => {
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "pd-img-"));
  const imagePath = require("node:path").join(dir, "spool.png");
  // 1x1 transparent PNG
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  require("node:fs").writeFileSync(imagePath, pngBytes);

  const request = buildChatRequest({ ...baseOptions, images: [imagePath] });
  const user = request.messages.at(-1);
  expect(user?.role).toBe("user");
  const parts = user?.content;
  if (typeof parts === "string" || parts === undefined) throw new Error("expected content parts");
  expect(parts).toHaveLength(2);
  expect(parts[0]).toEqual({
    type: "image_url",
    image_url: { url: `data:image/png;base64,${pngBytes.toString("base64")}` },
  });
  expect(parts[1]).toEqual({ type: "text", text: "do work" });

  require("node:fs").rmSync(dir, { recursive: true, force: true });
});

test("buildChatRequest rejects unsupported image extensions before any request", () => {
  expect(() => buildChatRequest({ ...baseOptions, images: ["/tmp/photo.tiff"] })).toThrow(
    /unsupported image type/,
  );
});

test("buildChatRequest merges requestParams without clobbering model or messages", () => {
  const request = buildChatRequest({
    ...baseOptions,
    requestParams: { max_tokens: 512, temperature: 0, model: "evil-override" },
  });
  expect(request.max_tokens).toBe(512);
  expect(request.temperature).toBe(0);
  expect(request.model).toBe("gpt-4o-mini");
});

test("OpenAiCompatRunner retries timeouts up to `retries` extra attempts", async () => {
  let attempts = 0;
  const fetchFn = (async () => {
    attempts += 1;
    if (attempts < 3) {
      const err = new DOMException("The operation timed out.", "TimeoutError");
      throw err;
    }
    return new Response(completion("recovered"));
  }) as unknown as typeof fetch;

  const runner = new OpenAiCompatRunner({ baseUrl: "http://x/v1", retries: 2, backoffMs: () => 0, fetchFn });
  const result = await runner.run(baseOptions);
  expect(result.output).toBe("recovered");
  expect(attempts).toBe(3);

  attempts = 0;
  const noRetry = new OpenAiCompatRunner({ baseUrl: "http://x/v1", retries: 0, backoffMs: () => 0, fetchFn });
  await expect(noRetry.run(baseOptions)).rejects.toThrow(/after 1 attempts/);
});

test("OpenAiCompatRunner retries 429/5xx but fails 4xx immediately", async () => {
  let attempts = 0;
  const flaky = (async () => {
    attempts += 1;
    return attempts < 3
      ? new Response("service overloaded", { status: attempts === 1 ? 503 : 429 })
      : new Response(completion("recovered"));
  }) as unknown as typeof fetch;

  // Default retries (2) ride out a 503 then a 429 — the exact class that was
  // killing whole compares against Fireworks.
  const runner = new OpenAiCompatRunner({ baseUrl: "http://x/v1", backoffMs: () => 0, fetchFn: flaky });
  const result = await runner.run(baseOptions);
  expect(result.output).toBe("recovered");
  expect(attempts).toBe(3);

  // Deterministic failures must not burn retries: one attempt, immediate error.
  let badRequests = 0;
  const badRequest = (async () => {
    badRequests += 1;
    return new Response("bad request", { status: 400 });
  }) as unknown as typeof fetch;
  const strict = new OpenAiCompatRunner({ baseUrl: "http://x/v1", backoffMs: () => 0, fetchFn: badRequest });
  await expect(strict.run(baseOptions)).rejects.toThrow(/returned 400/);
  expect(badRequests).toBe(1);

  // Exhausted retries report the attempt count.
  const alwaysDown = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  const exhausted = new OpenAiCompatRunner({ baseUrl: "http://x/v1", retries: 1, backoffMs: () => 0, fetchFn: alwaysDown });
  await expect(exhausted.run(baseOptions)).rejects.toThrow(/returned 503.*after 2 attempts/);
});
