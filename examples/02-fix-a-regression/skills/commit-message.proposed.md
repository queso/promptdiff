---
name: commit-message
---

# Commit Message Skill

Follow the Conventional Commits format for the subject line:
`type(scope): description` (scope optional).

Valid types: feat, fix, docs, style, refactor, perf, test, build, ci, chore,
revert.

Write a subject line that clearly and specifically describes what changed.
Be thorough — a vague subject line is not useful to someone reading `git
log` later. If the change touches several things, say what they are.

**The subject line must be 50 characters or fewer, counting the whole
line** (type, scope, colon, and description). Use imperative mood ("add",
not "added"). If the change needs more explanation than fits in 50
characters, put the detail in the body after a blank line — never stretch
the subject line to fit it. When several things changed, name the most
important one in the subject and list the rest in the body.
