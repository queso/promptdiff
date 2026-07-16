import { expect, test } from "bun:test";
import { validateRunnerSupport } from "../src/engine/compare";
import type { CompareConfig, EvalCaseConfig } from "../src/engine/config";
import type { Runner } from "../src/types";

const textOnlyRunner: Runner = {
  name: "openai",
  capabilities: { sandboxTools: false, skillRegistry: false },
  async run() {
    throw new Error("unused");
  },
};

function makeConfig(overrides: Partial<CompareConfig>, caseOverrides: Partial<EvalCaseConfig> = {}): CompareConfig {
  return {
    name: "support test",
    agent: "/tmp/agent.md",
    baselineSkills: ["/tmp/baseline.md"],
    proposedSkills: ["/tmp/proposed.md"],
    delivery: "inline",
    runner: "openai",
    model: "gpt-4o-mini",
    runs: 1,
    timeoutMs: 1_000,
    maxBudgetUsd: 1,
    addDirs: [],
    sandboxRoot: "/tmp/runs",
    keepSandbox: false,
    cases: [
      {
        name: "target",
        kind: "target",
        prompt: "do it",
        grader: { type: "text", contains: ["ok"] },
        addDirs: [],
        ...caseOverrides,
      },
    ],
    ...overrides,
  };
}

test("text-graded scenarios pass validation on a text-only runner", () => {
  expect(() => validateRunnerSupport(makeConfig({}), textOnlyRunner)).not.toThrow();
});

test("install delivery is rejected on a runner without a skill registry", () => {
  expect(() => validateRunnerSupport(makeConfig({ delivery: "install" }), textOnlyRunner)).toThrow(
    /skill registry/,
  );
});

test("scenarios that need sandbox tools are rejected on a text-only runner", () => {
  // Command graders infer artifact mode, which needs tools.
  const commandGraded = makeConfig({}, { grader: { type: "command", command: "bun test" } });
  expect(() => validateRunnerSupport(commandGraded, textOnlyRunner)).toThrow(/text-only/);

  const explicitTools = makeConfig({ tools: "Bash,Read" });
  expect(() => validateRunnerSupport(explicitTools, textOnlyRunner)).toThrow(/text-only/);

  const artifactMode = makeConfig({}, { mode: "artifact" });
  expect(() => validateRunnerSupport(artifactMode, textOnlyRunner)).toThrow(/text-only/);
});
