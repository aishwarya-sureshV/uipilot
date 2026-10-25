import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { alignEvidence, compile, report, schema, sources, validate, preserveContract } from '../src/core.mjs';
import { approvalSummary, parseApproval, waitForApproval } from '../src/approval.mjs';
import { diagnostics, execute, feedbackLoop } from '../src/runner.mjs';
import { sourceTool } from '../src/source-reader.mjs';
import { explorer, locate, pageUrl, treeChange, tools as browserTools } from '../src/browser-tool.mjs';
import { ask, codexArgs } from '../src/model.mjs';

const files = { 'src/example.tsx': 'setNotes(next);\n' };
const evidence = [{ file: 'src/example.tsx', line: 1, quote: 'setNotes(next);' }];
const target = { by: 'role', role: 'button', name: 'Save' };
const plan = { journeys: [{ id: 'save-note', goal: 'Save and reopen a note', prerequisites: ['Fresh context'], blocked: '', apiResponses: [],
  effects: [{ id: 'persist', trigger: 'save', consumer: 'list', expected: 'saved note remains visible', evidence, required: true, exercise: 'step-0', coveredBy: [{ step: 'step-2', check: 1 }], gap: '' }],
  steps: [0, 1, 2].map(i => ({ id: `step-${i}`, task: `Save note ${i}`, because: 'State change reaches the rendered note', actions: [{ kind: 'fill', target: { by: 'label', role: '', name: 'Note body' }, value: `Note ${i}` }, { kind: 'click', target, value: '' }], checks: [{ kind: 'visible', target, value: '' }, { kind: 'text', target: { by: 'role', role: 'status', name: 'Note status' }, value: 'Saved' }], evidence })),
}] };

