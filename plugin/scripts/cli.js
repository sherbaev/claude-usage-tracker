#!/usr/bin/env node
// usage-tracker — Claude 5h/weekly plan usage per device, synced to a self-hosted tracker server.
//   status                    show account windows + every device (default)
//   push [--throttle SEC]     report this device, print nothing on success
//   hook                      for SessionStart/Stop hooks: throttled push, never fails
//   guard                     for the UserPromptSubmit hook: exit 2 (block) when this device is over a
//                             cap set to "block" on the website
//   setup --server URL --token TOKEN [--device NAME]
//   register --server URL [--code CODE]
//   config                    show effective config (token redacted)
// Flags: --json, --no-sync, --no-color
import { parseArgs } from 'node:util';
import { isValidDeviceName, localWindowTotals } from './core.js';
import {
  CONFIG_PATH,
  defaultDevice,
  loadConfig,
  normalizeServerUrl,
  pluginOptionConfig,
  readState,
  saveConfig,
  updateState,
} from './config.js';
import { activeViolations, deviceStatus, NO_LIMITS } from './limits.js';
import { renderPanel } from './render.js';
import { fetchAccountUsage, fetchLocalBlocks, getAccessToken } from './sources.js';
import { fetchMe, fetchSummary, pushReport, registerAccount } from './sync.js';

const HOOK_THROTTLE_SEC = 300;
// A blocked device sends no Stop hooks, so the guard re-checks a stale verdict with the server
// itself; raising the cap on the website then unblocks within this many seconds.
const GUARD_REFRESH_SEC = 60;
// When Anthropic's usage endpoint is briefly unavailable (e.g. HTTP 429), reuse the last snapshot.
const ACCOUNT_FALLBACK_SEC = 15 * 60;
const BLOCK_EXIT_CODE = 2;

const out = (text) => process.stdout.write(`${text}\n`);
const redact = (token) => (token ? `${token.slice(0, 8)}…${token.slice(-4)}` : null);
const secondsSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 1000 : Infinity);

async function fetchAccountWithFallback() {
  try {
    const account = await fetchAccountUsage(await getAccessToken());
    await updateState({ account, accountFetchedAt: new Date().toISOString() });
    return account;
  } catch (error) {
    const { account, accountFetchedAt } = await readState();
    if (account && secondsSince(accountFetchedAt) < ACCOUNT_FALLBACK_SEC) return account;
    throw error;
  }
}

async function collectReport(device) {
  const [account, blocks] = await Promise.all([fetchAccountWithFallback(), fetchLocalBlocks()]);
  return { device, reportedAt: new Date().toISOString(), account, local: localWindowTotals(blocks, account) };
}

async function sendReport(config, report) {
  const status = await pushReport(config, report);
  await updateState({ lastPushAt: report.reportedAt, status, statusCheckedAt: new Date().toISOString() });
}

/** Re-reads this device's cap status from the server without a new report (no Anthropic call). */
async function refreshStatus(config) {
  const summary = await fetchSummary(config);
  const limits = summary.devices.find((d) => d.name === config.device)?.limits ?? NO_LIMITS;
  return updateState({ status: deviceStatus(summary, config.device, limits), statusCheckedAt: new Date().toISOString() });
}

async function syncAndSummarize(config, report) {
  if (!config.serverUrl) return { summary: null, syncError: null };
  try {
    await sendReport(config, report);
    return { summary: await fetchSummary(config), syncError: null };
  } catch (error) {
    return { summary: null, syncError: error.message };
  }
}

async function status(opts) {
  const config = await loadConfig();
  const report = await collectReport(config.device);
  const sync = opts['no-sync'] ? { summary: null, syncError: null } : await syncAndSummarize(config, report);
  if (opts.json) return out(JSON.stringify({ ...report, ...sync }, null, 2));
  const color = !opts['no-color'] && process.stdout.isTTY && !process.env.NO_COLOR;
  process.stdout.write(renderPanel({ ...report, ...sync, serverUrl: config.serverUrl }, { color }));
}

