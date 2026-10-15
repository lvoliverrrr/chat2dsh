#!/usr/bin/env node
import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { loadConfig, resolveCwd } from './config.mjs';
import { describeRuntime, runDsh, resolveDshEntry } from './dsh.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const VERSION = pkg.version;

const MAX_BODY_BYTES = 1024 * 1024;

function textResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Build one MCP server instance. In HTTP mode we build a fresh one per request (stateless). */
function createServer(config) {
  const server = new McpServer({ name: 'chat2dsh', version: VERSION });

  server.registerTool(
    'dsh_health',
    {
      title: 'Check the local DSH runtime',
      description:
        'Read-only. Reports whether DeepSeek Harness is reachable on this machine, its version, the Node runtime, the configured workspace roots and the DSH home directory. Call this first to prove the bridge is wired up.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const runtime = describeRuntime(config);
      const { _resolved, ...safe } = runtime;
      return textResult({
        ok: runtime.dshResolved,
        bridge: { name: 'chat2dsh', version: VERSION },
        roots: config.roots,
        profile: config.profile,
        ...safe,
      });
    },
  );

  server.registerTool(
    'dsh_run',
    {
      title: 'Run a task with the local DSH agent',
      description:
        'Hand one self-contained task to DeepSeek Harness on this machine. DSH runs its own agent loop in the given workspace: it reads and edits files and runs commands there. Blocks until the run finishes, then returns stdout, the tail of stderr, the exit code and the wall-clock time. Write a complete task: goal, target files, constraints, expected output. The prompt is one-shot and cannot ask follow-up questions, so do not reference earlier conversation.',
      inputSchema: {
        task: z
          .string()
          .min(1)
          .describe('The complete task for the DSH agent. Must stand on its own.'),
        cwd: z
          .string()
          .optional()
          .describe('Absolute path to run in. Must be inside one of the configured workspace roots.'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(`Wall-clock limit. Default ${config.timeoutMs} ms, hard ceiling ${config.maxTimeoutMs} ms.`),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ task, cwd, timeout_ms }) => {
      let workdir;
      try {
        workdir = resolveCwd(cwd, config.roots);
      } catch (err) {
        return errorResult(err.message);
      }

      const resolved = resolveDshEntry(config);
      if (!resolved && !config.dshBin) {
        return errorResult('DeepSeek Harness was not found. Install it (npm i -g @deepseek-ai/dsh) or set CHAT2DSH_DSH_ENTRY.');
      }

      const result = await runDsh(config, { task, cwd: workdir, timeoutMs: timeout_ms }, resolved);

      const payload = {
        ok: result.ok,
        task,
        cwd: workdir,
        exitCode: result.exitCode,
        signal: result.signal,
        seconds: Number(result.seconds.toFixed(2)),
        timedOut: result.timedOut,
        truncated: result.truncated || false,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };

      return result.ok ? textResult(payload) : { ...textResult(payload), isError: true };
    },
  );

  return server;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function tokenMatches(expected, provided) {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided || '');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAuthorized(req, config) {
  if (!config.token) return true;
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return tokenMatches(config.token, match ? match[1].trim() : '');
}

async function startHttp(config) {
  if (!config.token && !config.noAuth) {
    console.error(
      '[chat2dsh] refusing to start in HTTP mode without a token.\n' +
        '           Set CHAT2DSH_TOKEN=<secret> (recommended) or pass --no-auth if you are\n' +
        '           sure the port stays on loopback and nothing else can reach it.',
    );
    process.exit(1);
  }

  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    console.error(
      `[chat2dsh] warning: binding to ${config.host}. This endpoint executes code on this machine.\n` +
        '           Anyone who can reach the port and holds the token can drive DSH.',
    );
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz') {
      const runtime = describeRuntime(config);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: runtime.dshResolved,
          bridge: VERSION,
          dshVersion: runtime.dshVersion,
          authRequired: Boolean(config.token),
        }),
      );
      return;
    }

    if (url.pathname !== config.path) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', mcp: config.path }));
      return;
    }

    if (!isAuthorized(req, config)) {
      res.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="chat2dsh"',
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ error: 'method_not_allowed', hint: 'This bridge is stateless; POST only.' }));
      return;
    }

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_request', message: err.message }));
      return;
    }

    const mcp = createServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[chat2dsh] request failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error', message: err.message }));
      }
    }
  });

  server.listen(config.port, config.host, () => {
    const runtime = describeRuntime(config);
    console.error(`[chat2dsh] v${VERSION} listening on http://${config.host}:${config.port}${config.path}`);
    console.error(`[chat2dsh] dsh: ${runtime.dshVersion} (${runtime.dshEntry || runtime.fallbackCommand})`);
    console.error(`[chat2dsh] roots: ${config.roots.join(', ') || '(none — dsh_run will refuse to run)'}`);
    console.error(`[chat2dsh] auth: ${config.token ? 'bearer token required' : 'DISABLED (--no-auth)'}`);
  });
}

async function startStdio(config) {
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[chat2dsh] v${VERSION} speaking MCP over stdio`);
  console.error(`[chat2dsh] roots: ${config.roots.join(', ') || '(none — dsh_run will refuse to run)'}`);
}

const config = loadConfig();
const entry = config.mode === 'http' ? startHttp : startStdio;

entry(config).catch((err) => {
  console.error('[chat2dsh] fatal:', err);
  process.exit(1);
});

export { createServer, VERSION };