test('sources reads src and skips a missing server directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-src-'));
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/app.tsx'), 'export const a = 1;\n');
    await mkdir(path.join(dir, 'tests/journeys/generated'), { recursive: true });
    await writeFile(path.join(dir, 'tests/journeys/fixture.ts'), 'export const fixture = true;');
    await writeFile(path.join(dir, 'tests/journeys/generated/old.spec.ts'), 'old generated test');
    await writeFile(path.join(dir, 'playwright.config.ts'), 'export default {};');
    const found = await sources(dir, ['src', 'server']);
    assert.equal(found['src/app.tsx'], 'export const a = 1;\n');
    assert.equal(found['tests/journeys/fixture.ts'], 'export const fixture = true;');
    assert.equal(found['playwright.config.ts'], 'export default {};');
    assert.ok(!Object.hasOwn(found, 'tests/journeys/generated/old.spec.ts'));
    await assert.rejects(sources(path.join(dir, 'missing'), ['src', 'server']), /No UI source files/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('approval accepts yes, rejects no, and does not treat anything else as approval', () => {
  for (const answer of ['y', 'Y', ' yes ', 'approve', 'Approved']) assert.equal(parseApproval(answer), 'approve');
  for (const answer of ['n', 'N', 'no', 'reject', 'stop']) assert.equal(parseApproval(answer), 'reject');
  for (const answer of ['', 'maybe', 'yep', 'ok', 'run']) assert.equal(parseApproval(answer), null);
  assert.match(approvalSummary(plan), /1 executable \(save-note\)/);
  assert.match(approvalSummary(plan), /writes no scripts/);
});

test('approval runs only for an explicit yes or --yes, never from a non-interactive shell', async () => {
  assert.equal(await waitForApproval({ yes: true, stdin: { isTTY: false }, stdout: { write() {} } }), 'approve');
  assert.equal(await waitForApproval({ stdin: { isTTY: false }, stdout: { write() {} } }), 'needs-tty');
  assert.equal(await waitForApproval({ yes: false, stdin: { isTTY: undefined }, stdout: { write() {} } }), 'needs-tty');
});

test('rejects missing consequences, invented evidence, and silently uncovered consumers', () => {
  assert.equal(validate(plan, files), plan);
  const idPattern = new RegExp(schema.properties.journeys.items.properties.id.pattern);
  assert.ok(idPattern.test('composer-mode-pre-send'));
  assert.ok(!idPattern.test('composer_mode_pre_send'));
  const unknown = structuredClone(plan);
  unknown.journeys[0].effects[0].evidence[0].file = 'src/components/App.tsx';
  assert.throws(() => validate(unknown, files), /unknown evidence file "src\/components\/App.tsx" for quote "setNotes\(next\);?"/);
  for (const change of [
    p => p.journeys[0].steps[0].checks.splice(0),
    p => { p.journeys[0].steps[0].evidence[0].line = 99; },
    p => { p.journeys[0].steps[0].evidence[0].file = '../secret'; },
    p => { p.journeys[0].effects[0].coveredBy = []; },
    p => { p.journeys[0].effects[0].coveredBy[0].check = -1; },
    p => { p.journeys[0].steps[0].actions[0].kind = 'shell'; },
    p => { p.journeys[0].steps[0].actions = []; },
    p => { p.journeys[0].steps[0].task = ''; },
  ]) {
    const invalid = structuredClone(plan); change(invalid);
    assert.throws(() => validate(invalid, files));
  }
});

test('compiler quotes hostile model strings and produces parseable TypeScript', () => {
  const hostile = structuredClone(plan);
  hostile.journeys[0].steps[0].actions[1].target.name = '\"); process.exit(0); //\n`$(echo bad)`';
  const code = compile(validate(hostile, files), './fixture');
  assert.equal(ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0);
  assert.match(code, /await test\.step/);
  assert.match(code, /await expect/);
  assert.match(code, /filter\(\{ visible: true \}\)\.first\(\)\)\.toBeVisible/);
  assert.match(code, /getByRole\("status", \{ name: "Note status", exact: true \}\)\)\.toContainText\("Saved"\)/);
  const hidden = structuredClone(plan);
  for (const step of hidden.journeys[0].steps) step.checks[0].kind = 'hidden';
  assert.doesNotMatch(compile(hidden, './fixture'), /filter\(/);
  const select = structuredClone(plan);
  select.journeys[0].steps[0].actions = [{ kind: 'selectOption', target: { by: 'label', name: 'Effort', role: '' }, value: 'high' }];
  assert.match(compile(validate(select, files), './fixture'), /getByLabel\("Effort", \{ exact: true \}\)\.selectOption\("high"\)/);
});

test('required user-task outcomes cannot be replaced by setup checks or optional gaps', () => {
  const missing = structuredClone(plan);
  delete missing.journeys[0].effects[0].required;
  assert.throws(() => validate(missing, files), /missing required user-task outcome/);
  const unsupported = structuredClone(plan);
  const outcome = unsupported.journeys[0].effects[0];
  outcome.expected = 'Submit an edit request, approve permission, and verify the file changes';
  outcome.gap = 'Harness has no agent/SSE or filesystem integration';
  assert.throws(() => validate(unsupported, files), /required task outcome is untested/);
  unsupported.journeys[0].blocked = outcome.gap;
  unsupported.journeys[0].steps = [];
  outcome.exercise = '';
  outcome.coveredBy = [];
  assert.equal(validate(unsupported, files), unsupported);
  const premature = structuredClone(plan);
  premature.journeys[0].effects[0].exercise = 'step-2';
  premature.journeys[0].effects[0].coveredBy[0].step = 'step-0';
  assert.throws(() => validate(premature, files), /completion checks must follow/);
});

