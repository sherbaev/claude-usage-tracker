#!/usr/bin/env node
// usage-tracker — Claude 5h/weekly plan usage per device, synced to a self-hosted tracker server.
//   status                    show account windows + every device (default)
//   push [--throttle SEC]     report this device, print nothing on success
//   hook                      for SessionStart/Stop hooks: throttled push, never fails
//   guard                     for the UserPromptSubmit hook: exit 2 (block) when this device is over a
//                             cap set to "block" on the website
//   background on|off|status  report every 5 minutes even when Claude Code is closed (macOS LaunchAgent;
//                             elsewhere prints a crontab line), so Claude Desktop / claude.ai usage is seen
//   setup --server URL --token TOKEN [--device NAME]
//   register --server URL [--code CODE]
//   config                    show effective config (token redacted)
// Flags: --json, --no-sync, --no-color
import { fileURLToPath } from 'node:url';
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
import { backgroundStatus, cronLine, disableBackground, enableBackground, refreshBackground } from './background.js';
import { activeViolations, deviceStatus, NO_LIMITS } from './limits.js';
import { attachCodexPlan, claudeDaily, summarizeAgents } from './agents.js';
import { readCodexSnapshot } from './codex.js';
import { attachModels, summarizeModels, unitPrices } from './models.js';
import { renderPanel } from './render.js';
import { surfaceActivity } from './surfaces.js';
import { fetchAccountUsage, fetchAgentDaily, fetchLocalBlocks, getAccessToken, NO_CLAUDE_LOGIN } from './sources.js';
import { fetchMe, fetchSummary, pushReport, registerAccount } from './sync.js';
import { readUsageEntries } from './transcripts.js';

const HOOK_THROTTLE_SEC = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
// Covers the weekly window (7 days) whatever its reset time.
const BREAKDOWN_LOOKBACK_MS = 8 * DAY_MS;
const AGENT_WEEK_DAYS = 7;
const NO_ACCOUNT = Object.freeze({ fiveHour: null, sevenDay: null });
// A blocked device sends no Stop hooks, so the guard re-checks a stale verdict with the server
// itself; raising the cap on the website then unblocks within this many seconds.
const GUARD_REFRESH_SEC = 60;
// When Anthropic's usage endpoint is briefly unavailable (e.g. HTTP 429), reuse the last snapshot.
const ACCOUNT_FALLBACK_SEC = 15 * 60;
const BLOCK_EXIT_CODE = 2;
const IS_MAC = process.platform === 'darwin';
// What the background job runs: this node and this copy of the plugin, with the hooks' state directory.
const SELF = Object.freeze({ node: process.execPath, cli: fileURLToPath(import.meta.url), pluginData: process.env.CLAUDE_PLUGIN_DATA });

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

/** Extra detail (model breakdown, other agents): report without it rather than not at all. */
async function optional(what, load) {
  try {
    return await load();
  } catch (error) {
    process.stderr.write(`usage-tracker: ${what} unavailable — ${error.message}\n`);
    return null;
  }
}

/** Claude plan windows, or empty windows on a device that only uses other agents. */
async function fetchClaudeAccount() {
  try {
    return await fetchAccountWithFallback();
  } catch (error) {
    if (error.code === NO_CLAUDE_LOGIN) return NO_ACCOUNT;
    throw error;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');
// ccusage groups days in the system time zone.
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const agentDays = (now) => ({ today: localDate(now), weekStart: localDate(new Date(now.getTime() - (AGENT_WEEK_DAYS - 1) * DAY_MS)) });

async function collectReport(device) {
  const now = new Date();
  const sinceMs = now.getTime() - BREAKDOWN_LOOKBACK_MS;
  const [account, blocksOrError, daily, entries, codexSnapshot, surfaces] = await Promise.all([
    fetchClaudeAccount(),
    fetchLocalBlocks().catch((error) => error),
    optional('per-agent usage', () => fetchAgentDaily({ now })),
    optional('model breakdown', () => readUsageEntries({ sinceMs })),
    optional('Codex plan usage', () => readCodexSnapshot({ sinceMs })),
    optional('Claude Desktop / claude.ai activity', () => surfaceActivity()),
  ]);
  // Without a Claude login there is no Claude data, and ccusage's Claude commands fail: skip them.
  if (blocksOrError instanceof Error && account !== NO_ACCOUNT) throw blocksOrError;
  const blocks = account === NO_ACCOUNT || blocksOrError instanceof Error ? [] : blocksOrError;
  const prices = unitPrices(claudeDaily(daily));
  const models = entries && daily ? summarizeModels(entries, prices, account) : {};
  const agents = attachCodexPlan(daily ? summarizeAgents(daily, agentDays(now)) : {}, codexSnapshot);
  return { device, reportedAt: now.toISOString(), account, local: attachModels(localWindowTotals(blocks, account), models), agents, surfaces };
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
    if (IS_MAC) await refreshBackground(SELF);
  } catch (error) {
    process.stderr.write(`usage-tracker: ${error.message}\n`);
  }
}

async function background(_opts, action = 'status') {
  if (!['on', 'off', 'status'].includes(action)) throw new Error('usage: background on|off|status');
  if (!IS_MAC) {
    out('Background reporting is built in on macOS only. On this system add this line with `crontab -e`:');
    return out(cronLine(SELF));
  }
  if (action === 'on') {
    if (!(await loadConfig()).serverUrl) throw new Error('not connected to a tracker server — run /usage-tracker:setup first');
    await enableBackground(SELF);
    return out('Background reporting is on: this Mac reports every 5 minutes, even when Claude Code is closed.\n' +
      'It uses the Claude login that Claude Code refreshes, so open Claude Code at least once a day.');
  }
  if (action === 'off') return out((await disableBackground()) ? 'Background reporting is off.' : 'Background reporting was not on.');
  const status = await backgroundStatus();
  out(status.installed ? `Background reporting is on (every 5 minutes, ${status.cli}).` : 'Background reporting is off. Turn it on with: background on');
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

const COMMANDS = { status, push, hook, guard, background, setup, register, config: showConfig };

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
  await command(values, positionals[1]);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`usage-tracker: ${error.message}\n`);
  process.exit(1);
});
