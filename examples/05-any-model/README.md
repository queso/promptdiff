# Any Model (openai runner + ollama)

promptdiff isn't Claude-only. This example runs the same baseline-vs-proposed
compare against a local [ollama](https://ollama.com) model over its
OpenAI-compatible endpoint — no API key, no cloud cost, no `claude` binary
involved at all. The only thing that changes from `01-hello-compare` is the
top-level `"runner"`/`"baseUrl"`/`"model"` fields; the scenario shape,
grading, and CLI are identical.

**Cost:** free (local) · **Time:** ~10s · **Requires:** ollama with a small
model pulled (`ollama pull llama3.2:1b`)

```bash
./promptdiff compare --scenario ./examples/05-any-model/scenario.json
```

## Example output (illustrative — requires ollama)

Ollama was not installed in the environment this example was built in
(`ollama: command not found`), so this compare was never actually executed —
no output below is a real run. The scenario itself was verified to load and
validate: `loadCompareConfig` resolves both arms to
`{ model: "llama3.2:1b", runner: "openai", baseUrl: "http://localhost:11434/v1" }`,
and running `./promptdiff compare` against it proceeds all the way to an
HTTP `POST http://localhost:11434/v1/chat/completions`, which only then fails
with a connection error — i.e. every promptdiff-side check (config parsing,
skill resolution, runner-capability validation) passes; the only missing
piece is a running ollama server. The block below is shaped exactly like
`formatCompareSummary`'s real output (see `src/engine/compare.ts`), with
plausible numbers substituted:

```
promptdiff compare: any-model-ollama

validation-explanation (target)
  baseline: 1/3 pass (33%) | $0.0000
  proposed: 3/3 pass (100%) | $0.0000
  delta: +67% pass | +$0.0000
  PASS: assertions satisfied
  NOTE: delta could be sampling noise (Fisher exact p=0.40) — consider more runs

total cost: $0.0000
```

## What to notice

- The arm config is just `"runner": "openai"` + `"baseUrl": "http://localhost:11434/v1"`
  at the top level of the scenario file — no code changes, no separate
  runner integration, and (for a local server) no API key.
- Cost reports `$0.0000` for both arms: the openai runner only prices a run
  when `"pricing"` is set in the scenario, and a local server has no dollar
  cost to report anyway.
- The `NOTE: ... sampling noise` line is `compare`'s built-in guardrail
  against over-reading a small-n delta — at `runs: 3` even a real
  improvement often can't clear p=0.05, so bump `--runs` before trusting a
  win here.
- The same `runner: "openai"` + `baseUrl` shape works unmodified against
  vLLM, llama.cpp, and OpenRouter — swap the URL (and model name) and
  nothing else changes.
- Documented limitation: the openai runner is text-graded and single-turn
  only — no tools, no sandbox execution, no skill registry, and no turn cap
  (there's only one turn). Scenarios needing artifact mode, command graders,
  or install delivery are rejected up front; use `claude-p` for those.
