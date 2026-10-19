// Other coding agents on this device: usage from `ccusage daily --by-agent`, plus Codex's own plan
// windows (5h / weekly %) from its session files. Pure.
import { foldTail } from './models.js';

const CLAUDE = 'claude'; // Claude has hour-precise plan windows; handled separately
const FIVE_HOUR_MAX_MINUTES = 6 * 60;
const WEEK_MIN_MINUTES = 6 * 24 * 60;
const MS_PER_SECOND = 1000;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const breakdownTokens = (b) => num(b.inputTokens) + num(b.outputTokens) + num(b.cacheCreationTokens) + num(b.cacheReadTokens);
const add = (a, costUSD, tokens) => ({ costUSD: a.costUSD + costUSD, tokens: a.tokens + tokens });
const ZERO = Object.freeze({ costUSD: 0, tokens: 0 });

function addModels(models, breakdowns) {
  return (breakdowns ?? []).reduce((acc, b) => {
    const prev = acc[b.modelName] ?? ZERO;
    return { ...acc, [b.modelName]: add(prev, num(b.cost), breakdownTokens(b)) };
  }, models);
}

const toModelRows = (models) =>
  foldTail(
    Object.entries(models)
      .map(([model, t]) => ({ model, effort: null, speed: null, ...t }))
      .sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens),
  );

/**
 * Today and last-7-days usage per non-Claude agent. `today` / `weekStart` are local YYYY-MM-DD dates,
 * matching ccusage's `period` (it groups by the system time zone).
 */
export function summarizeAgents(daily, { today, weekStart }) {
  const acc = (daily ?? [])
    .filter((day) => day.period >= weekStart)
    .flatMap((day) => (day.agents ?? []).map((a) => ({ ...a, isToday: day.period === today })))
    .filter((a) => a.agent && a.agent !== CLAUDE)
    .reduce((byAgent, a) => {
      const prev = byAgent[a.agent] ?? { today: ZERO, week: ZERO, models: {} };
      const cost = num(a.totalCost);
      const tokens = num(a.totalTokens);
      return {
        ...byAgent,
        [a.agent]: {
          today: a.isToday ? add(prev.today, cost, tokens) : prev.today,
          week: add(prev.week, cost, tokens),
          models: addModels(prev.models, a.modelBreakdowns),
        },
      };
    }, {});
  return Object.fromEntries(
    Object.entries(acc)
      .filter(([, a]) => a.week.costUSD > 0 || a.week.tokens > 0)
      .map(([id, a]) => [id, { today: a.today, week: a.week, models: toModelRows(a.models) }]),
  );
}

/** Claude's per-model daily costs in the shape `unitPrices` expects. */
export const claudeDaily = (daily) =>
  (daily ?? []).map((day) => ({ modelBreakdowns: (day.agents ?? []).find((a) => a.agent === CLAUDE)?.modelBreakdowns ?? [] }));

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function planWindow(raw, observedAtMs) {
  if (!raw || !Number.isFinite(raw.used_percent)) return null;
  const resetsAtMs = Number.isFinite(raw.resets_at)
    ? raw.resets_at * MS_PER_SECOND
    : Number.isFinite(raw.resets_in_seconds)
      ? observedAtMs + raw.resets_in_seconds * MS_PER_SECOND
      : NaN;
  return Number.isNaN(resetsAtMs) ? null : { pct: raw.used_percent, resetsAt: new Date(resetsAtMs).toISOString() };
}

/** A Codex `token_count` event → its plan windows, matched by window length (not primary/secondary). */
export function parseCodexSnapshot(line) {
  if (!line.includes('"rate_limits"')) return null;
  const record = parseJson(line);
  const limits = record?.payload?.rate_limits;
  const observedAtMs = Date.parse(record?.timestamp);
  if (!limits || Number.isNaN(observedAtMs)) return null;
  const windows = [limits.primary, limits.secondary].filter((w) => w && Number.isFinite(w.window_minutes));
  const pick = (test) => planWindow(windows.find((w) => test(w.window_minutes)), observedAtMs);
  const plan = { fiveHour: pick((m) => m <= FIVE_HOUR_MAX_MINUTES), sevenDay: pick((m) => m >= WEEK_MIN_MINUTES) };
  if (!plan.fiveHour && !plan.sevenDay) return null;
  return { observedAt: new Date(observedAtMs).toISOString(), plan };
}

/** Adds the latest Codex plan snapshot to the Codex usage (creating it when Codex had no priced usage). */
export function attachCodexPlan(agents, snapshot) {
  if (!snapshot) return agents;
  const codex = agents.codex ?? { today: ZERO, week: ZERO, models: [] };
  return { ...agents, codex: { ...codex, plan: snapshot.plan, planObservedAt: snapshot.observedAt } };
}
