import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string', minLength: 1 };
const array = items => ({ type: 'array', items });
const target = object({ by: { enum: ['role', 'label', 'text', 'placeholder'] }, name: string, role: { type: 'string' } });
const operation = kinds => object({ kind: { enum: kinds }, target: { anyOf: [target, { type: 'null' }] }, value: { type: 'string' } });
const evidence = array(object({ file: string, line: { type: 'integer', minimum: 1 }, quote: { type: 'string', minLength: 1, maxLength: 160 } }));
// `act` and `state` reach the app's own fixture: whatever the app can do or observe outside the page
// (an outage, a second device, a stored record) is named there, so no app is built into the harness.
export const actions = ['click', 'fill', 'press', 'selectOption', 'reload', 'apiResponse', 'act'];
export const checks = ['visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count', 'request', 'state'];
// Presence checks show the UI is there; they never prove what an action did.
const presence = ['visible', 'hidden', 'enabled', 'disabled'];
export const schema = object({ journeys: array(object({
  id: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,79}$' }, goal: string, prerequisites: array(string), blocked: { type: 'string' },
  apiResponses: array(string),
  effects: array(object({ id: string, trigger: string, consumer: string, expected: string, evidence,
    required: { type: 'boolean' }, exercise: { type: 'string' },
    coveredBy: array(object({ step: string, check: { type: 'integer', minimum: 0 } })), gap: { type: 'string' },
  })),
  steps: array(object({
    id: string, task: string, because: string, actions: { ...array(operation(actions)), minItems: 1 }, checks: array(operation(checks)),
    evidence,
  })),
})) });

// Common app layouts; missing directories are skipped. UIPILOT_SOURCE_DIRS overrides.
const defaultDirs = 'src,app,pages,components,lib,server';
const skipDirs = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.next', '.nuxt', '.svelte-kit', 'generated']);
export async function sources(root, dirs = (process.env.UIPILOT_SOURCE_DIRS || defaultDirs).split(',').map(dir => dir.trim()).filter(Boolean)) {
  const result = {};
  async function walk(dir) {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!skipDirs.has(entry.name)) await walk(file); }
      else if (entry.isFile() && /\.([cm]?[jt]sx?|vue|svelte|astro)$/.test(file)) result[file] = await readFile(path.join(root, file), 'utf8');
    }
  }
  for (const dir of dirs) await walk(dir);
  if (!Object.keys(result).length) throw new Error(`No UI source files under ${dirs.join(', ')} in ${root}`);
  for (const file of ['tests/uipilot/fixture.ts', ...['ts', 'js', 'mjs', 'cjs'].map(ext => `playwright.config.${ext}`)]) {
    try { result[file] = await readFile(path.join(root, file), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}

export const hash = text => createHash('sha256').update(text).digest('hex');

export function apiResponse(value) {
  const r = JSON.parse(value);
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method) || typeof r.path !== 'string' || !r.path.startsWith('/') || !r.body || typeof r.body !== 'object') throw new Error('Invalid API fixture/request');
  return r;
}

// Correct citation metadata only when the exact excerpt resolves within the snapshot.
// Invented or ambiguous excerpts still go through strict validation.
export function alignEvidence(plan, files) {
  for (const journey of plan?.journeys ?? []) {
    for (const item of [...(journey.effects ?? []), ...(journey.steps ?? [])]) {
      for (const e of item.evidence ?? []) {
        if (typeof e.file !== 'string' || typeof e.quote !== 'string' || !Number.isInteger(e.line) || e.line < 1) continue;
        const quote = e.quote.trim().replace(/;$/, '').trimEnd();
        if (!quote) continue;
        if (!Object.hasOwn(files, e.file)) {
          const candidates = Object.keys(files).filter(file => path.basename(file) === path.basename(e.file) && files[file].includes(quote));
          if (candidates.length === 1) e.file = candidates[0];
        }
        if (typeof files[e.file] !== 'string') continue;
        const lines = files[e.file].split('\n');
        const matches = i => lines.slice(i, i + quote.split('\n').length).join('\n').trim().includes(quote);
        if (matches(e.line - 1)) continue;
        const candidates = lines.flatMap((_, i) => matches(i) ? [i + 1] : []);
        if (candidates.length === 1) e.line = candidates[0];
      }
    }
  }
  return plan;
}

const identifier = /^[A-Za-z_$][\w$]*$/;
export function fixtureAct(value) {
  const r = JSON.parse(value);
  if (!identifier.test(r?.name ?? '')) throw new Error('Invalid act; use {"name":"fixtureCapability","args":{...}}');
  return { name: r.name, args: r.args ?? null };
}

