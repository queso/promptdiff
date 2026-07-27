import { readFileSync } from "node:fs";
import { CliError, parseArgs, type FlagSpecs } from "./args";
import { loadCompareConfig, type ArmConfig, type CompareOverrides } from "./engine/config";
import { formatCompareSummary, runCompare } from "./engine/compare";
import { prepareSandbox } from "./engine/sandbox";
import { installSkills, type Delivery } from "./engine/skill-install";
import { renderStrict, resolveRenderVars, type RenderVars } from "./engine/render";
import { assembleSystemPrompt } from "./prompt";
import { createRunner, RUNNER_NAMES, type RunnerName } from "./runner";
import type { RunMode, Runner, RunnerRunOptions } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUDGET_USD = 1;

const runSpecs: FlagSpecs = {
  agent: { arity: "one" },
  skill: { arity: "one", repeat: true },
  delivery: { arity: "one" },
  runner: { arity: "one" },
  "base-url": { arity: "one" },
  model: { arity: "one" },
  prompt: { arity: "one" },
  "prompt-file": { arity: "one" },
  image: { arity: "one", repeat: true },
  var: { arity: "one", repeat: true },
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
  delivery: { arity: "one" },
  runner: { arity: "one" },
  "baseline-runner": { arity: "one" },
  "proposed-runner": { arity: "one" },
  "base-url": { arity: "one" },
  model: { arity: "one" },
  "baseline-model": { arity: "one" },
  "proposed-model": { arity: "one" },
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
  const delivery = deliveryFromString(args.one("delivery") ?? "inline");
  const mode = modeFromString(args.one("mode") ?? (delivery === "install" ? "artifact" : "text"));
  const tools = args.one("tools") ?? (delivery === "install" ? "default" : defaultTools(mode));
  if (delivery === "install" && tools === "") {
    throw new CliError('--delivery install needs tools enabled: skills trigger via the Skill tool, so --tools "" can never fire them');
  }
  const runner = runnerFromArgs(args.one("runner"), args.one("base-url"));
  if (delivery === "install" && !runner.capabilities.skillRegistry) {
    throw new CliError(`--delivery install needs a runner with a skill registry; runner "${runner.name}" has none (use claude-p)`);
  }
  if (tools !== "" && !runner.capabilities.sandboxTools) {
    throw new CliError(`runner "${runner.name}" is text-only — artifact mode and tools need claude-p (or pass --tools "")`);
  }
  const images = args.many("image");
  if (images.length > 0 && !runner.capabilities.images) {
    throw new CliError(`runner "${runner.name}" cannot attach images — use --runner openai with a vision model`);
  }
  const renderVars = varsFromFlags(args.many("var"));
  if (renderVars !== undefined && delivery === "install") {
    throw new CliError("--var applies to inlined prompt text; --delivery install copies skill files verbatim, so placeholders cannot be bound");
  }
  const keepSandbox = args.has("keep-sandbox") || (mode === "artifact" && !args.has("clean-sandbox"));
  const sandbox = prepareSandbox({
    root: args.one("sandbox") ?? ".promptdiff/run",
    seed: args.one("seed"),
    prefix: "run",
    keep: keepSandbox,
  });

  try {
    const assembled = assembleSystemPrompt(agent, delivery === "install" ? [] : args.many("skill"));
    const systemPrompt = renderVars === undefined ? assembled : renderStrict(assembled, renderVars, "system prompt");
    const userPrompt = renderVars === undefined ? prompt : renderStrict(prompt, renderVars, "prompt");
    if (delivery === "install") {
      const { installed, warnings } = installSkills(args.many("skill"), sandbox.dir);
      console.error(
        `[promptdiff] installed skills: ${installed.map((skill) => skill.name).join(", ") || "(none)"}`,
      );
      for (const warning of warnings) {
        console.error(`[promptdiff] WARNING: ${warning}`);
      }
    }
    const runOptions: RunnerRunOptions = {
      systemPrompt,
      systemPromptMode: delivery === "install" ? "append" : "replace",
      userPrompt,
      images,
      model,
      cwd: sandbox.dir,
      addDirs: args.many("add-dir"),
      tools,
      timeoutMs: args.number("timeout-ms", DEFAULT_TIMEOUT_MS),
      maxBudgetUsd: args.number("max-budget-usd", DEFAULT_MAX_BUDGET_USD),
    };

    console.error(
      delivery === "install"
        ? `[promptdiff] appended agent prompt: ${systemPrompt.length} chars (skills installed, not inlined)`
        : `[promptdiff] system prompt: ${systemPrompt.length} chars (agent + ${args.many("skill").length} skill(s))`,
    );
    console.error(`[promptdiff] sandbox cwd: ${sandbox.dir}`);

    const result = await runner.run(runOptions);
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
    delivery: args.one("delivery") ? deliveryFromString(args.one("delivery")) : undefined,
    runner: args.one("runner") ? runnerNameFromString(args.one("runner")) : undefined,
    baselineRunner: args.one("baseline-runner") ? runnerNameFromString(args.one("baseline-runner")) : undefined,
    proposedRunner: args.one("proposed-runner") ? runnerNameFromString(args.one("proposed-runner")) : undefined,
    baseUrl: args.one("base-url"),
    model: args.one("model"),
    baselineModel: args.one("baseline-model"),
    proposedModel: args.one("proposed-model"),
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
    runners: {
      baseline: armRunner(config.arms.baseline, config.retries),
      proposed: armRunner(config.arms.proposed, config.retries),
    },
    onProgress: (message) => console.error(`[promptdiff] ${message}`),
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

function deliveryFromString(value: string | undefined): Delivery {
  if (value === "inline" || value === "install") return value;
  throw new CliError("--delivery must be either inline or install");
}

function varsFromFlags(entries: string[]): RenderVars | undefined {
  if (entries.length === 0) return undefined;
  const raw: Record<string, unknown> = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`--var must be name=value (value is a file path or literal): ${entry}`);
    }
    raw[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return resolveRenderVars(raw, process.cwd(), "--var");
}

function runnerNameFromString(value: string | undefined): RunnerName {
  if (value === "claude-p" || value === "openai") return value;
  throw new CliError(`--runner must be one of: ${RUNNER_NAMES.join(", ")}`);
}

function runnerFromArgs(name: string | undefined, baseUrl: string | undefined): Runner {
  return createRunner(name === undefined ? "claude-p" : runnerNameFromString(name), { baseUrl });
}

function armRunner(arm: ArmConfig, retries: number | undefined): Runner {
  return createRunner(arm.runner, { baseUrl: arm.baseUrl, retries });
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
    "usage: promptdiff run --agent <file.md> --model <model> (--prompt <text>|--prompt-file <file>) [flags]",
    "",
    "Runs one bounded model invocation. Use this to inspect whether one agent +",
    "skill set behaves roughly as expected before promoting the fixture to compare.",
    "",
    "flags: --skill <SKILL.md|dir>... --delivery <inline|install> --mode <text|artifact>",
    "       --runner <claude-p|openai> --base-url <url> --image <file>...",
    "       --var <name=value>... --sandbox <dir> --seed <dir>",
    "       --tools <tools|default|''> --timeout-ms <ms> --max-budget-usd <usd>",
    "",
    "templates:",
    "  --var draft=./fixture.md binds {{draft}} in the agent, skills, and prompt;",
    "  values naming an existing file are read as contents, otherwise used as",
    "  literals. With any --var set, unbound {{placeholders}} fail before the run.",
    "",
    "runners:",
    "  claude-p  (default) headless Claude Code — supports tools, artifact mode,",
    "            and install delivery",
    "  openai    single chat completion against any OpenAI-compatible endpoint",
    "            (text mode only); --base-url or $OPENAI_BASE_URL picks the server,",
    "            $OPENAI_API_KEY is sent when set; --image attaches image files",
    "            to the user message for vision models (repeatable)",
    "",
    "modes:",
    "  text      disables tools with --tools '' and grades only the final output manually",
    "  artifact  runs the agent in a fresh sandbox cwd with default tools enabled",
    "",
    "delivery:",
    "  inline    (default) skill bodies are inlined into a replaced system prompt —",
    "            controlled compliance testing of skill text the model already sees",
    "  install   skill dirs are copied to <sandbox>/.claude/skills/<name> with",
    "            frontmatter intact and the agent text is appended to the default",
    "            system prompt — tests whether the registry description actually",
    "            triggers the Skill invocation (implies --mode artifact + tools)",
  ].join("\n");
}

