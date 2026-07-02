import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { prepareSandbox } from "../src/engine/sandbox";

test("prepareSandbox copies seed contents and cleans up by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "skill-eval-sandbox-test-"));
  const seed = join(dir, "seed");
  const root = join(dir, "runs");
  try {
    Bun.spawnSync(["mkdir", "-p", seed]);
    writeFileSync(join(seed, "fixture.txt"), "fixture", "utf8");

    const sandbox = prepareSandbox({ root, seed, prefix: "case", keep: false });
    expect(existsSync(join(sandbox.dir, "fixture.txt"))).toBe(true);
    sandbox.cleanup();
    expect(existsSync(sandbox.dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
