// Usage from other coding agents (Codex, Gemini CLI, OpenCode, … — whatever ccusage detects). Pure:
// validates the per-agent part of a device report and merges it across devices for the summary.
import { cleanModels, rowLabel } from './model-rows.js';

export const AGENT_LABELS = Object.freeze({
  amp: 'Amp',
  antigravity: 'Antigravity',
  codebuff: 'Codebuff',
  codex: 'Codex',
  copilot: 'GitHub Copilot CLI',
  droid: 'Droid',
  gemini: 'Gemini CLI',
  goose: 'Goose',
  grok: 'Grok Build',
  hermes: 'Hermes',
  kilo: 'Kilo Code',
  kimi: 'Kimi',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  pi: 'pi',
  qwen: 'Qwen Code',
  zcode: 'ZCode',
});
export const AGENT_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CLAUDE = 'claude'; // reported through the plan windows, not here
const MAX_AGENTS = 24;
const MAX_PCT = 1000;
const MAX_COST_USD = 1e7;
const MAX_TOKENS = 1e13;
const PLAN_WINDOWS = ['fiveHour', 'sevenDay'];

const inRange = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const isoOrNull = (value) => (typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null);

export const agentLabel = (id) => AGENT_LABELS[id] ?? id;

const cleanTotals = (t) =>
  t && inRange(t.costUSD, MAX_COST_USD) && inRange(t.tokens, MAX_TOKENS) ? { costUSD: t.costUSD, tokens: t.tokens } : null;

function cleanPlanWindow(w) {
  const resetsAt = isoOrNull(w?.resetsAt);
  return w && inRange(w.pct, MAX_PCT) && resetsAt ? { pct: w.pct, resetsAt } : null;
}

function cleanPlan(plan) {
  if (plan == null || typeof plan !== 'object') return null;
  const clean = Object.fromEntries(PLAN_WINDOWS.map((k) => [k, cleanPlanWindow(plan[k])]));
  return PLAN_WINDOWS.some((k) => clean[k]) ? clean : null;
}

function cleanAgent(agent) {
  const week = cleanTotals(agent?.week);
  if (!week) return null;
  return {
    today: cleanTotals(agent.today) ?? { costUSD: 0, tokens: 0 },
    week,
    models: cleanModels(agent.models),
    plan: cleanPlan(agent.plan),
    planObservedAt: isoOrNull(agent.planObservedAt),
  };
}

/** Validates the `agents` part of a device report (server boundary). Returns clean copies. */
export function cleanAgents(agents) {
  if (agents == null || typeof agents !== 'object' || Array.isArray(agents)) return {};
  return Object.fromEntries(
    Object.entries(agents)
      .filter(([id]) => AGENT_RE.test(id) && id !== CLAUDE)
      .map(([id, agent]) => [id, cleanAgent(agent)])
      .filter(([, agent]) => agent)
      .slice(0, MAX_AGENTS),
  );
}

/** A plan snapshot without the windows that already reset. */
function currentPlan(plan, now) {
  if (!plan) return null;
  const live = Object.fromEntries(PLAN_WINDOWS.map((k) => [k, plan[k] && Date.parse(plan[k].resetsAt) > now ? plan[k] : null]));
  return PLAN_WINDOWS.some((k) => live[k]) ? live : null;
}

function summarizeAgent(id, reports, now) {
  const withAgent = reports.filter((r) => r.agents?.[id]);
  const devices = withAgent
    .map((r) => {
      const a = r.agents[id];
      return { device: r.device, reportedAt: r.reportedAt, today: a.today, week: a.week, models: a.models.map((m) => ({ ...m, label: rowLabel(m) })) };
    })
    .sort((a, b) => b.week.costUSD - a.week.costUSD);
  // The plan % is account-wide: take the freshest snapshot any device saw.
  const freshest = withAgent
    .filter((r) => r.agents[id].plan && r.agents[id].planObservedAt)
    .sort((a, b) => Date.parse(b.agents[id].planObservedAt) - Date.parse(a.agents[id].planObservedAt))[0];
  const plan = currentPlan(freshest?.agents[id].plan, now);
  return { id, label: agentLabel(id), plan, planObservedAt: plan ? freshest.agents[id].planObservedAt : null, devices };
}

/** Per-agent view across an account's devices, biggest weekly cost first. */
export function summarizeAgentReports(reports, now = Date.now()) {
  const ids = [...new Set(reports.flatMap((r) => Object.keys(r.agents ?? {})))];
  const weekCost = (agent) => agent.devices.reduce((sum, d) => sum + d.week.costUSD, 0);
  return ids.map((id) => summarizeAgent(id, reports, now)).sort((a, b) => weekCost(b) - weekCost(a));
}
