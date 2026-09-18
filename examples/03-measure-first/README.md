# Measure first

Before you rewrite a prompt you suspect is flaky, measure its current pass
rate. Skip that step and any before/after comparison is a coin flip against
a coin flip: two runs of the *same* prompt can already look like a fix or a
regression from sampling noise alone. `measure` runs one instruction set N
times and reports a bare pass rate — a real number to rewrite against,
instead of a vibe from the last output you happened to read.

This example measures `skill.md`, an intentionally under-specified
extraction prompt: "extract the key fields from this support ticket as
JSON," no schema. Given the same support ticket four times, `haiku`
extracts a working JSON object every time — it just doesn't agree with
itself on the field names (`severity` vs. `urgency` vs. `priority`) or the
value casing (`"Medium"` vs. `"medium"`). The `json` grader's path
assertions catch exactly that kind of drift, because they check one exact
path and value, not "did it extract *something* reasonable."

**Cost:** ~$0.01 · **Time:** ~28s · **Requires:** claude CLI

```bash
./promptdiff measure --scenario ./examples/03-measure-first/scenario.json
```

Real output:

```
[promptdiff] scenario extracts-medium-severity
[promptdiff]   measure run 1/4
[promptdiff]   measure run 2/4
[promptdiff]   measure run 3/4
[promptdiff]   measure run 4/4
promptdiff measure: ticket-field-extraction (haiku via claude-p)

extracts-medium-severity
  2/4 pass (50%) | $0.0139
  run 1 failed: severity == "Medium": path segment "severity" not found (at {"subject":"Can't export reports since yesterday's update","reporter_name":"Dana Whitfield","reporter_email":"dana.whitf…)
  run 4 failed: severity == "Medium": found "medium"

total cost: $0.0139
```

```bash
$ echo $?
0
```

## What to notice

- **50% is the measurement, not a bug.** The grader is exact on purpose
  (`severity == "Medium"`) — an under-specified prompt gets an
  under-specified extraction, and the pass rate is the honest size of that
  problem. Run it again and you'll see a different split (25%, 50%, ...);
  that's the real variance in the prompt, not flakiness in the harness.
- **The two failure reasons are two different bugs.** Run 1's `severity`
  key doesn't exist at all — the model named it `reporter_name`/
  `reporter_email` and dropped severity from that response's schema
  entirely. Run 4 has the key but the wrong case (`"medium"` vs
  `"Medium"`). A prompt fix for one won't fix the other — you'd need to
  pin both the field name and an enum of allowed values.
- **`measure` exits 0 here even though the scenario "failed" 50% of the
  time.** `echo $?` above prints `0` — a measurement has no pass/fail, so a
  49-53% swing on rerun is not a CI signal by itself. Wire a *threshold*
  check around the printed rate (or graduate to `compare` with an assertion)
  once you have a bar to enforce.
- This baseline is now the number a proposed fix has to beat. Pin the
  schema (name the fields, constrain `severity` to an enum) in a revised
  `skill.md`, drop it into a `compare` scenario as the proposed arm against
  this one as baseline, and see if the pass rate — not just one output —
  actually moves.
