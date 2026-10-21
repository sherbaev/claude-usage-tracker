# Claude Multi-Device Usage Tracker

[![Claude Code](https://img.shields.io/badge/Claude_Code-plan_%25_per_device-D97757)](#supported-tools)
[![Codex](https://img.shields.io/badge/Codex-plan_%25_+_usage-10A37F)](#supported-tools)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-usage-4285F4)](#supported-tools)
[![OpenCode · Amp · Copilot CLI · more](https://img.shields.io/badge/OpenCode_·_Amp_·_Copilot_CLI_·_+12-usage-6E7781)](#supported-tools)
[![Telegram bot](https://img.shields.io/badge/Telegram-bot_+_alerts-26A5E4?logo=telegram&logoColor=white)](#telegram-bot)
[![CI](https://github.com/sherbaev/claude-usage-tracker/actions/workflows/test.yml/badge.svg)](https://github.com/sherbaev/claude-usage-tracker/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Buy me a coffee](https://img.shields.io/badge/Buy_me_a_coffee-support-FFDD00?logo=buymeacoffee&logoColor=black)](https://buymeacoffee.com/sherbaev)

Track **AI coding plan limits on every device you use** — laptop, desktop, build server. See how much of your
**Claude** 5-hour and weekly limits each device uses, cap a device's share, and see which model and effort level used
it. **Codex, Gemini CLI, OpenCode, Amp, GitHub Copilot CLI** and every other agent
[ccusage](https://github.com/ccusage/ccusage) supports are tracked too. Get it all in a **Telegram bot**, with alerts
when a device gets near its limit. Free, open source, self-hostable.

**→ Use it now: [Open the website](https://0p2nwzsgdyic0rh1gboomqzi.178.105.41.164.sslip.io)** — sign up in the browser, no install
needed.

![Dashboard](docs/dashboard.png)

## Supported tools

| Tool | Plan limit % (5h / weekly) | Usage per device | Models | Per-device caps |
|---|---|---|---|---|
| **Claude Code** (CLI, VS Code, JetBrains, Desktop's Code tab) | ✅ account % + each device's share | ✅ exact 5h / weekly windows | ✅ model · effort level | ✅ warn or block |
| **Codex** (OpenAI) | ✅ account % (from Codex's own records) | ✅ today · last 7 days | ✅ | — |
| **Gemini CLI** (Google) | — | ✅ today · last 7 days | ✅ | — |
| **OpenCode**, **Amp**, **GitHub Copilot CLI**, **Droid**, **Qwen Code**, **Kimi**, **Goose**, **Kilo Code**, **Antigravity**, **Grok Build**, **Codebuff**, **Hermes**, **OpenClaw**, **pi**, **ZCode** | — | ✅ today · last 7 days | ✅ | — |

Other tools are read through [ccusage](https://github.com/ccusage/ccusage), so anything it detects on a device shows
up automatically — nothing to configure. Only Claude and Codex publish plan-limit percentages; for the rest you see
cost and tokens.

## Quick start

1. **Create an account** on the [website](https://0p2nwzsgdyic0rh1gboomqzi.178.105.41.164.sslip.io) and copy your
   token.
2. **Install the plugin** in Claude Code on each device:

   ```text
   /plugin install usage-tracker --marketplace sherbaev/claude-usage-tracker
   ```

3. **Connect the device** — the website's **Add a device** section builds this command for you:

   ```text
   /usage-tracker:setup https://0p2nwzsgdyic0rh1gboomqzi.178.105.41.164.sslip.io <your_token> Work MacBook
   ```

Use the **same token on every device** and give each device its own name. That's it — devices report
automatically while you use Claude Code.

Needs Claude Code logged in with a Claude subscription (Pro / Max / Team, not an API key) and Node.js 18.17+.

## Commands

| Command | What it does |
|---|---|
| `/usage-tracker:status` | Account 5h / weekly %, reset times, each device's share and cap |
| `/usage-tracker:setup [url] [token] [name]` | Connect this device |
| `/usage-tracker:background [on\|off\|status]` | Report every 5 minutes even when Claude Code is closed, so Claude Desktop, claude.ai and Chrome extension usage is seen (macOS; prints a crontab line elsewhere) |

```text
Claude plan windows · device: work-macbook
  Window  Account (all devices)        Resets                This device
  5h      ███████░░░░░░░░░░░░░  34%    in 2h 26m (14:00)     $9.20 · 17.5M tok
  Weekly  ██████████████░░░░░░  71%    in 2d 10h (Wed 22:00) $410.00 · 1.07B tok
```

## What you get

- **Account usage** — the same 5h / weekly % and reset times as `/usage` in Claude Code, for your whole account.
- **Per-device share** — an estimate of how much of that each device used, split by cost.
- **Model · effort breakdown** — which model and effort level used each device's share.
- **Per-device caps** — on the website, set a cap per device to get a warning, or block Claude Code on that device
  until the window resets.
- **Other coding agents** — Codex, Gemini CLI, OpenCode, Amp, Copilot CLI and more ([full list](#supported-tools)):
  cost and tokens per device for today and the last 7 days, with the models used, plus Codex's own 5-hour and
  weekly plan %.
- **Telegram bot** — usage per device in Telegram, and alerts when you get near a limit or hit it
  ([setup](#telegram-bot)).

## Telegram bot

Check your usage and get alerts in Telegram. Everything is set up from the dashboard, and the bot works with buttons,
so there are no commands to remember.

```text
📊 Claude plan
⏱ 5-hour  🟩⬜⬜⬜⬜⬜⬜⬜⬜⬜ 9.0%
      ↻ resets in 4h 6m
📅 Weekly  🟨🟨🟨🟨🟨🟨🟨🟨⬜⬜ 75%
      ↻ resets in 1d 3h

💻 Devices · share of the plan
🔔 Work MacBook
      ⏱ 5h  🟩⬜⬜⬜⬜ 9.0% of 50% cap
      📅 Weekly  🟨🟨🟨⬜⬜ 29% of 50% cap
🔕 Home PC
      📅 Weekly  🟥🟥🟥🟥🟥 46% of 50% cap

[ 🔄 Refresh ]  [ 💻 Device alerts ]
```

```text
⚠️ 💻 Work MacBook is at 41% of its 50% weekly cap
⏳ resets in 2d 10h
```

### Set it up (2 minutes)

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it gives you.
2. On the dashboard, open **Telegram**, paste the token and click **Connect bot**. The server names the bot
   **Claude Usage Tracker**, sets its picture, description and menu, and connects it to your server.
3. Click **Link a chat** and open the link with the Telegram account that should get messages, then press **Start**.
   Link as many chats as you like (you, a teammate, a group). Each link works once and expires after 10 minutes.

### Buttons

| Button | What it shows |
|---|---|
| 📊 **Usage** | Claude 5-hour and weekly usage as bars, each device against its cap (🟩 fine · 🟨 getting close · 🟥 at the cap · ⛔ over), usage outside Claude Code not yet assigned (🧭), Codex and other agents. 🔄 Refresh updates it in place |
| 💻 **Devices** | Every device with its caps and when it last synced. Tap a device's **🔔 / 🔕** button to turn its alerts on or off |
| 🔔 **Alerts** | Alerts on or off, near-limit level (70 / 80 / 90%), limit reached, Codex limits |
| ❓ **Help** | What each button does. Send `/stop` to unlink a chat |

### Alerts

- **Per device:** turn alerts on only for the devices you care about, with the 🔔 buttons under 💻 Devices or
  **Device alerts** on the dashboard. Give the device caps under **Devices → Set cap** on the dashboard, for example
  50% of the 5-hour and 50% of the weekly limit. You get ⚠️ when it nears either cap and 🚨 when it reaches one.
- **Whole account:** ⚠️ / 🚨 when Claude's 5-hour or weekly limit is near or reached, and the same for Codex.
- Each alert is sent once per window. Alerts are checked when a device reports, about every 5 minutes while you use
  Claude Code.

### Usage outside Claude Code

Claude Desktop, claude.ai and the Chrome extension use the same plan, but they leave no logs on your devices. When
the plan goes up more than your devices' Claude Code usage explains, the bot asks whose it was:

```text
🧭 Usage outside Claude Code
Your plan went up more than your devices' Claude Code explains — likely Claude Desktop, claude.ai or the Chrome extension.
⏱ 5h +8.0% · 📅 Weekly +3.0%

👉 Whose was it? It then counts toward that device's share and caps.
[ 💻 MacBook Pro ]
[ 💻 Work PC ]
[ 🙈 Not sure — split by usage ]
```

- Tap a device and the usage counts toward that device's share and caps, so its alerts and blocking stay accurate.
  Tap another device to change your answer.
- **🙈 Not sure** splits it across devices by their Claude Code usage, and it isn't asked about again.
- Until you answer, the usage is shown on its own (`🧭 Outside Claude Code … not assigned` in 📊 Usage, and on the
  dashboard) instead of being added to your devices. **🧭 Assign outside usage** asks again.
- **How it's found:** from finished 5-hour windows, the server learns how much plan % a dollar of Claude Code uses
  on your account. Plan % beyond that is outside usage, even while Claude Code is running at the same time.
  Learning needs two finished 5-hour windows with some Claude Code use. Until then, only a rise with no Claude Code
  activity at all is caught.
- It's an estimate. Anthropic doesn't say which app used the plan, and the learned rate varies a little with the
  models you use. Amounts under about 20% of your Claude Code usage, or under 2 points (5-hour) / 1 point (weekly),
  are treated as noise and add up until they're large enough to ask about.
- Usage is checked when a device reports. The bot waits 6 minutes so a device whose Claude Code report is still on
  its way isn't mistaken for Desktop use.
- **Turn on background reporting** with `/usage-tracker:background on` on the Mac where you use Claude Desktop or
  the browser. Devices otherwise report only while Claude Code runs, so the server doesn't see Desktop use until
  Claude Code next runs. Usage from a window that has already reset is never seen. Background reporting uses the
  Claude login that Claude Code keeps fresh, so open Claude Code at least once a day.

The bot only answers chats you linked. Bot tokens are stored encrypted on your server.

<details>
<summary><b>Tracking a machine that doesn't run Claude Code</b></summary>

Devices report from Claude Code's hooks. On a machine that only uses Codex or another agent, report on a schedule
instead (Node.js 18.17+; no Claude login needed):

```sh
git clone https://github.com/sherbaev/claude-usage-tracker ~/.usage-tracker
node ~/.usage-tracker/plugin/scripts/cli.js setup --server <server-url> --token <your_token> --device "Build Server"
# crontab -e
*/10 * * * * node ~/.usage-tracker/plugin/scripts/cli.js push
```

</details>

## Privacy

- Only usage numbers are sent: device name, %, cost and token counts, model names and effort levels. **Never** prompts,
  code, file paths or your Claude / Codex login.
- Your Claude login stays on your device and is only used with `api.anthropic.com`.
- The server stores a hash of your token, not the token. Delete your account and all its data from the website
  anytime.

<details>
<summary><b>Other ways to install the plugin</b></summary>

On older Claude Code:

```text
/plugin marketplace add sherbaev/claude-usage-tracker
/plugin install usage-tracker@claude-usage-tracker
```

In the VS Code or JetBrains panel, install from a terminal and restart the panel:

```sh
claude plugin marketplace add sherbaev/claude-usage-tracker
claude plugin install usage-tracker@claude-usage-tracker
```

You can also set `server_url`, `token` and `device_name` under `/plugin` → *usage-tracker* → *Configure options*;
the token is then kept in your system's secure credential store.

</details>

<details>
<summary><b>How the numbers are calculated</b></summary>

| Number | Source |
|---|---|
| Account % and reset time | Claude Code's own usage endpoint (`/api/oauth/usage`) — covers every device plus claude.ai chat |
| This device's cost and tokens | [`ccusage`](https://github.com/ccusage/ccusage), summed over Anthropic's exact window |
| Per-device ≈ % | `account % × device cost ÷ total cost of all devices` — an **estimate**, since Anthropic reports one number per account |
| Model · effort | Model and effort level from Claude Code's local transcripts (metadata only, never content) |

Devices report from the plugin's hooks, at most every 5 minutes. A blocked device is unblocked within a minute after
you raise or remove its cap, and automatically when the window resets.

</details>

<details>
<summary><b>Host your own server</b></summary>

The website and API are in `server/` and run in Docker (no npm dependencies, Node 22.13+).

```sh
docker build -t usage-tracker . && docker run -p 8787:8787 -v usage-data:/data usage-tracker
```

On **Coolify**: New Resource → Public Repository → this repo, build pack **Dockerfile** (or **Docker Compose**),
port `8787`, a persistent volume at `/data`. Check it with `curl https://your-domain/health`.

| Variable | Default | |
|---|---|---|
| `REGISTRATION` | `open` | `open`, `code` (needs `REGISTRATION_CODE`) or `closed` |
| `REGISTRATION_CODE` | — | Invite code (8+ characters) when `REGISTRATION=code` |
| `MAX_DEVICES_PER_USER` | `20` | |
| `MAX_USERS` | `10000` | |
| `TRUST_PROXY` | `1` in Docker | Number of reverse proxies in front; `0` if exposed directly |
| `PUBLIC_URL` | dashboard's address | Public `https://` URL Telegram sends bot updates to. Only needed if the dashboard is opened through a different address |
| `TELEGRAM_SECRET` | key file in `/data` | Encrypts stored Telegram bot tokens. If unset, a random key is created next to the database |

Unused accounts are deleted after 7 days, inactive ones after 180 days; device data is kept 30 days after its last
report.

</details>

<details>
<summary><b>API</b></summary>

All `/api/*` routes except `register` and `config` need `Authorization: Bearer <token>`. Responses are
`{ success, data, error }`.

| Route | |
|---|---|
| `POST /api/register` | → `{ token }` |
| `GET /api/me` | account + devices |
| `POST /api/report` | device report |
| `GET /api/summary` | account windows + per-device share, cap and model breakdown |
| `GET /api/stats` | public: active accounts and devices (reported in the last 7 days) |
| `PUT /api/devices/:name/limits` | set caps (% of plan) and whether to block |
| `DELETE /api/devices/:name` | remove a device |
| `DELETE /api/me` | delete account |
| `GET /api/telegram` | Telegram bot, linked chats, alert settings |
| `POST /api/telegram` `{ token }` | connect and set up a bot |
| `POST /api/telegram/link` | one-time link to connect a chat |
| `PUT /api/telegram/alerts` | alert settings |
| `POST /api/telegram/test` | send a test message |
| `DELETE /api/telegram`, `DELETE /api/telegram/chats/:id` | disconnect the bot, unlink a chat |
| `GET /api/config`, `GET /health` | public |

</details>

## Development

```sh
npm test            # tests + coverage
npm start           # server on :8787
npm run validate    # validate the Claude Code plugin
```

> The usage endpoint is the one Claude Code itself uses. It is not a documented public API and may change. This
> project is not affiliated with Anthropic.

## Support the project

If this saves you from hitting your limits, you can support development:

[![Buy me a coffee](https://img.shields.io/badge/Buy_me_a_coffee-support-FFDD00?logo=buymeacoffee&logoColor=black&style=for-the-badge)](https://buymeacoffee.com/sherbaev)

Stars, issues and pull requests help too.

## License

MIT
