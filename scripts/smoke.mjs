#!/usr/bin/env node
/**
 * End-to-end self check.
 *
 * Boots the bridge as a real child process, then connects to it with a real MCP
 * client over Streamable HTTP and exercises the tools. No mocks: if this passes,
 * an MCP client can drive DSH through the bridge on this machine.
 *
 *   node scripts/smoke.mjs                  # handshake + tools/list + dsh_health
 *   node scripts/smoke.mjs --with-run       # also fire one real dsh_run task
 *   node scripts/smoke.mjs --root <dir>     # workspace root (defaults to cwd)
 */
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const serverEntry = path.join(projectRoot, 'src', 'server.mjs');

const argv = process.argv.slice(2);
const withRun = argv.includes('--with-run');
const rootFlag = argv.indexOf('--root');
const root = rootFlag !== -1 ? path.resolve(argv[rootFlag + 1]) : process.cwd();
const port = 7300 + Math.floor(Math.random() * 400);
const token = randomBytes(16).toString('hex');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitForHealth(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`bridge did not answer /healthz within ${timeoutMs} ms`);
}

const child = spawn(
  process.execPath,
  [serverEntry, '--http', '--port', String(port), '--token', token, '--root', root],
  { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
);

let serverLog = '';
child.stdout.on('data', (d) => (serverLog += d.toString()));
child.stderr.on('data', (d) => (serverLog += d.toString()));

let client;
try {
  const base = `http://127.0.0.1:${port}`;
  const health = await waitForHealth(`${base}/healthz`);
  record('server boots and binds loopback', true, `bridge ${health.bridge}, dsh ${health.dshVersion}`);
  record('dsh is reachable from the bridge process', Boolean(health.ok), health.ok ? 'resolved' : 'NOT resolved');

  const unauthed = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  record('unauthenticated request is rejected', unauthed.status === 401, `HTTP ${unauthed.status}`);

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  client = new Client({ name: 'chat2dsh-smoke', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  record('MCP handshake over Streamable HTTP', true, `session ${randomUUID().slice(0, 8)}`);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  record('tools/list returns the bridge surface', names.includes('dsh_health') && names.includes('dsh_run'), names.join(', '));

  const healthCall = await client.callTool({ name: 'dsh_health', arguments: {} });
  const healthPayload = JSON.parse(healthCall.content[0].text);
  record(
    'dsh_health reports a real dsh runtime',
    Boolean(healthPayload.dshResolved) && /\d+\.\d+/.test(healthPayload.dshVersion || ''),
    `dsh ${healthPayload.dshVersion} @ ${healthPayload.dshEntry}`,
  );

  const escaped = await client.callTool({
    name: 'dsh_run',
    arguments: { task: 'echo hi', cwd: path.resolve(root, '..') },
  });
  record('dsh_run refuses a cwd outside the roots', escaped.isError === true, (escaped.content?.[0]?.text || '').slice(0, 80));

  if (withRun) {
    const run = await client.callTool({
      name: 'dsh_run',
      arguments: { task: '只回复两个字：收到。不要做任何其他事。', cwd: root, timeout_ms: 180_000 },
    });
    const payload = JSON.parse(run.content[0].text);
    record(
      'dsh_run executed a real task through the bridge',
      payload.ok === true,
      `exit=${payload.exitCode} in ${payload.seconds}s${payload.ok ? '' : ` — ${(payload.stdout || payload.stderr || '').slice(0, 200)}`}`,
    );
  } else {
    console.log('SKIP  dsh_run live task — pass --with-run to spend one real LLM call');
  }
} catch (err) {
  record('smoke run', false, err.message);
} finally {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  child.kill('SIGTERM');
  setTimeout(() => child.kill('SIGKILL'), 3_000).unref?.();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log('\n--- server log ---\n' + serverLog.trim());
  process.exit(1);
}
