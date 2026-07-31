# promptdiff

`promptdiff` is a small Bun CLI for testing whether an LLM prompt or skill
change actually changes behavior — with any model, not just Claude.

It has four commands:

- `run`: one bounded model invocation with an agent file and optional inlined
  skill files.
- `compare`: N-run baseline-vs-proposed comparison from a JSON scenario file,
  with deterministic text or command graders (plus calibrated LLM judges).
- `measure`: N-run single-arm characterization — pass rates, no assertions.
- `calibrate`: prove a judge grader against labeled rubric fixtures before
  compare/measure will let it grade anything.

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

- `--max-budget-usd 1` per invocation — enforced by claude-p natively, and by
  the openai runner whenever `pricing` is set (unpriced openai runs report $0
  and are bounded only by being single completions)
- `--timeout-ms 600000` per invocation
- fresh sandbox working directories under `.promptdiff/`
- `run --mode text` disables tools with `--tools ""`
- artifact mode uses the sandbox as the agent's actual `cwd`

For artifact-producing runs, use `--mode artifact`; by default that enables
the agent's default tools and keeps the sandbox for inspection. Pass
`--clean-sandbox` to delete it after a single run.

**Budget sizing:** the default `$1` cap is tuned for text-mode runs. An
artifact-mode run with default tools on even a small fixture can measure
`~$0.86` — right at the cap — and the cap is only checked between turns, so
runs need headroom. Set `maxBudgetUsd` to `3` or more for artifact scenarios.
A run that hits the cap fails with an explicit
`claude hit the $N max budget` error rather than a silent bad sample.

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
- `"pricing": { "gpt-4o-mini": { "input": 0.15, "output": 0.60 } }` — USD per
  million input/output tokens, keyed by model (so mixed-model compares price
  each arm correctly). With pricing set, cost columns are computed from each
  response's `usage` and `maxBudgetUsd` actually enforces; a priced endpoint
  that returns no usage fails loudly instead of reporting $0. Unpriced openai
  arms keep reporting $0, which is the truth for local servers. On `run`, the
  equivalent is `--price 0.15,0.60`.
- `"retries": 2` (the default) — extra attempts after a *transient* failure:
  timeout, connection error, HTTP 429 or 5xx, with exponential backoff and a
  per-attempt timeout. One `503 service overloaded` no longer throws away a
  whole compare. Deterministic failures (other 4xx, malformed responses)
  still fail immediately without burning retries. Set `"retries": 0` to
  disable.

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

Reading results:

- Failing runs print their grader message plus the tail of grader
  stdout/stderr directly in the summary, so one compare run tells you *which*
  check missed without a `--keep-sandbox` re-run.
- Deltas that sampling noise could explain are labelled
  (`NOTE: delta could be sampling noise (Fisher exact p=0.47)`). Assertions
  and exit codes are unchanged — the label keeps a 1/3 → 2/3 "win" from
  reading like a receipt. At n=3 per arm, even 0/3 → 3/3 only reaches p=0.10;
  use more runs when the claim matters.
- Declare `"productionModel": "gpt-5.5"` and any arm testing a different
  model gets a warning on the summary — a pass on the wrong model validates
  prompt logic, not production behavior.

### Run history

`--report ndjson --report-out ./runs.ndjson` appends one record per scenario
per invocation: timestamp, arms (model, runner, passes, cost), delta,
sampling p, failed assertions, sha256 hashes of each arm's rendered system
prompt, and `productionModel`. Append-only NDJSON — diffable, greppable, and
queryable months later ("has the catch rate drifted since July?") without
hand-transcribing summaries. Failed comparisons are recorded too.

### Receipts

`--receipts <dir>` (on `compare` and `measure`) writes one
`<scenario>.receipt.json` per scenario, overwritten each run — a receipt is
*current state*; the ndjson report is the history. Each receipt records the
repo-relative path and content sha256 of the agent and every skill file
(install-delivery skill directories get a deterministic tree hash covering
supporting files), the arm results, sampling p, and a verdict: `pass`/`fail`
for asserted scenarios, `none` for `"kind": "compare"`, `measured` for
measure runs.

This replaces hand-maintained `prompt_version` strings with content
addressing: a consuming repo's CI can assert that every prompt it ships has
a passing receipt for its **current** hash —

```bash
current=$(sha256sum flows/post/prompts/editorial.md | cut -d' ' -f1)
jq -e --arg h "$current" \
  '.verdict == "pass" and ([.prompts.proposedSkills[].sha256] | index($h))' \
  receipts/editorial-gate.receipt.json
```

