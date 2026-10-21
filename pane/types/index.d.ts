export type PlanWindow = { pct: number; resetsAt: string }

export type DeviceShare = {
  device: string
  sharePct: number
  costUSD: number
  limitPct: number | null
  overLimit: boolean
}

export type AgentPlan = {
  label: string
  fiveHour: PlanWindow | null
  sevenDay: PlanWindow | null
}

export type Summary = {
  account: { fiveHour: PlanWindow | null; sevenDay: PlanWindow | null } | null
  windows: { fiveHour: DeviceShare[]; sevenDay: DeviceShare[] }
  outside: { fiveHour: number; sevenDay: number }
  devices: { name: string; reportedAt: string }[]
  agents: AgentPlan[]
}

export type Snapshot = {
  serverUrl: string | null
  summary: Summary | null
  fetchedAt: number | null
  error: string | null
  isLoading: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'usage-tracker-pane': { snapshot: Snapshot }
  }
}
