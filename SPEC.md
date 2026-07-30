# promptdiff - Design Spec

Status: early implementation. The original spike proved the `claude -p`
mechanism; the current repo now contains a real `run` command, a scenario-driven
`compare` command, deterministic graders, sandbox setup, timeout and budget
bounds, pluggable runners (headless Claude Code and OpenAI-compatible
endpoints), and tests for the core local behavior.

## 1. Problem

AI agent pipelines generate proposed improvements to prompts, skills, and
enforcement hooks. The chronic failure mode is that proposed edits are shipped
on faith or never shipped at all because there is no cheap proof that the edit
changes behavior without damaging scenarios that already worked.

`promptdiff` is the proof step between "we think this skill edit helps" and
"ship it." It does not collect findings, rank recurrence, or manage tuning
rounds. Those can live in a larger system. This repo focuses on the eval harness.

## 2. Eval Altitudes

The eval method should match the change being tested:

| Change altitude | Eval method | Cost |
|---|---|---|
| Enforcement hook | Deterministic unit test | 1 run, near-free |
| Skill or agent prompt text | N-run stochastic A/B over pass rates | N x arms x per-run cost |

`promptdiff` targets the second row. It runs one agent with baseline skill text
and one agent with proposed skill text against the same scenario set.

## 3. Runners

Model access goes through a small `Runner` interface: system prompt + user
prompt + bounds in, `RunResult` (output text, cost, turns, duration, models)
out. Each runner declares capabilities:

- `sandboxTools`: the runner executes tools inside the sandbox cwd (needed for
  artifact mode, command graders against agent-written files, and any
  non-empty tools list)
- `skillRegistry`: the runner has a harness-managed skill registry and an
  appendable default system prompt (needed for install delivery)
- `images`: the runner can attach image files to the user message (needed for
  scenarios with `images` / `run --image`)

The engine validates a scenario's demands against the selected runner's
capabilities before any paid run, so unsupported combinations fail loudly at
startup instead of producing a silently tool-less arm. Runners are selected
with `--runner <name>` or a top-level `"runner"` scenario field.

### 3.1 `claude-p` (default)

Shells out to headless Claude Code:

```bash
claude -p "<fixture work item>" \
  --system-prompt-file <assembled prompt file> \
  --model <model> \
  --output-format json \
  --tools <tools> \
  --max-budget-usd <amount>
```

The spawned process runs with the per-run sandbox as its actual working
directory. Extra directories can be granted with `--add-dir`, but they are not
used as a substitute for sandboxing.

The runner captures final output text, `total_cost_usd`, turn count, duration,
and model usage keys.

### 3.2 `openai`

Sends one `POST <baseUrl>/chat/completions` request to any OpenAI-compatible
endpoint (OpenAI, ollama, vLLM, llama.cpp, OpenRouter, ...). The assembled
system prompt and the scenario prompt become the `system` and `user` messages.
`--base-url`/`$OPENAI_BASE_URL` select the server; `$OPENAI_API_KEY` is sent as
a bearer token when set (local servers need none).

Text mode only — no tools, no sandbox execution, no skill registry, so it pairs
with text graders. These endpoints report tokens, not USD, so pricing is
user-declared: scenario `pricing` (per-model USD per million input/output
tokens) or `run --price in,out`. Priced runs compute real cost from response
`usage`, enforce `maxBudgetUsd` post-hoc (a completed completion cannot be
aborted mid-request; over-budget runs error rather than retry), and fail
loudly when a priced endpoint returns no usage. Unpriced runs report 0 —
true for local servers — and are bounded only by being single completions.
Raw usage is always preserved in the raw result.

Vision: this is the only runner declaring the `images` capability. Scenario
`images` (or `run --image`) are embedded as base64 data-URI `image_url`
content parts ahead of the prompt text — jpg/jpeg/png/webp/gif, validated for
existence at load time. Two scenario fields tune the endpoint: `requestParams`
merges extra fields into the request body (spread first, so it can never
clobber `model` or `messages` — pin `temperature` here to keep pass-rate
deltas about the prompt), and `retries` (default 2) re-attempts transient
failures — timeouts, connection errors, HTTP 429/5xx — with exponential
backoff and a per-attempt timeout, so one overloaded-endpoint response cannot
abort a whole compare. Deterministic failures (other 4xx, malformed
responses) fail immediately without burning retries. claude-p is excluded on
purpose: the CLI manages its own transport, and retrying non-zero exits
would re-run budget aborts.

