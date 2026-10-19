// Per-model usage rows (model · effort · speed) inside a window. Pure and dependency-free: the client
// builds the rows, the server validates them and splits the device's plan % across them.

export const MAX_MODEL_ROWS = 8;
export const OTHER_MODEL = 'other';
// The top rows plus one folded "other" row.
const MAX_ROWS_ACCEPTED = MAX_MODEL_ROWS + 1;
const MODEL_RE = /^[A-Za-z0-9][\w.:-]{0,63}$/;
const TAG_RE = /^[a-z]{1,16}$/;
const MAX_COST_USD = 1e7;
const MAX_TOKENS = 1e13;

const inRange = (value, max) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
const tagOrNull = (value) => (typeof value === 'string' && TAG_RE.test(value) ? value : null);

/** "claude-opus-5-5" → "Opus 5.5". Ids in another format are returned unchanged. */
export function modelLabel(model) {
  if (model === OTHER_MODEL) return 'Other';
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!match) return model;
  const [, family, major, minor] = match;
  return `${family[0].toUpperCase()}${family.slice(1)} ${minor ? `${major}.${minor}` : major}`;
}

/** "Opus 5.5 · high · fast" */
export const rowLabel = (row) => [modelLabel(row.model), row.effort, row.speed].filter(Boolean).join(' · ');

const isValidRow = (row) =>
  row != null && typeof row.model === 'string' && MODEL_RE.test(row.model) && inRange(row.costUSD, MAX_COST_USD) && inRange(row.tokens, MAX_TOKENS);

/** Validates the model rows of a device report (server boundary). Returns clean copies. */
export function cleanModels(models) {
  if (!Array.isArray(models)) return [];
  return models
    .filter(isValidRow)
    .slice(0, MAX_ROWS_ACCEPTED)
    .map(({ model, effort, speed, costUSD, tokens }) => ({ model, effort: tagOrNull(effort), speed: tagOrNull(speed), costUSD, tokens }));
}

/** Splits a device's share of the plan across its model rows, proportionally to cost. */
export function modelShares(models = [], sharePct) {
  const totalCost = models.reduce((sum, m) => sum + m.costUSD, 0);
  return models.map((m) => ({ ...m, label: rowLabel(m), sharePct: totalCost > 0 ? (sharePct * m.costUSD) / totalCost : 0 }));
}
