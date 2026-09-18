# Examples

Six runnable, self-contained examples, ordered as a learning curve. Each
directory holds everything it needs (agent, skills, scenario file) plus its
own README with the exact command, an honest cost label, and output captured
from a real run — so you can see what promptdiff gives you before spending
anything yourself.

Run them from the repo root. All except 05 need the `claude` CLI installed;
none need an API key beyond what `claude` already uses.

| Example | What it shows | Cost |
| --- | --- | --- |
| [01-hello-compare](./01-hello-compare/) | The smallest baseline-vs-proposed comparison: one added instruction, one text grader, a 0% → 100% delta. Start here. | ~$0.01 |
| [02-fix-a-regression](./02-fix-a-regression/) | The core loop: baseline reproduces a realistic defect, proposed fixes it, a second scenario proves nothing regressed. | ~$0.10 |
| [03-measure-first](./03-measure-first/) | Single-arm `measure`: put a number on a flaky prompt (here: a genuine ~50% pass rate) before you try to fix it. | ~$0.01 |
| [04-judge-grader](./04-judge-grader/) | A calibrated LLM judge end to end: rubric, labeled fixtures, `calibrate`, then a compare — and the refuse-to-grade gate when calibration is missing. | ~$0.10 |
| [05-any-model](./05-any-model/) | The `openai` runner against local ollama: not Claude-only, zero API keys. Same shape works for vLLM, llama.cpp, OpenRouter. | free (local) |
| [06-token-economics](./06-token-economics/) | Turn caps (`--max-turns`) + raw per-run results (`--raw-out`): token-category analysis, and how a capped run is failed without grading. | ~$0.19 |

Every `scenario.json` here is loaded by `test/examples.test.ts` in CI, so the
examples can't silently drift from the config schema.
