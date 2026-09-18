# Judge grader (calibrated)

Some qualities can't be text-matched. "Is this explanation appropriate for a
non-technical audience?" has no substring or regex that captures it —
jargon-free phrasing varies too much, and a regex tuned to catch "DNS" or
"latency" will both miss paraphrases and flag legitimate uses. An LLM judge
grading against a rubric can make that call, but an *unproven* judge is
worse than the regex it replaces: same wrongness, more confidence, higher
cost, and it can silently bless any output as "appropriate" forever.
`promptdiff calibrate` closes that gap — it proves the judge against labeled
pass/fail fixtures before `compare` or `measure` are allowed to use it to
grade anything real.

This example: a support agent answers a customer's DNS question. The
baseline skill gives no audience guidance, so Haiku answers like it's
talking to another engineer ("DNS propagation," "TTL," "resolvers," "cached
records"). The proposed skill instructs plain language for a non-technical
reader. A judge grades each reply against `rubrics/audience-appropriate.md`.

**Cost:** ~$0.10 (calibrate $0.0362 + compare $0.0685) · **Time:** ~215s ·
**Requires:** claude CLI

## 1. Calibrate the judge

```bash
./promptdiff calibrate --rubric examples/04-judge-grader/rubrics/audience-appropriate.md --model haiku
```

Real output:

```
[promptdiff] judging fixture pass/domain-change.md
[promptdiff] judging fixture pass/email-missing.md
[promptdiff] judging fixture pass/login-locked.md
[promptdiff] judging fixture pass/slow-site.md
[promptdiff] judging fixture fail/domain-change.md
[promptdiff] judging fixture fail/email-missing.md
[promptdiff] judging fixture fail/login-locked.md
[promptdiff] judging fixture fail/slow-site.md
promptdiff calibrate: haiku via claude-p

pass class: 4/4 correct (100%)
fail class: 4/4 correct (100%)

calibration record written: /home/josh/Code/OpenSource/promptdiff/examples/04-judge-grader/rubrics/audience-appropriate.md.calibration.json
judge cost: $0.0362
gate: compare/measure require BOTH classes >= minAccuracy (default 90%)
```

This writes `rubrics/audience-appropriate.md.calibration.json` (committed
alongside the rubric) — a fixture-keyed proof that this judge model, on this
rubric's content hash, correctly separates the two classes. `calibrate`
always exits 0; it measures. The gate below is what enforces.

## 2. Compare with the judge as grader

```bash
./promptdiff compare --scenario examples/04-judge-grader/scenario.json
```

Real output:

```
[promptdiff] scenario nameserver-change-support-reply (target)
[promptdiff]   baseline run 1/3
[promptdiff]   baseline run 2/3
[promptdiff]   baseline run 3/3
[promptdiff]   proposed run 1/3
[promptdiff]   proposed run 2/3
[promptdiff]   proposed run 3/3
promptdiff compare: plain-language support answers

nameserver-change-support-reply (target)
  baseline: 0/3 pass (0%) | $0.0177
  proposed: 3/3 pass (100%) | $0.0508
  delta: +100% pass | +$0.0330
  PASS: assertions satisfied
  NOTE: delta could be sampling noise (Fisher exact p=0.10) — consider more runs
  baseline run 1 failed: judge verdict: fail — Uses multiple unexplained technical terms without definition: 'nameservers', 'DNS' (appears 4 times—the acronym is never explained in plain words), 'propagate/propagation', and 'resolvers'. A non-technical reader would encounter at least three unclear concepts in the first sentence alone and would need to look up what these terms mean to follow the explanation.
  baseline run 2 failed: judge verdict: fail — Uses multiple unexplained jargon terms: 'DNS' (acronym, never defined), 'propagate' (technical concept, unexplained), 'nameserver' (unexplained), and 'cached' (unexplained). A non-technical reader would encounter at least 4 terms requiring external lookup to understand the core message.
  baseline run 3 failed: judge verdict: fail — Uses multiple unexplained jargon terms: 'DNS' (appears 4 times without definition), 'propagate,' 'cache/caches,' and 'nameserver.' A non-technical reader would not understand what these mean or why they matter. The answer assumes knowledge of how domain name systems and caching work.

total cost: $0.0685
```

## What to notice

- **The gate reads the same file it grades with.** `scenario.json`'s judge
  grader is `{"rubric": "./rubrics/audience-appropriate.md", "model":
  "haiku", "minAccuracy": 0.9}` — same rubric path, same model as the
  calibration run. Change either and the gate refuses (stale-record or
  model-mismatch error) until you recalibrate.
- **Skipping calibration refuses the run, before any paid call.** Deleting
  `audience-appropriate.md.calibration.json` and re-running `compare`
  produces, immediately and with exit code 1:
  ```
  judge rubric .../audience-appropriate.md has no calibration record
  (.../audience-appropriate.md.calibration.json) — run: promptdiff calibrate
  --rubric .../audience-appropriate.md --model haiku
  ```
  No model calls happen — the check runs before the baseline/proposed arms
  do.
- **Per-class bars matter.** A judge that rubber-stamps everything as "pass"
  would score 100% on the `pass` fixtures and 0% on the `fail` fixtures;
  overall accuracy would hide that. `calibrate` reports both classes
  separately, and the gate requires both to clear `minAccuracy` (0.9 here).
- **The judge's own reasoning is legible.** Each failed baseline run prints
  the judge's `reason` (e.g. "DNS... never explained in plain words"), so a
  `compare` failure tells you *why* in the judge's own words, not just
  pass/fail.
- **n=3 is a demo, not a claim.** 0/3 → 3/3 is exactly the shape the
  `NOTE: delta could be sampling noise (Fisher exact p=0.10)` line exists
  to flag — real usage would run more.
