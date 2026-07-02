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

test("buildClaudeArgs append mode layers on the default prompt instead of replacing it", () => {
  const args = buildClaudeArgs({
    systemPrompt: "agent persona",
    systemPromptMode: "append",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: [],
    tools: "default",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  });

  // Replacing the system prompt would strip harness machinery like the skill
  // registry — the very thing install-delivery evals measure.
  expect(args).toContain("--append-system-prompt");
  expect(args).toContain("agent persona");
  expect(args).not.toContain("--system-prompt-file");

  const empty = buildClaudeArgs({
    systemPrompt: "   ",
    systemPromptMode: "append",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: [],
    tools: "default",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  });
  expect(empty).not.toContain("--append-system-prompt");
  expect(empty).not.toContain("--system-prompt-file");
});

test("buildClaudeArgs sets acceptEdits so artifact-mode agents can write outputs", () => {
  const args = buildClaudeArgs({
    systemPrompt: "system",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: [],
    tools: "default",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  });

  // Headless claude denies file writes without an explicit permission mode; without
  // this, any scenario whose grader reads an agent-written artifact fails every run.
  const i = args.indexOf("--permission-mode");
  expect(i).toBeGreaterThan(-1);
  expect(args[i + 1]).toBe("acceptEdits");
});
