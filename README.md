# Claude Multi-Device Usage Tracker

Track your **Claude 5-hour and weekly plan limits per device**: see how much each laptop, desktop and server uses,
cap a device's share, and see which model and effort level used it. Works with Claude Code (CLI and IDE panels) and
a web dashboard. Free, open source, self-hostable.

**→ Use it now: [Open the website](https://0p2nwzsgdyic0rh1gboomqzi.178.105.41.164.sslip.io)** — sign up in the browser, no install
needed.

![Dashboard](docs/dashboard.png)

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

## Privacy

- Only usage numbers are sent: device name, %, cost and token counts. **Never** prompts, code, file paths or your
  Claude login.
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

## License

MIT
