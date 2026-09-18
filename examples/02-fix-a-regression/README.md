# Fix a Regression

This demonstrates the core loop from promptdiff's ["Why it exists"](../../README.md#why-it-exists):
for a recurring defect, a trustworthy eval has to show two things at once —
(1) the **baseline** instruction set still reproduces the failure, and (2) the
**proposed** instruction set fixes it **without regressing** a case that
already worked.

The skill under test writes git commit messages. The baseline skill tells the
model to follow Conventional Commits and "be thorough" about what changed,
but never states a length limit — so on any change with more than one moving
part, the model pads the subject line describing all of them, blowing past
the 50-character convention. The proposed skill adds one explicit rule: keep
the subject line ≤50 chars, put extra detail in the body.

Two scenarios exercise this:

- `target-multi-part-change` (**target**) — a change with four distinct parts
  (swap the session store, add expiry, update handlers, migrate tests).
  Baseline is expected to fail here; proposed is expected to fix it.
- `regression-simple-typo-fix` (**regression**) — a trivial one-line change
  both arms already handle fine. This proves the new length rule doesn't make
  the skill worse on cases it wasn't broken on.

The grader is a deterministic text/regex check (no LLM judge needed): the
first line must match Conventional Commits format, and — separately — the
first line must be ≤50 characters.

**Cost:** ~$0.10 · **Time:** ~188s · **Requires:** claude CLI

## Run it

```bash
./promptdiff compare --scenario examples/02-fix-a-regression/scenario.json
```

## Actual output

```
promptdiff compare: commit-message subject length

target-multi-part-change (target)
  baseline: 0/3 pass (0%) | $0.0209
  proposed: 3/3 pass (100%) | $0.0537
  delta: +100% pass | +$0.0328
  PASS: assertions satisfied
  NOTE: delta could be sampling noise (Fisher exact p=0.10) — consider more runs
  baseline run 1 failed: output did not match /^.{1,50}(\n|$)/
  baseline run 2 failed: output did not match /^.{1,50}(\n|$)/
  baseline run 3 failed: output did not match /^.{1,50}(\n|$)/

regression-simple-typo-fix (regression)
  baseline: 3/3 pass (100%) | $0.0135
  proposed: 3/3 pass (100%) | $0.0133
  delta: +0% pass | $-0.0002
  PASS: assertions satisfied

total cost: $0.1014
```

## What to notice

- **Baseline fails 0/3, proposed passes 3/3** on the target case — the
  defect is real and reproducible, not cherry-picked, and the fix clears it
  every run at `runs: 3`.
- **The regression scenario stays 3/3 → 3/3.** Adding the length rule didn't
  make the skill worse on a case it already handled — that's the "no
  regression" half of the claim, checked automatically rather than asserted
  by eye.
- The grader is two independent regex checks (`type(scope): …` format, and
  overall line length ≤50 via `^.{1,50}(\n|$)`) plus a `notContains` guard
  against code fences — no LLM judge, no flakiness from a second model's
  opinion.
- The `NOTE: delta could be sampling noise (Fisher exact p=0.10)` line on the
  target scenario is expected at `runs: 3` — even a clean 0/3 → 3/3 flip
  can't rule out noise at this sample size; the assertions and exit code are
  unaffected. Raise `--runs` if you need a tighter p-value.
