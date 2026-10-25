# journey-agent

Source-driven UI journey tests with a person in the loop. The agent reads the app, proposes journeys, and waits. After approval it compiles Playwright scripts and runs them. `auto` still skips the prompt.

The checked-in DevDen browser examples stay in DevDen. This repo is only the agent.

## Slash command

`/journey` is a Grok skill in `.grok/skills/journey`. Install it for every workspace:

```sh
ln -s "$(pwd)/.grok/skills/journey" ~/.grok/skills/journey
```

```text
/journey notes create, save, reopen, and delete
```

The command prints the plan and stops. Reply yes and it writes the scripts and runs them. Reply no and it keeps the plan.

## CLI

```sh
npm install
# The app under test needs @playwright/test, a Playwright config, and tests/journeys/fixture.ts.
# The config must use JOURNEY_TEST_DIR as testDir when that env var is set.

journey discover --root /path/to/app --focus "the feature"
journey propose --root /path/to/app --focus "the feature"
journey propose --root /path/to/app tests/journeys/generated/<run>/plan.json
journey run --root /path/to/app tests/journeys/generated/<run>/plan.json --repairs 0
journey auto --root /path/to/app --focus "the feature"
```

`propose` asks in the terminal. `y` writes scripts and runs them. `n` keeps the plan and writes nothing. A non-interactive shell stops unless you pass `--yes`.

`--model` overrides the model. The default is Codex `gpt-6-luna` with `xhigh` reasoning. `JOURNEY_CODEX_BIN` selects the Codex executable. `--repairs` accepts 0–3.

Source is read from `src/` and `server/` under `--root`. Set `JOURNEY_SOURCE_DIRS` to a comma-separated list to change that. Missing directories are skipped.

Generated files go in `<app>/tests/journeys/generated/` and are not written back into this package. The compiler emits data-driven Playwright against the app's `tests/journeys/fixture.ts`.

```sh
npm test
```