Edit the prompt and the hash changes, the receipt goes stale, and the check
names exactly which scenario to re-run. No version bump to remember, no way
to ship a prompt whose eval never ran.

### Caching the baseline arm

A baseline arm is usually frozen by construction — it reproduces a known
failure and never changes — yet every compare re-runs it, so about half of
each iteration's cost re-proves something already recorded. `--cache` reuses
recorded baseline results instead:

```bash
./promptdiff compare --scenario ./scenarios/wi-203.json --cache
```

Results land in `.promptdiff/cache` (override with `--cache-dir <dir>`; it
requires `--cache`). Caching is opt-in because a cache that is silently on is
a cache that is silently stale. The key hashes content, not paths, so a hit
means nothing outcome-relevant changed: the rendered baseline system prompt
(agent + skill text + render vars), the scenario prompt, the baseline
model/runner, the run count, tools/mode/delivery, the grader spec, image file
contents, and the sandbox seed tree. Change any of those and the next compare
runs the baseline fresh. The proposed arm — the thing being iterated — always
runs fresh, and cached baselines are real graded results, so assertions,
sampling-p notes, and reports work unchanged; the summary marks the baseline
line with `(cached)`. Delete the cache dir to bust it.

## Measure: characterize before you change

`compare` answers "did the change help?" — `measure` answers the question
that comes first: *what does the current prompt actually do?* One arm,
per-case pass rates, no delta and no assertions:

```bash
./promptdiff measure --scenario ./scenarios/survival.json
```

```json
{
  "name": "finding survival",
  "agent": "./agents/reviewer.md",
  "skills": ["../flows/review/prompts/coordinate.md"],
  "model": "sonnet",
  "runs": 16,
  "scenarios": [
    {
      "name": "true-finding-survives",
      "prompt": "Review this diff.",
      "grader": { "type": "text", "contains": ["unbounded-network-call"] }
    }
  ]
}
```

The scenario file is the compare format — render vars, images, pricing,
`productionModel`, and both grader types all apply — but only `skills` (or
`baselineSkills`) is required; no proposed arm. Don't fake this with
identical compare arms: two identical arms at small n routinely produce
verdicts like `FAIL: proposed regressed below baseline` out of pure sampling
noise. `measure` exits 0 whenever the runs complete — a measurement has no
pass/fail.

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

## Testing templated prompts

Production prompts often contain template placeholders (`{{draft}}`,
`{{voice}}`) that a pipeline fills in at runtime. `render` lets a scenario
point at the real prompt file and supply the bindings, so the eval tests what
ships — not a hand-copied "rendered variant" that drifts:

```json
{
  "agent": "./agents/editor.md",
  "baselineSkills": ["../flows/post/prompts/editorial.md"],
  "proposedSkills": ["./editorial.tightened.md"],
  "model": "sonnet",
  "render": { "vars": { "voice": "../voice/personal.md" } },
  "scenarios": [
    {
      "name": "catches-scope-overstatement",
      "kind": "target",
      "prompt": "Apply the editorial gate.",
      "render": { "vars": { "draft": "./fixtures/draft-scope-overstatement.md" } },
      "grader": { "type": "text", "regex": ["REJECT"] }
    }
  ]
}
```

- Var values resolve as paths relative to the scenario file: a value naming
  an existing file is read as its contents; anything else is used literally.
  Files are read at load time, so a missing fixture fails before any paid run.
- Bindings apply to the agent body, inlined skill text, and scenario prompts.
  A scenario's `render` merges over the top-level one (scenario wins per var)
  — bind shared vars once, vary the fixture per scenario.
- Rendering is strict: when any `render` block is present, unbound
  `{{placeholders}}` abort before any paid run, so `{{draft}}` never silently
  reaches a model. Without a `render` block, braces pass through untouched,
  as before.
- Inline delivery only — install delivery copies skill files verbatim, so
  placeholders can't be bound there.
- `run` gets the same behavior via `--var name=value` (repeatable), handy
  while developing fixtures.

Placeholder syntax is `{{name}}`, with inner whitespace tolerated
(`{{ draft }}`).

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

JSON grader:

```json
{
  "type": "json",
  "assert": [
    "findings.items.length >= 1",
    "findings.items[*].domain contains \"correctness\""
  ]
}
```

The json grader parses the run's output as JSON and checks each `assert`
entry; all must hold. Reasoning models wrap their answer in prose, so if the
whole output is not valid JSON, the grader takes the **last balanced JSON
value** (`{...}` or `[...]`) in the output — braces inside string literals
are handled correctly. No JSON value at all fails the grade with
`no JSON value found in output`.