function compareUsage(): string {
  return [
    "usage: promptdiff compare --scenario <scenario.json> [overrides]",
    "",
    "Runs baseline and proposed arms against the same scenarios, then grades",
    "each run deterministically and compares pass rates. The arms may differ by",
    "skill set, by model/runner, or both.",
    "",
    "overrides: --agent <file.md> --baseline <SKILL.md>... --proposed <SKILL.md>...",
    "           --delivery <inline|install> (install: skills land in the sandbox",
    "           registry with frontmatter intact instead of being inlined)",
    "           --runner <claude-p|openai> --base-url <url> (openai: text-graded",
    "           scenarios against any OpenAI-compatible endpoint)",
    "           --model <model> --runs <n> --sandbox <dir> --keep-sandbox",
    "           --baseline-model <m> --proposed-model <m>",
    "           --baseline-runner <r> --proposed-runner <r>",
    "           --mode <text|artifact> --tools <tools|default|''>",
    "           --timeout-ms <ms> --max-budget-usd <usd>",
    "",
    "model comparison:",
    "  hold the skills constant and vary the model per arm. A top-level \"skills\"",
    "  array is inherited by both arms, and the record form of \"baseline\"/",
    "  \"proposed\" accepts per-arm \"model\", \"runner\", and \"baseUrl\" (each falls",
    "  back to the shared top-level value). --baseline-model/--proposed-model and",
    "  --baseline-runner/--proposed-runner override per arm from the CLI.",
    "",
    "runs:",
    "  scenario-level \"runs\": 5 means 5 baseline runs and 5 proposed runs per case.",
    "  --runs <n> overrides the scenario default. A case may also define its own runs.",
    "",
    "graders:",
    "  text     checks the run's final output with contains, notContains, and regex arrays",
    "  command  runs a shell command inside the per-run sandbox and checks exit code",
    "           (needs a tool-capable runner: claude-p)",
    "",
    "images:",
    "  a scenario may set \"images\": [\"photo.jpg\", ...] (paths relative to the",
    "  scenario file) to attach images to the user message — openai runner +",
    "  vision model only",
    "",
    "templates:",
    "  top-level \"render\": { \"vars\": { \"draft\": \"./fixtures/a.md\" } } binds",
    "  {{draft}} in the agent, inlined skills, and scenario prompts, so scenarios",
    "  can point at production prompt files with placeholders. Values naming an",
    "  existing file (relative to the scenario) are read as contents, otherwise",
    "  used as literals. Scenarios may add their own \"render\" (scenario wins per",
    "  var). Unbound placeholders fail before any paid run. Inline delivery only.",
    "",
    "assertions:",
    "  target      baseline must not fully pass; proposed must beat baseline pass rate",
    "  regression  proposed must not fall below baseline pass rate",
    "  compare     no assertion — reports both arms' pass rates and the delta",
    "              (for model-vs-model diffs with no directional claim)",
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
    "usage: promptdiff <run|compare> [flags]",
    "",
    "commands:",
    "  run      one bounded model invocation with inlined skills",
    "  compare  N-run baseline-vs-proposed scenario comparison",
    "",
    "use `promptdiff run --help` or `promptdiff compare --help` for command flags",
  ].join("\n");
}
