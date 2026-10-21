// Claude plan usage for every device, inside the Claude app: a pane beside the chat, a status-line entry
// and a /plan-usage command. It reads GET /api/summary from your Claude Usage Tracker server — the same
// numbers as the website and the Telegram bot. Devices still report through the usage-tracker plugin.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentPlan, DeviceShare, PlanWindow, Snapshot, Summary } from '../types'

const PANE = 'plan-usage'
const TITLE = 'Claude usage'
const COMMAND = 'plan-usage'
const REFRESH_MS = 60_000
const STORE_KEY = 'connection'
const WARN_PCT = 70
const CRIT_PCT = 90
const BAR_CELLS = 16
const MINUTE_MS = 60_000

const TOKEN_RE = /^cut_[A-Za-z0-9_-]{43}$/
const DEVICE_RE = /^[\w.\- ]{1,64}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

const EMPTY: Snapshot = { serverUrl: null, summary: null, fetchedAt: null, error: null, isLoading: false }
const snapshot = atom({ plugin: 'usage-tracker-pane', key: 'snapshot' } as const, EMPTY)

type Connection = { serverUrl: string; token: string; source: string }
type Options = { server_url?: unknown; token?: unknown }

// ---------- config ----------

const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** https only (the bearer token must not travel in cleartext), except for a local test server. */
function normalizeServerUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const isLocal = LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

function connection(serverUrl: unknown, token: unknown, source: string): Connection | null {
  const url = nonEmpty(serverUrl)
  const tok = nonEmpty(token)
  if (!url || !tok || !TOKEN_RE.test(tok)) return null
  const normalized = normalizeServerUrl(url)
  return normalized ? { serverUrl: normalized, token: tok, source } : null
}

/** Plugin settings → /plan-usage connect → the config the usage-tracker plugin's setup wrote. */
async function loadConnection($: EngineInterface, options: Options): Promise<Connection | null> {
  const fromOptions = connection(options.server_url, options.token, 'plugin settings')
  if (fromOptions) return fromOptions

  const stored = (await $.store.get(STORE_KEY)) as { serverUrl?: unknown; token?: unknown } | undefined
  const fromStore = stored ? connection(stored.serverUrl, stored.token, '/plan-usage connect') : null
  if (fromStore) return fromStore

  const xdg = await $.env.get('XDG_CONFIG_HOME')
  const home = await $.env.get('HOME')
  const dir = xdg ?? (home ? `${home}/.config` : null)
  if (!dir) return null
  try {
    const file = JSON.parse(await $.fs.read(`${dir}/claude-usage-tracker/config.json`)) as Record<string, unknown>
    return connection(file.serverUrl, file.token, 'usage-tracker plugin setup')
  } catch {
    return null
  }
}

// ---------- server response (untrusted: keep known fields with valid values) ----------

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)
const clean = (v: unknown, max = 80): string => String(v ?? '').replace(CONTROL_CHARS, ' ').slice(0, max)

function planWindow(w: any): PlanWindow | null {
  const pct = finite(w?.pct)
  const resetsAt = iso(w?.resetsAt)
  return pct !== null && resetsAt ? { pct, resetsAt } : null
}

function shareRows(rows: unknown): DeviceShare[] {
  if (!Array.isArray(rows)) return []
  return rows.flatMap((r: any) => {
    const sharePct = finite(r?.sharePct)
    if (typeof r?.device !== 'string' || !DEVICE_RE.test(r.device) || sharePct === null) return []
    return [{ device: r.device, sharePct, costUSD: finite(r.costUSD) ?? 0, limitPct: finite(r.limitPct), overLimit: r.overLimit === true }]
  })
}

function parseSummary(data: any): Summary {
  const agents: AgentPlan[] = Array.isArray(data?.agents)
    ? data.agents.slice(0, 24).flatMap((a: any) => {
        const fiveHour = planWindow(a?.plan?.fiveHour)
        const sevenDay = planWindow(a?.plan?.sevenDay)
        return fiveHour || sevenDay ? [{ label: clean(a?.label ?? a?.id), fiveHour, sevenDay }] : []
      })
    : []
  return {
    account: data?.account ? { fiveHour: planWindow(data.account.fiveHour), sevenDay: planWindow(data.account.sevenDay) } : null,
    windows: { fiveHour: shareRows(data?.windows?.fiveHour), sevenDay: shareRows(data?.windows?.sevenDay) },
    outside: { fiveHour: finite(data?.outside?.fiveHour?.unassignedPct) ?? 0, sevenDay: finite(data?.outside?.sevenDay?.unassignedPct) ?? 0 },
    devices: Array.isArray(data?.devices)
      ? data.devices.flatMap((d: any) =>
          typeof d?.name === 'string' && DEVICE_RE.test(d.name) && iso(d.reportedAt) ? [{ name: d.name, reportedAt: d.reportedAt }] : [],
        )
      : [],
    agents,
  }
}