Each assertion is `<path> <op> <literal>` (spaces around the operator):

- **path** — dot-separated keys with `[<index>]` and `[*]` steps:
  `verdict`, `findings.items.length`, `findings.items[0].severity`,
  `findings.items[*].domain`. A trailing `.length` on an array or string
  reads its length.
- **op** — `==`, `!=`, `>`, `>=`, `<`, `<=`, `contains` (substring on a
  string, membership on an array).
- **literal** — a JSON scalar: `"correctness"`, `0`, `true`, `null`.

`[*]` is existential: the assertion passes if **any** element satisfies it —
including `!=`, where `items[*].x != 1` means "some element differs". For
"no element equals", assert on a value that must not appear another way
(e.g. combine with a `length` bound or use a `[<index>]` path). Missing
paths and type mismatches fail the assertion (with a message naming the
problem), never the whole run. Bad assertion grammar fails at config load,
before any paid run. Like text graders, json graders inspect only the final
output, so they work with every runner, including openai.

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
graders work with every runner. For semantic judgments neither can express,
see [Judge graders (calibrated)](#judge-graders-calibrated) below.

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

## Judge graders (calibrated)

Some judgments cannot be expressed as string checks — "is this the
negate-then-restate construction?" is a semantic call, and regex attempts
both under- and over-catch it. The `judge` grader has an LLM grade the run's
output against a markdown rubric:

```json
{
  "type": "judge",
  "rubric": "./rubrics/negate-restate.md",
  "model": "haiku",
  "runner": "claude-p",
  "minAccuracy": 0.9
}
```

The rubric file becomes the judge's system prompt verbatim (plus a fixed
harness instruction demanding a single JSON verdict), and the graded output
becomes the user prompt. `model` is required and deliberately never defaults
to the arm's model — a model grading its own output is the bias judges exist
to avoid. `runner` defaults to `claude-p`; `baseUrl` targets the openai
runner at any OpenAI-compatible endpoint (judges there are pinned to
temperature 0).

**Calibration is mandatory.** An uncalibrated judge is worse than the regex
it replaces: same wrongness, more confidence, higher cost. So every rubric
ships with labeled fixtures in a sibling directory:

```text
rubrics/negate-restate.md
rubrics/negate-restate.fixtures/
  pass/   outputs the judge must call clean
  fail/   outputs the judge must flag
```

Run the calibration before trusting the judge:

```bash
promptdiff calibrate --rubric rubrics/negate-restate.md --model haiku
```

This judges every fixture, prints per-class accuracy plus each miss, and
writes `rubrics/negate-restate.md.calibration.json` next to the rubric —
commit it; it is the judge's proof of competence, keyed to the rubric's
content hash. Calibrate always exits 0: it measures, the gate enforces.

**The gate.** At compare/measure startup — before any paid run — every judge
grader must have a calibration record that exists, matches the current
rubric content (editing the rubric stales the record) and the spec's
model/runner, and clears `minAccuracy` (default 0.9) on **both** classes.
Per-class bars on purpose: a judge that passes everything scores 100% on the
pass class and 0% on the fail class — overall accuracy would hide it. Any
violation refuses the whole run and names the fix.

Judge verdicts are strict: the last balanced JSON object in the judge's
reply wins (reasoning models add prose), and a reply with no valid verdict
**fails** the graded run — a judge problem never silently counts as a pass.

Cost note: a judge grader adds one billed model call per graded run; that
cost is added into the run's cost so summary totals stay honest. v1 judges
are absolute (one output vs the rubric); pairwise comparison is deferred —
a rubric whose absolute judge cannot clear the calibration bar is the signal
to escalate.

## Designing good fixtures

Lessons from production compare runs, for scenario authors:

- **Don't seed the answer key.** If the primary sources live inside the
  sandbox, any thorough agent can "verify" claims by adjacency and both arms
  pass for the wrong reason. Cite out-of-sandbox paths or URLs so
  re-derivation is the discriminating behavior.
- **Planted defects must be unambiguous.** A one-word quote diff grades as
  pedantry; a clear paraphrase grades cleanly. The answer key belongs in the
  grader — never in the fixture itself.
- **Set the pass bar where the policy value is.** Mechanical holes (wrong
  dates, dead links) fall to any tools-capable agent; the bar has to require
  the defect classes only the prompt-under-test knows about, or the eval
  can't tell your prompt from no prompt.
- **Prove the gap exists before trusting the fix.** That's what target
  scenarios' "baseline must not fully pass" assertion is for — a fixture the
  baseline aces can't certify an improvement.

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
