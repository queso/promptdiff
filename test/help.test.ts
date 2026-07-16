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
  expect(stdout).toContain("\"grader\": { \"type\": \"command\", \"command\": \"bun test\" }");
});
