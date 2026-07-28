import { expect, test } from "bun:test";

test("compare help documents runs, graders, and assertions", () => {
  const result = Bun.spawnSync(["./promptdiff", "compare", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("5 baseline runs and 5 proposed runs");
  expect(stdout).toContain("graders:");
  expect(stdout).toContain("text     checks the run's final output");
  expect(stdout).toContain("command  runs a shell command inside the per-run sandbox");
  expect(stdout).toContain("assertions:");
  expect(stdout).toContain("judge    an explicit judge model grades the final output");
  expect(stdout).toContain("\"grader\": { \"type\": \"command\", \"command\": \"bun test\" }");
});

test("calibrate help documents fixtures, the per-class bar, and the gate", () => {
  const result = Bun.spawnSync(["./promptdiff", "calibrate", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = result.stdout.toString();
  expect(result.exitCode).toBe(0);
  expect(stdout).toContain("usage: promptdiff calibrate --rubric <rubric.md> --model <judge-model>");
  expect(stdout).toContain(".fixtures/pass/*.md");
  expect(stdout).toContain(".fixtures/fail/*.md");
  expect(stdout).toContain("per class");
  expect(stdout).toContain("the compare/measure gate is what enforces the bar");
});
