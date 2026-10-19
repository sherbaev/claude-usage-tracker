// Dashboard: Telegram bot card — connect a bot, link chats, alert settings. Uses $, el, api and fmtAgo
// from app.js (classic scripts share globals). Never builds HTML from data.
const TG_BOTFATHER = 'https://t.me/BotFather';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ICON_PATHS = {
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z',
  external: 'M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12zm11-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
};

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

let tgState = null;

/** Runs an async action with a busy button and a status message (aria-live). */
async function tgAction(button, statusEl, run, { success } = {}) {
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  statusEl.className = 'tgstatus muted small';
  statusEl.textContent = 'Working…';
  try {
    const result = await run();
    statusEl.className = 'tgstatus ok small';
    statusEl.replaceChildren(icon('check'), ` ${success ?? 'Done'}`);
    return result;
  } catch (error) {
    statusEl.className = 'tgstatus error small';
    statusEl.replaceChildren(icon('alert'), ` ${error.message}`);
    return null;
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

const statusLine = () => el('p', { className: 'tgstatus small', role: 'status', ariaLive: 'polite' });

// ---------- not connected: 3-step setup ----------
function setupView() {
  const input = el('input', {
    id: 'tgToken', type: 'password', autocomplete: 'off', spellcheck: false,
    placeholder: '123456789:AAH…', ariaDescribedBy: 'tgTokenHelp',
  });
  const toggle = el('button', { type: 'button', className: 'ghost small iconbtn', ariaLabel: 'Show token', title: 'Show token' }, [icon('eye')]);
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.ariaLabel = show ? 'Hide token' : 'Show token';
  });
  const status = statusLine();
  const connect = el('button', { textContent: 'Connect bot' });
  connect.addEventListener('click', async () => {
    const token = input.value.trim();
    if (!token) {
      status.className = 'tgstatus error small';
      status.replaceChildren(icon('alert'), ' Paste the token from BotFather first.');
      input.focus();
      return;
    }
    const data = await tgAction(connect, status, () => api('POST', '/api/telegram', { token }), { success: 'Bot connected' });
    if (!data) return input.focus();
    input.value = '';
    tgState = data;
    renderTelegram(data.setup);
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && connect.click());

  const step = (n, title, body) => el('li', { className: 'tgstep' }, [el('span', { className: 'stepnum', textContent: String(n), ariaHidden: 'true' }), el('div', {}, [el('strong', { textContent: title }), ...body])]);
  return el('div', {}, [
    el('p', { className: 'muted', textContent: 'Get usage and near-limit alerts in Telegram. You create the bot, we set up the rest: name, picture, commands.' }),
    el('ol', { className: 'tgsteps' }, [
      step(1, 'Create a bot', [
        el('p', { className: 'muted small' }, ['Open ', el('a', { href: TG_BOTFATHER, target: '_blank', rel: 'noopener', textContent: '@BotFather' }), ', send ', el('code', { textContent: '/newbot' }), ' and pick any username ending in "bot".']),
      ]),
      step(2, 'Paste its token', [
        el('label', { htmlFor: 'tgToken', className: 'sr-only', textContent: 'Bot token' }),
        el('div', { className: 'tgtokenrow' }, [input, toggle]),
        el('p', { id: 'tgTokenHelp', className: 'muted small', textContent: 'BotFather replies with a token like 123456789:AAH… It is stored encrypted on this server.' }),
      ]),
      step(3, 'Connect', [
        el('p', { className: 'muted small', textContent: 'We rename the bot to "Claude Usage Tracker", set its picture and commands, and point it at this server.' }),
        connect,
        status,
      ]),
    ]),
  ]);
}

// ---------- connected ----------
function setupResults(setup) {
  const failed = (setup ?? []).filter((s) => !s.ok);
  if (!failed.length) return null;
  return el('p', { className: 'tgnote small', role: 'status' }, [
    icon('alert'),
    ` Connected, but Telegram refused: ${failed.map((s) => `${s.step} (${s.error})`).join('; ')}. You can set these in @BotFather, or reconnect later.`,
  ]);
}

function chatsSection(state) {
  const list = state.chats.length
    ? el('ul', { className: 'tgchats' }, state.chats.map((c) => {
      const unlink = el('button', { className: 'ghost small', textContent: 'Unlink', ariaLabel: `Unlink ${c.name}` });
      unlink.addEventListener('click', async () => {
        unlink.disabled = true;
        tgState = await api('DELETE', `/api/telegram/chats/${c.id}`).catch((e) => (window.alert(e.message), tgState));
        renderTelegram();
      });
      return el('li', {}, [el('div', {}, [el('strong', { textContent: c.name }), el('div', { className: 'muted small', textContent: `linked ${fmtAgo(c.linkedAt)}` })]), unlink]);
    }))
    : el('p', { className: 'muted small', textContent: 'No chats linked yet. Link one to get alerts and use /usage.' });

  const status = statusLine();
  const linkBox = el('div', { className: 'tglink', hidden: !state.link });
  const showLink = (link) => {
    linkBox.hidden = !link;
    if (!link) return;
    const open = el('a', { className: 'button', href: link.url, target: '_blank', rel: 'noopener' }, [icon('external'), ' Open in Telegram']);
    const code = el('code', { className: 'token', textContent: link.url });
    const copy = el('button', { className: 'ghost small', textContent: 'Copy' });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(link.url).catch(() => {});
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    });
    const minutes = Math.max(1, Math.round((Date.parse(link.expiresAt) - Date.now()) / 60_000));
    linkBox.replaceChildren(
      el('p', { className: 'small', textContent: 'Open this on the phone or computer with the Telegram account to link, then press Start. Works once.' }),
      el('div', { className: 'copyrow' }, [code, copy]),
      el('div', { className: 'tglinkactions' }, [open, el('span', { className: 'muted small', textContent: `Expires in ${minutes} min` })]),
    );
  };
  showLink(state.link);
  const linkBtn = el('button', { className: 'ghost', textContent: state.chats.length ? 'Link another chat' : 'Link a chat' });
  linkBtn.addEventListener('click', async () => {
    const link = await tgAction(linkBtn, status, () => api('POST', '/api/telegram/link'), { success: 'Link ready' });
    if (link) showLink(link);
  });
  return el('section', { className: 'tgsection' }, [el('h3', { textContent: 'Linked chats' }), list, linkBtn, status, linkBox]);
}

