// Live-app exploration for discovery: the model opens pages of the running app, reads the
// accessibility tree, and clicks or fills with the same targets plan steps use.
// Playwright comes from the app under test, which already needs it to run the journeys.
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from './source-reader.mjs';

const SNAPSHOT_LIMIT = 30_000;

// Only same-origin paths: exploration must stay on the app under test.
export function pageUrl(base, target) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) throw new Error('path must start with / and stay on the app (e.g. "/notes")');
  return new URL(target, base).href;
}

// Lines that differ between two trees, as a multiset so repeated rows count. Order follows each tree.
export function treeChange(before, after) {
  const counts = lines => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
  const extra = (lines, other) => { const left = counts(other); return lines.filter(line => (left.get(line) ?? 0) > 0 ? (left.set(line, left.get(line) - 1), false) : true); };
  const a = before.split('\n'), b = after.split('\n');
  return { removed: extra(a, b), added: extra(b, a), size: b.length };
}

// Same locator semantics as the compiler, so a target that works here works in the generated test.
export function locate(page, target) {
  if (!target || typeof target.name !== 'string' || !target.name) throw new Error('target needs {by, name} (and role when by is "role")');
  if (target.by === 'role') return page.getByRole(target.role, { name: target.name, exact: true });
  const method = { label: 'getByLabel', text: 'getByText', placeholder: 'getByPlaceholder' }[target.by];
  if (!method) throw new Error('target.by must be role, label, text or placeholder');
  return page[method](target.name, { exact: true });
}

const target = { type: 'object', properties: { by: { enum: ['role', 'label', 'text', 'placeholder'] }, role: { type: 'string' }, name: { type: 'string' } }, required: ['by', 'name'], additionalProperties: false };
export const tools = [
  { name: 'browser_open', description: 'Open a page of the running app by path (e.g. "/"), then return its URL and accessibility tree.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'browser_snapshot', annotations: { readOnlyHint: true }, description: 'Return the current URL and accessibility tree (roles and accessible names).', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'browser_click', description: 'Click the element a plan target names, then return what changed in the accessibility tree (the full tree when the page changed).', inputSchema: { type: 'object', properties: { target }, required: ['target'], additionalProperties: false } },
  { name: 'browser_fill', description: 'Fill the field a plan target names with a value, then return what changed in the accessibility tree.', inputSchema: { type: 'object', properties: { target, value: { type: 'string' } }, required: ['target', 'value'], additionalProperties: false } },
];

export function explorer(base, launch) {
  const origin = new URL(base).origin;
  let browser, page, blocked = null, last = null;
  const ready = async () => {
    if (!page) {
      browser = await launch();
      page = await (await browser.newContext({ baseURL: base })).newPage();
      page.setDefaultTimeout(5_000);
      // Links off the app are aborted before they load; the browser never visits another site.
      await page.route('**/*', route => {
        const request = route.request();
        if (request.isNavigationRequest() && request.frame() === page.mainFrame() && new URL(request.url()).origin !== origin) {
          blocked = request.url();
          // ERR_ABORTED cancels the navigation and keeps the current page (other codes show an error page).
          return route.abort('aborted');
        }
        return route.continue();
      });
    }
    return page;
  };
  // After a click or fill, only the changed lines go back to the model: the tree it already has is
  // in its context, and resending it on every action is most of exploration's token cost.
  const snapshot = async (changesOnly = false) => {
    // ponytail: fixed settle delay; apps with streaming connections never reach networkidle.
    await page.waitForTimeout(300);
    const tree = await page.locator('body').ariaSnapshot();
    const url = page.url(), previous = last;
    last = { url, tree };
    if (changesOnly && previous?.url === url) {
      const { removed, added, size } = treeChange(previous.tree, tree);
      if (!removed.length && !added.length) return `URL: ${url}\nNo change on the page.`;
      if (removed.length + added.length <= size / 2) {
        return `URL: ${url}\nChanged lines (browser_snapshot returns the full tree):${removed.length ? `\nremoved:\n${removed.join('\n')}` : ''}${added.length ? `\nadded:\n${added.join('\n')}` : ''}`;
      }
    }
    return `URL: ${url}\n${tree.length > SNAPSHOT_LIMIT ? `${tree.slice(0, SNAPSHOT_LIMIT)}\n… (truncated)` : tree}`;
  };
  const act = async run => {
    blocked = null;
    try { await run(); }
    catch (error) {
      if (!/Timeout|strict mode/.test(error.message)) throw error;
      throw new Error(`${/strict mode/.test(error.message) ? 'That target matches more than one element' : 'No element matches that target'}; use the exact role and name from the latest snapshot`);
    }
    if (blocked) throw new Error(`Blocked navigation off the app to ${blocked}; exploration stays on ${origin}`);
  };
  return {
    async call(name, args) {
      await ready();
      if (name === 'browser_open') await page.goto(pageUrl(base, args.path));
      else if (name === 'browser_click') await act(() => locate(page, args.target).click());
      else if (name === 'browser_fill') await act(() => locate(page, args.target).fill(String(args.value ?? '')));
      else if (name !== 'browser_snapshot') throw new Error('Unknown tool');
      else if (page.url() === 'about:blank') throw new Error('Open a page first with browser_open');
      return snapshot(name === 'browser_click' || name === 'browser_fill');
    },
    close: () => browser?.close(),
  };
}

async function main() {
  const [root, base] = process.argv.slice(2);
  const require = createRequire(path.join(root, 'package.json'));
  let playwright;
  try { playwright = require('@playwright/test'); } catch { playwright = require('playwright'); }
  const app = explorer(base, () => playwright.chromium.launch());
  try { await serve(tools, (name, args) => app.call(name, args)); } finally { await app.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.exitCode = 1; });
