import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { compile, sources, validate, preserveContract } from '../src/core.mjs';
import { approvalSummary, parseApproval, waitForApproval } from '../src/approval.mjs';
import { diagnostics, feedbackLoop } from '../src/runner.mjs';
import { sourceTool } from '../src/source-reader.mjs';
import { codexArgs } from '../src/model.mjs';

const files = { 'src/example.tsx': 'setNotes(next);\n' };
const evidence = [{ file: 'src/example.tsx', line: 1, quote: 'setNotes(next);' }];
const target = { by: 'role', role: 'button', name: 'Save' };
const plan = { journeys: [{ id: 'save-note', goal: 'Save and reopen a note', prerequisites: ['Fresh context'], blocked: '', apiResponses: [],
  effects: [{ id: 'persist', trigger: 'save', consumer: 'list', expected: 'saved note remains visible', evidence, coveredBy: [{ step: 'step-2', check: 0 }], gap: '' }],
  steps: [0, 1, 2].map(i => ({ id: `step-${i}`, because: 'State change reaches the rendered note', action: { kind: 'click', target, value: '' }, checks: [{ kind: 'visible', target, value: '' }], evidence })),
}] };

test('sources reads src and skips a missing server directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'journey-src-'));
  try {
    await mkdir(path.join(dir, 'src'), { recursive: true });
    await writeFile(path.join(dir, 'src/app.tsx'), 'export const a = 1;\n');
    const found = await sources(dir, ['src', 'server']);
    assert.equal(found['src/app.tsx'], 'export const a = 1;\n');
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
  for (const change of [
    p => p.journeys[0].steps[0].checks.splice(0),
    p => { p.journeys[0].steps[0].evidence[0].line = 99; },
    p => { p.journeys[0].steps[0].evidence[0].file = '../secret'; },
    p => { p.journeys[0].effects[0].coveredBy = []; },
    p => { p.journeys[0].effects[0].coveredBy[0].check = -1; },
    p => { p.journeys[0].steps[0].action.kind = 'shell'; },
  ]) {
    const invalid = structuredClone(plan); change(invalid);
    assert.throws(() => validate(invalid, files));
  }
});

test('compiler quotes hostile model strings and produces parseable TypeScript', () => {
  const hostile = structuredClone(plan);
  hostile.journeys[0].steps[0].action.target.name = '\"); process.exit(0); //\n`$(echo bad)`';
  const code = compile(validate(hostile, files), './fixture');
  assert.equal(ts.createSourceFile('test.ts', code, ts.ScriptTarget.Latest, true).parseDiagnostics.length, 0);
  assert.match(code, /await test\.step/);
  assert.match(code, /await expect/);
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
      const fixed = structuredClone(p); fixed.journeys[0].steps[0].action.target.by = 'text'; return fixed;
    } });
    assert.equal(result.passed, false); assert.equal(runs, 2);
    await assert.rejects(feedbackLoop({ ...options, repair: async p => {
      const broken = structuredClone(p); broken.journeys[0].steps.pop(); return broken;
    } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('diagnostics includes inline request and console logs', async () => {
  const text = await diagnostics(tmpdir(), { suites: [{ errors: [{ message: 'failure' }], attachments: [{ name: 'journey-diagnostics', contentType: 'application/json', body: Buffer.from('{"requests":[],"consoleLogs":["error"]}').toString('base64') }] }] });
  assert.match(text, /consoleLogs/); assert.match(text, /failure/);
});

test('source tools confine reads to the snapshot and paginate all consumer matches', () => {
  assert.equal(sourceTool(files, 'read_source', { file: 'src/example.tsx', start: 1, count: 1 }), '1: setNotes(next);');
  assert.throws(() => sourceTool(files, 'read_source', { file: '../.env' }));
  assert.throws(() => sourceTool(files, 'read_source', { file: 'src/example.tsx', count: 1000 }));
  assert.throws(() => sourceTool(files, 'shell', {}));
  const matches = JSON.parse(sourceTool({ 'src/a.ts': 'catalog\n'.repeat(110) }, 'search_source', { text: 'catalog' }));
  assert.equal(matches.total, 110); assert.equal(matches.matches.length, 100); assert.equal(matches.nextOffset, 100);
  assert.equal(JSON.parse(sourceTool({ 'src/a.ts': 'catalog\n'.repeat(110) }, 'search_source', { text: 'catalog', offset: 100 })).matches.length, 10);
});

test('discovery and repairs default to the requested Luna model with extra-high reasoning', () => {
  const args = codexArgs('/tmp/fixture', '/tmp/reader.mjs');
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-6-luna');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
});
