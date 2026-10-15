import path from 'node:path';
import os from 'node:os';

const DEFAULTS = {
  host: '127.0.0.1',
  port: 7317,
  profile: 'headless',
  timeoutMs: 300_000,
  maxTimeoutMs: 1_800_000,
  maxOutputBytes: 65_536,
  path: '/mcp',
};

function splitList(value) {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

export function parseArgs(argv) {
  const mode = argv.includes('--stdio') ? 'stdio' : argv.includes('--http') ? 'http' : null;
  return {
    mode,
    port: flagValue(argv, '--port'),
    host: flagValue(argv, '--host'),
    token: flagValue(argv, '--token'),
    noAuth: argv.includes('--no-auth'),
    roots: argv.filter((a, i) => argv[i - 1] === '--root'),
  };
}

export function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  const roots = [...splitList(process.env.CHAT2DSH_ROOTS), ...(args.roots || [])].map((r) =>
    path.resolve(r),
  );

  const config = {
    mode: args.mode || 'stdio',
    host: typeof args.host === 'string' ? args.host : process.env.CHAT2DSH_HOST || DEFAULTS.host,
    port: Number(
      (typeof args.port === 'string' ? args.port : process.env.CHAT2DSH_PORT) || DEFAULTS.port,
    ),
    path: process.env.CHAT2DSH_PATH || DEFAULTS.path,
    token: (typeof args.token === 'string' ? args.token : process.env.CHAT2DSH_TOKEN) || '',
    noAuth: Boolean(args.noAuth) || process.env.CHAT2DSH_NO_AUTH === '1',
    roots,
    profile: process.env.CHAT2DSH_DSH_PROFILE || DEFAULTS.profile,
    dshEntry: process.env.CHAT2DSH_DSH_ENTRY || '',
    dshBin: process.env.CHAT2DSH_DSH_BIN || 'dsh',
    timeoutMs: Number(process.env.CHAT2DSH_TIMEOUT_MS || DEFAULTS.timeoutMs),
    maxTimeoutMs: DEFAULTS.maxTimeoutMs,
    maxOutputBytes: Number(process.env.CHAT2DSH_MAX_OUTPUT || DEFAULTS.maxOutputBytes),
    env: {
      DSH_HOME: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
      DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL || '',
    },
  };

  return config;
}

export function resolveCwd(requested, roots) {
  if (!roots.length) {
    throw new Error(
      'No workspace root configured. Set CHAT2DSH_ROOTS or pass --root <dir>. Refusing to run dsh anywhere.',
    );
  }
  const target = requested ? path.resolve(requested) : roots[0];
  const ok = roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
  if (!ok) {
    throw new Error(
      `cwd "${target}" is outside the allowed roots: ${roots.join(', ')}. Add it with --root or CHAT2DSH_ROOTS.`,
    );
  }
  return target;
}