// ---------- fetching ----------

// Refreshes run one after another, so one asked for after a change (a new connection) reads that change.
let queue: Promise<void> = Promise.resolve()
let waiting: Promise<void> | null = null

async function fetchSummary($: EngineInterface, conn: Connection): Promise<Summary> {
  let res
  try {
    res = await $.http.fetch(`${conn.serverUrl}/api/summary`, { headers: { Authorization: `Bearer ${conn.token}` } })
  } catch (error) {
    throw new Error(`cannot reach ${conn.serverUrl} — ${clean((error as Error)?.message, 120)}`)
  }
  let payload: any = {}
  try {
    payload = JSON.parse(res.text)
  } catch {
    // not JSON: reported by status below
  }
  if (res.status === 401) throw new Error('the server rejected the token — check it on the tracker website')
  if (!res.ok || payload?.success === false) throw new Error(`server answered HTTP ${res.status} ${clean(payload?.error ?? '', 120)}`.trim())
  return parseSummary(payload?.data)
}

const pctLabel = (pct: number) => `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`

function statusText(summary: Summary | null): string | undefined {
  const acc = summary?.account
  if (!acc?.fiveHour && !acc?.sevenDay) return undefined
  const parts = [acc.fiveHour && `5h ${pctLabel(acc.fiveHour.pct)}`, acc.sevenDay && `week ${pctLabel(acc.sevenDay.pct)}`].filter(Boolean)
  return `Claude ${parts.join(' · ')}`
}

function refresh($: EngineInterface, options: Options): Promise<void> {
  // Several asks while one waits share it: it starts after them all.
  if (waiting) return waiting
  waiting = queue.then(() => {
    waiting = null
    return refreshNow($, options)
  })
  queue = waiting.catch(() => {})
  return waiting
}

async function refreshNow($: EngineInterface, options: Options): Promise<void> {
  await update($, snapshot, (s) => ({ ...(s ?? EMPTY), isLoading: true }))
  const conn = await loadConnection($, options)
  if (!conn) {
    await update($, snapshot, () => ({ ...EMPTY, error: 'not-connected' }))
    $.ui.status(undefined)
    return
  }
  try {
    const summary = await fetchSummary($, conn)
    const fetchedAt = await $.clock.now()
    await update($, snapshot, () => ({ serverUrl: conn.serverUrl, summary, fetchedAt, error: null, isLoading: false }))
    $.ui.status(statusText(summary))
  } catch (error) {
    // Keep the last good numbers on screen; say why they are not fresh.
    await update($, snapshot, (s) => ({ ...(s ?? EMPTY), serverUrl: conn.serverUrl, error: (error as Error).message, isLoading: false }))
  }
}

// ---------- drawing ----------

function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE_MS))
  const days = Math.floor(total / 1440)
  const hours = Math.floor((total % 1440) / 60)
  const mins = total % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

const tone = (pct: number) => (pct >= CRIT_PCT ? 'error' : pct >= WARN_PCT ? 'warning' : 'success')
const bar = (pct: number, cells = BAR_CELLS) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * cells)
  return ['█'.repeat(filled), '░'.repeat(cells - filled)] as const
}

const WINDOW_LABELS = { fiveHour: '5-hour', sevenDay: 'Weekly' } as const

