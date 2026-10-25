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
export const actions = ['click', 'fill', 'press', 'reload', 'notesFailure', 'apiResponse'];
export const checks = ['visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count', 'request', 'serverNote', 'noServerNote', 'browserNote', 'noBrowserNote'];
export const schema = object({ journeys: array(object({
  id: string, goal: string, prerequisites: array(string), blocked: { type: 'string' },
  apiResponses: array(string),
  effects: array(object({ id: string, trigger: string, consumer: string, expected: string, evidence,
    coveredBy: array(object({ step: string, check: { type: 'integer', minimum: 0 } })), gap: { type: 'string' },
  })),
  steps: array(object({
    id: string, because: string, action: operation(actions), checks: array(operation(checks)),
    evidence,
  })),
})) });

export async function sources(root, dirs = (process.env.JOURNEY_SOURCE_DIRS || 'src,server').split(',').map(dir => dir.trim()).filter(Boolean)) {
  const result = {};
  async function walk(dir) {
    let entries;
    try { entries = await readdir(path.join(root, dir), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && /\.(tsx?|m?js)$/.test(file)) result[file] = await readFile(path.join(root, file), 'utf8');
    }
  }
  for (const dir of dirs) await walk(dir);
  if (!Object.keys(result).length) throw new Error(`No UI source files under ${dirs.join(', ')} in ${root}`);
  return result;
}

export const hash = text => createHash('sha256').update(text).digest('hex');

export function apiResponse(value) {
  const r = JSON.parse(value);
  if (!['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(r.method) || typeof r.path !== 'string' || !r.path.startsWith('/api/') || !r.body || typeof r.body !== 'object') throw new Error('Invalid API fixture/request');
  return r;
}

export function validate(plan, files) {
  const fail = message => { throw new Error(`Invalid journey plan: ${message}`); };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(plan?.journeys) || !plan.journeys.length) fail('no journeys');
  const ids = new Set();
  for (const journey of plan.journeys) {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(journey.id) || ids.has(journey.id)) fail('invalid/duplicate id');
    ids.add(journey.id);
    if (!text(journey.goal) || !Array.isArray(journey.prerequisites) || !journey.prerequisites.every(text) || typeof journey.blocked !== 'string') fail(`${journey.id}: missing goal/prerequisites/status`);
    if (!Array.isArray(journey.steps) || !Array.isArray(journey.effects) || !journey.effects.length || !Array.isArray(journey.apiResponses)) fail('missing steps, consumer effects, or fixtures');
    journey.apiResponses.forEach(apiResponse);
    const validateEvidence = evidence => {
      if (!Array.isArray(evidence) || !evidence.length) fail('missing source evidence');
      for (const e of evidence) {
        if (!Object.hasOwn(files, e.file) || !Number.isInteger(e.line) || e.line < 1 || !text(e.quote)) fail('invalid evidence');
        const lines = files[e.file].split('\n');
        // Excerpts need not include a terminating semicolon or indentation. Canonicalize
        // only those boundaries; all remaining characters must occur at the cited line.
        e.quote = e.quote.trim().replace(/;$/, '').trimEnd();
        if (!text(e.quote) || !lines.slice(e.line - 1, e.line - 1 + e.quote.split('\n').length).join('\n').trim().includes(e.quote)) fail(`${e.file}:${e.line}: quote does not match source`);
      }
    };
    const effectIds = new Set();
    for (const e of journey.effects) {
      if (!text(e.id) || effectIds.has(e.id) || !text(e.trigger) || !text(e.consumer) || !text(e.expected) || typeof e.gap !== 'string' || !Array.isArray(e.coveredBy)) fail('invalid consumer effect');
      effectIds.add(e.id);
      validateEvidence(e.evidence);
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
      if (!text(step.id) || stepIds.has(step.id) || !text(step.because)) fail('invalid/duplicate step or missing causal explanation');
      stepIds.add(step.id);
      if (!Array.isArray(step.checks) || !step.checks.length) fail(`${step.id}: missing consequences`);
      for (const [op, kinds] of [[step.action, actions], ...step.checks.map(c => [c, checks])]) {
        if (!op || !kinds.includes(op.kind) || typeof op.value !== 'string') fail('unsupported operation');
        const needsTarget = ['click', 'fill', 'press', 'visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count'].includes(op.kind);
        if (needsTarget && (!op.target || !['role', 'label', 'text', 'placeholder'].includes(op.target.by) || !text(op.target.name) || (op.target.by === 'role' && !text(op.target.role)))) fail('invalid locator');
        if (op.kind === 'count' && !/^\d+$/.test(op.value)) fail('invalid count');
        if (op.kind === 'notesFailure' && !['true', 'false'].includes(op.value)) fail('invalid failure toggle');
        if (['apiResponse', 'request'].includes(op.kind)) apiResponse(op.value);
      }
      if (!step.checks.some(c => ['visible', 'hidden', 'enabled', 'disabled', 'text', 'value', 'count'].includes(c.kind))) fail('each step needs a UI consequence');
      validateEvidence(step.evidence);
    }
  }
  return plan;
}

