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
  const dir = mkdtempSync(join(tmpdir(), "promptdiff-grader-test-"));
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

test("command graders receive the run output via $PROMPTDIFF_OUTPUT_FILE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pd-grade-out-"));
  const grade = await gradeRun(
    { type: "command", command: 'grep -q "the model said this" "$PROMPTDIFF_OUTPUT_FILE"' },
    { run: { ...run, output: "well, the model said this indeed" }, sandboxDir: dir },
  );
  expect(grade.pass).toBe(true);

  const miss = await gradeRun(
    { type: "command", command: 'grep -q "something else" "$PROMPTDIFF_OUTPUT_FILE"' },
    { run: { ...run, output: "well, the model said this indeed" }, sandboxDir: dir },
  );
  expect(miss.pass).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});
