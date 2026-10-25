import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compile, preserveContract, validate, report, sources, hash } from './core.mjs';

const exec = promisify(execFile);
// ~15k tokens: enough for the failing assertion, page snapshot and recent trace without flooding repairs.
const DIAGNOSTICS_LIMIT = 60_000;
async function inside(dir, file) {
  const actual = await realpath(file);
  const relative = path.relative(await realpath(dir), actual);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact outside run directory');
  return actual;
}

export async function diagnostics(dir, result) {
  const items = [];
  const attachments = [];
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.errors?.length) items.push({ errors: value.errors });
    if (value.attachments) attachments.push(...value.attachments);
    for (const [key, child] of Object.entries(value)) if (!['attachments', 'errors'].includes(key)) {
      if (Array.isArray(child)) child.forEach(walk); else walk(child);
    }
  }
  walk(result);
  for (const attachment of attachments) {
    if (attachment.body && /json|text/.test(attachment.contentType)) items.push({ name: attachment.name, content: Buffer.from(attachment.body, 'base64').toString('utf8').slice(-60_000) });
    if (!attachment.path) continue;
    const filename = await inside(dir, attachment.path);
    if (attachment.name === 'trace') {
      // Read trace events without extracting or executing any archive contents.
      const { stdout } = await exec('unzip', ['-Z1', filename], { maxBuffer: 1_000_000 });
      for (const entry of stdout.split('\n').filter(n => /\.trace$/.test(n))) {
        const { stdout: trace } = await exec('unzip', ['-p', filename, entry], { maxBuffer: 20_000_000 });
        const events = trace.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        items.push({ trace: entry, events: events.filter(e => ['before', 'after', 'log', 'console', 'event'].includes(e.type)).slice(-40) });
      }
    } else if (/json|text/.test(attachment.contentType)) items.push({ name: attachment.name, content: (await readFile(filename, 'utf8')).slice(-60_000) });
  }
  // Most useful first, within a budget: errors, then page state and logs, then trace tail.
  // The old tail-slice dropped the errors first, since they lead the list.
  const rank = item => item.errors ? 0 : item.trace ? 2 : 1;
  let text = '';
  for (const item of items.sort((a, b) => rank(a) - rank(b))) {
    const entry = JSON.stringify(item) + '\n';
    if (text.length + entry.length > DIAGNOSTICS_LIMIT) return text + entry.slice(0, Math.max(0, DIAGNOSTICS_LIMIT - text.length)) + '… (diagnostics truncated)';
    text += entry;
  }
  return text;
}

export async function execute(root, dir, snapshot) {
  const checkSources = async () => {
    if (!snapshot) return;
    const current = await sources(root);
    const changed = [...new Set([...Object.keys(snapshot), ...Object.keys(current)])].filter(file => !(file in snapshot) || !(file in current) || hash(snapshot[file]) !== hash(current[file]));
    if (changed.length) throw new Error(`Source changed during journey validation: ${changed.join(', ')}; rerun against a stable checkout`);
  };
  await checkSources();
  const reportFile = path.join(dir, 'results.json');
  const playwright = path.join(root, 'node_modules/@playwright/test/cli.js');
  try { await access(playwright); } catch { throw new Error(`Install @playwright/test in ${root} and add a playwright.config that honors UIPILOT_TEST_DIR`); }
  const log = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwright, 'test', path.join(dir, 'journeys.spec.ts'), '--reporter=list,json', '--output', path.join(dir, 'artifacts')], {
      cwd: root, env: { ...process.env, UIPILOT_TEST_DIR: dir, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 5 * 60_000);
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', data => { log.push(data.toString()); process.stderr.write(data); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve(code ?? 1); });
  });
  await writeFile(path.join(dir, 'run.log'), log.join(''));
  let result;
  try { result = JSON.parse(await readFile(reportFile, 'utf8')); } catch {
    throw new Error(`Browser runner did not produce a report; inspect ${dir}/run.log`);
  }
  await checkSources();
  // A zero-test or skipped/flaky run is not evidence of correctness.
  const passed = exitCode === 0 && result.stats?.expected > 0 && result.stats.unexpected === 0 && result.stats.skipped === 0 && result.stats.flaky === 0;
  return { passed, result, feedback: passed ? '' : await diagnostics(dir, result) };
}

export async function feedbackLoop({ root, dir, plan, files, repairs, repair, run = execute }) {
  validate(plan, files);
  const original = structuredClone(plan);
  const attempts = [];
  for (let attempt = 0; attempt <= repairs; attempt++) {
    validate(plan, files);
    preserveContract(original, plan);
    const attemptDir = path.join(dir, `attempt-${attempt}`);
    await mkdir(attemptDir, { recursive: true });
    await writeFile(path.join(attemptDir, 'plan.json'), JSON.stringify(plan, null, 2));
    await writeFile(path.join(attemptDir, 'journeys.md'), report(plan));
    await writeFile(path.join(attemptDir, 'journeys.spec.ts'), compile(plan, '../../../fixture'));
    const outcome = await run(root, attemptDir, files);
    attempts.push({ attempt, passed: outcome.passed, artifacts: attemptDir });
    const blocked = plan.journeys.filter(j => j.blocked).map(j => ({ journey: j.id, reason: j.blocked }));
    const summary = { passed: outcome.passed && blocked.length === 0, browserPassed: outcome.passed, blocked, boundary: 'As provided by the app fixture (tests/uipilot/fixture.ts); no exhaustive coverage claim', backend: plan.backend ?? null, gaps: plan.journeys.flatMap(j => j.effects.filter(e => e.gap).map(e => ({ journey: j.id, effect: e.id, gap: e.gap }))), attempts };
    await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    if (outcome.passed || attempt === repairs) return summary;
    await writeFile(path.join(attemptDir, 'feedback.json'), outcome.feedback);
    const next = await repair(plan, outcome.feedback);
    validate(next, files);
    preserveContract(original, next);
    if (compile(next, '') === compile(plan, '')) {
      summary.stopped = 'No permitted automation repair; inspect for an application bug or missing fixture capability.';
      await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
      return summary;
    }
    plan = next;
  }
}
