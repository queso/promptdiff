"""Background job queue with retry handling."""

import time


def enqueue(job):
    return {"job": job, "attempts": 0}


def retry_delay(attempts):
    # Double the wait after each failed attempt, capped at 30 seconds.
    return min(2 ** attempts, 30)


def run_with_retries(job, fn, max_attempts=5):
    for attempt in range(max_attempts):
        try:
            return fn(job)
        except Exception:
            time.sleep(retry_delay(attempt))
    raise RuntimeError("job failed after max attempts")
