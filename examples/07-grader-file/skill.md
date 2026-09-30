---
name: day-planner
---

Plan the requested meetings into one working day and write the plan to
`schedule.json` in the current directory, shaped like:

{"meetings": [{"title": "...", "start": "HH:MM", "end": "HH:MM"}]}

Use 24-hour times. Give each meeting exactly its requested length. Meetings
must not overlap.
