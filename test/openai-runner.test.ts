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
  expect(claude.capabilities).toEqual({ sandboxTools: true, skillRegistry: true });

  const openai = createRunner("openai", { baseUrl: "http://localhost:8080/v1" });
  expect(openai.name).toBe("openai");
  expect(openai.capabilities).toEqual({ sandboxTools: false, skillRegistry: false });
});
