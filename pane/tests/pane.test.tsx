import { expect, mock, test } from 'claude-code/testing'
import type { HttpResponse, On } from 'claude-code'

const SERVER = 'https://tracker.example'
const TOKEN = `cut_${'a'.repeat(43)}`
const NOW = Date.parse('2026-10-21T16:00:00Z')

const SUMMARY = {
  success: true,
  data: {
    account: {
      fiveHour: { pct: 34, resetsAt: '2026-10-21T18:26:00Z' },
      sevenDay: { pct: 71, resetsAt: '2026-10-23T22:00:00Z' },
    },
    windows: {
      fiveHour: [{ device: 'Work MacBook', sharePct: 20, costUSD: 9.2, limitPct: 50, overLimit: false }],
      sevenDay: [{ device: 'Work MacBook', sharePct: 46, costUSD: 410, limitPct: 50, overLimit: false }],
    },
    outside: { fiveHour: { unassignedPct: 8 }, sevenDay: { unassignedPct: 0 } },
    devices: [{ name: 'Work MacBook', reportedAt: '2026-10-21T15:58:00Z' }],
    agents: [],
  },
}

const PANE = {
  plugin: 'usage-tracker-pane',
  component: 'Pane',
  requestId: 'plan-usage',
  props: { title: 'Claude usage', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

function engine(on: On, fetchAnswer: () => HttpResponse) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/Users/me' })
  const statuses: (string | undefined)[] = []
  const urls: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('fs.read', () => ({ deny: 'ENOENT: no such file' }))
  on('http.fetch', (_, e) => {
    urls.push(e.url)
    return { value: fetchAnswer() }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  return { statuses, urls }
}

test('the pane shows account windows and each device, on every surface', { options: { server_url: SERVER, token: TOKEN } }, async ($, on) => {
  const { statuses, urls } = engine(on, () => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(SUMMARY) }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'plan-usage', args: '', origin: { kind: 'human' }, presentation: 'transcript' } as never)

  expect(urls[0]).toBe(`${SERVER}/api/summary`)
  expect(statuses.at(-1)).toBe('Claude 5h 34% · week 71%')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Work MacBook/ }))?.text).toBe('Work MacBook')
    expect((await ui.find({ type: 'Text', text: /of 50% cap/ }))?.text).toBe('20% of 50% cap')
    expect((await ui.find({ type: 'Text', text: /resets in/ }))?.text).toBe('resets in 2h 26m')
    expect(await ui.find({ type: 'Text', text: /Outside Claude Code/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('without a connection the pane says how to connect', async ($, on) => {
  const { urls } = engine(on, () => ({ status: 200, ok: true, headers: {}, text: '{}' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'plan-usage', args: '', origin: { kind: 'human' }, presentation: 'transcript' } as never)
  expect(urls.length).toBe(0)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Not connected/ })).toBeTruthy()
  await ui.unmount()
})

test('/plan-usage connect saves the server and a rejected token is reported', async ($, on) => {
  const { urls } = engine(on, () => ({ status: 401, ok: false, headers: {}, text: '{"success":false,"error":"invalid or missing token"}' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const result = await $.command.run({ command: 'plan-usage', args: `connect ${SERVER} ${TOKEN}`, origin: { kind: 'human' }, presentation: 'transcript' } as never)
  expect(urls.at(-1)).toBe(`${SERVER}/api/summary`)
  expect(String(result.text)).toContain('rejected the token')
  expect(String(result.text)).not.toContain(TOKEN)
})
