import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { loadCompareConfig } from "../src/engine/config";

// Every shipped example must load through the real config loader, so schema
// drift breaks CI instead of the first user who copies an example.
const examplesRoot = join(import.meta.dir, "..", "examples");

const exampleDirs = readdirSync(examplesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test("examples directory is not empty", () => {
  expect(exampleDirs.length).toBeGreaterThan(0);
});

for (const dir of exampleDirs) {
  test(`examples/${dir}/scenario.json loads (fixture paths included)`, () => {
    const scenario = join(examplesRoot, dir, "scenario.json");
    // Measure-only examples have no proposed arm; singleArm accepts both
    // shapes, and loading also validates that referenced files exist.
    const config = loadCompareConfig(scenario, {}, { singleArm: true });
    expect(config.cases.length).toBeGreaterThan(0);
  });
}