export function fixtureState(value) {
  const r = JSON.parse(value);
  const expectations = ['equals', 'includes', 'excludes'].filter(key => Object.hasOwn(r ?? {}, key));
  if (!identifier.test(r?.probe ?? '') || expectations.length !== 1) throw new Error('Invalid state check; use {"probe":"fixtureProbe","args":{...}} with exactly one of equals, includes or excludes');
  return { probe: r.probe, args: r.args ?? null, [expectations[0]]: r[expectations[0]] };
}

// One tested task belongs to one journey: a second journey that tests it again is the same journey split up.
// Steps that only navigate or look (no effect exercises them) may repeat across journeys.
const taskKey = step => JSON.stringify(step.actions.map(a => [a.kind, a.target?.by ?? '', a.target?.role ?? '', a.target?.name ?? '', a.kind === 'apiResponse' ? '' : a.value]));

export function validate(plan, files) {
  const fail = message => { throw new Error(`Invalid journey plan: ${message}`); };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const evidenceErrors = new Set();
  if (!Array.isArray(plan?.journeys) || !plan.journeys.length) fail('no journeys');
  const ids = new Set();
  const actionOwners = new Map();
  for (const journey of plan.journeys) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(journey.id) || ids.has(journey.id)) fail(`invalid/duplicate id ${JSON.stringify(journey.id)}; use a unique lowercase kebab-case id of at most 80 characters`);
    ids.add(journey.id);
    if (!text(journey.goal) || !Array.isArray(journey.prerequisites) || !journey.prerequisites.every(text) || typeof journey.blocked !== 'string') fail(`${journey.id}: missing goal/prerequisites/status`);
    if (!Array.isArray(journey.steps) || !Array.isArray(journey.effects) || !journey.effects.length || !Array.isArray(journey.apiResponses)) fail('missing steps, consumer effects, or fixtures');
    const parse = (where, parser, value) => { try { return parser(value); } catch (error) { fail(`${where}: ${error.message}; value ${JSON.stringify(value)}`); } };
    journey.apiResponses.forEach((value, i) => parse(`${journey.id}/apiResponses[${i}]`, apiResponse, value));
    const validateEvidence = evidence => {
      if (!Array.isArray(evidence) || !evidence.length) fail('missing source evidence');
      for (const e of evidence) {
        if (!Object.hasOwn(files, e.file)) fail(`${journey.id}: unknown evidence file ${JSON.stringify(e.file)} for quote ${JSON.stringify(e.quote)}; search the inventoried sources for the correct file`);
        if (!Number.isInteger(e.line) || e.line < 1 || !text(e.quote)) fail(`${journey.id}: invalid evidence ${JSON.stringify(e)}; use a positive 1-based line and nonempty verbatim quote`);
        const lines = files[e.file].split('\n');
        // Excerpts need not include a terminating semicolon or indentation. Canonicalize
        // only those boundaries; all remaining characters must occur at the cited line.
        e.quote = e.quote.trim().replace(/;$/, '').trimEnd();
        if (!text(e.quote) || !lines.slice(e.line - 1, e.line - 1 + e.quote.split('\n').length).join('\n').trim().includes(e.quote)) {
          const start = Math.max(0, Math.min(e.line - 3, lines.length - 5));
          evidenceErrors.add(`${e.file}:${e.line}: quote does not match source\nQuoted: ${JSON.stringify(e.quote)}\nSource context:\n${lines.slice(start, start + 7).map((line, i) => `${start + i + 1}: ${line}`).join('\n')}`);
        }
      }
    };
    const effectIds = new Set();
    if (!journey.effects.some(e => e.required === true)) fail(`${journey.id}: missing required user-task outcome; define what completing the requested task proves before considering fixture capabilities`);
    for (const e of journey.effects) {
      if (!text(e.id) || effectIds.has(e.id) || !text(e.trigger) || !text(e.consumer) || !text(e.expected) || typeof e.gap !== 'string' || !Array.isArray(e.coveredBy)) fail('invalid consumer effect');
      effectIds.add(e.id);
      if (typeof e.required !== 'boolean' || typeof e.exercise !== 'string') fail(`${journey.id}/${e.id}: specify required and exercise; setup checks do not establish task completion`);
      validateEvidence(e.evidence);
      if (e.required && !journey.blocked) {
        const exerciseIndex = journey.steps.findIndex(s => s.id === e.exercise);
        if (text(e.gap) || exerciseIndex < 0 || !e.coveredBy.length) fail(`${journey.id}/${e.id}: required task outcome is untested; mark the journey blocked instead of substituting setup or visibility checks`);
        if (e.coveredBy.some(c => journey.steps.findIndex(s => s.id === c.step) < exerciseIndex)) fail(`${journey.id}/${e.id}: completion checks must follow the task's exercise action`);
        if (e.coveredBy.every(c => presence.includes(journey.steps.find(s => s.id === c.step)?.checks?.[c.check]?.kind))) fail(`${journey.id}/${e.id}: required outcome is covered only by visible/hidden/enabled/disabled checks; cover it with what the action changed (agent run, workspace file, persisted data, request body, produced text)`);
      }
      if (e.required && journey.blocked && (!text(e.gap) || e.coveredBy.length || e.exercise)) fail(`${journey.id}/${e.id}: blocked task needs an explicit missing capability, no executable exercise or coverage`);
      if (!e.coveredBy.length && !text(e.gap)) fail(`${e.id}: consumer consequence silently omitted`);
      for (const coverage of e.coveredBy) {
        const step = journey.steps.find(s => s.id === coverage.step);
        if (!step || !Number.isInteger(coverage.check) || coverage.check < 0 || !step.checks?.[coverage.check]) fail(`${journey.id}/${e.id}: coverage ${coverage.step}[${coverage.check}] does not exist; available steps/check indexes: ${journey.steps.map(s => `${s.id}[0..${(s.checks?.length ?? 0) - 1}]`).join(', ')}`);
      }
    }
    if (journey.blocked) {
      if (journey.steps.length) fail('blocked journeys must have no executable steps');
      continue;
    }
    if (journey.steps.length < 3) fail(`${journey.id}: needs a multi-stage journey`);
    const stepIds = new Set();
    for (const step of journey.steps) {
      if (!text(step?.id) || stepIds.has(step.id) || !text(step.task) || !text(step.because)) fail('invalid/duplicate step or missing task/causal explanation');
      if (!Array.isArray(step.actions) || !step.actions.length) fail(`${journey.id}/${step.id}: a step is one user task with at least one action`);
      stepIds.add(step.id);
      if (!Array.isArray(step.checks) || !step.checks.length) fail(`${step.id}: missing consequences`);
      for (const [op, kinds] of [...step.actions.map(a => [a, actions]), ...step.checks.map(c => [c, checks])]) {
        if (!op || !kinds.includes(op.kind) || typeof op.value !== 'string') fail('unsupported operation');
        const needsTarget = ['click', 'fill', 'press', 'selectOption', 'visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count'].includes(op.kind);
        if (needsTarget && (!op.target || !['role', 'label', 'text', 'placeholder'].includes(op.target.by) || !text(op.target.name) || (op.target.by === 'role' && !text(op.target.role)))) fail('invalid locator');
        if (op.kind === 'count' && !/^\d+$/.test(op.value)) fail('invalid count');
        const where = `${journey.id}/${step.id} ${op.kind}`;
        if (['apiResponse', 'request'].includes(op.kind)) parse(where, apiResponse, op.value);
        if (['act', 'state'].includes(op.kind)) {
          const name = op.kind === 'act' ? parse(where, fixtureAct, op.value).name : parse(where, fixtureState, op.value).probe;
          // ponytail: textual lookup of the name in fixture.ts; parse its exported capability map if names start colliding.
          if (!files['tests/uipilot/fixture.ts']?.includes(name)) fail(`${journey.id}/${step.id}: ${op.kind} "${name}" is not provided by tests/uipilot/fixture.ts; use a capability it defines, or mark the task blocked and name the missing capability`);
        }
      }
      validateEvidence(step.evidence);
    }
    const tested = new Set(journey.effects.map(e => e.exercise).filter(text));
    for (const step of journey.steps) {
      if (!tested.has(step.id)) continue;
      const owner = actionOwners.get(taskKey(step));
      if (owner && owner !== journey.id) fail(`${journey.id}/${step.id}: repeats the tested task of journey ${owner}; merge them into one continuous journey instead of testing the same task twice`);
      actionOwners.set(taskKey(step), journey.id);
    }
  }
  if (evidenceErrors.size) fail(`${[...evidenceErrors].join('\n\n')}\nRe-read these files and correct all evidence; do not guess line numbers or change expected behavior.`);
  return plan;
}

