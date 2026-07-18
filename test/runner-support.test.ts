import { expect, test } from "bun:test";
import { validateRunnerSupport } from "../src/engine/compare";
import type { CompareConfig, EvalCaseConfig } from "../src/engine/config";
import type { Runner } from "../src/types";

const textOnlyRunner: Runner = {
  name: "openai",
  capabilities: { sandboxTools: false, skillRegistry: false, images: true },
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
    arms: {
      baseline: { model: "gpt-4o-mini", runner: "openai" },
      proposed: { model: "gpt-4o-mini", runner: "openai" },
    },
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
        images: [],
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

test("mixed arms validate per arm: the openai arm rejects command graders, text graders pass both", () => {
  const toolRunner: Runner = {
    name: "claude-p",
    capabilities: { sandboxTools: true, skillRegistry: true, images: false },
    async run() {
      throw new Error("unused");
    },
  };

  // Text-graded scenarios are fine on both arms of a claude-p vs openai comparison.
  const textGraded = makeConfig({
    arms: {
      baseline: { model: "sonnet", runner: "claude-p" },
      proposed: { model: "llama3.1", runner: "openai" },
    },
  });
  expect(() => validateRunnerSupport(textGraded, toolRunner)).not.toThrow();
  expect(() => validateRunnerSupport(textGraded, textOnlyRunner)).not.toThrow();

  // A command grader passes the claude-p arm but must reject on the openai arm.
  const commandGraded = makeConfig(
    {
      arms: {
        baseline: { model: "sonnet", runner: "claude-p" },
        proposed: { model: "llama3.1", runner: "openai" },
      },
    },
    { grader: { type: "command", command: "bun test" } },
  );
  expect(() => validateRunnerSupport(commandGraded, toolRunner)).not.toThrow();
  expect(() => validateRunnerSupport(commandGraded, textOnlyRunner)).toThrow(/text-only/);
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
