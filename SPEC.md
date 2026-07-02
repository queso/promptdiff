# skill-eval - Design Spec

Status: early implementation. The original spike proved the `claude -p`
mechanism; the current repo now contains a real `run` command, a scenario-driven
`compare` command, deterministic graders, sandbox setup, timeout and budget
bounds, and tests for the core local behavior.

## 1. Problem

AI agent pipelines generate proposed improvements to prompts, skills, and
enforcement hooks. The chronic failure mode is that proposed edits are shipped
on faith or never shipped at all because there is no cheap proof that the edit
changes behavior without damaging scenarios that already worked.

`skill-eval` is the proof step between "we think this skill edit helps" and
"ship it." It does not collect findings, rank recurrence, or manage tuning
rounds. Those can live in a larger system. This repo focuses on the eval harness.

## 2. Eval Altitudes

The eval method should match the change being tested:

| Change altitude | Eval method | Cost |
|---|---|---|
| Enforcement hook | Deterministic unit test | 1 run, near-free |
| Skill or agent prompt text | N-run stochastic A/B over pass rates | N x arms x per-run cost |

`skill-eval` targets the second row. It runs one agent with baseline skill text
and one agent with proposed skill text against the same scenario set.

## 3. Claude Runner

The runner shells out to headless Claude Code:

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

The runner captures:

- final output text
- `total_cost_usd`
- turn count
- duration
- model usage keys

## 4. A/B Variable

Skill variants are inlined into the system prompt instead of being loaded by the
Skill tool at runtime:

```text
system prompt = agent body with frontmatter stripped
              + baseline or proposed skill body with frontmatter stripped
```

That keeps the comparison controlled. The baseline and proposed arms differ by
the skill text under test, not by whichever skill version happens to be
installed on disk.

## 5. Scenario Format

A compare file defines:

- agent file
- baseline skill files
- proposed skill files
- model
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

## 6. Grading

Prefer deterministic graders over LLM judges.

Text graders inspect Claude's final output. Command graders run inside the
sandbox after the model invocation and check the exit code of a local command
such as `bun test`, `go test ./...`, or a fixture-specific script.

LLM judges are intentionally not implemented yet. They would add a second billed
call per run and should be reserved for cases that cannot be expressed as local
checks.

## 7. Architecture

```text
skill-eval          # Bun executable shim
src/cli.ts          # command parsing and user-facing orchestration
src/args.ts         # strict local flag parser
src/prompt.ts       # frontmatter stripping and prompt assembly
src/runner/         # provider-coupled runner code
src/engine/         # compare loop, config loading, graders, sandbox lifecycle
test/               # Bun tests
```

The compare engine depends on a small runner interface. Claude Code is the first
runner, but the engine does not import provider SDKs.

## 8. Current Limitations

- Pass-rate assertions are intentionally simple. They are good enough to catch
  decisive effects at small N, but there is no statistical test yet.
- Scenario authoring is manual JSON. A future tuning loop should generate these
  files from accepted findings.
- Command graders run trusted local commands from scenario files. Do not run
  untrusted scenario files.
- The OpenAI-compatible runner is still planned, not implemented.
- Fixture coverage remains the bottleneck. Missing fixtures mean missing
  regression protection.

## 9. Decisions

- Standalone Bun repo rather than embedding in a larger mission runner.
- Claude Code `-p` runner first.
- Inline skills for variant control.
- Deterministic graders first; LLM judges later if needed.
- Per-run sandbox cwd, timeout, and budget bounds are mandatory for paid runs.
