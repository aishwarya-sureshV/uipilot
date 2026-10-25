---
name: journey
description: >
  Propose source-backed UI journey tests for the current app, show the plan,
  and write or run Playwright scripts only after the user approves.
  Use when the user runs /journey or $journey.
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

`realpath` must follow the symlink. Three directories up from the real `SKILL.md` is the journey-agent repo, including when this skill is opened from `~/.claude/skills/journey`, `~/.agents/skills/journey`, or `~/.codex/skills/journey`. The app under test is the current workspace, or the directory the user names. Pass it as `--root`. Do not use the journey-agent package as the app.

## Propose

When the argument is not a `plan.json` path, discover and stop:

```sh
node <package>/bin/journey.mjs discover --root <app> --focus "<argument or the user's feature>"
```

Show the printed journey report and the `Plan:` path. Stop. Ask for approval. Do not run `auto`, `generate`, `run`, or `propose --yes` in this step.

Review the plan the way a user would judge it:

- Each step is a user task ("Add a note", "Check out"), not a keystroke, field or menu.
- Every check passes the test "would a user notice if this broke?". Formatting, ordering, exact wording and markup are not outcomes.
- Required outcomes are proven by what changed: data seen again after a reload or on a fresh device, the app's result, a received request, or a fixture probe. Never by a visible/enabled check, a label or a selected option.
- The feature is one continuous journey, where possible, with persistence, a reversal and a failure with recovery. A tested task never appears in two journeys; steps that only navigate or look at a result may.
- Restrictions are tested by asking for the restricted thing, and checking both the denied and the allowed outcome.
- A task whose outcome needs a capability the fixture lacks is reported as blocked, naming that capability, rather than replaced with setup checks.

When the argument is an existing `plan.json`, read the sibling `journeys.md` if it exists, otherwise show the plan JSON. Stop for approval the same way. Do not rediscover.

## After the user answers

Approval is an explicit yes: `y`, `yes`, `approve`, or a sentence that tells you to write and run that plan. Then:

```sh
node <package>/bin/journey.mjs run --root <app> <plan.json>
```

`run` compiles the Playwright scripts and executes them. Report the summary, the gaps, and where the artifacts were written.

Anything else, including `n` or a request to change the plan, is not approval. Do not write scripts. If they edited the plan, show the edited plan and wait again.

Use `--yes` or `auto` only when the user explicitly says to skip review.