function checkbox(id, label, checked, help) {
  const input = el('input', { type: 'checkbox', id, checked });
  return { input, node: el('div', { className: 'tgcheck' }, [input, el('label', { htmlFor: id }, [el('span', { textContent: label }), help ? el('span', { className: 'muted small', textContent: help }) : ''])]) };
}

function alertsSection(state) {
  const a = state.alerts;
  const enabled = checkbox('tgEnabled', 'Send alerts', a.enabled, 'Master switch for every alert below.');
  const near = checkbox('tgNear', 'Near the limit', a.near);
  const nearPct = el('input', { id: 'tgNearPct', type: 'number', min: '1', max: '99', step: '1', value: String(a.nearPct), ariaLabel: 'Near-limit threshold in percent', className: 'tgpct' });
  near.node.querySelector('label').append(el('span', { className: 'tgpctrow' }, ['at ', nearPct, ' % of the limit']));
  const hit = checkbox('tgHit', 'Limit reached', a.hit, '100% of a 5-hour or weekly window.');
  const caps = checkbox('tgCaps', 'Per-device caps', a.caps, 'When a device nears or reaches the cap you set for it.');
  const agents = checkbox('tgAgents', 'Codex and other agents', a.agents, 'Their own 5-hour / weekly limits, when they report one.');
  const sub = el('fieldset', { className: 'tgsub' }, [el('legend', { className: 'sr-only', textContent: 'Which alerts' }), near.node, hit.node, caps.node, agents.node]);
  const syncDisabled = () => { sub.disabled = !enabled.input.checked; };
  enabled.input.addEventListener('change', syncDisabled);
  syncDisabled();

  const status = statusLine();
  const save = el('button', { textContent: 'Save alerts' });
  save.addEventListener('click', async () => {
    const body = {
      enabled: enabled.input.checked, near: near.input.checked, hit: hit.input.checked,
      caps: caps.input.checked, agents: agents.input.checked, nearPct: Number(nearPct.value),
    };
    const data = await tgAction(save, status, () => api('PUT', '/api/telegram/alerts', body), { success: 'Saved' });
    if (data) tgState = data;
  });
  const test = el('button', { className: 'ghost' }, [icon('send'), ' Send test message']);
  test.disabled = !state.chats.length;
  test.title = state.chats.length ? '' : 'Link a chat first';
  test.addEventListener('click', () => tgAction(test, status, () => api('POST', '/api/telegram/test'), { success: 'Test message sent' }));
  return el('section', { className: 'tgsection' }, [
    el('h3', { textContent: 'Alerts' }),
    el('p', { className: 'muted small', textContent: 'Checked every time a device reports (about every 5 minutes while in use). Each alert is sent once per window.' }),
    enabled.node, sub,
    el('div', { className: 'tgactions' }, [save, test]),
    status,
  ]);
}

function connectedView(state, setup) {
  const status = statusLine();
  const disconnect = el('button', { className: 'destructive small', textContent: 'Disconnect bot' });
  disconnect.addEventListener('click', async () => {
    if (!window.confirm('Disconnect the bot? Linked chats stop getting messages.')) return;
    const data = await tgAction(disconnect, status, () => api('DELETE', '/api/telegram'), { success: 'Disconnected' });
    if (data) { tgState = data; renderTelegram(); }
  });
  const head = el('div', { className: 'tgbot' }, [
    el('img', { src: '/bot-avatar.jpg', alt: '', width: 48, height: 48, className: 'tgavatar' }),
    el('div', {}, [
      el('strong', { textContent: state.bot.name }),
      el('div', { className: 'small' }, [el('a', { href: state.bot.url, target: '_blank', rel: 'noopener', textContent: `@${state.bot.username}` }), ' · ', el('span', { className: 'tgbadge' }, [icon('check'), ' Connected'])]),
    ]),
  ]);
  return el('div', {}, [
    head,
    setupResults(setup) ?? '',
    el('div', { className: 'tggrid' }, [chatsSection(state), alertsSection(state)]),
    el('div', { className: 'tgfooter' }, [disconnect, status]),
  ]);
}

function renderTelegram(setup) {
  if (!tgState) return;
  $('telegram').replaceChildren(tgState.connected ? connectedView(tgState, setup) : setupView());
}

/** Called by app.js when the dashboard opens. */
async function loadTelegram() {
  try {
    tgState = await api('GET', '/api/telegram');
    renderTelegram();
  } catch (error) {
    $('telegram').replaceChildren(el('p', { className: 'error', textContent: `Could not load Telegram settings: ${error.message}` }));
  }
}