export const register: Register = (on, options: Options) => {
  let timer: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Claude plan usage for every device (Usage Tracker)',
      argumentHint: '[connect <server-url> <token> | disconnect]',
    })
    timer?.cancel()
    timer = $.clock.every(REFRESH_MS, () => refresh($, options))
    void refresh($, options)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void refresh($, options) // the turn just used plan; the server may have a newer report
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const [action, url, token] = e.args.trim().split(/\s+/)
    if (action === 'connect') {
      const conn = connection(url, token, '/plan-usage connect')
      if (!conn) return { text: 'Usage: /plan-usage connect https://your-tracker.example cut_…  (https URL and a cut_ token from the tracker website)' }
      await $.store.set(STORE_KEY, { serverUrl: conn.serverUrl, token: conn.token })
      await refresh($, options)
      await $.ui.open({ id: PANE, title: TITLE })
      const { error } = await read($, snapshot)
      return { text: error ? `Saved, but the first fetch failed: ${error}` : `Connected to ${conn.serverUrl}.` }
    }
    if (action === 'disconnect') {
      await $.store.delete(STORE_KEY)
      await refresh($, options)
      return { text: 'Forgot the server saved by /plan-usage connect.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($, options)
    return { text: statusText((await read($, snapshot)).summary) ?? 'Claude usage pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const now = await $.clock.now()
    const reload = () => refresh($, options)

    if (snap.error === 'not-connected') {
      return (
        <Box flexDirection="column" gap={1}>
          <Text weight="semibold">Not connected to a Usage Tracker server</Text>
          <Text dimColor>Run this in the chat with your server and the cut_… token from the tracker website:</Text>
          <Text mono>/plan-usage connect https://your-server cut_…</Text>
          <Text dimColor>Or set it under this plugin's settings. A computer where /usage-tracker:setup already ran is found by itself.</Text>
          <Button key="retry" label="Check again" onPress={reload} />
        </Box>
      )
    }

    const summary = snap.summary
    const windowRow = (key: 'fiveHour' | 'sevenDay', w: PlanWindow | null | undefined) => {
      if (!w) return <Text dimColor>{WINDOW_LABELS[key]}: no data yet</Text>
      const [full, empty] = bar(w.pct)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between">
            <Text weight="semibold">{WINDOW_LABELS[key]}</Text>
            <Text dimColor>resets in {duration(Date.parse(w.resetsAt) - now)}</Text>
          </Box>
          <Text mono>
            <Text color={tone(w.pct)}>{full}</Text>
            <Text dimColor>{empty}</Text> {pctLabel(w.pct)}
          </Text>
        </Box>
      )
    }

    const deviceRows = (key: 'fiveHour' | 'sevenDay') => {
      const rows = summary?.windows[key] ?? []
      const outside = summary?.outside[key] ?? 0
      if (!rows.length && outside <= 0) return null
      return (
        <Box flexDirection="column">
          <Text dimColor>{WINDOW_LABELS[key]} · share per device</Text>
          {rows.map((r) => (
            <Box key={`${key}-${r.device}`} flexDirection="row" justifyContent="space-between">
              <Text>
                {r.overLimit ? '⛔ ' : ''}
                {r.device}
              </Text>
              <Text tabular color={r.limitPct !== null ? tone((r.sharePct / r.limitPct) * 100) : undefined}>
                {pctLabel(r.sharePct)}
                {r.limitPct !== null ? ` of ${r.limitPct}% cap` : ''}
              </Text>
            </Box>
          ))}
          {outside > 0 && (
            <Box flexDirection="row" justifyContent="space-between">
              <Text dimColor>🧭 Outside Claude Code (not assigned)</Text>
              <Text tabular dimColor>
                {pctLabel(outside)}
              </Text>
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {windowRow('fiveHour', summary?.account?.fiveHour)}
        {windowRow('sevenDay', summary?.account?.sevenDay)}
        {deviceRows('fiveHour')}
        {deviceRows('sevenDay')}
        {summary?.agents.map((a) => (
          <Text key={`agent-${a.label}`} dimColor>
            {a.label}: {a.fiveHour ? `5h ${pctLabel(a.fiveHour.pct)}` : ''}
            {a.fiveHour && a.sevenDay ? ' · ' : ''}
            {a.sevenDay ? `week ${pctLabel(a.sevenDay.pct)}` : ''}
          </Text>
        ))}
        {!summary && !snap.error && <Text dimColor>Loading…</Text>}
        {snap.error && <Text color="warning">⚠ {snap.error}</Text>}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text dimColor size="caption">
            {snap.isLoading ? 'Updating…' : snap.fetchedAt ? (now - snap.fetchedAt < MINUTE_MS ? 'Updated just now' : `Updated ${duration(now - snap.fetchedAt)} ago`) : ''}
          </Text>
          <Box flexDirection="row" gap="xs">
            {snap.serverUrl && <Link href={snap.serverUrl} label="Dashboard" />}
            <Button key="refresh" label="Refresh" hotkey="r" onPress={reload} />
          </Box>
        </Box>
      </Box>
    )
  })
}
