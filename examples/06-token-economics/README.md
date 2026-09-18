# Token economics

`measure`'s summary line collapses a run down to `$0.1733` — a single
cost-USD number that blends fresh input tokens, cache-write tokens,
cache-read tokens, and output tokens into one weighted sum (cache reads are
priced far below fresh input). That's the right altitude for "did this pass,
and what did it cost" — and the wrong altitude for "did my prompt change
actually cut how much the agent explores, or did it just shift the same
reads from fresh input into cache?" Answering that needs the token
categories themselves, which is what `--raw-out` writes: each run's full
runner result JSON, `usage` block included. This example pairs that with
`--max-turns`, because a token-economics number is only honest if every run
it's computed from actually finished — a run that got cut off mid-exploration
and stumbled onto a passing answer would silently corrupt the average, so a
capped run is scored as a failed run instead of graded on its partial output.

The task: a `code-investigator` agent is dropped into a 5-file sandboxed
Python "service" (`seed/`) and asked which file implements exponential
backoff for retries. The word "backoff" doesn't appear anywhere in the seed
files, so the agent can't grep its way to the answer — it has to actually
read the files and understand what the code does. The correct file is
`queue.py`.

**Cost:** ~$0.19 · **Time:** ~32s · **Requires:** claude CLI

## Run it

Generous cap — runs finish normally, raw JSON lands per run:

```bash
./promptdiff measure \
  --scenario ./examples/06-token-economics/scenario.json \
  --max-turns 8 \
  --raw-out ./examples/06-token-economics/raw
```

Tight cap — same scenario, same seed, capped at 1 turn:

```bash
./promptdiff measure \
  --scenario ./examples/06-token-economics/scenario.json \
  --max-turns 1 \
  --raw-out ./examples/06-token-economics/raw-capped
```

## Actual output

Generous cap (`--max-turns 8`):

```
[promptdiff] scenario find-retry-backoff-module
[promptdiff]   measure run 1/2
[promptdiff]   measure run 2/2
promptdiff measure: token-economics (sonnet via claude-p)

find-retry-backoff-module
  2/2 pass (100%) | $0.1733

total cost: $0.1733
```

Tight cap (`--max-turns 1`):

```
[promptdiff] scenario find-retry-backoff-module
[promptdiff]   measure run 1/2
[promptdiff]   measure run 2/2
promptdiff measure: token-economics (sonnet via claude-p)

find-retry-backoff-module
  0/2 pass (0%) | $0.0138
  run 1 failed: hit the 1-turn cap before finishing
  run 2 failed: hit the 1-turn cap before finishing

total cost: $0.0138
```

Trimmed `usage` block from one raw file of the generous-cap run
(`raw/find-retry-backoff-module_measure_1.json`) — the agent actually
finished, having read through the seed files across 7 turns:

```json
{
  "total_cost_usd": 0.11324400000000001,
  "usage": {
    "input_tokens": 14,
    "cache_creation_input_tokens": 16451,
    "cache_read_input_tokens": 197660,
    "output_tokens": 788
  },
  "num_turns": 7,
  "subtype": "success",
  "result": "This clearly implements exponential backoff (`2 ** attempts`, capped, used in retry loop). I'm confident in the answer.\n\nqueue.py"
}
```

And the same block from the tight-cap run
(`raw-capped/find-retry-backoff-module_measure_1.json`) — cut off after its
first tool call, with almost no fresh exploration and no cache built up yet:

```json
{
  "total_cost_usd": 0.006822400000000001,
  "usage": {
    "input_tokens": 2,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 29392,
    "output_tokens": 94
  },
  "num_turns": 2,
  "subtype": "error_max_turns",
  "errors": ["Reached maximum number of turns (1)"]
}
```

## What to notice

- The summary's `$0.1733` and `$0.0138` are single numbers; the raw files
  underneath are where `input_tokens` (14), `cache_creation_input_tokens`
  (16,451), `cache_read_input_tokens` (197,660), and `output_tokens` (788)
  live separately — that's the breakdown a real "did this change cut
  exploration or just move it into cache?" comparison would diff.
- The tight-cap run's `subtype` is `error_max_turns`, not `success`, and its
  `usage.cache_read_input_tokens` (29,392) is over 6x smaller than the
  finished run's — it never got far enough to build up the full-context
  reads that come from actually working through all 5 seed files.
- Both capped runs failed with `hit the 1-turn cap before finishing`, and
  neither was graded — the harness never even looked at whether the model's
  cut-off partial output happened to mention `queue.py`. That's the point:
  a turn-capped run is a measured outcome, not a cheap opportunity to pass.
- Raw files are written as `<scenario>_measure_<n>.json` the moment each run
  finishes, one per run — so `--raw-out` gives per-run granularity that the
  summary's aggregate cost/pass-rate line can't.
