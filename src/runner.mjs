import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compile, preserveContract, validate, report } from './core.mjs';

const exec = promisify(execFile);
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
        items.push({ trace: entry, events: events.filter(e => ['before', 'after', 'log', 'console', 'event'].includes(e.type)).slice(-100) });
      }
    } else if (/json|text/.test(attachment.contentType)) items.push({ name: attachment.name, content: (await readFile(filename, 'utf8')).slice(-60_000) });
  }
  return JSON.stringify(items).slice(-180_000);
}

export async function execute(root, dir) {
  const reportFile = path.join(dir, 'results.json');
  const playwright = path.join(root, 'node_modules/@playwright/test/cli.js');
  try { await access(playwright); } catch { throw new Error(`Install @playwright/test in ${root} and add a playwright.config that honors JOURNEY_TEST_DIR`); }
  const log = [];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [playwright, 'test', path.join(dir, 'journeys.spec.ts'), '--reporter=list,json', '--output', path.join(dir, 'artifacts')], {
      cwd: root, env: { ...process.env, JOURNEY_TEST_DIR: dir, DEVDEN_JOURNEY_TEST_DIR: dir, PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile }, stdio: ['ignore', 'pipe', 'pipe'],
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
    const outcome = await run(root, attemptDir);
    attempts.push({ attempt, passed: outcome.passed, artifacts: attemptDir });
    const summary = { passed: outcome.passed, boundary: 'Real frontend, mocked API; no backend integration or exhaustive coverage claim', backend: plan.backend ?? null, gaps: plan.journeys.flatMap(j => j.effects.filter(e => e.gap).map(e => ({ journey: j.id, effect: e.id, gap: e.gap }))), attempts };
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
