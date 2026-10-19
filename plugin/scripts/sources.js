// Data sources: Claude Code OAuth token, Anthropic usage endpoint, local ccusage blocks.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseAccountUsage } from './core.js';
import { unitPrices } from './models.js';

const execFileAsync = promisify(execFile);

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const HTTP_TIMEOUT_MS = 8000;
// Weekly window is 7 days; look back 8 so timezone-based date filtering never cuts it.
const LOOKBACK_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

function extractAccessToken(raw, origin) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Claude credentials in ${origin} are not valid JSON`);
  }
  const oauth = parsed?.claudeAiOauth;
  if (!oauth?.accessToken) throw new Error(`No claudeAiOauth.accessToken in ${origin}`);
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) {
    throw new Error('Claude Code OAuth token expired — run `claude` once to refresh it');
  }
  return oauth.accessToken;
}

async function readKeychainCredentials() {
  const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
  return stdout.trim();
}

/** Finds the Claude Code OAuth token: env → macOS Keychain → ~/.claude/.credentials.json. */
export async function getAccessToken() {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (process.platform === 'darwin') {
    try {
      return extractAccessToken(await readKeychainCredentials(), 'macOS Keychain');
    } catch (error) {
      if (/expired/.test(error.message)) throw error;
      // fall through to the credentials file
    }
  }
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  try {
    return extractAccessToken(await readFile(file, 'utf8'), file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Claude Code credentials not found — log in with `claude` (subscription login) first');
    }
    throw error;
  }
}

/** Account-wide 5h/weekly utilization as shown by Claude Code's /usage. */
export async function fetchAccountUsage(token) {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (res.status === 401) throw new Error('Anthropic rejected the OAuth token (401) — run `claude` to refresh login');
  if (!res.ok) throw new Error(`Anthropic usage endpoint returned HTTP ${res.status}`);
  return parseAccountUsage(await res.json());
}

const yyyymmdd = (date) => date.toISOString().slice(0, 10).replaceAll('-', '');

// `ccusage claude blocks` exists since ccusage v20; older global installs fall through to npx.
// Pinned exactly, and run from the home directory so a project-local node_modules/.bin can't hijack it.
const NPX_CCUSAGE = ['npx', ['-y', 'ccusage@20.0.36']];
const EXEC_OPTIONS = { maxBuffer: 64 * 1024 * 1024, cwd: homedir() };

async function runCcusage(args) {
  const custom = process.env.USAGE_TRACKER_CCUSAGE_BIN;
  const candidates = custom ? [[custom, []]] : [['ccusage', []], NPX_CCUSAGE];
  const failures = [];
  for (const [bin, prefix] of candidates) {
    try {
      return (await execFileAsync(bin, [...prefix, ...args], EXEC_OPTIONS)).stdout;
    } catch (error) {
      failures.push(`${bin}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`Failed to run ccusage (install it: npm i -g ccusage) — ${failures.join('; ')}`);
}

/** $ per weighted token for each model, derived from ccusage's per-model daily costs. */
export async function fetchModelPrices({ now = new Date() } = {}) {
  const since = yyyymmdd(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const stdout = await runCcusage(['claude', 'daily', '--breakdown', '--json', '--since', since]);
  const daily = JSON.parse(stdout)?.daily;
  if (!Array.isArray(daily)) throw new Error('Unexpected ccusage daily JSON (no "daily" array)');
  return unitPrices(daily);
}

/** Hour-granular local usage blocks from ccusage (priced by ccusage itself). */
export async function fetchLocalBlocks({ now = new Date() } = {}) {
  const since = yyyymmdd(new Date(now.getTime() - LOOKBACK_DAYS * DAY_MS));
  const stdout = await runCcusage(['claude', 'blocks', '--session-length', '1', '--json', '--since', since]);
  const blocks = JSON.parse(stdout)?.blocks;
  if (!Array.isArray(blocks)) throw new Error('Unexpected ccusage blocks JSON (no "blocks" array)');
  return blocks;
}
