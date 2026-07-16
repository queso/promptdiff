# promptdiff

`promptdiff` is a small Bun CLI for testing whether an LLM prompt or skill
change actually changes behavior — with any model, not just Claude.

It has two commands:

- `run`: one bounded model invocation with an agent file and optional inlined
  skill files.
- `compare`: N-run baseline-vs-proposed comparison from a JSON scenario file,
  with deterministic text or command graders.

Model access goes through pluggable runners. Two ship today:

- `claude-p` (default): headless Claude Code via `claude -p`. Supports tools,
  sandboxed artifact runs, and skill-registry install testing.
- `openai`: a single chat completion against any OpenAI-compatible endpoint
  (OpenAI, ollama, vLLM, llama.cpp, OpenRouter, ...). Text-graded evals only.

The project is still early, but the CLI performs real repeated comparisons;
provider-specific code is isolated in `src/runner/`.

## Why it exists

Prompt and skill edits are easy to propose and hard to trust. For a recurring
defect, a useful eval should show two things:

1. the baseline instruction set still reproduces the failure, and
2. the proposed instruction set improves the target case without regressing
   existing scenarios.

`promptdiff compare` encodes that loop. It runs each arm several times, grades
each output deterministically, and reports pass rates and cost.

## Install

From npm:

```bash
bun add -g @the-ai-team/promptdiff
```

or:

```bash
npm install -g @the-ai-team/promptdiff
```

Runtime requirements:

```bash
bun --version
claude --version   # only for the default claude-p runner
```

Then run:

```bash
promptdiff --help
```

From a checkout:

```bash
bun install
```

Run from the repo:

```bash
./promptdiff --help
```

## Safe Defaults

Paid model calls are bounded by default:

- `--max-budget-usd 1` per invocation (enforced by the claude-p runner; the
  openai runner is a single completion per run, so cost is bounded by design)
- `--timeout-ms 600000` per invocation
- fresh sandbox working directories under `.promptdiff/`
- `run --mode text` disables tools with `--tools ""`
- artifact mode uses the sandbox as the agent's actual `cwd`

For artifact-producing runs, use `--mode artifact`; by default that enables
the agent's default tools and keeps the sandbox for inspection. Pass
`--clean-sandbox` to delete it after a single run.

## Runners

`--runner claude-p` (default) shells out to headless Claude Code and supports
everything: tools, artifact mode, command graders, and `--delivery install`.

`--runner openai` sends one chat completion to an OpenAI-compatible endpoint:

```bash
OPENAI_API_KEY=sk-... ./promptdiff run \
  --runner openai \
  --model gpt-4o-mini \
  --agent ./agents/ba.md \
  --skill ./skills/defensive-coding/SKILL.md \
  --prompt "Explain how you would validate POST /api/items."
```

The endpoint defaults to `https://api.openai.com/v1` and can be changed with
`--base-url` or `$OPENAI_BASE_URL` — point it at ollama, vLLM, llama.cpp,
OpenRouter, or anything else that speaks `/chat/completions`. `$OPENAI_API_KEY`
is sent as a bearer token when set; local servers work without one.

```bash
./promptdiff run \
  --runner openai \
  --base-url http://localhost:11434/v1 \
  --model llama3.1 \
  --agent ./agents/ba.md \
  --prompt "Explain how you would validate POST /api/items."
```

The openai runner is text-only: no tools, no sandbox execution, no skill
registry. Scenarios that need artifact mode, command graders, or install
delivery are rejected up front — before any paid run — with an error telling
you to use claude-p. In a scenario file, select it with top-level
`"runner": "openai"` and optionally `"baseUrl": "..."`.

## Single Run

Text-only eval:

```bash
./promptdiff run \
  --agent ./agents/ba.md \
  --skill ./skills/defensive-coding/SKILL.md \
  --model sonnet \
  --prompt "Explain how you would validate POST /api/items."
```

Artifact-producing eval:

