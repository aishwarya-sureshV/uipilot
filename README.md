# journey-agent

Source-driven UI journey tests with a person in the loop. The agent reads the app, proposes journeys, and waits. After approval it compiles Playwright scripts and runs them. `auto` still skips the prompt.

This repo is the agent. Point it at an app with `--root`.

It works with any web app that has a Playwright setup and a small fixture (below).

## What a journey is

- **One story, end to end.** A journey follows a real user through the feature in one continuous session: create, use, change, remove. Later tasks depend on earlier results.
- **Each step is a user task**, such as "Add a note" or "Check out with the saved card". A step can take many clicks and keystrokes; a keystroke is never a step of its own.
- **Check what a user would notice if it broke.** Formatting rules, element order, exact status wording, styling, markup and storage keys are implementation details, not outcomes.
- **Prove outcomes, not presence.** A required outcome is proven by what the task changed: data seen again after a reload or on a fresh device, the app's result, a request the server received, or a fixture probe. `visible`/`hidden`/`enabled`/`disabled` checks cannot prove it.
- **As few journeys as possible.** The task a step tests may be tested in only one journey. A second journey must start from a state the first can't reach; the validator rejects a plan that tests the same task twice. Steps that only navigate or look at a result, like opening a statement, may appear in several journeys.
- **Include what breaks in real use:** a reload or reopen, a reversal that stays reversed, and one failure with recovery when the app supports it.
- **Restrictions are tested by trying them.** For permissions, roles, modes or approvals, the input asks for the restricted thing, and both the denied and the allowed outcome are checked.
- **Blocked, not faked.** If the harness can't execute or observe a required outcome, the whole journey is reported as blocked, naming the missing capability. A run with passing browser tests and blocked journeys reports `passed: false` and `browserPassed: true`.

## Fixture contract

The app under test provides `@playwright/test`, a Playwright config (`playwright.config.ts`, `.js`, `.mjs` or `.cjs`) whose `testDir` is `process.env.JOURNEY_TEST_DIR` when set, and `tests/journeys/fixture.ts`. The fixture extends Playwright's `test` with an `app` object:

| Member | Used by | Purpose |
|---|---|---|
| `responses` | `apiResponses`, `apiResponse` | Mocked `{method, path, body}` responses, first match wins. Leave empty if the app runs against a real backend. |
| `hasRequest(subset)` | `request` check | True if a recorded request matches the method, path and body subset. |
| `act(name, args)` | `act` action | Named capabilities outside the page: take the server offline, open a fresh device, advance the clock. |
| `probe(name, args)` | `state` check | Named observations outside the page: stored records, sent emails, files written. |

The model reads the fixture and may only use `act`/`probe` names it defines. A plan that names one the fixture lacks is rejected, so define a capability before asking for journeys that need it.

```ts
import { test as base, expect } from '@playwright/test';

export const test = base.extend<{ app: any }>({
  app: async ({ page }, use) => {
    let offline = false;
    const requests: { method: string; path: string; body: unknown }[] = [];
    const app = {
      responses: [] as { method: string; path: string; body: unknown }[],
      // matches(): your body-subset comparison.
      hasRequest: (r) => requests.some(x => x.method === r.method && x.path === r.path && matches(x.body, r.body)),
      act: async (name: string, args: any) => ({ serverOffline: () => { offline = args?.on ?? true; } })[name](),
      probe: async (name: string, args: any) => ({ storedNotes: () => readStore().notes.map(n => n.body) })[name](), // readStore(): your test server's data
    };
    await page.route('**/api/**', route => { /* record the request, honour offline and app.responses */ });
    await use(app);
  },
});
export { expect };
```

## Slash command

`/journey` is the skill in `.grok/skills/journey`. The same directory is what Claude Code and Codex load. Install it once for each host:

```sh
mkdir -p ~/.agents/skills ~/.grok/skills ~/.claude/skills ~/.codex/skills
ln -sfn "$(pwd)/.grok/skills/journey" ~/.grok/skills/journey
ln -sfn "$(pwd)/.grok/skills/journey" ~/.claude/skills/journey
ln -sfn "$(pwd)/.grok/skills/journey" ~/.agents/skills/journey
ln -sfn "$(pwd)/.grok/skills/journey" ~/.codex/skills/journey
```

```text
/journey notes create, save, reopen, and delete
$journey notes create, save, reopen, and delete
```

Claude Code and Grok use `/journey`. Codex uses `$journey`, or the `/skills` picker. `/journey` does nothing in Codex. The Codex CLI reads `~/.agents/skills`. Codex Desktop also reads `~/.codex/skills`. Restart the app after linking. The command prints the plan and stops. Reply yes and it writes the scripts and runs them. Reply no and it keeps the plan. Discovery still runs through the Codex CLI.

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

`--model` overrides the model. The default is Codex `gpt-6-luna` with `xhigh` reasoning. `JOURNEY_CODEX_BIN` selects the Codex executable. `--repairs` accepts 0–3, bounding draft-validation retries and browser repairs separately. Each browser repair has its own validation allowance.

Source is read from `src/`, `app/`, `pages/`, `components/`, `lib/` and `server/` under `--root`, skipping `node_modules`, build output and generated tests. Set `JOURNEY_SOURCE_DIRS` to a comma-separated list to change that. Missing directories are skipped.

The app's fixture and Playwright config are also inventoried when present. CLI outputs save `sources.json`; browser runs check the inventoried source before and after execution and reject changes during validation.

Generated files go in `<app>/tests/journeys/generated/` and are not written back into this package. The compiler emits data-driven Playwright against the app's `tests/journeys/fixture.ts`.

```sh
npm test
```