test('aligns unique exact evidence without accepting invented or ambiguous excerpts', () => {
  const snapshot = { 'src/example.tsx': 'const before = 1;\nsetNotes(next);\n' };
  const shifted = structuredClone(plan);
  assert.equal(validate(alignEvidence(shifted, snapshot), snapshot), shifted);
  assert.equal(shifted.journeys[0].effects[0].evidence[0].line, 2);
  assert.equal(shifted.journeys[0].steps[0].evidence[0].line, 2);
  const wrongPath = structuredClone(plan);
  for (const item of [...wrongPath.journeys[0].effects, ...wrongPath.journeys[0].steps]) item.evidence[0].file = 'src/components/example.tsx';
  assert.equal(validate(alignEvidence(wrongPath, snapshot), snapshot), wrongPath);
  assert.equal(wrongPath.journeys[0].effects[0].evidence[0].file, 'src/example.tsx');
  const ambiguousPaths = { ...snapshot, 'server/example.tsx': snapshot['src/example.tsx'] };
  const ambiguous = structuredClone(plan);
  ambiguous.journeys[0].effects[0].evidence[0].file = 'unknown/example.tsx';
  alignEvidence(ambiguous, ambiguousPaths);
  assert.equal(ambiguous.journeys[0].effects[0].evidence[0].file, 'unknown/example.tsx');
  assert.throws(() => validate(ambiguous, ambiguousPaths), /unknown evidence file/);
  for (const content of ['unrelated();\n', 'before();\nsetNotes(next);\nsetNotes(next);\n']) {
    const invalid = structuredClone(plan);
    const files = { 'src/example.tsx': content };
    alignEvidence(invalid, files);
    assert.equal(invalid.journeys[0].effects[0].evidence[0].line, 1);
    assert.throws(() => validate(invalid, files), /Quoted:.*setNotes.*\nSource context:/s);
  }
  const multiple = structuredClone(plan);
  multiple.journeys[0].steps[0].evidence = [{ file: 'src/example.tsx', line: 1, quote: 'secondInventedCall()' }];
  assert.throws(() => validate(multiple, { 'src/example.tsx': 'unrelated();' }), error => error.message.includes('setNotes(next)') && error.message.includes('secondInventedCall()'));
  const multiline = structuredClone(plan);
  for (const item of [...multiline.journeys[0].effects, ...multiline.journeys[0].steps]) item.evidence[0].quote = 'setNotes(\nnext\n)';
  const multiFiles = { 'src/example.tsx': 'before();\nsetNotes(\nnext\n);\n' };
  assert.equal(validate(alignEvidence(multiline, multiFiles), multiFiles), multiline);
});

