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

The npm package (`@the-ai-team/promptdiff`) is coming soon. Until then,
install from a checkout:

```bash
git clone https://github.com/queso/promptdiff
cd promptdiff
bun install
```

Runtime requirements:

```bash
bun --version
claude --version   # only for the default claude-p runner
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

### Vision evals (VLMs)

The openai runner can attach images to the user message, so prompt A/B tests
work against vision-language models too. On `run`, pass `--image`
(repeatable):

```bash
./promptdiff run \
  --runner openai \
  --base-url http://localhost:11434/v1 \
  --model qwen2.5vl \
  --agent ./agents/alt-text.md \
  --image ./fixtures/screenshot.png \
  --prompt "Write alt text for this screenshot."
```

In a scenario file, any scenario may list `"images"`:

```json
{
  "name": "alt-text-quality",
  "kind": "target",
  "prompt": "Write alt text for this screenshot.",
  "images": ["./fixtures/screenshot.png"],
  "grader": { "type": "text", "notContains": ["image of"] }
}
```

Image paths resolve relative to the scenario file and are checked at load
time, so a missing file fails before any paid run. Supported formats: jpg,
jpeg, png, webp, gif. Files are embedded as base64 data URIs — no upload
endpoint needed, so local servers (ollama, vLLM) work as-is. The claude-p
runner does not support image attachment; a scenario with `images` on a
claude-p arm is rejected up front.

### Endpoint options (scenario file)

Two more top-level scenario fields tune the openai runner in `compare`:

- `"requestParams": { "max_tokens": 512, "temperature": 0 }` — extra fields
  merged into the chat-completions request body (they can never clobber
  `model` or `messages`). Useful for pinning temperature so pass-rate deltas
  reflect the prompt, not sampling noise.
- `"retries": 2` — extra attempts after a timeout or connection failure,
  for flaky local endpoints. HTTP errors and malformed responses still fail
  immediately. Default 0.

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

## Comparing models

The A/B variable does not have to be the skill text. Hold the prompt and
skills constant and vary the model — or the runner and endpoint — per arm:

```json
{
  "name": "sonnet vs local llama3.1",
  "agent": "./agents/ba.md",
  "skills": ["./skills/defensive-coding/SKILL.md"],
  "baseline": { "model": "sonnet", "runner": "claude-p" },
  "proposed": {
    "model": "llama3.1",
    "runner": "openai",
    "baseUrl": "http://localhost:11434/v1"
  },
  "runs": 5,
  "scenarios": [
    {
      "name": "validation-explanation",
      "kind": "compare",
      "prompt": "Explain how you would validate POST /api/items.",
      "grader": { "type": "text", "contains": ["status"], "notContains": ["TODO"] }
    }
  ]
}
```

- A top-level `"skills"` array is inherited by both arms when an arm defines
  none of its own; each arm may still bring its own `"skills"`.
- The record form of `"baseline"`/`"proposed"` accepts `"model"`, `"runner"`,
  and `"baseUrl"`, each falling back to the shared top-level value.
- `"kind": "compare"` makes no directional claim: it never fails the run, it
  just reports both arms' pass rates and the delta. Target and regression
  scenarios still work in model comparisons if you do want an assertion.
- `--baseline-model`/`--proposed-model` and
  `--baseline-runner`/`--proposed-runner` override per arm from the CLI.

Each arm is validated against its own runner's capabilities before any paid
run, so an openai arm still rejects command graders, tools, artifact mode,
and install delivery up front.

Two caveats when the arms use different runners: claude-p arms are agentic
(tools, multiple turns) while openai arms are single completions, so pass
rates compare but the mechanics differ; and the openai runner reports $0 cost
(tokens only), so the summary flags the cost columns as not comparable.

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
  --skill ./skills/deploy-checklist \
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

Command graders run inside the per-run sandbox. Typically they grade files
the agent wrote there, which needs a tool-capable runner (claude-p); text
graders work with every runner.

Every command grader also receives the run's final output, written into the
sandbox and exposed as `$PROMPTDIFF_OUTPUT_FILE`. That means completion-style
runs (openai runner) can be command-graded too — set `"mode": "text"` on the
scenario so no tools are demanded, and script against the file:

```json
{
  "name": "structured-answer",
  "kind": "target",
  "mode": "text",
  "prompt": "Reply with JSON: {\"status\": ...}",
  "grader": {
    "type": "command",
    "command": "jq -e '.status == \"ok\"' \"$PROMPTDIFF_OUTPUT_FILE\""
  }
}
```

## Security note

Command graders execute arbitrary shell commands from scenario files (inside
the per-run sandbox, but with your local permissions). Only run scenario files
you trust.

## Development

```bash
bun test
bun run typecheck
bun run check
```

See [SPEC.md](./SPEC.md) for design notes, limitations, and the reasoning behind
inlining skill variants into the system prompt.

## License

[MIT](./LICENSE)
