# Grader file

A grader file replaces a hand-written grader script: one TS file, named
graders, and a `result` object with checks. promptdiff reads the artifact,
parses the JSON, runs every check, prints each failure with the data it was
judged on, and turns the outcome into the command-grader exit code.

The skill under test plans four meetings into one day and writes
`schedule.json`. The two graders in [`grade.eval.ts`](./grade.eval.ts) are
semantic: "no two meetings overlap" and "nothing lands in the lunch block"
are time-range math, which no substring check can express. So both lead
with `result.assert(condition, message, context)`, and `shouldHave` appears
once, for the one literal thing worth checking (Priya's name).

```ts
export default grade("schedule.json", {
  "lunch-stays-free": ({ result }) => {
    const meetings: Meeting[] = result.json().meetings;
    const clashes = meetings.filter((m) => minutes(m.start) < minutes("13:00") && minutes(m.end) > minutes("12:00"));
    result.assert(clashes.length === 0, "a meeting overlaps the 12:00-13:00 lunch block", { clashes });
  },
});
```

The scenario references each grader by name:

```json
"grader": { "file": "./grade.eval.ts", "name": "lunch-stays-free" }
```

**Cost:** free for the grader runs below. The `measure` run (8 haiku runs
in artifact mode) was not run for this README, so its cost is not measured.
**Requires:** bun; the claude CLI for `measure`

## Try the graders without a model run

`promptdiff grade` is the command every file grader compiles to. It resolves
the artifact path against the current directory, which inside a real run is
the sandbox. The `samples/` directories hold hand-written schedules, so you
can check a grader before paying for any runs.

A clean schedule:

```bash
cd examples/07-grader-file/samples/pass
../../../../promptdiff grade --file ../../grade.eval.ts --name no-overlaps
```

```
grade "no-overlaps" (schedule.json): 6 of 6 checks passed
```

A schedule with two defects. Each grader reports its own, with the meetings
that caused it:

```bash
cd examples/07-grader-file/samples/lunch-clash
../../../../promptdiff grade --file ../../grade.eval.ts --name no-overlaps
```

```
FAIL 1:1 with Priya starts before Design review ends | context: {"before":{"title":"Design review","start":"09:00","end":"10:00"},"after":{"title":"1:1 with Priya","start":"09:30","end":"10:00"}}
grade "no-overlaps" (schedule.json): 1 of 6 checks failed
```

```bash
../../../../promptdiff grade --file ../../grade.eval.ts --name lunch-stays-free
```

```
FAIL a meeting overlaps the 12:00-13:00 lunch block | context: {"clashes":[{"title":"Hiring debrief","start":"12:00","end":"13:00"}]}
grade "lunch-stays-free" (schedule.json): 1 of 1 checks failed
```

No schedule at all (run from `samples/`, which has no `schedule.json`):

```bash
cd examples/07-grader-file/samples
../../../promptdiff grade --file ../grade.eval.ts --name no-overlaps; echo $?
```

```
no artifact: schedule.json does not exist in the grader's working directory
77
```

## Run it for real

```bash
./promptdiff measure --scenario ./examples/07-grader-file/scenario.json
```

This output was not captured for this README. Each scenario prints a line
like `3/3 pass (100%), 1 no-artifact`.

## What to notice

- **Every failure is reported, not the first one.** A failed check records
  itself and the grader keeps going, so one run shows every defect.
- **No artifact is not a failure.** Exit 77 means the agent wrote nothing.
  `measure` and `compare` leave those runs out of the pass rate and count
  them on their own (`3/3 pass (100%), 1 no-artifact`), so a run that
  produced nothing can neither pass a negative check nor count as a
  reproduced defect.
- **Context is the evidence.** The third argument to `result.assert` is
  printed on failure. Pass the data the check looked at, and the summary
  answers "why did run 2 fail" without a `--keep-sandbox` re-run.
- The import is `@theaiteam/promptdiff`. Under `promptdiff grade` it
  resolves to the running promptdiff, so the grader works without
  installing the package next to it; install it as a dev dependency if you
  want editor types.
