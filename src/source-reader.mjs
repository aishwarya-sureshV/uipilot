// Minimal stdio MCP reader. The model can only read/search this immutable source snapshot.
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export function sourceTool(files, name, args) {
  if (name === 'read_source') {
    if (typeof args.file !== 'string' || !Object.hasOwn(files, args.file)) throw new Error('Unknown source file');
    const start = args.start ?? 1, count = args.count ?? 200;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1 || count > 400) throw new Error('Invalid line window (count 1–400)');
    return files[args.file].split('\n').slice(start - 1, start - 1 + count).map((line, i) => `${start + i}: ${line}`).join('\n');
  }
  if (name === 'search_source') {
    if (typeof args.text !== 'string' || !args.text.length) throw new Error('Search text required');
    const matches = [];
    for (const [file, content] of Object.entries(files)) {
      for (const [index, line] of content.split('\n').entries()) {
        if (line.includes(args.text)) matches.push({ file, line: index + 1, text: line.slice(0, 500) });
      }
    }
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid search offset');
    return JSON.stringify({ total: matches.length, matches: matches.slice(offset, offset + 100), nextOffset: matches.length > offset + 100 ? offset + 100 : null });
  }
  throw new Error('Unknown tool');
}

async function main() {
  const [snapshot, readLog] = process.argv.slice(2);
  const files = JSON.parse(await readFile(snapshot, 'utf8'));
  const tools = [
    { name: 'read_source', annotations: { readOnlyHint: true }, description: 'Read an inventoried source file with exact 1-based line numbers. Paginate large files.', inputSchema: { type: 'object', properties: { file: { type: 'string' }, start: { type: 'integer' }, count: { type: 'integer' } }, required: ['file'], additionalProperties: false } },
    { name: 'search_source', annotations: { readOnlyHint: true }, description: 'Search the source snapshot for a literal identifier or text. Follow matches relevant to the requested UI workflow; paginate when needed.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, offset: { type: 'integer' } }, required: ['text'], additionalProperties: false } },
  ];
  for await (const line of createInterface({ input: process.stdin })) {
    let request;
    try {
      request = JSON.parse(line);
      if (!Object.hasOwn(request, 'id')) continue;
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'journey-source', version: '1.0.0' } };
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/call') {
        try {
          const text = sourceTool(files, request.params.name, request.params.arguments ?? {});
          if (request.params.name === 'read_source') await appendFile(readLog, JSON.stringify(request.params.arguments.file) + '\n');
          result = { content: [{ type: 'text', text }] };
        } catch (error) { result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
      } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue; }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32700, message: 'Invalid request' } }) + '\n');
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.exitCode = 1; });
