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

test("buildClaudeArgs switches to stream-json only when a transcript sink is attached", () => {
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

  expect(buildClaudeArgs(base)).toContain("json");
  expect(buildClaudeArgs(base)).not.toContain("stream-json");
  expect(buildClaudeArgs(base)).not.toContain("--verbose");

  const streaming = buildClaudeArgs({ ...base, onStreamEvent: () => {} });
  const i = streaming.indexOf("--output-format");
  expect(streaming[i + 1]).toBe("stream-json");
  // stream-json is rejected under -p without --verbose.
  expect(streaming).toContain("--verbose");
});

// Captured shape of a stream-json run: NDJSON events, terminal `result` last.
const STREAM_EVENTS = [
  { type: "system", subtype: "init", session_id: "s-1" },
  { type: "assistant", message: { usage: { input_tokens: 12, cache_read_input_tokens: 9_000 } } },
  { type: "assistant", message: { usage: { input_tokens: 40, cache_read_input_tokens: 9_400 } } },
  {
    type: "result",
    subtype: "success",
    result: "done",
    num_turns: 2,
    total_cost_usd: 0.03,
    duration_ms: 4_200,
    modelUsage: { "claude-sonnet-5": { costUSD: 0.03 } },
  },
];

function fakeClaude(dir: string, body: string): string {
  const bin = join(dir, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return bin;
}

const streamRunOptions = (cwd: string, onStreamEvent: (line: string) => void) => ({
  systemPrompt: "system",
  userPrompt: "do work",
  model: "sonnet",
  cwd,
  addDirs: [] as string[],
  tools: "",
  timeoutMs: 10_000,
  maxBudgetUsd: 1,
  onStreamEvent,
});

test("stream mode feeds every event to the sink and scores the terminal result event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    const echoes = STREAM_EVENTS.map((event) => `echo '${JSON.stringify(event)}'`).join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, echoes));

    const lines: string[] = [];
    const result = await runner.run(streamRunOptions(dir, (line) => lines.push(line)));

    // Per-turn usage is the whole point: the aggregate result cannot show how
    // context grew between turn 1 and turn 2.
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[1] ?? "{}").message.usage.cache_read_input_tokens).toBe(9_000);
    expect(JSON.parse(lines[2] ?? "{}").message.usage.cache_read_input_tokens).toBe(9_400);

    expect(result.output).toBe("done");
    expect(result.turns).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(result.models).toEqual(["claude-sonnet-5"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a truncated stream keeps its lines but has no outcome to score", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // Two whole events then a killed mid-line write: no terminal result event.
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `echo '${JSON.stringify(STREAM_EVENTS[1])}'`,
      `printf '%s' '{"type":"assistant","mess'`,
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    await expect(runner.run(streamRunOptions(dir, (line) => lines.push(line)))).rejects.toThrow(
      "no terminal result event",
    );

    // "Last line is the result" is not safe, but the partial stream is still
    // the evidence a token-economics run was after.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('{"type":"assistant","mess');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A result-shaped event that is NOT the real terminal one, the kind a
// subagent or compaction can emit mid-stream. Its "result" text is
// distinctive so a test would notice if it were ever scored as the outcome.
const MID_STREAM_RESULT_EVENT = {
  type: "result",
  subtype: "success",
  result: "mid-stream, not the real outcome",
  num_turns: 1,
  total_cost_usd: 0.01,
};

test("a mid-stream result event is not scored as the outcome when the run then exits non-zero", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // A result event fires mid-stream, then the process dies (exit 1) without
    // ever emitting the real terminal event. A result event is only trusted
    // as terminal when the process also exited cleanly, so this must reject
    // rather than return MID_STREAM_RESULT_EVENT as a scored success.
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `echo '${JSON.stringify(MID_STREAM_RESULT_EVENT)}'`,
      "exit 1",
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    await expect(runner.run(streamRunOptions(dir, (line) => lines.push(line)))).rejects.toThrow(/claude exited 1/);

    // The partial stream is still evidence even though the run is scored as a failure.
    expect(lines).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-stream result event is not scored as the outcome when the run is then killed by a signal", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // Same scenario, but the process dies from a signal (as the timeout path's
    // SIGTERM/SIGKILL would deliver) instead of a self-chosen exit code. A
    // signaled process does not exit 0, so this must reject too.
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `echo '${JSON.stringify(MID_STREAM_RESULT_EVENT)}'`,
      "kill -TERM $$",
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    await expect(runner.run(streamRunOptions(dir, (line) => lines.push(line)))).rejects.toThrow(/claude exited/);

    expect(lines).toHaveLength(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the last result event wins when the run exits cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // A result event fires mid-stream, then the real terminal result event
    // follows, and the process exits 0. The mid-stream event must not win
    // just because it arrived first — only the last one is the outcome.
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `echo '${JSON.stringify(MID_STREAM_RESULT_EVENT)}'`,
      `echo '${JSON.stringify(STREAM_EVENTS[3])}'`,
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    const result = await runner.run(streamRunOptions(dir, (line) => lines.push(line)));

    expect(lines).toHaveLength(3);
    expect(result.output).toBe("done");
    expect(result.turns).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.03);
    expect(result.output).not.toBe(MID_STREAM_RESULT_EVENT.result);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stream mode decodes turn caps and budget aborts out of NDJSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    const capped = fakeClaude(
      dir,
      [`echo '${JSON.stringify(STREAM_EVENTS[0])}'`, `echo '${MAX_TURNS_STDOUT}'`, "exit 1"].join("\n"),
    );
    const cappedResult = await new ClaudePrintRunner(capped).run(streamRunOptions(dir, () => {}));
    expect(cappedResult.exhaustedTurns).toBe(true);
    expect(cappedResult.turns).toBe(25);

    const broke = fakeClaude(
      dir,
      [`echo '${JSON.stringify(STREAM_EVENTS[0])}'`, `echo '${BUDGET_ABORT_STDOUT}'`, "exit 1"].join("\n"),
    );
    // Whole-stdout JSON.parse fails on NDJSON, which would have made a budget
    // abort read as a bare exit code again.
    await expect(new ClaudePrintRunner(broke).run(streamRunOptions(dir, () => {}))).rejects.toThrow("max budget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mid-stream turn-cap event followed by more stream and a crash is not scored as exhaustedTurns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // MAX_TURNS_STDOUT fires mid-stream (not as the last line), another event
    // follows it, and then the process exits non-zero without ever emitting a
    // real terminal result. The run must be reported as a failure — scoring it
    // as exhaustedTurns would corrupt the measurement by turning a crash into
    // a counted, "completed" data point.
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `echo '${MAX_TURNS_STDOUT}'`,
      `echo '${JSON.stringify(STREAM_EVENTS[1])}'`,
      "exit 1",
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    await expect(runner.run(streamRunOptions(dir, (line) => lines.push(line)))).rejects.toThrow(/claude exited 1/);

    expect(lines).toHaveLength(3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single event line spanning many stdout chunks is still read whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-runner-test-"));
  try {
    // A pipe hands back far less than 2MB per read, so a field this large
    // splits the NDJSON line across many stdout chunks (11 here) — the case
    // the per-chunk scan-offset arithmetic has to get right. Built with
    // head/tr rather than an embedded literal: a 2,000,000-character
    // argument to echo risks blowing past ARG_MAX.
    const bigFieldChars = 2_000_000;
    const body = [
      `echo '${JSON.stringify(STREAM_EVENTS[0])}'`,
      `printf '%s' '{"type":"assistant","big":"'`,
      `head -c ${bigFieldChars} /dev/zero | tr '\\0' 'a'`,
      `printf '"}\\n'`,
      `echo '${JSON.stringify(STREAM_EVENTS[3])}'`,
      // A short line after the giant one: if a late chunk happens to land
      // two newlines at once (the giant line's close plus this line's own),
      // a stale scan offset would merge them into one garbled line instead
      // of missing them outright — this line is what would expose that.
      `echo '${JSON.stringify(STREAM_EVENTS[1])}'`,
    ].join("\n");
    const runner = new ClaudePrintRunner(fakeClaude(dir, body));

    const lines: string[] = [];
    const result = await runner.run(streamRunOptions(dir, (line) => lines.push(line)));

    // Exactly the four lines the script printed: init, the giant line, the
    // terminal result, and the trailing line — a dropped, duplicated, or
    // merged newline boundary would show up here as the wrong count.
    expect(lines).toHaveLength(4);

    const big = JSON.parse(lines[1] ?? "{}") as { big: string };
    expect(big.big).toHaveLength(bigFieldChars);
    expect(big.big).toBe("a".repeat(bigFieldChars));

    const trailing = JSON.parse(lines[3] ?? "{}") as { message: { usage: { cache_read_input_tokens: number } } };
    expect(trailing.message.usage.cache_read_input_tokens).toBe(9_000);

    expect(result.output).toBe("done");
    expect(result.turns).toBe(2);
    expect(result.costUsd).toBeCloseTo(0.03);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
