import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildClaudeArgs, ClaudePrintRunner, describeClaudeFailure } from "../src/runner/claude-p";

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

test("buildClaudeArgs grants explicit tool lists via --allowedTools", () => {
  const listArgs = buildClaudeArgs({
    systemPrompt: "system",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: [],
    tools: "Bash,Read,Grep",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  });
  // --tools alone leaves Bash permission-denied in headless mode.
  expect(listArgs).toContain("--allowedTools");
  expect(listArgs.filter((arg) => arg === "Bash,Read,Grep")).toHaveLength(2);

  for (const tools of ["", "default"]) {
    const args = buildClaudeArgs({
      systemPrompt: "system",
      systemPromptFile: "/tmp/system.md",
      userPrompt: "do work",
      model: "sonnet",
      cwd: "/tmp/sandbox",
      addDirs: [],
      tools,
      timeoutMs: 1_000,
      maxBudgetUsd: 0.25,
    });
    expect(args).not.toContain("--allowedTools");
  }
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

// Captured from a real budget abort (claude -p --max-budget-usd 0.001): exit 1,
// empty stderr, full JSON result on stdout.
const BUDGET_ABORT_STDOUT = JSON.stringify({
  type: "result",
  subtype: "error_max_budget_usd",
  is_error: true,
  num_turns: 1,
  total_cost_usd: 0.0287771,
  terminal_reason: "budget_exhausted",
  errors: ["Reached maximum budget ($0.001)"],
});

test("describeClaudeFailure names a budget abort instead of a bare exit code", () => {
  const message = describeClaudeFailure(1, BUDGET_ABORT_STDOUT, "", 0.001);
  expect(message).toContain("max budget");
  expect(message).toContain("$0.0288");
  expect(message).toContain("raise --max-budget-usd");
  expect(message).not.toContain("claude exited 1");
});

test("describeClaudeFailure surfaces structured errors and falls back to raw streams", () => {
  const structured = describeClaudeFailure(
    1,
    JSON.stringify({ subtype: "error_during_execution", errors: ["tool Bash crashed"] }),
    "",
    1,
  );
  expect(structured).toBe("claude exited 1: tool Bash crashed");

  // stderr wins when present; stdout fills in when stderr is empty (the old
  // message was blank in exactly the case that needed diagnosing).
  expect(describeClaudeFailure(2, "not json", "boom", 1)).toBe("claude exited 2: boom");
  expect(describeClaudeFailure(2, "partial output", "", 1)).toBe("claude exited 2: partial output");
});

test("buildClaudeArgs passes --max-turns only when a cap is set", () => {
  const base = {
    systemPrompt: "system",
    systemPromptFile: "/tmp/system.md",
    userPrompt: "do work",
    model: "sonnet",
    cwd: "/tmp/sandbox",
    addDirs: [],
    tools: "",
    timeoutMs: 1_000,
    maxBudgetUsd: 0.25,
  };

  const capped = buildClaudeArgs({ ...base, maxTurns: 25 });
  const i = capped.indexOf("--max-turns");
  expect(i).toBeGreaterThan(-1);
  expect(capped[i + 1]).toBe("25");

  expect(buildClaudeArgs(base)).not.toContain("--max-turns");
});

// Captured shape of a turn-cap stop: full result JSON on stdout with
// subtype "error_max_turns" (exit code varies by claude version).
const MAX_TURNS_STDOUT = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  result: "partial answer",
  num_turns: 25,
  total_cost_usd: 0.42,
  duration_ms: 60_000,
  modelUsage: { "claude-sonnet-5": { costUSD: 0.42 } },
});

test("a turn-capped run is returned as a measured outcome, not thrown as a crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, `#!/bin/sh\necho '${MAX_TURNS_STDOUT}'\nexit 1\n`, { mode: 0o755 });

    const runner = new ClaudePrintRunner(bin);
    const result = await runner.run({
      systemPrompt: "system",
      userPrompt: "do work",
      model: "sonnet",
      cwd: dir,
      addDirs: [],
      tools: "",
      timeoutMs: 10_000,
      maxBudgetUsd: 1,
      maxTurns: 25,
    });

    expect(result.exhaustedTurns).toBe(true);
    expect(result.output).toBe("partial answer");
    expect(result.turns).toBe(25);
    expect(result.costUsd).toBeCloseTo(0.42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-zero exits without a turn-cap subtype still throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    const bin = join(dir, "fake-claude");
    writeFileSync(bin, `#!/bin/sh\necho boom >&2\nexit 2\n`, { mode: 0o755 });

    const runner = new ClaudePrintRunner(bin);
    await expect(
      runner.run({
        systemPrompt: "system",
        userPrompt: "do work",
        model: "sonnet",
        cwd: dir,
        addDirs: [],
        tools: "",
        timeoutMs: 10_000,
        maxBudgetUsd: 1,
      }),
    ).rejects.toThrow("claude exited 2: boom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