export function report(plan) {
  return '# User journeys\n\nExpectations are source-inferred; they are not independent product requirements. Execution uses the real frontend with a mocked API. Consumer discovery is not exhaustive.\n\n' + plan.journeys.map(j => `## ${j.id}\n\n${j.goal}\n\nPrerequisites: ${j.prerequisites.join('; ')}\n\nConsumer coverage:\n${j.effects.map(e => `- ${e.trigger} → ${e.consumer} → ${e.expected}: ${e.gap ? `GAP: ${e.gap}` : e.coveredBy.map(c => `${c.step}[${c.check}]`).join(', ')}`).join('\n')}\n\n` + (j.blocked ? `BLOCKED: ${j.blocked}\n` : j.steps.map(s => `- **${s.id}**: ${s.action.kind} ${s.action.target?.name ?? ''} ${s.action.value}\n  - Why: ${s.because}\n  - Verify: ${s.checks.map(c => `${c.kind} ${c.target?.name ?? ''} ${c.value}`).join('; ')}\n  - Source: ${s.evidence.map(e => `${e.file}:${e.line}`).join(', ')}`).join('\n'))).join('\n\n') + '\n';
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
      code += `  await test.step(${q(`${s.id}: ${s.because}`)}, async () => {\n`;
      const a = s.action;
      if (a.kind === 'reload') code += '    await page.reload();\n';
      else if (a.kind === 'notesFailure') code += `    app.notesFailure = ${a.value};\n`;
      else if (a.kind === 'apiResponse') code += `    app.responses.unshift(${q(apiResponse(a.value))});\n`;
      else code += `    await ${locator(a.target)}.${a.kind}(${a.kind === 'click' ? '' : q(a.value)});\n`;
      for (const c of s.checks) {
        if (c.kind === 'request') code += `    await expect.poll(() => app.hasRequest(${q(apiResponse(c.value))})).toBe(true);\n`;
        else if (['serverNote', 'noServerNote', 'browserNote', 'noBrowserNote'].includes(c.kind)) {
          const browser = c.kind.toLowerCase().includes('browser');
          const expr = browser ? `await page.evaluate(() => JSON.parse(localStorage.getItem('devden.notes') || '[]').map((n: { body: string }) => n.body))` : 'app.notes.map(n => n.body)';
          code += `    await expect.poll(async () => ${expr}).${c.kind.startsWith('no') ? 'not.' : ''}toContain(${q(c.value)});\n`;
        } else {
          const method = { visible: 'toBeVisible', hidden: 'toBeHidden', enabled: 'toBeEnabled', disabled: 'toBeDisabled', text: 'toHaveText', value: 'toHaveValue', count: 'toHaveCount' }[c.kind];
          code += `    await expect(${locator(c.target)}).${method}(${['visible', 'hidden', 'enabled', 'disabled'].includes(c.kind) ? '' : c.kind === 'count' ? Number(c.value) : q(c.value)});\n`;
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
    steps: j.steps.map(s => ({ id: s.id, because: s.because, evidence: s.evidence,
      action: { kind: s.action.kind, value: s.action.kind === 'apiResponse' ? '' : s.action.value },
      checks: s.checks.map(c => ({ kind: c.kind, value: c.value, name: c.target?.name })),
    })),
  }));
  if (!isDeepStrictEqual(contract(original), contract(repaired))) throw new Error('Repair changed journey outcomes or coverage; refusing to weaken the test');
}
