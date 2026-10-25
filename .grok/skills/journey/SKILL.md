---
name: journey
description: >
  Propose source-backed UI journey tests for the current app, show the plan,
  and write or run Playwright scripts only after the user approves.
  Use when the user runs /journey.
argument-hint: "[feature focus or plan.json]"
user-invocable: true
disable-model-invocation: true
---

# /journey

Propose UI journey tests, then wait. Scripts are written and executed only after the user approves that plan in this conversation.

The CLI is `node "$PACKAGE/bin/journey.mjs"`. Resolve `PACKAGE` from this file, following symlinks:

```sh
PACKAGE="$(cd "$(dirname "$(realpath <this SKILL.md>)")/../../.." && pwd)"
```

That walks from `.grok/skills/journey/` up to the journey-agent repo. The app under test is the current workspace, or the directory the user names. Pass it as `--root`. Do not use the journey-agent package as the app.

## Propose

When the argument is not a `plan.json` path, discover and stop:

```sh
node <package>/bin/journey.mjs discover --root <app> --focus "<argument or the user's feature>"
```

Show the printed journey report and the `Plan:` path. Stop. Ask for approval. Do not run `auto`, `generate`, `run`, or `propose --yes` in this step.

When the argument is an existing `plan.json`, read the sibling `journeys.md` if it exists, otherwise show the plan JSON. Stop for approval the same way. Do not rediscover.

## After the user answers

Approval is an explicit yes: `y`, `yes`, `approve`, or a sentence that tells you to write and run that plan. Then:

```sh
node <package>/bin/journey.mjs run --root <app> <plan.json>
```

`run` compiles the Playwright scripts and executes them. Report the summary, the gaps, and where the artifacts were written.

Anything else, including `n` or a request to change the plan, is not approval. Do not write scripts. If they edited the plan, show the edited plan and wait again.

Use `--yes` or `auto` only when the user explicitly says to skip review.
