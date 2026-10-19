// Which usage alerts to send. Pure: the caller stores `state` (last level sent per key and window)
// so each alert goes out once per level per window. Device cap alerts only go out for devices the
// user subscribed to (`settings.devices`).
import { isValidDeviceName } from '../../../plugin/scripts/core.js';

const SAME_WINDOW_MS = 2 * 60 * 1000; // Anthropic's reset times jitter by milliseconds
const LEVEL_RANK = Object.freeze({ near: 1, hit: 2 });
const MIN_NEAR_PCT = 1;
const MAX_NEAR_PCT = 99;
const MAX_SUBSCRIBED_DEVICES = 50;
const TOGGLES = ['enabled', 'near', 'hit', 'agents'];

export const DEFAULT_ALERTS = Object.freeze({ enabled: true, nearPct: 80, near: true, hit: true, agents: true, devices: Object.freeze([]) });

/** Stored settings → current shape (settings saved before per-device alerts had `caps` and no `devices`). */
export function normalizeAlertSettings(stored) {
  if (stored == null || typeof stored !== 'object') return DEFAULT_ALERTS;
  const pick = (key) => (typeof stored[key] === typeof DEFAULT_ALERTS[key] ? stored[key] : DEFAULT_ALERTS[key]);
  const devices = Array.isArray(stored.devices) ? stored.devices.filter(isValidDeviceName) : [];
  return { enabled: pick('enabled'), nearPct: pick('nearPct'), near: pick('near'), hit: pick('hit'), agents: pick('agents'), devices };
}

/** Validates alert settings from the website (server boundary). */
export function validateAlertSettings(body) {
  if (body == null || typeof body !== 'object') throw new Error('body must be an object');
  for (const key of TOGGLES) {
    if (typeof body[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  }
  const { nearPct } = body;
  if (!Number.isFinite(nearPct) || nearPct < MIN_NEAR_PCT || nearPct > MAX_NEAR_PCT) {
    throw new Error(`nearPct must be a number between ${MIN_NEAR_PCT} and ${MAX_NEAR_PCT}`);
  }
  const { devices } = body;
  if (!Array.isArray(devices) || devices.length > MAX_SUBSCRIBED_DEVICES || !devices.every(isValidDeviceName)) {
    throw new Error(`devices must be a list of up to ${MAX_SUBSCRIBED_DEVICES} device names`);
  }
  return { enabled: body.enabled, nearPct, near: body.near, hit: body.hit, agents: body.agents, devices: [...new Set(devices)] };
}

const planCandidates = (account) =>
  Object.entries(account ?? {})
    .filter(([, w]) => w)
    .map(([window, w]) => ({ key: `claude:${window}`, kind: 'plan', source: 'Claude', window, pct: w.pct, limitPct: 100, resetsAt: w.resetsAt }));

function capCandidates(summary) {
  const enforce = Object.fromEntries((summary.devices ?? []).map((d) => [d.name, d.limits?.enforce === true]));
  return Object.entries(summary.windows ?? {}).flatMap(([window, rows]) =>
    rows
      .filter((r) => r.limitPct != null && summary.account?.[window])
      .map((r) => ({
        key: `cap:${r.device}:${window}`,
        kind: 'cap',
        source: 'Claude',
        device: r.device,
        window,
        pct: r.sharePct,
        limitPct: r.limitPct,
        resetsAt: summary.account[window].resetsAt,
        enforce: enforce[r.device] ?? false,
      })),
  );
}

const agentCandidates = (agents) =>
  (agents ?? []).flatMap((a) =>
    Object.entries(a.plan ?? {})
      .filter(([, w]) => w)
      .map(([window, w]) => ({ key: `${a.id}:${window}`, kind: 'agent', source: a.label, window, pct: w.pct, limitPct: 100, resetsAt: w.resetsAt })),
  );

/** Everything in a summary that can run into a limit. */
export const alertCandidates = (summary) => [...planCandidates(summary.account), ...capCandidates(summary), ...agentCandidates(summary.agents)];

const levelOf = (c, nearPct) => (c.pct >= c.limitPct ? 'hit' : c.pct >= (c.limitPct * nearPct) / 100 ? 'near' : null);
const isSameWindow = (a, b) => Math.abs(Date.parse(a) - Date.parse(b)) <= SAME_WINDOW_MS;

function isWanted(c, level, settings) {
  if (!level || !settings[level]) return false;
  if (c.kind === 'cap') return settings.devices.includes(c.device);
  if (c.kind === 'agent') return settings.agents;
  return true;
}

/** @returns {{ alerts: object[], state: Record<string, { level: string, resetsAt: string }> }} */
export function evaluateAlerts(candidates, settings, state) {
  if (!settings.enabled) return { alerts: [], state };
  return candidates.reduce(
    (acc, c) => {
      const level = levelOf(c, settings.nearPct);
      if (!isWanted(c, level, settings)) return acc;
      const prev = acc.state[c.key];
      if (prev && isSameWindow(prev.resetsAt, c.resetsAt) && LEVEL_RANK[prev.level] >= LEVEL_RANK[level]) return acc;
      return { alerts: [...acc.alerts, { ...c, level }], state: { ...acc.state, [c.key]: { level, resetsAt: c.resetsAt } } };
    },
    { alerts: [], state },
  );
}
