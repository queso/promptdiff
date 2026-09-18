# Hello Compare

The smallest possible `promptdiff compare`: one agent, one scenario, one
grader. The baseline skill is missing a formatting instruction; the proposed
skill adds it; a text grader catches the difference. This is the shape every
other example builds on — start here before reading the rest.

**Cost:** ~$0.01 · **Time:** ~12s · **Requires:** claude CLI

## Run it

```bash
./promptdiff compare --scenario ./examples/01-hello-compare/scenario.json
```

## Output

```
promptdiff compare: hello-compare

answers-with-summary-prefix (target)
  baseline: 0/2 pass (0%) | $0.0021
  proposed: 2/2 pass (100%) | $0.0033
  delta: +100% pass | +$0.0013
  PASS: assertions satisfied
  NOTE: delta could be sampling noise (Fisher exact p=0.33) — consider more runs
  baseline run 1 failed: output did not contain "SUMMARY:"
  baseline run 2 failed: output did not contain "SUMMARY:"

total cost: $0.0054
```

## What to notice

- `baseline.md` and `proposed.md` are the same skill except for one added
  instruction ("start your reply with `SUMMARY:`"). That's the entire A/B
  variable — the agent and the scenario prompt never change.
- The pass-rate delta (0% → 100%) is the whole point: the grader
  (`{"type": "text", "contains": ["SUMMARY:"]}`) can't see the instruction
  text, only its effect on the model's output.
- This scenario is `"kind": "target"`, so `compare` asserts baseline must
  *not* fully pass (the gap is real) and proposed must improve on it. Both
  hold here, so the process exits `0`; either failing would exit non-zero —
  to see the failing case, edit `scenario.json` so `proposedSkills` points at
  `./baseline.md` and rerun.
- At `runs: 2` the delta is real but small-sample — the `NOTE:` line about
  sampling noise is `compare` being honest about that, not a bug. It doesn't
  change the exit code.