## 4. A/B Variable

Two delivery modes, matching two distinct questions about a skill edit:

**`inline` (default) — compliance.** Skill variants are inlined into the system
prompt instead of being loaded by the Skill tool at runtime:

```text
system prompt = agent body with frontmatter stripped
              + baseline or proposed skill body with frontmatter stripped
```

That keeps the comparison controlled. The baseline and proposed arms differ by
the skill text under test, not by whichever skill version happens to be
installed on disk. The limitation is the flip side of the control: an inlined
skill is always in context, so inline evals cannot measure whether the skill
would have been *invoked* — and frontmatter (including the `description` that
drives model-invoked triggering) is stripped entirely.

**`install` — invocation.** The skill directory is copied, frontmatter intact,
into `<sandbox>/.claude/skills/<name>`, where headless Claude's project-skill
discovery registers it. The agent body is delivered with
`--append-system-prompt` rather than `--system-prompt-file`, because replacing
the system prompt would strip the harness machinery (skill registry, Skill
tool) that this mode exists to exercise. Arms differ only by which variant
directory lands in the per-run sandbox registry. This is the mode for A/B
testing description/trigger wording — the "does it fire at all" question. It
requires tools and is incompatible with `--tools ""`.

Known contamination source in install mode: same-named user-level skills load
in both arms; the installer warns when it detects one.

**Model as the A/B variable.** The arms can also differ by model, runner, or
endpoint instead of (or in addition to) skill text. A shared top-level
`"skills"` array holds the instruction set constant, and the record form of
`"baseline"`/`"proposed"` carries per-arm `"model"`, `"runner"`, and
`"baseUrl"` (each falling back to the shared top-level value). Each arm is
validated against its own runner's capabilities before any paid run, and the
summary labels each arm with its model (and runner, when they differ).

Cross-runner confound: a claude-p arm is agentic — tools, multiple turns —
while an openai arm is a single completion. Pass rates on text-graded
scenarios compare meaningfully, but the mechanics differ and cost does not
compare at all (the openai runner reports $0; the summary notes this when
exactly one arm is openai).

## 5. Scenario Format

A compare file defines:

- agent file
- baseline skill files (or a shared skill set both arms inherit)
- proposed skill files
- model (shared, or per arm for model comparisons)
- run count
- sandbox root and optional seed workspace
- target and regression scenarios
- deterministic graders

The first scenario defaults to `target`; later scenarios default to
`regression`. Explicit `kind` is preferred.

Target assertions:

1. baseline must not fully pass, otherwise the gap was not reproduced
2. proposed must improve the target pass rate

Regression assertions:

1. proposed must not fall below baseline pass rate

Every case also carries a two-tailed Fisher exact p for its pass/fail table;
the summary labels deltas with p > 0.05 as explainable by sampling noise.
This is a label, not a gate — assertions and exit codes are unchanged, but a
receipt now says how thin its evidence is. Scenarios may declare
`productionModel`; arms testing a different model are flagged in the summary.
`--report ndjson --report-out <file>` appends per-scenario records (arms,
rates, cost, sampling p, rendered-prompt sha256 hashes) as append-only run
history. `--receipts <dir>` writes per-scenario receipt files (overwritten
each run) recording the content hash of every prompt file tested plus the
verdict — content addressing instead of hand-maintained prompt_version
strings, so a consuming repo's CI can require a passing receipt for each
shipped prompt's current hash. Reports are history; receipts are current
state.

`compare` scenarios assert nothing: they exist to report both arms' pass
rates and the delta, for comparisons (typically model-vs-model) where neither
direction is claimed in advance.

**Measure mode.** `promptdiff measure` runs a single instruction set through
the same scenario machinery and reports per-case pass rates with no delta
and no assertions — the "characterize before you change" half of prompt
testing. It loads the compare format with a single-arm allowance (`skills`
or `baselineSkills` alone suffices) and always exits 0 on completion.
Identical-arm compares are not a substitute: at small n they emit
directional verdicts from pure sampling noise.

