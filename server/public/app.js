// Website: register, sign in with token, per-device dashboard. No framework, no innerHTML with data.
const TOKEN_KEY = 'cut.token';
const REFRESH_MS = 60_000;
const WINDOW_LABELS = { fiveHour: '5-hour window', sevenDay: 'Weekly window' };
const WARN_PCT = 70;
const CRIT_PCT = 90;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

const storage = {
  get() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: token lives in memory only */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  },
};

let token = storage.get();
let refreshTimer = null;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
  if (!payload.success) throw Object.assign(new Error(payload.error ?? `HTTP ${res.status}`), { status: res.status });
  return payload.data;
}

function show(sectionId) {
  for (const id of ['welcome', 'created', 'dashboard']) $(id).hidden = id !== sectionId;
  $('nav').hidden = sectionId !== 'dashboard';
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

// ---------- formatting ----------
const fmtUsd = (n) => `$${n.toFixed(2)}`;
const fmtPct = (n) => `${n.toFixed(n < 10 ? 1 : 0)}%`;
function fmtTokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${min % 60}m`;
  return `${min}m`;
}
const fmtAgo = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  return ms < 60_000 ? 'just now' : `${fmtDuration(ms)} ago`;
};
const level = (pct) => (pct >= CRIT_PCT ? 'crit' : pct >= WARN_PCT ? 'warn' : 'ok');

function meter(pct, extraClass = '') {
  const fill = el('span', { className: `fill ${level(pct)}` });
  fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  return el('div', { className: `meter ${extraClass}`, role: 'img', ariaLabel: `${fmtPct(pct)} used` }, [fill]);
}

// ---------- install instructions ----------
function installBlock() {
  const node = $('installTemplate').content.cloneNode(true);
  node.querySelector('[data-fill="setup"]').textContent =
    `/usage-tracker:setup ${location.origin} ${token ?? '<your token>'}`;
  return node;
}

// ---------- dashboard ----------
function renderWindows(summary) {
  const cards = Object.entries(WINDOW_LABELS).map(([key, label]) => {
    const win = summary.account?.[key];
    if (!win) return el('div', { className: 'card window' }, [el('h3', { textContent: label }), el('p', { className: 'muted', textContent: 'No data yet' })]);
    // Anthropic reports resets a few ms around the hour; round so 07:59:59.9 shows as 08:00.
    const resets = new Date(Math.round(Date.parse(win.resetsAt) / 60_000) * 60_000);
    return el('div', { className: 'card window' }, [
      el('h3', { textContent: label }),
      el('div', { className: `bigpct ${level(win.pct)}`, textContent: fmtPct(win.pct) }),
      meter(win.pct),
      el('p', {
        className: 'muted small',
        textContent: `Resets in ${fmtDuration(resets - Date.now())} · ${resets.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`,
      }),
    ]);
  });
  $('windows').replaceChildren(...cards);
}

// ---------- per-device caps ----------
let editingDevice = null; // while a cap editor is open, auto-refresh leaves the table alone

function capMeter(row) {
  const bar = meter(row.sharePct, 'thin');
  if (row.limitPct != null) {
    const mark = el('span', { className: 'capmark', title: `Cap ${row.limitPct}%` });
    mark.style.left = `${Math.min(100, row.limitPct)}%`;
    bar.append(mark);
    bar.firstChild.className = `fill ${row.overLimit ? 'crit' : 'ok'}`;
  }
  return bar;
}

function shareCell(row, limits, key) {
  if (!row) return el('td', { className: 'muted', textContent: limits[key] != null ? `— · cap ${limits[key]}%` : '—' });
  const capText = row.limitPct != null ? ` of ${row.limitPct}% cap` : '';
  const badge = row.overLimit ? [el('span', { className: 'badge', textContent: limits.enforce ? 'Blocked' : 'Over cap' })] : [];
  return el('td', {}, [
    el('div', { className: 'share' }, [
      el('div', {}, [el('strong', { textContent: `≈ ${fmtPct(row.sharePct)}` }), el('span', { className: 'muted small', textContent: capText }), ...badge]),
      capMeter(row),
    ]),
    el('div', { className: 'muted small', textContent: `${fmtUsd(row.costUSD)} · ${fmtTokens(row.tokens)} tok` }),
  ]);
}

function numberField(label, value) {
  const input = el('input', { type: 'number', min: '1', max: '100', step: '1', placeholder: 'No cap', value: value ?? '' });
  return { input, node: el('label', { className: 'inline' }, [label, input]) };
}

function capEditor(device) {
  const five = numberField('5h cap (% of plan)', device.limits.fiveHour);
  const week = numberField('Weekly cap (% of plan)', device.limits.sevenDay);
  const mode = el('select', {}, [
    el('option', { value: 'warn', textContent: 'Warn only', selected: !device.limits.enforce }),
    el('option', { value: 'block', textContent: 'Block Claude Code on this device', selected: device.limits.enforce }),
  ]);
  const error = el('p', { className: 'error', hidden: true });
  const save = el('button', { className: 'small', textContent: 'Save' });
  const cancel = el('button', { className: 'ghost small', textContent: 'Cancel' });
  const toNumber = (input) => (input.value.trim() === '' ? null : Number(input.value));
  save.addEventListener('click', async () => {
    try {
      await api('PUT', `/api/devices/${encodeURIComponent(device.name)}/limits`, {
        fiveHour: toNumber(five.input),
        sevenDay: toNumber(week.input),
        enforce: mode.value === 'block',
      });
      editingDevice = null;
      await refresh();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  });
  cancel.addEventListener('click', () => {
    editingDevice = null;
    refresh();
  });
  const help = el('p', { className: 'muted small', textContent:
    'A cap is the share of your whole plan limit this device may use in that window. "Block" stops new Claude Code prompts on the device until the window resets or you raise the cap.' });
  return el('tr', { className: 'editor' }, [
    el('td', { colSpan: 4 }, [el('div', { className: 'capform' }, [five.node, week.node, el('label', { className: 'inline' }, ['When over', mode]), save, cancel]), error, help]),
  ]);
}

function deviceRows(device, rowsByWindow) {
  const capButton = el('button', { className: 'ghost small', textContent: 'Cap', title: `Set usage cap for ${device.name}` });
  capButton.addEventListener('click', () => {
    editingDevice = editingDevice === device.name ? null : device.name;
    renderDevices(lastSummary, { force: true });
  });
  const remove = el('button', { className: 'ghost small', textContent: 'Remove', title: `Remove ${device.name}` });
  remove.addEventListener('click', () => removeDevice(device.name));
  const capSummary = [device.limits.fiveHour, device.limits.sevenDay].some((v) => v != null)
    ? `${device.limits.enforce ? 'blocks' : 'warns'} at cap` : '';
  const row = el('tr', {}, [
    el('td', {}, [
      el('div', { className: 'devname', textContent: device.name }),
      el('div', { className: 'muted small', textContent: [`synced ${fmtAgo(device.reportedAt)}`, capSummary].filter(Boolean).join(' · ') }),
    ]),
    ...Object.keys(WINDOW_LABELS).map((key) => shareCell(rowsByWindow[key], device.limits, key)),
    el('td', { className: 'right actions' }, [capButton, remove]),
  ]);
  return editingDevice === device.name ? [row, capEditor(device)] : [row];
}

let lastSummary = null;

function renderDevices(summary, { force = false } = {}) {
  lastSummary = summary;
  if (editingDevice && !force) return;
  if (!summary.devices.length) {
    $('devices').replaceChildren(el('p', { className: 'muted', textContent: 'No devices yet — install the plugin on a device (see "Add a device").' }));
    return;
  }
  const byDevice = (key) => Object.fromEntries((summary.windows[key] ?? []).map((r) => [r.device, r]));
  const lookup = Object.fromEntries(Object.keys(WINDOW_LABELS).map((key) => [key, byDevice(key)]));
  const head = el('tr', {}, ['Device', '5h', 'Weekly', ''].map((t) => el('th', { textContent: t })));
  const rows = [...summary.devices]
    .sort((a, b) => (lookup.sevenDay[b.name]?.costUSD ?? 0) - (lookup.sevenDay[a.name]?.costUSD ?? 0))
    .flatMap((d) => deviceRows(d, { fiveHour: lookup.fiveHour[d.name], sevenDay: lookup.sevenDay[d.name] }));
  $('devices').replaceChildren(el('table', {}, [el('thead', {}, [head]), el('tbody', {}, rows)]));
}

async function refresh() {
  try {
    const summary = await api('GET', '/api/summary');
    renderWindows(summary);
    renderDevices(summary);
    $('refreshed').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (error) {
    if (error.status === 401) return signOut('Token is not valid on this server.');
    $('refreshed').textContent = `Refresh failed: ${error.message}`;
  }
}

async function openDashboard() {
  show('dashboard');
  $('installDetailsSlot').replaceChildren(installBlock());
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, REFRESH_MS);
}

async function removeDevice(name) {
  if (!window.confirm(`Remove "${name}"? It reappears if the device syncs again.`)) return;
  await api('DELETE', `/api/devices/${encodeURIComponent(name)}`).catch((e) => window.alert(e.message));
  await refresh();
}

function signOut(message = '') {
  clearInterval(refreshTimer);
  token = null;
  storage.clear();
  show('welcome');
  showError('signinError', message);
}

// ---------- events ----------
async function onRegister() {
  showError('registerError', '');
  $('register').disabled = true;
  try {
    const { token: newToken } = await api('POST', '/api/register', { code: $('code').value || undefined });
    token = newToken;
    storage.set(token);
    $('newToken').textContent = token;
    $('installCardSlot').replaceChildren(installBlock());
    show('created');
  } catch (error) {
    showError('registerError', error.message);
  } finally {
    $('register').disabled = false;
  }
}

async function onSignin() {
  const candidate = $('tokenInput').value.trim();
  if (!candidate) return showError('signinError', 'Paste your token first.');
  token = candidate;
  try {
    await api('GET', '/api/me');
    storage.set(token);
    $('tokenInput').value = '';
    showError('signinError', '');
    await openDashboard();
  } catch (error) {
    token = null;
    showError('signinError', error.status === 401 ? 'That token is not valid on this server.' : error.message);
  }
}

async function onDeleteAccount() {
  if (!window.confirm('Delete your account and all device data? This cannot be undone.')) return;
  try {
    await api('DELETE', '/api/me');
    signOut();
  } catch (error) {
    window.alert(error.message);
  }
}

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-copy]');
  if (!target) return;
  await navigator.clipboard.writeText($(target.dataset.copy).textContent).catch(() => {});
  target.textContent = 'Copied';
  setTimeout(() => { target.textContent = 'Copy'; }, 1500);
});

async function init() {
  $('register').addEventListener('click', onRegister);
  $('signin').addEventListener('click', onSignin);
  $('tokenInput').addEventListener('keydown', (e) => e.key === 'Enter' && onSignin());
  $('signout').addEventListener('click', () => signOut());
  $('toDashboard').addEventListener('click', openDashboard);
  $('deleteAccount').addEventListener('click', onDeleteAccount);

  const config = await api('GET', '/api/config').catch(() => ({ registration: 'open' }));
  $('codeRow').hidden = config.registration !== 'code';
  $('registerClosed').hidden = config.registration !== 'closed';
  $('register').hidden = config.registration === 'closed';

  if (token) await openDashboard();
  else show('welcome');
}

init();