export function report(plan) {
  return '# User journeys\n\nExpectations are source-inferred; they are not independent product requirements. The execution boundary is whatever the app fixture (tests/uipilot/fixture.ts) provides. Consumer discovery is not exhaustive. Setup visibility and configuration alone do not prove task completion.\n\n' + plan.journeys.map(j => `## ${j.id}\n\n${j.goal}\n\nPrerequisites: ${j.prerequisites.join('; ')}\n\nConsumer coverage:\n${j.effects.map(e => `- ${e.required ? 'REQUIRED TASK OUTCOME: ' : ''}${e.trigger} → ${e.consumer} → ${e.expected}: ${e.gap ? `GAP: ${e.gap}` : `${e.required ? `exercise ${e.exercise}; ` : ''}${e.coveredBy.map(c => `${c.step}[${c.check}]`).join(', ')}`}`).join('\n')}\n\n` + (j.blocked ? `BLOCKED: ${j.blocked}\n` : j.steps.map((s, i) => `${i + 1}. **${s.task}**\n   - Why: ${s.because}\n   - Expect: ${s.checks.map(c => `${c.kind} ${c.target?.name ?? ''} ${c.value}`.replace(/\s+/g, ' ').trim()).join('; ')}\n   - Source: ${s.evidence.map(e => `${e.file}:${e.line}`).join(', ')}`).join('\n'))).join('\n\n') + '\n';
}

