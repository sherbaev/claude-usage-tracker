// Client config. Precedence: plugin options (CLAUDE_PLUGIN_OPTION_*, set via /plugin configure)
// → USAGE_TRACKER_* env → ~/.config/claude-usage-tracker/config.json (written by `setup`).
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'claude-usage-tracker');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
export const STATE_PATH = join(process.env.CLAUDE_PLUGIN_DATA ?? CONFIG_DIR, 'state.json');

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Cannot read ${path}: ${error.message}`);
  }
}

export const defaultDevice = () => hostname().replace(/\.local$/, '').replace(/[^\w.\- ]/g, '-').slice(0, 64);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Requires https (the bearer token must not travel in cleartext), except for local testing. */
export function normalizeServerUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid server URL "${url}"`);
  }
  const isLocal = LOCAL_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    throw new Error(`server URL must use https:// (got "${url}")`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

/** @returns {Promise<{ serverUrl: string|null, token: string|null, device: string }>} */
export async function loadConfig(env = process.env, path = CONFIG_PATH) {
  const file = await readJson(path);
  const pick = (optionKey, envKey, fileKey) =>
    nonEmpty(env[`CLAUDE_PLUGIN_OPTION_${optionKey}`]) ?? nonEmpty(env[envKey]) ?? nonEmpty(file[fileKey]) ?? null;
  const serverUrl = pick('SERVER_URL', 'USAGE_TRACKER_SERVER_URL', 'serverUrl');
  const token = pick('TOKEN', 'USAGE_TRACKER_TOKEN', 'token');
  const device = pick('DEVICE_NAME', 'USAGE_TRACKER_DEVICE', 'device') ?? defaultDevice();
  if (serverUrl && !token) throw new Error('server URL is set but token is missing — run /usage-tracker:setup');
  return { serverUrl: serverUrl ? normalizeServerUrl(serverUrl) : null, token, device };
}

/**
 * Plugin options are only exported to hook processes, so hooks persist them to the
 * config file for slash commands. Returns null when the options are not set.
 */
export function pluginOptionConfig(env = process.env) {
  const serverUrl = nonEmpty(env.CLAUDE_PLUGIN_OPTION_SERVER_URL);
  const token = nonEmpty(env.CLAUDE_PLUGIN_OPTION_TOKEN);
  if (!serverUrl || !token) return null;
  return {
    serverUrl: normalizeServerUrl(serverUrl),
    token,
    device: nonEmpty(env.CLAUDE_PLUGIN_OPTION_DEVICE_NAME) ?? defaultDevice(),
  };
}

/** Writes the config file readable only by the current user. */
export async function saveConfig(config, path = CONFIG_PATH) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

export const readState = (path = STATE_PATH) => readJson(path);

/** Merges `patch` into the state file (returns the new state; never mutates its inputs). */
export async function updateState(patch, path = STATE_PATH) {
  const next = { ...(await readState(path)), ...patch };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(next));
  return next;
}