test('validation retry receives source context and original task in a fresh process', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-retry-'));
  const previous = process.env.JOURNEY_CODEX_BIN;
  try {
    const invalid = structuredClone(plan);
    invalid.journeys[0].effects[0].evidence[0].quote = 'inventedCall()';
    const fake = path.join(dir, 'codex.mjs');
    await writeFile(fake, `#!/usr/bin/env node
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(path.join(dir, 'prompts.jsonl'))}, JSON.stringify(prompt) + '\\n');
const retry = prompt.includes('VALIDATION ERROR:');
const answer = retry ? ${JSON.stringify(plan)} : ${JSON.stringify(invalid)};
const args = process.argv.slice(2);
const output = args[args.indexOf('--output-last-message') + 1];
await writeFile(output, JSON.stringify(answer));
await writeFile(path.join(path.dirname(output), 'reads.jsonl'), JSON.stringify('src/example.tsx') + '\\n');
`);
    await chmod(fake, 0o755);
    process.env.JOURNEY_CODEX_BIN = fake;
    const result = await ask({ root: dir, files, prompt: 'Test save and reopen; preserve all assertions.', budget: { remaining: 1 } });
    assert.equal(result.journeys[0].goal, plan.journeys[0].goal);
    const prompts = (await readFile(path.join(dir, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /ORIGINAL TASK:\nTest save and reopen; preserve all assertions\./);
    assert.match(prompts[1], /Quoted: "inventedCall\(\)"/);
    assert.match(prompts[1], /Source context:\n1: setNotes\(next\);/);
    assert.match(prompts[1], /fresh process/);
    assert.match(prompts[1], /add missing outcome checks/);
    assert.ok(!prompts[1].includes('assertion count/kinds/values'));
    assert.ok(prompts[0].includes('Discover user goals by tracing'));
    assert.match(prompts[0], /required outcomes BEFORE considering what the harness can execute/);
    assert.match(prompts[0], /mark the WHOLE journey blocked/);
    assert.match(prompts[0], /ONE user task named the way the user would say it/);
    assert.match(prompts[0], /would a user notice\?/);
    assert.match(prompts[0], /must not repeat a tested task of another journey/);
    assert.match(prompts[0], /swapping in the unrestricted behaviour would fail the test/);
    assert.match(prompts[0], /Verify both the denied path and the allowed path by their outcomes/);
    assert.doesNotMatch(prompts[0], /devden|notesFailure|Full auto/i);
    assert.ok(!prompts[1].includes('Discover user goals by tracing'));
    await writeFile(path.join(dir, 'prompts.jsonl'), '');
    await ask({ root: dir, files, prompt: 'Repair the frozen save journey.', executionRepair: true, budget: { remaining: 1 } });
    const repairPrompts = (await readFile(path.join(dir, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(repairPrompts.length, 2);
    assert.ok(repairPrompts.every(prompt => prompt.includes('assertion count/kinds/values')));
    assert.ok(repairPrompts.every(prompt => !prompt.includes('Discover user goals by tracing')));
    assert.match(repairPrompts[1], /ORIGINAL TASK:\nRepair the frozen save journey\./);
  } finally {
    if (previous === undefined) delete process.env.JOURNEY_CODEX_BIN; else process.env.JOURNEY_CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('repairs may change locator strategy but cannot weaken or redirect assertions', () => {
  const fixed = structuredClone(plan);
  fixed.journeys[0].steps[0].checks[0].target.by = 'text';
  assert.doesNotThrow(() => preserveContract(plan, fixed));
  for (const change of [
    p => { p.journeys[0].steps[0].checks[0].kind = 'hidden'; },
    p => { p.journeys[0].steps[0].checks[0].target.name = 'Unrelated'; },
    p => { p.journeys[0].steps.pop(); },
    p => { p.journeys[0].effects = []; },
  ]) {
    const weakened = structuredClone(plan); change(weakened);
    assert.throws(() => preserveContract(plan, weakened), /refusing to weaken/);
  }
});

test('CLI retains browser repair allowance after correcting a draft', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-cli-'));
  try {
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src/example.tsx'), files['src/example.tsx']);
    const fake = path.join(dir, 'codex.mjs');
    await writeFile(fake, `#!/usr/bin/env node
import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
await appendFile(${JSON.stringify(path.join(dir, 'prompts.jsonl'))}, JSON.stringify(prompt) + '\\n');
const answer = ${JSON.stringify(plan)};
if (prompt.includes('This is execution repair')) answer.journeys[0].steps[0].checks[0].target.by = 'text';
else if (!prompt.includes('VALIDATION ERROR:')) answer.journeys[0].effects[0].evidence[0].quote = 'invented()';
const args = process.argv.slice(2), output = args[args.indexOf('--output-last-message') + 1];
await writeFile(output, JSON.stringify(answer));
await writeFile(path.join(path.dirname(output), 'reads.jsonl'), JSON.stringify('src/example.tsx') + '\\n');
`);
    await chmod(fake, 0o755);
    const runner = path.join(dir, 'node_modules/@playwright/test');
    await mkdir(runner, { recursive: true });
    await writeFile(path.join(runner, 'cli.js'), `
const fs = require('node:fs');
const passed = process.env.JOURNEY_TEST_DIR.endsWith('attempt-1');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ suites: [], stats: { expected: passed ? 1 : 0, unexpected: passed ? 0 : 1, skipped: 0, flaky: 0 } }));
process.exitCode = passed ? 0 : 1;
`);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/journey.mjs', import.meta.url)), 'auto', '--root', dir, '--repairs', '1'], {
      env: { ...process.env, JOURNEY_CODEX_BIN: fake }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const summaryPath = JSON.parse(result.stdout.match(/"summary": (".*")/)[1]);
    const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
    assert.equal(summary.passed, true);
    assert.equal(summary.attempts.length, 2);
    const prompts = (await readFile(path.join(dir, 'prompts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(prompts.length, 3);
    assert.match(prompts[2], /This is execution repair/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feedback loop passes diagnostics to repair, preserves attempts, and reruns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-'));
  let runs = 0, repairs = 0;
  try {
    const result = await feedbackLoop({ root: dir, dir, plan, files, repairs: 2,
      run: async () => ({ passed: ++runs === 2, feedback: '{"error":"accessible name mismatch"}' }),
      repair: async (original, feedback) => {
        repairs++;
        assert.match(feedback, /accessible name mismatch/);
        const fixed = structuredClone(original);
        fixed.journeys[0].steps[0].checks[0].target.by = 'text';
        return fixed;
      },
    });
    assert.equal(result.passed, true);
    assert.equal(runs, 2); assert.equal(repairs, 1);
    assert.equal(JSON.parse(await readFile(path.join(dir, 'summary.json'), 'utf8')).attempts.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('feedback loop stops at retry budget and rejects assertion removal', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-'));
  try {
    let runs = 0;
    const options = { root: dir, dir, plan, files, repairs: 1, run: async () => ({ passed: false, feedback: `failure ${++runs}` }) };
    const result = await feedbackLoop({ ...options, repair: async p => {
      const fixed = structuredClone(p); fixed.journeys[0].steps[0].actions[1].target.by = 'text'; return fixed;
    } });
    assert.equal(result.passed, false); assert.equal(runs, 2);
    await assert.rejects(feedbackLoop({ ...options, repair: async p => {
      const broken = structuredClone(p); broken.journeys[0].steps.pop(); return broken;
    } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('passing browser checks cannot make a blocked requested task pass', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-blocked-'));
  try {
    const mixed = structuredClone(plan);
    const blocked = structuredClone(plan.journeys[0]);
    blocked.id = 'ask-edit-permission';
    blocked.blocked = 'No agent, SSE or filesystem integration';
    blocked.steps = [];
    Object.assign(blocked.effects[0], { exercise: '', coveredBy: [], gap: blocked.blocked });
    mixed.journeys.push(blocked);
    const result = await feedbackLoop({ root: dir, dir, plan: mixed, files, repairs: 1,
      run: async () => ({ passed: true, feedback: '' }),
      repair: async () => { assert.fail('A blocked task needs harness support, not assertion repair'); },
    });
    assert.equal(result.browserPassed, true);
    assert.equal(result.passed, false);
    assert.deepEqual(result.blocked, [{ journey: blocked.id, reason: blocked.blocked }]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('diagnostics includes inline request and console logs', async () => {
  const text = await diagnostics(tmpdir(), { suites: [{ errors: [{ message: 'failure' }], attachments: [{ name: 'journey-diagnostics', contentType: 'application/json', body: Buffer.from('{"requests":[],"consoleLogs":["error"]}').toString('base64') }] }] });
  assert.match(text, /consoleLogs/); assert.match(text, /failure/);
});

test('runner rejects a green report when application source changes during execution', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-drift-'));
  try {
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src/example.tsx'), files['src/example.tsx']);
    const runner = path.join(dir, 'node_modules/@playwright/test');
    await mkdir(runner, { recursive: true });
    await writeFile(path.join(runner, 'cli.js'), `
const fs = require('node:fs');
fs.writeFileSync('src/example.tsx', 'changed();');
fs.writeFileSync(process.env.PLAYWRIGHT_JSON_OUTPUT_FILE, JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } }));
`);
    await assert.rejects(execute(dir, dir, files), /Source changed during journey validation: src\/example.tsx/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('source tools confine reads to the snapshot and paginate all consumer matches', () => {
  assert.equal(sourceTool(files, 'read_source', { file: 'src/example.tsx', start: 1, count: 1 }), '1: setNotes(next);');
  assert.throws(() => sourceTool(files, 'read_source', { file: '../.env' }));
  assert.throws(() => sourceTool(files, 'read_source', { file: 'src/example.tsx', count: 1000 }));
  assert.throws(() => sourceTool(files, 'shell', {}));
  const matches = JSON.parse(sourceTool({ 'src/a.ts': 'catalog\n'.repeat(110) }, 'search_source', { text: 'catalog' }));
  assert.equal(matches.total, 110); assert.equal(matches.matches.length, 100); assert.equal(matches.nextOffset, 100);
  assert.equal(JSON.parse(sourceTool({ 'src/a.ts': 'catalog\n'.repeat(110) }, 'search_source', { text: 'catalog', offset: 100 })).matches.length, 10);
  const long = JSON.parse(sourceTool({ 'src/b.tsx': `${'x'.repeat(900)} statusLabel ${'y'.repeat(900)}` }, 'search_source', { text: 'statusLabel' })).matches[0].text;
  assert.match(long, /^…x+ statusLabel y+…$/);
  assert.ok(long.length < 260);
});

test('discovery and repairs default to the requested Luna model with extra-high reasoning', () => {
  const args = codexArgs('/tmp/fixture', '/tmp/reader.mjs');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});

test('required outcomes need outcome checks, not presence checks', () => {
  const presenceOnly = structuredClone(plan);
  presenceOnly.journeys[0].effects[0].coveredBy = [{ step: 'step-2', check: 0 }];
  assert.throws(() => validate(presenceOnly, files), /covered only by visible\/hidden\/enabled\/disabled/);
});

test('a second journey cannot test the same task again, but may repeat navigation steps', () => {
  const split = structuredClone(plan);
  const second = structuredClone(plan.journeys[0]);
  second.id = 'save-note-again';
  split.journeys.push(second);
  assert.throws(() => validate(split, files), /repeats the tested task of journey save-note; merge them/);
  // Only the exercised step changes; step-1 and step-2 still repeat journey one's clicks.
  second.steps[0].actions = [{ kind: 'fill', target: { by: 'label', role: '', name: 'Title' }, value: 'A different note' }];
  assert.equal(validate(split, files), split);
  // Journey one only passes through step-1, so journey two may test it...
  const exercisedLater = structuredClone(split);
  exercisedLater.journeys[1].effects[0].exercise = 'step-1';
  assert.equal(validate(exercisedLater, files), exercisedLater);
  // ...but once both journeys test it, it is the same test twice.
  exercisedLater.journeys[0].effects[0].exercise = 'step-1';
  assert.throws(() => validate(exercisedLater, files), /save-note-again\/step-1: repeats the tested task/);
});

test('steps report as user tasks and fixture capabilities compile to act/probe calls', () => {
  assert.match(report(plan), /1\. \*\*Save note 0\*\*/);
  assert.doesNotMatch(report(plan), /fill Note body/);
  const outcome = structuredClone(plan);
  outcome.journeys[0].steps[1].actions.push({ kind: 'act', target: null, value: JSON.stringify({ name: 'serverOffline', args: { on: true } }) });
  outcome.journeys[0].steps[2].checks.push(
    { kind: 'state', target: null, value: JSON.stringify({ probe: 'storedNotes', includes: 'Note 2' }) },
    { kind: 'state', target: null, value: JSON.stringify({ probe: 'storedNotes', args: { device: 'fresh' }, excludes: 'Note 1' }) },
  );
  outcome.journeys[0].effects[0].coveredBy = [{ step: 'step-2', check: 2 }];
  assert.throws(() => validate(structuredClone(outcome), files), /act "serverOffline" is not provided by tests\/journeys\/fixture.ts/);
  const withFixture = { ...files, 'tests/journeys/fixture.ts': 'const acts = { serverOffline() {} };\nconst probes = { storedNotes() {} };\n' };
  const code = compile(validate(outcome, withFixture), './fixture');
  assert.equal(ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0);
  assert.match(code, /await app\.act\("serverOffline", \{"on":true\}\)/);
  assert.match(code, /app\.probe\("storedNotes", null\)\)\.toContain\("Note 2"\)/);
  assert.match(code, /app\.probe\("storedNotes", \{"device":"fresh"\}\)\)\.not\.toContain\("Note 1"\)/);
  for (const value of [{ probe: 'storedNotes' }, { probe: 'storedNotes', equals: 1, includes: 1 }, { probe: 'x); evil(' , equals: 1 }]) {
    const bad = structuredClone(outcome);
    bad.journeys[0].steps[2].checks[2].value = JSON.stringify(value);
    assert.throws(() => validate(bad, withFixture), /Invalid state check/);
  }
});

test('malformed JSON values fail as located plan errors the model can correct', () => {
  for (const [edit, where] of [
    [p => { p.journeys[0].apiResponses = ['{oops']; }, /save-note\/apiResponses\[0\]: .*value "\{oops"/],
    [p => { p.journeys[0].steps[2].checks.push({ kind: 'state', target: null, value: 'nope' }); }, /save-note\/step-2 state: .*value "nope"/],
    [p => { p.journeys[0].steps[0].actions = [null]; }, /Invalid journey plan: unsupported operation/],
  ]) {
    const bad = structuredClone(plan); edit(bad);
    assert.throws(() => validate(bad, files), error => error.message.startsWith('Invalid journey plan') && where.test(error.message));
  }
});

test('default source scan covers common layouts and skips dependencies and build output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-layout-'));
  try {
    for (const file of ['src/Page.jsx', 'src/View.vue', 'src/Card.svelte', 'app/page.tsx', 'src/node_modules/x/index.js', 'src/dist/bundle.js', 'playwright.config.js']) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), 'x');
    }
    const found = Object.keys(await sources(dir)).sort();
    assert.deepEqual(found, ['app/page.tsx', 'playwright.config.js', 'src/Card.svelte', 'src/Page.jsx', 'src/View.vue']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('live exploration stays on the app and uses plan target semantics', async () => {
  const base = 'http://localhost:5173';
  assert.equal(pageUrl(base, '/notes?x=1'), 'http://localhost:5173/notes?x=1');
  for (const bad of ['https://example.com', '//example.com/x', 'notes', '', null]) assert.throws(() => pageUrl(base, bad), /path must start with \//);
  const calls = [];
  const page = new Proxy({}, { get: (_, method) => (...args) => { calls.push([method, ...args]); return 'locator'; } });
  locate(page, { by: 'role', role: 'button', name: 'Save' });
  locate(page, { by: 'label', role: '', name: 'Amount' });
  assert.deepEqual(calls, [['getByRole', 'button', { name: 'Save', exact: true }], ['getByLabel', 'Amount', { exact: true }]]);
  assert.throws(() => locate(page, { by: 'css', name: '.x' }), /target.by must be/);
  assert.deepEqual(browserTools.map(t => t.name), ['browser_open', 'browser_snapshot', 'browser_click', 'browser_fill']);
  const fakePage = { setDefaultTimeout() {}, async route() {}, url: () => 'about:blank' };
  let launched = 0;
  const app = explorer(base, async () => { launched++; return { newContext: async () => ({ newPage: async () => fakePage }), close: async () => {} }; });
  await assert.rejects(app.call('browser_snapshot', {}), /Open a page first/);
  await assert.rejects(app.call('browser_open', { path: 'https://evil.test/' }), /stay on the app/);
  await assert.rejects(app.call('browser_type', {}), /Unknown tool/);
  assert.equal(launched, 1);
});

test('browser tools are offered to the model only with a base URL', async () => {
  assert.ok(!codexArgs('/tmp/x', '/tmp/reader.mjs').some(arg => arg.includes('mcp_servers.browser')));
  const args = codexArgs('/tmp/x', '/tmp/reader.mjs', undefined, { script: '/pkg/src/browser-tool.mjs', root: '/app', baseUrl: 'http://localhost:5173' });
  assert.ok(args.includes(`mcp_servers.browser.args=${JSON.stringify(['/pkg/src/browser-tool.mjs', '/app', 'http://localhost:5173'])}`));
  assert.ok(args.includes('mcp_servers.browser.required=true'));
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-live-'));
  const previous = process.env.JOURNEY_CODEX_BIN;
  try {
    const fake = path.join(dir, 'codex.mjs');
    await writeFile(fake, `#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2), output = args[args.indexOf('--output-last-message') + 1];
await writeFile(${JSON.stringify(path.join(dir, 'seen.json'))}, JSON.stringify({ prompt, args }));
await writeFile(output, JSON.stringify(${JSON.stringify(plan)}));
await writeFile(path.join(path.dirname(output), 'reads.jsonl'), JSON.stringify('src/example.tsx') + '\\n');
`);
    await chmod(fake, 0o755);
    process.env.JOURNEY_CODEX_BIN = fake;
    await ask({ root: dir, files, prompt: 'Discover', baseUrl: 'http://localhost:5173' });
    const seen = JSON.parse(await readFile(path.join(dir, 'seen.json'), 'utf8'));
    assert.match(seen.prompt, /LIVE APP\. The running app is at http:\/\/localhost:5173/);
    assert.match(seen.prompt, /Take locator names from the tree, not from guesses/);
    assert.match(seen.prompt, /only change or delete data you created while exploring/);
    assert.ok(seen.args.some(arg => arg.startsWith('mcp_servers.browser.args=')));
    await ask({ root: dir, files, prompt: 'Discover' });
    const plain = JSON.parse(await readFile(path.join(dir, 'seen.json'), 'utf8'));
    assert.doesNotMatch(plain.prompt, /LIVE APP/);
  } finally {
    if (previous === undefined) delete process.env.JOURNEY_CODEX_BIN; else process.env.JOURNEY_CODEX_BIN = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('diagnostics keep errors first within the budget', async () => {
  const noise = { name: 'log', contentType: 'text/plain', body: Buffer.from('x'.repeat(59_000)).toString('base64') };
  const text = await diagnostics(tmpdir(), { suites: [{ attachments: [noise, noise] }, { errors: [{ message: 'expected ₹500, got ₹50' }] }] });
  assert.ok(text.startsWith('{"errors"'));
  assert.match(text, /expected ₹500, got ₹50/);
  assert.ok(text.length <= 60_000 + 30);
  assert.match(text, /diagnostics truncated/);
});

test('tree changes count repeated lines and keep only what differs', () => {
  const before = ['- heading "Tag"', '- paragraph: Balance ₹1,200', '- cell "-₹40"', '- cell "-₹40"'].join('\n');
  const after = ['- heading "Tag"', '- paragraph: Balance ₹1,700', '- cell "+₹500"', '- cell "-₹40"', '- cell "-₹40"'].join('\n');
  assert.deepEqual(treeChange(before, after), { removed: ['- paragraph: Balance ₹1,200'], added: ['- paragraph: Balance ₹1,700', '- cell "+₹500"'], size: 5 });
  assert.deepEqual(treeChange(after, after), { removed: [], added: [], size: 5 });
  assert.deepEqual(treeChange('- cell "-₹40"', '- cell "-₹40"\n- cell "-₹40"').added, ['- cell "-₹40"']);
});
