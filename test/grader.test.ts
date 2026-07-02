import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { gradeRun } from "../src/engine/grader";

const run = {
  output: "route returned ok",
  costUsd: 0,
  turns: 1,
  durationMs: 1,
  models: [],
  raw: {},
};

test("text grader checks required and forbidden text", async () => {
  await expect(
    gradeRun({ type: "text", contains: ["ok"], notContains: ["error"] }, { run, sandboxDir: process.cwd() }),
  ).resolves.toMatchObject({ pass: true });

  await expect(
    gradeRun({ type: "text", contains: ["missing"] }, { run, sandboxDir: process.cwd() }),
  ).resolves.toMatchObject({ pass: false });
});

test("command grader runs inside the sandbox", async () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-eval-grader-test-"));
  try {
    writeFileSync(join(dir, "artifact.txt"), "ok", "utf8");
    const grade = await gradeRun(
      { type: "command", command: "test -f artifact.txt", timeoutMs: 1_000 },
      { run, sandboxDir: dir },
    );
    expect(grade.pass).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
