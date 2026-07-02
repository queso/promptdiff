import { expect, test } from "bun:test";
import { buildClaudeArgs } from "../src/runner/claude-p";

test("buildClaudeArgs uses a system prompt file, budget, tools, and add-dir", () => {
  const args = buildClaudeArgs({
    systemPrompt: "system",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: ["/tmp/extra-a", "/tmp/extra-b"],
    tools: "",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  });

  expect(args).toContain("--system-prompt-file");
  expect(args).toContain("/tmp/system.md");
  expect(args).toContain("--tools");
  expect(args).toContain("");
  expect(args).toContain("--max-budget-usd");
  expect(args).toContain("0.25");
  expect(args).toContain("--add-dir");
  expect(args).toContain("/tmp/extra-a");
  expect(args).toContain("/tmp/extra-b");
});
