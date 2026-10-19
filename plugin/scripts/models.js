// Model · effort · speed breakdown of this device's usage, built from Claude Code transcript lines. Pure.
// Cost uses a per-model rate derived from ccusage's own per-model daily costs, so no price table lives here.
import { WINDOWS } from './core.js';
import { MAX_MODEL_ROWS, OTHER_MODEL } from './model-rows.js';

// Token prices relative to input tokens, the same within every Claude model.
const TOKEN_WEIGHTS = Object.freeze({ input: 1, output: 5, cacheCreate: 1.25, cacheRead: 0.1 });
const SYNTHETIC_MODEL = '<synthetic>';
const STANDARD_SPEED = 'standard';

const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0);
const sumOf = (rows, field) => rows.reduce((sum, row) => sum + row[field], 0);
const totalTokens = (t) => t.input + t.output + t.cacheCreate + t.cacheRead;

/** @param {{ input?: number, output?: number, cacheCreate?: number, cacheRead?: number }} tokens */
export const weightedUnits = (tokens) =>
  Object.entries(TOKEN_WEIGHTS).reduce((sum, [kind, weight]) => sum + weight * count(tokens[kind]), 0);

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** One transcript line → a usage entry, or null when it is not an assistant message with usage. */
export function parseTranscriptLine(line) {
  // Cheap pre-filter: most lines are user messages and tool results.
  if (!line.includes('"assistant"') || !line.includes('"usage"')) return null;
  const record = parseJson(line);
  const message = record?.message;
  const usage = message?.usage;
  if (record?.type !== 'assistant' || !usage || typeof message.model !== 'string' || message.model === SYNTHETIC_MODEL) return null;
  const timestampMs = Date.parse(record.timestamp);
  if (Number.isNaN(timestampMs)) return null;
  return {
    key: message.id ? `${message.id}:${record.requestId}` : null,
    timestampMs,
    model: message.model,
    effort: typeof record.effort === 'string' ? record.effort : null,
    speed: typeof usage.speed === 'string' && usage.speed !== STANDARD_SPEED ? usage.speed : null,
    tokens: {
      input: count(usage.input_tokens),
      output: count(usage.output_tokens),
      cacheCreate: count(usage.cache_creation_input_tokens),
      cacheRead: count(usage.cache_read_input_tokens),
    },
  };
}

/** $ per weighted token for each model, from `ccusage daily --breakdown --json` days. */
export function unitPrices(daily) {
  const totals = (daily ?? [])
    .flatMap((day) => day.modelBreakdowns ?? [])
    .reduce((acc, b) => {
      const prev = acc[b.modelName] ?? { cost: 0, units: 0 };
      const units = weightedUnits({ input: b.inputTokens, output: b.outputTokens, cacheCreate: b.cacheCreationTokens, cacheRead: b.cacheReadTokens });
      return { ...acc, [b.modelName]: { cost: prev.cost + count(b.cost), units: prev.units + units } };
    }, {});
  return Object.fromEntries(
    Object.entries(totals)
      .filter(([, t]) => t.units > 0)
      .map(([model, t]) => [model, t.cost / t.units]),
  );
}

function groupRows(entries, prices) {
  const groups = new Map();
  for (const e of entries) {
    const id = `${e.model}|${e.effort}|${e.speed}`;
    const prev = groups.get(id) ?? { model: e.model, effort: e.effort, speed: e.speed, costUSD: 0, tokens: 0 };
    const costUSD = prev.costUSD + weightedUnits(e.tokens) * (prices[e.model] ?? 0);
    groups.set(id, { ...prev, costUSD, tokens: prev.tokens + totalTokens(e.tokens) });
  }
  return [...groups.values()].sort((a, b) => b.costUSD - a.costUSD || b.tokens - a.tokens);
}

/** Keeps the top rows and folds the rest into one "other" row. Rows must be sorted. */
export function foldTail(rows) {
  if (rows.length <= MAX_MODEL_ROWS + 1) return rows;
  const tail = rows.slice(MAX_MODEL_ROWS);
  const other = { model: OTHER_MODEL, effort: null, speed: null, costUSD: sumOf(tail, 'costUSD'), tokens: sumOf(tail, 'tokens') };
  return [...rows.slice(0, MAX_MODEL_ROWS), other];
}

/** Model rows for every account window, aligned to Anthropic's reset times. */
export function summarizeModels(entries, prices, account) {
  return Object.fromEntries(
    Object.entries(WINDOWS).map(([key, { lengthMs }]) => {
      const win = account[key];
      if (!win) return [key, []];
      const endMs = Date.parse(win.resetsAt);
      const inWindow = entries.filter((e) => e.timestampMs >= endMs - lengthMs && e.timestampMs < endMs);
      return [key, foldTail(groupRows(inWindow, prices))];
    }),
  );
}

/** Adds model rows to the local window totals that exist. */
export const attachModels = (totals, modelsByWindow) =>
  Object.fromEntries(Object.entries(totals).map(([key, t]) => [key, t && { ...t, models: modelsByWindow[key] ?? [] }]));
