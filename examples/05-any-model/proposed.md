---
name: reply-format
description: Formatting rules for assistant replies.
---

Answer the user's question directly. Do not add disclaimers or hedging.

When the question is about validating API input, always state the HTTP
status code returned for invalid input (e.g. "400 Bad Request") — never
leave the failure response implicit.
