# Changelog

## 1.0.0 — 2026-07-31

First stable release. promptdiff is a Bun CLI for testing whether an LLM
prompt or skill change actually changes behavior — with any model, not just
Claude.

### Commands

- `run` — one bounded model invocation with an agent file and optional skills
- `compare` — N-run baseline-vs-proposed comparison with deterministic
  grading, pass-rate assertions, and honest statistics
- `measure` — single-arm characterization: per-case pass rates, no
  comparison semantics (#18)
- `calibrate` — measure a judge rubric's accuracy against labeled fixtures
  before it is trusted to grade anything (#21/#22)

### Runners

- `claude-p` (default): headless Claude Code — tools, artifact sandboxes,
  skill-registry install testing, explicit budget-abort errors (#3)
- `openai`: any OpenAI-compatible endpoint (OpenAI, ollama, vLLM, llama.cpp,
  OpenRouter) — vision inputs, `requestParams` passthrough, transient-failure
  retries with backoff (#17), and usage-based cost accounting so
  `maxBudgetUsd` enforces (#20)
- Per-arm model/runner/endpoint for model-vs-model comparisons, with
  cross-runner caveats surfaced in the summary

### Graders

- `text` — contains / notContains / regex over the final output
- `command` — shell exit codes in the per-run sandbox, with
  `$PROMPTDIFF_OUTPUT_FILE` for completion-style runs
- `json` — path assertions over the last balanced JSON value (#19)
- `judge` — LLM judge with a rubric, labeled calibration fixtures, and a
  refuse-to-grade gate on per-class accuracy (#21/#22)

### Trustworthy receipts

- Template rendering (`render.vars`, `--var`) so scenarios test the prompt
  files that actually ship (#15)
- Sampling-noise labels via exact Fisher tests (#13)
- `productionModel` divergence warnings (#14)
- Grader evidence for failing runs in the summary (#4)
- `--report ndjson` append-only run history (#11)
- `--receipts` content-addressed eval receipts keyed on prompt hashes (#10)
- `--cache` opt-in baseline-arm caching keyed on content (#12)