**Template rendering.** `render.vars` — top-level and/or per scenario, with
the scenario winning per var — binds `{{name}}` placeholders across the agent
body, inlined skill text, and scenario prompts. This is what lets scenarios
point at production prompt files (which are full of pipeline placeholders)
instead of hand-rendered copies that drift. Values resolve file-first
relative to the scenario file and are read at load time; anything that isn't
an existing file is a literal. Rendering is opt-in and strict: with any
`render` block present, unbound placeholders abort before any paid run;
without one, braces pass through untouched. Substituted content is never
re-scanned, so fixtures containing braces neither expand recursively nor
false-positive the unbound check. Incompatible with install delivery, which
copies skill files verbatim.

## 6. Grading

Prefer deterministic graders over LLM judges.

Text graders inspect the run's final output. JSON graders parse that output —
the last balanced JSON value when prose surrounds it, since reasoning models
narrate around their answer — and check `assert` path assertions of the form
`<path> <op> <literal>` (ops `==` `!=` `>` `>=` `<` `<=` `contains`; `[*]` is
existential: any element may satisfy the assertion, including for `!=`).
Assertion grammar is validated at config load, before any paid run; missing
paths and type mismatches at grade time fail the assertion with a message,
never throw. Like text graders, json graders demand no sandbox tools and work
on every runner. Command graders run inside the
sandbox after the model invocation and check the exit code of a local command
such as `bun test`, `go test ./...`, or a fixture-specific script. The final
output is also written into the sandbox and exposed to command graders as
`$PROMPTDIFF_OUTPUT_FILE`, so completion-only runs can be command-graded
(scenario `mode: "text"` keeps the tools demand at zero).

LLM judges are intentionally not implemented yet. They would add a second billed
call per run and should be reserved for cases that cannot be expressed as local
checks.

## 7. Architecture

```text
promptdiff          # Bun executable shim
src/cli.ts          # command parsing and user-facing orchestration
src/args.ts         # strict local flag parser
src/prompt.ts       # frontmatter stripping and prompt assembly
src/runner/         # provider-coupled runner code
src/engine/         # compare loop, config loading, graders, sandbox lifecycle
test/               # Bun tests
```

The compare engine depends only on the runner interface and its declared
capabilities; it never imports provider SDKs or provider-specific code.
`src/runner/index.ts` is the registry that maps runner names to
implementations.

Baseline arms are usually frozen by construction, so `compare --cache`
(opt-in; results under `--cache-dir`, default `.promptdiff/cache`) reuses
recorded baseline-arm results instead of re-paying for them on every
iteration of the proposed prompt. `src/engine/cache.ts` keys each case on a
sha256 over everything that could change the outcome — rendered baseline
system prompt, scenario prompt, baseline model/runner/baseUrl, run count,
tools/mode/delivery, grader spec, image contents, and a deterministic tree
hash of the sandbox seed (plus the baseline skill trees under install
delivery, where skill text never enters the system prompt). Hits are real
recorded ArmSummaries, marked `(cached)` on the summary; the proposed arm
always runs fresh. Deleting the cache directory busts it.

## 8. Current Limitations

- Pass-rate assertions are intentionally simple. They are good enough to catch
  decisive effects at small N, but there is no statistical test yet.
- Scenario authoring is manual JSON. A future tuning loop should generate these
  files from accepted findings.
- Command graders run trusted local commands from scenario files. Do not run
  untrusted scenario files.
- The openai runner is a single completion per run: no tool use, so it can only
  answer text-graded questions. Tool-using evals on non-Claude models would
  need an agentic runner (e.g. wrapping another agent CLI).
- Fixture coverage remains the bottleneck. Missing fixtures mean missing
  regression protection.

## 9. Decisions

- Standalone Bun repo rather than embedding in a larger mission runner.
- Claude Code `-p` runner first; OpenAI-compatible endpoints second. Runner
  capabilities are validated up front rather than degraded silently.
- Inline skills for variant control.
- Deterministic graders first; LLM judges later if needed.
- Per-run sandbox cwd, timeout, and budget bounds are mandatory for paid runs.