```bash
./promptdiff run \
  --agent ./agents/ba.md \
  --skill ./skills/defensive-coding/SKILL.md \
  --model sonnet \
  --mode artifact \
  --seed ./fixtures/wi-203 \
  --sandbox .promptdiff/manual \
  --prompt "FIXTURE WI-203: Add GET /api/health returning {\"status\":\"ok\"}. Tests exist."
```

## Compare

Create a scenario file:

```json
{
  "name": "wi-203 health route",
  "agent": "./agents/ba.md",
  "baselineSkills": ["./skills/defensive-coding.baseline.md"],
  "proposedSkills": ["./skills/defensive-coding.proposed.md"],
  "model": "sonnet",
  "runs": 5,
  "maxBudgetUsd": 1,
  "timeoutMs": 600000,
  "sandbox": {
    "root": ".promptdiff/runs",
    "seed": "./fixtures/wi-203"
  },
  "scenarios": [
    {
      "name": "target-health-route",
      "kind": "target",
      "prompt": "Add GET /api/health returning {\"status\":\"ok\"}. Existing tests define the desired behavior.",
      "grader": {
        "type": "command",
        "command": "bun test",
        "timeoutMs": 120000
      }
    },
    {
      "name": "regression-existing-tests",
      "kind": "regression",
      "prompt": "Make no functional changes. Ensure the existing app still passes tests.",
      "grader": {
        "type": "command",
        "command": "bun test",
        "timeoutMs": 120000
      }
    }
  ]
}
```

Paths inside a scenario file are resolved relative to that scenario file.

Run it:

```bash
./promptdiff compare --scenario ./scenarios/wi-203.json
```

Useful overrides:

```bash
./promptdiff compare \
  --scenario ./scenarios/wi-203.json \
  --baseline ./skills/current/SKILL.md \
  --proposed ./skills/proposed/SKILL.md \
  --runs 8 \
  --keep-sandbox
```

`compare` exits non-zero when assertions fail. For target scenarios, baseline
must not fully pass and proposed must improve the pass rate. For regression
scenarios, proposed must not fall below baseline.

## Delivery: inline vs install

Two ways to put the skill under test in front of the agent, for two different
questions:

- `inline` (default): skill bodies are inlined into a replaced system prompt,
  frontmatter stripped. Tests **compliance** — given the skill text is in
  context, does behavior follow it? Fully controlled, works with `--tools ""`.
- `install`: skill directories are copied to `<sandbox>/.claude/skills/<name>`
  with frontmatter intact, and the agent text is appended to the **default**
  system prompt (`--append-system-prompt`) so the harness's skill registry
  stays active. Tests **invocation** — does the frontmatter description get
  the skill triggered at all? Requires tools (the Skill tool does the
  triggering); implies `--mode artifact`. Claude Code only (`--runner claude-p`):
  it exercises that harness's skill registry, which plain completion endpoints
  do not have.

```bash
./promptdiff run \
  --agent ./agents/probe.md \
  --skill ../Cortex/skills/cortex \
  --delivery install \
  --model sonnet \
  --prompt "Where should this app be deployed?"
```

In a scenario file, set top-level `"delivery": "install"` and point
`baselineSkills`/`proposedSkills` at skill *directories* (or their SKILL.md;
the parent directory is copied either way). Each run gets a fresh install in
its own sandbox.

Caveat: a user-level skill with the same name (`~/.claude/skills/<name>` or
`$CLAUDE_CONFIG_DIR/skills/<name>`) loads in every run of both arms and
contaminates the comparison. promptdiff warns when it detects this; remove or
rename the user-level copy before comparing.

## Graders

Text grader:

```json
{
  "type": "text",
  "contains": ["status"],
  "notContains": ["TODO"],
  "regex": ["health"]
}
```

Command grader:

```json
{
  "type": "command",
  "command": "bun test",
  "cwd": ".",
  "timeoutMs": 120000,
  "expectExitCode": 0
}
```

Command graders run inside the per-run sandbox. They grade files the agent
wrote there, so they need a tool-capable runner (claude-p); text graders work
with every runner.

## Development

```bash
bun test
bun run typecheck
bun run check
```

See [SPEC.md](./SPEC.md) for design notes, limitations, and the reasoning behind
inlining skill variants into the system prompt.
