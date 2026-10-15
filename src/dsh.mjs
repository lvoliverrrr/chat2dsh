import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Resolve the JavaScript entry of DeepSeek Harness.
 * We deliberately avoid the `dsh` shell shim: on Windows it is a .cmd wrapper, and
 * routing a task string through cmd.exe means fighting quoting and escaping rules.
 * Spawning `node <entry> <task>` passes the task as a real argv element instead.
 */
export function resolveDshEntry(config = {}) {
  const candidates = [];

  if (config.dshEntry) candidates.push(config.dshEntry);

  try {
    candidates.push(require.resolve('@deepseek-ai/dsh/package.json'));
  } catch {
    /* not a local dependency */
  }

  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    }).trim();
    if (globalRoot) candidates.push(path.join(globalRoot, '@deepseek-ai', 'dsh', 'package.json'));
  } catch {
    /* npm not available or too slow */
  }

  for (const candidate of candidates) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    try {
      const pkgDir = candidate.endsWith('package.json') ? path.dirname(candidate) : candidate;
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh;
      if (!rel) continue;
      const entry = path.join(pkgDir, rel);
      if (fs.existsSync(entry)) {
        return { entry, version: pkg.version || null, source: candidate };
      }
    } catch {
      /* keep looking */
    }
  }

  return null;
}

function buildEnv(config) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(config.env || {})) {
    if (value) env[key] = value;
  }
  return env;
}

function buildInvocation(config, task, resolved) {
  const profile = config.profile || 'headless';
  if (resolved?.entry) {
    return {
      command: process.execPath,
      args: [resolved.entry, profile, task],
      options: { shell: false },
    };
  }
  return {
    command: config.dshBin || 'dsh',
    args: [profile, task],
    options: { shell: true },
  };
}

function truncate(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const buf = Buffer.from(text, 'utf8').subarray(-maxBytes);
  return { text: `…[truncated, showing last ${maxBytes} bytes]\n${buf.toString('utf8')}`, truncated: true };
}

/** Run one task through `dsh <profile> "<task>"`. One shot: the profile answers, prints, exits. */
export function runDsh(config, { task, cwd, timeoutMs }, resolved = resolveDshEntry(config)) {
  const limit = Math.min(Number(timeoutMs) || config.timeoutMs, config.maxTimeoutMs);
  const invocation = buildInvocation(config, task, resolved);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: buildEnv(config),
      windowsHide: true,
      ...invocation.options,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, limit);

    child.stdout?.on('data', (d) => {
      stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: null,
        seconds: (Date.now() - startedAt) / 1000,
        stdout: '',
        stderr: `${err.message}`,
        timedOut,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const out = truncate(stdout, config.maxOutputBytes);
      const err = truncate(stderr, config.maxOutputBytes);
      resolve({
        ok: code === 0 && !timedOut,
        exitCode: code,
        signal: signal || null,
        seconds: (Date.now() - startedAt) / 1000,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
      });
    });
  });
}

export function readVersion(resolved, config) {
  const invocation = resolved?.entry
    ? { command: process.execPath, args: [resolved.entry, '--version'], shell: false }
    : { command: config.dshBin || 'dsh', args: ['--version'], shell: true };
  try {
    return execFileSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      timeout: 60_000,
      env: buildEnv(config),
      shell: invocation.shell,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    return `unavailable (${err.message.split('\n')[0]})`;
  }
}

export function describeRuntime(config) {
  const resolved = resolveDshEntry(config);
  return {
    dshResolved: Boolean(resolved),
    dshEntry: resolved?.entry || null,
    dshVersion: resolved ? readVersion(resolved, config) : 'not found',
    resolvedFrom: resolved?.source || null,
    fallbackCommand: resolved ? null : config.dshBin,
    node: process.version,
    nodeExecPath: process.execPath,
    dshHome: buildEnv(config).DSH_HOME,
    profile: config.profile,
    credentialsFile: fs.existsSync(path.join(buildEnv(config).DSH_HOME || '', '.credentials.yaml')),
    apiKeyInEnv: Boolean(process.env.DEEPSEEK_API_KEY),
    _resolved: resolved,
  };
}