const q = JSON.stringify;
function locator(t) {
  if (t.by === 'role') return `page.getByRole(${q(t.role)}, { name: ${q(t.name)}, exact: true })`;
  return `page.getBy${({ label: 'Label', text: 'Text', placeholder: 'Placeholder' })[t.by]}(${q(t.name)}, { exact: true })`;
}

// Generated code comes only from this compiler; model text is always a string literal.
export function compile(plan, fixtureImport) {
  let code = `// Generated from a source-backed journey plan. Do not edit; update the plan.\nimport { test, expect } from ${q(fixtureImport)};\n\n`;
  for (const j of plan.journeys.filter(j => !j.blocked)) {
    code += `test(${q(`${j.id}: ${j.goal}`)}, async ({ page, app }) => {\n  app.responses = ${q(j.apiResponses.map(apiResponse))};\n  await page.goto('/');\n`;
    for (const s of j.steps) {
      code += `  await test.step(${q(`${s.id}: ${s.task}`)}, async () => {\n`;
      for (const a of s.actions) {
        if (a.kind === 'reload') code += '    await page.reload();\n';
        else if (a.kind === 'apiResponse') code += `    app.responses.unshift(${q(apiResponse(a.value))});\n`;
        else if (a.kind === 'act') { const f = fixtureAct(a.value); code += `    await app.act(${q(f.name)}, ${q(f.args)});\n`; }
        else code += `    await ${locator(a.target)}.${a.kind}(${a.kind === 'click' ? '' : q(a.value)});\n`;
      }
      for (const c of s.checks) {
        if (c.kind === 'request') code += `    await expect.poll(() => app.hasRequest(${q(apiResponse(c.value))})).toBe(true);\n`;
        else if (c.kind === 'state') {
          const f = fixtureState(c.value);
          const matcher = Object.hasOwn(f, 'equals') ? `toEqual(${q(f.equals)})` : Object.hasOwn(f, 'includes') ? `toContain(${q(f.includes)})` : `not.toContain(${q(f.excludes)})`;
          code += `    await expect.poll(() => app.probe(${q(f.probe)}, ${q(f.args)})).${matcher};\n`;
        } else {
          // text is containment: a statement row or region shows the amount among its other text.
          const method = { visible: 'toBeVisible', hidden: 'toBeHidden', enabled: 'toBeEnabled', disabled: 'toBeDisabled', text: 'toContainText', value: 'toHaveValue', count: 'toHaveCount' }[c.kind];
          // visible means at least one match is shown; the same text in two places must not trip strict mode.
          code += `    await expect(${locator(c.target)}${c.kind === 'visible' ? '.filter({ visible: true }).first()' : ''}).${method}(${['visible', 'hidden', 'enabled', 'disabled'].includes(c.kind) ? '' : c.kind === 'count' ? Number(c.value) : q(c.value)});\n`;
        }
      }
      code += '  });\n';
    }
    code += '});\n\n';
  }
  return code;
}

export function preserveContract(original, repaired) {
  // Locators and API fixtures can change. Outcomes, coverage, evidence, and actions cannot disappear.
  const contract = plan => plan.journeys.map(j => ({
    id: j.id, goal: j.goal, prerequisites: j.prerequisites, blocked: j.blocked, effects: j.effects,
    steps: j.steps.map(s => ({ id: s.id, task: s.task, because: s.because, evidence: s.evidence,
      actions: s.actions.map(a => ({ kind: a.kind, value: a.kind === 'apiResponse' ? '' : a.value })),
      checks: s.checks.map(c => ({ kind: c.kind, value: c.value, name: c.target?.name })),
    })),
  }));
  if (!isDeepStrictEqual(contract(original), contract(repaired))) throw new Error('Repair changed journey outcomes or coverage; refusing to weaken the test');
}
