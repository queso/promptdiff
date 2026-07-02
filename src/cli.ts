import { readFileSync } from "node:fs";
import { CliError, parseArgs, type FlagSpecs } from "./args";
import { loadCompareConfig, type CompareOverrides } from "./engine/config";
import { formatCompareSummary, runCompare } from "./engine/compare";
import { prepareSandbox } from "./engine/sandbox";
import { assembleSystemPrompt } from "./prompt";
import { ClaudePrintRunner } from "./runner/claude-p";
import type { RunMode, RunnerRunOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUDGET_USD = 1;

const runSpecs: FlagSpecs = {
  agent: { arity: "one" },
  skill: { arity: "one", repeat: true },
  model: { arity: "one" },
  prompt: { arity: "one" },
  "prompt-file": { arity: "one" },
  mode: { arity: "one" },
  sandbox: { arity: "one" },
  seed: { arity: "one" },
  "add-dir": { arity: "one", repeat: true },
  tools: { arity: "one" },
  "timeout-ms": { arity: "one" },
  "max-budget-usd": { arity: "one" },
  "keep-sandbox": { arity: "none" },
  "clean-sandbox": { arity: "none" },
};

const compareSpecs: FlagSpecs = {
  scenario: { arity: "one" },
  agent: { arity: "one" },
  baseline: { arity: "one", repeat: true },
  proposed: { arity: "one", repeat: true },
  "baseline-skill": { arity: "one", repeat: true },
  "proposed-skill": { arity: "one", repeat: true },
  model: { arity: "one" },
  runs: { arity: "one" },
  mode: { arity: "one" },
  sandbox: { arity: "one" },
  seed: { arity: "one" },
  "add-dir": { arity: "one", repeat: true },
  tools: { arity: "one" },
  "timeout-ms": { arity: "one" },
  "max-budget-usd": { arity: "one" },
  "keep-sandbox": { arity: "none" },
};

export async function main(argv: string[]): Promise<number> {
  try {
    const [command, ...rest] = argv;
    switch (command) {
      case undefined:
      case "--help":
      case "-h":
      case "help":
        console.log(generalUsage());
        return command === undefined ? 2 : 0;
      case "run":
        if (isHelp(rest)) {
          console.log(runUsage());
          return 0;
        }
        await cmdRun(rest);
        return 0;
      case "compare":
        if (isHelp(rest)) {
          console.log(compareUsage());
          return 0;
        }
        return await cmdCompare(rest);
      default:
        throw new CliError(generalUsage());
    }
  } catch (error) {
    if (error instanceof CliError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function isHelp(argv: string[]): boolean {
  return argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h");
}

async function cmdRun(argv: string[]): Promise<void> {
  const args = parseArgs(argv, runSpecs);
  const agent = args.one("agent");
  const model = args.one("model");
  if (!agent || !model) {
    throw new CliError(runUsage());
  }

  const prompt = promptFromArgs(args.one("prompt"), args.one("prompt-file"));
  const mode = modeFromString(args.one("mode") ?? "text");
  const keepSandbox = args.has("keep-sandbox") || (mode === "artifact" && !args.has("clean-sandbox"));
  const sandbox = prepareSandbox({
    root: args.one("sandbox") ?? ".skill-eval/run",
    seed: args.one("seed"),
    prefix: "run",
    keep: keepSandbox,
  });

  try {
    const systemPrompt = assembleSystemPrompt(agent, args.many("skill"));
    const runOptions: RunnerRunOptions = {
      systemPrompt,
      userPrompt: prompt,
      model,
      cwd: sandbox.dir,
      addDirs: args.many("add-dir"),
      tools: args.one("tools") ?? defaultTools(mode),
      timeoutMs: args.number("timeout-ms", DEFAULT_TIMEOUT_MS),
      maxBudgetUsd: args.number("max-budget-usd", DEFAULT_MAX_BUDGET_USD),
    };

    console.error(
      `[skill-eval] system prompt: ${systemPrompt.length} chars (agent + ${args.many("skill").length} skill(s))`,
    );
    console.error(`[skill-eval] sandbox cwd: ${sandbox.dir}`);

    const result = await new ClaudePrintRunner().run(runOptions);
    console.log("\n--- OUTPUT ---\n" + result.output);
    console.log(
      `\n--- $${result.costUsd.toFixed(4)} | ${result.turns} turns | ${(result.durationMs / 1000).toFixed(1)}s | models: ${result.models.join(", ")} ---`,
    );
    if (keepSandbox) {
      console.log(`--- sandbox kept: ${sandbox.dir} ---`);
    }
  } finally {
    sandbox.cleanup();
  }
}

async function cmdCompare(argv: string[]): Promise<number> {
  const args = parseArgs(argv, compareSpecs);
  const scenario = args.one("scenario");
  if (!scenario) {
    throw new CliError(compareUsage());
  }

  const overrides: CompareOverrides = {
    agent: args.one("agent"),
    baselineSkills: coalesceMany(args.many("baseline-skill"), args.many("baseline")),
    proposedSkills: coalesceMany(args.many("proposed-skill"), args.many("proposed")),
    model: args.one("model"),
    runs: args.has("runs") ? args.number("runs", 0) : undefined,
    timeoutMs: args.has("timeout-ms") ? args.number("timeout-ms", DEFAULT_TIMEOUT_MS) : undefined,
    maxBudgetUsd: args.has("max-budget-usd") ? args.number("max-budget-usd", DEFAULT_MAX_BUDGET_USD) : undefined,
    mode: args.one("mode") ? modeFromString(args.one("mode")) : undefined,
    tools: args.one("tools"),
    addDirs: args.many("add-dir").length ? args.many("add-dir") : undefined,
    sandboxRoot: args.one("sandbox"),
    sandboxSeed: args.one("seed"),
    keepSandbox: args.has("keep-sandbox") ? true : undefined,
  };

  const config = loadCompareConfig(scenario, overrides);
  const summary = await runCompare({
    config,
    runner: new ClaudePrintRunner(),
    onProgress: (message) => console.error(`[skill-eval] ${message}`),
  });

  console.log(formatCompareSummary(summary));
  return summary.failedAssertions.length > 0 ? 1 : 0;
}

function promptFromArgs(prompt: string | undefined, promptFile: string | undefined): string {
  if (prompt && promptFile) {
    throw new CliError("pass only one of --prompt or --prompt-file");
  }
  if (prompt) return prompt;
  if (promptFile) return readFileSync(promptFile, "utf8");
  throw new CliError(runUsage());
}

function modeFromString(value: string | undefined): RunMode {
  if (value === "text" || value === "artifact") return value;
  throw new CliError("--mode must be either text or artifact");
}

function defaultTools(mode: RunMode): string {
  return mode === "text" ? "" : "default";
}

function coalesceMany(primary: string[], fallback: string[]): string[] | undefined {
  if (primary.length > 0) return primary;
  if (fallback.length > 0) return fallback;
  return undefined;
}

function runUsage(): string {
  return [
    "usage: skill-eval run --agent <file.md> --model <model> (--prompt <text>|--prompt-file <file>) [flags]",
    "",
    "Runs one bounded Claude invocation. Use this to inspect whether one agent +",
    "skill set behaves roughly as expected before promoting the fixture to compare.",
    "",
    "flags: --skill <SKILL.md>... --mode <text|artifact> --sandbox <dir> --seed <dir>",
    "       --tools <tools|default|''> --timeout-ms <ms> --max-budget-usd <usd>",
    "",
    "modes:",
    "  text      disables tools with --tools '' and grades only the final output manually",
    "  artifact  runs Claude in a fresh sandbox cwd with default tools enabled",
  ].join("\n");
}

function compareUsage(): string {
  return [
    "usage: skill-eval compare --scenario <scenario.json> [overrides]",
    "",
    "Runs baseline and proposed skill sets against the same scenarios, then grades",
    "each run deterministically and compares pass rates.",
    "",
    "overrides: --agent <file.md> --baseline <SKILL.md>... --proposed <SKILL.md>...",
    "           --model <model> --runs <n> --sandbox <dir> --keep-sandbox",
    "           --mode <text|artifact> --tools <tools|default|''>",
    "           --timeout-ms <ms> --max-budget-usd <usd>",
    "",
    "runs:",
    "  scenario-level \"runs\": 5 means 5 baseline runs and 5 proposed runs per case.",
    "  --runs <n> overrides the scenario default. A case may also define its own runs.",
    "",
    "graders:",
    "  text     checks Claude's final output with contains, notContains, and regex arrays",
    "  command  runs a shell command inside the per-run sandbox and checks exit code",
    "",
    "assertions:",
    "  target      baseline must not fully pass; proposed must beat baseline pass rate",
    "  regression  proposed must not fall below baseline pass rate",
    "",
    "minimal scenario:",
    "  {",
    "    \"agent\": \"./agent.md\",",
    "    \"baselineSkills\": [\"./skill.baseline.md\"],",
    "    \"proposedSkills\": [\"./skill.proposed.md\"],",
    "    \"model\": \"sonnet\",",
    "    \"runs\": 5,",
    "    \"scenarios\": [{",
    "      \"name\": \"target-case\",",
    "      \"kind\": \"target\",",
    "      \"prompt\": \"Do the fixture task.\",",
    "      \"grader\": { \"type\": \"command\", \"command\": \"bun test\" }",
    "    }]",
    "  }",
  ].join("\n");
}

function generalUsage(): string {
  return [
    "usage: skill-eval <run|compare> [flags]",
    "",
    "commands:",
    "  run      one bounded Claude invocation with inlined skills",
    "  compare  N-run baseline-vs-proposed scenario comparison",
    "",
    "use `skill-eval run --help` or `skill-eval compare --help` for command flags",
  ].join("\n");
}
