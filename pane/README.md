# usage-tracker-pane

Your Claude plan usage inside the Claude app (Claude Desktop, the Code tab, claude.ai's Code sessions, the terminal):
a **Claude usage** pane beside the chat, an entry in the status line (`Claude 5h 34% · week 71%`) and a
`/plan-usage` command. It shows the account's 5-hour and weekly %, when each resets, every device's share against
its cap, usage outside Claude Code not yet assigned, and Codex's plan %. It refreshes every minute and after each turn.

It reads `GET /api/summary` from your [Claude Usage Tracker](https://github.com/sherbaev/claude-usage-tracker)
server — the same numbers as the website and the Telegram bot. Devices keep reporting through the `usage-tracker`
plugin; this one only displays.

## Install

```text
/plugin install usage-tracker-pane --marketplace sherbaev/claude-usage-tracker
```

## Connect

It finds the server by itself on a computer where `/usage-tracker:setup` already ran. Anywhere else (a cloud session,
a fresh computer), run once:

```text
/plan-usage connect https://your-tracker-server cut_your_token
```

or set **Tracker server URL** and **Account token** in the plugin's settings. `/plan-usage disconnect` forgets a
server saved with `connect`.

## Commands

| Command | What it does |
|---|---|
| `/plan-usage` | Opens the pane, refreshes, and prints the account % |
| `/plan-usage connect <url> <token>` | Saves the server for this plugin |
| `/plan-usage disconnect` | Forgets it |

The token goes only to your tracker server, over https.
