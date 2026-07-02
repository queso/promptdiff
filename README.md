# skill-eval

`skill-eval` is a small Bun CLI for testing whether an AI agent prompt or skill
change actually changes behavior.

It has two commands:

- `run`: one headless Claude Code invocation with an agent file and optional
  inlined skill files.
- `compare`: N-run baseline-vs-proposed comparison from a JSON scenario file,
  with deterministic text or command graders.

The project is still early, but the CLI now performs real repeated comparisons.
It shells out to `claude -p`; the provider-specific code is isolated in the
runner.

## Why it exists

Prompt and skill edits are easy to propose and hard to trust. For a recurring
defect, a useful eval should show two things:

1. the baseline instruction set still reproduces the failure, and
2. the proposed instruction set improves the target case without regressing
   existing scenarios.

`skill-eval compare` encodes that loop. It runs each arm several times, grades
each output deterministically, and reports pass rates and cost.

## Install

From npm:

```bash
bun add -g @the-ai-team/skill-eval
```

or:

```bash
npm install -g @the-ai-team/skill-eval
```

Runtime requirements:

```bash
bun --version
claude --version
```

Then run:

```bash
skill-eval --help
```

From a checkout:

```bash
bun install
```

Run from the repo:

```bash
./skill-eval --help
```

## Safe Defaults

Paid model calls are bounded by default:

- `--max-budget-usd 1` per Claude invocation
- `--timeout-ms 600000` per Claude invocation
- fresh sandbox working directories under `.skill-eval/`
- `run --mode text` disables tools with `--tools ""`
- artifact mode uses the sandbox as Claude's actual `cwd`

For artifact-producing runs, use `--mode artifact`; by default that enables
Claude's default tools and keeps the sandbox for inspection. Pass
`--clean-sandbox` to delete it after a single run.

## Single Run

Text-only eval:

```bash
./skill-eval run \
  --agent ./agents/ba.md \
  --skill ./skills/defensive-coding/SKILL.md \
  --model sonnet \
  --prompt "Explain how you would validate POST /api/items."
```

Artifact-producing eval:

```bash
./skill-eval run \
  --agent ./agents/ba.md \
  --skill ./skills/defensive-coding/SKILL.md \
  --model sonnet \
  --mode artifact \
  --seed ./fixtures/wi-203 \
  --sandbox .skill-eval/manual \
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
    "root": ".skill-eval/runs",
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
./skill-eval compare --scenario ./scenarios/wi-203.json
```

Useful overrides:

```bash
./skill-eval compare \
  --scenario ./scenarios/wi-203.json \
  --baseline ./skills/current/SKILL.md \
  --proposed ./skills/proposed/SKILL.md \
  --runs 8 \
  --keep-sandbox
```

`compare` exits non-zero when assertions fail. For target scenarios, baseline
must not fully pass and proposed must improve the pass rate. For regression
scenarios, proposed must not fall below baseline.

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

Command graders run inside the per-run sandbox.

## Development

```bash
bun test
bun run typecheck
bun run check
```

See [SPEC.md](./SPEC.md) for design notes, limitations, and the reasoning behind
inlining skill variants into the system prompt.
