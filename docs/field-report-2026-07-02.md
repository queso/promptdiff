# Field report — first real compare run (content pipeline research adversary)

First production use: proving `flows/research/prompts/adversary.md` (TheAITeam/content) against
a seeded-defects fixture before wiring it into the Conduit research flow. Scenario:
`content/test/evals/research-adversary.scenario.json` — naive-review baseline vs adversarial
prompt, artifact mode, command grader counting planted holes, 3 runs/arm.

## What worked (keep these)

- **The gap-must-exist assertion earned its keep on run one.** First fixture put the primary
  sources inside the sandbox; baseline passed 3/3 and promptdiff FAILED the comparison with
  "baseline fully passed; the target gap was not reproduced." Without that assertion we'd have
  shipped a checker validated by a test that couldn't fail. This is the tool's core value and
  it fired exactly as designed.
- **Command graders against agent-written artifacts** (findings.json + a bun answer-key script)
  gave a real ≥N-of-M score, which text graders' all-must-match semantics can't express.
- **Cost + pass-rate reporting per arm** made the iterate/accept decision one glance
  (final: baseline 0/3 @ $0.85, proposed 2/3 @ $1.76, +67%).

## Fixed this session (committed)

- **`--permission-mode acceptEdits` in the runner args.** Headless claude denies file writes
  without an explicit permission mode, so artifact-mode agents couldn't write findings.json —
  every command-grader scenario would fail both arms. Safe because text mode passes
  `--tools ""` and artifact mode's cwd is the disposable sandbox. Regression test added.

## Requested improvements (from real debugging cost)

1. **Budget aborts surface as `claude exited 1:` with empty stderr.** A run that hit the
   `--max-budget-usd` cap is indistinguishable from a crash; it cost a full debug cycle to
   identify. When exit != 0 and reported cost is near maxBudgetUsd, say so
   ("likely budget abort — raise maxBudgetUsd").
2. **Show grader output for failing runs in compare results.** Diagnosing WHICH planted hole a
   2/3 proposed arm missed requires re-running with `--keep-sandbox`. Capturing grader
   stdout/stderr per failing run (even truncated) would make one compare run self-diagnosing.
3. **README budget guidance.** An artifact-mode run with default tools on a small fixture
   measured ~$0.86 API-equivalent — right at the default $1 cap. Suggest documenting $3+ for
   artifact scenarios.

## Fixture-design lessons (for scenario authors)

- **Don't seed the answer key.** Primaries inside the sandbox let any thorough agent "verify"
  by adjacency; cite real out-of-sandbox paths/URLs so re-derivation is the discriminating
  behavior.
- **Planted defects must be unambiguous** (a one-word quote diff grades as pedantry; a clear
  paraphrase grades cleanly), and the answer key lives in the grader, never the fixture.
- **Set the bar where the *policy* value is.** Mechanical holes (dates, dead links) fall to any
  tools-agent; the bar (7/8) has to require the classes only the prompt-under-test knows about
  (posture, confidentiality, completeness).