async function push(opts) {
  const config = await loadConfig();
  if (!config.serverUrl) throw new Error('not connected to a tracker server — run /usage-tracker:setup');
  const { lastPushAt } = await readState();
  if (secondsSince(lastPushAt) < Number(opts.throttle ?? 0)) return;
  await sendReport(config, await collectReport(config.device));
}

async function persistPluginOptions() {
  const fromOptions = pluginOptionConfig();
  if (!fromOptions) return;
  const current = await loadConfig({});
  const changed = ['serverUrl', 'token', 'device'].some((k) => current[k] !== fromOptions[k]);
  if (changed) await saveConfig(fromOptions);
}

async function hook() {
  try {
    await persistPluginOptions();
    const config = await loadConfig();
    if (config.serverUrl) await push({ throttle: HOOK_THROTTLE_SEC });
  } catch (error) {
    process.stderr.write(`usage-tracker: ${error.message}\n`);
  }
}

const blockingViolations = (state) => (state.status?.enforce ? activeViolations(state.status) : []);

function describe(violation) {
  const resets = new Date(violation.resetsAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return `${violation.window}: ≈${violation.sharePct.toFixed(1)}% used, cap ${violation.limitPct}% (resets ${resets})`;
}

async function guard() {
  try {
    let state = await readState();
    if (blockingViolations(state).length && secondsSince(state.statusCheckedAt) > GUARD_REFRESH_SEC) {
      const config = await loadConfig();
      // Keep the cached verdict when the server is unreachable.
      if (config.serverUrl) state = await refreshStatus(config).catch(() => state);
    }
    const violations = blockingViolations(state);
    if (!violations.length) return;
    process.stderr.write(
      `Usage cap reached on this device — ${violations.map(describe).join('; ')}. ` +
        'Raise or remove the cap for this device on your tracker website to continue.\n',
    );
    process.exitCode = BLOCK_EXIT_CODE;
  } catch (error) {
    process.stderr.write(`usage-tracker guard: ${error.message}\n`); // fail open
  }
}

async function setup(opts) {
  if (!opts.server || !opts.token) throw new Error('usage: setup --server URL --token TOKEN [--device NAME]');
  const device = opts.device ?? defaultDevice();
  if (!isValidDeviceName(device)) throw new Error('device name must be 1-64 chars of letters, digits, space, _ . -');
  const config = { serverUrl: normalizeServerUrl(opts.server), token: opts.token.trim(), device };
  const me = await fetchMe(config);
  const existing = me.devices.find((d) => d.name === device);
  await saveConfig(config);
  out(`Connected "${device}" to ${config.serverUrl} (config: ${CONFIG_PATH}).`);
  if (existing) out(`Note: a device named "${device}" already reported (${existing.reportedAt}); this device now shares that name.`);
  const others = me.devices.filter((d) => d.name !== device).map((d) => d.name);
  out(others.length ? `Other devices on this account: ${others.join(', ')}` : 'This is the first device on this account.');
  await push({});
  out('First usage report sent.');
}

async function register(opts) {
  if (!opts.server) throw new Error('usage: register --server URL [--code CODE]');
  out(await registerAccount(normalizeServerUrl(opts.server), opts.code));
}

async function showConfig() {
  const config = await loadConfig();
  out(JSON.stringify({ ...config, token: redact(config.token), configFile: CONFIG_PATH }, null, 2));
}

const COMMANDS = { status, push, hook, guard, setup, register, config: showConfig };

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      'no-sync': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      throttle: { type: 'string' },
      server: { type: 'string' },
      token: { type: 'string' },
      device: { type: 'string' },
      code: { type: 'string' },
    },
  });
  const name = positionals[0] ?? 'status';
  const command = COMMANDS[name];
  if (!command) throw new Error(`unknown command "${name}" (${Object.keys(COMMANDS).join(', ')})`);
  await command(values);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`usage-tracker: ${error.message}\n`);
  process.exit(1);
});
