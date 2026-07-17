# pi-grok-usage

Show **Grok / xAI account credit usage** in the [Pi](https://pi.dev) status bar.

Uses the same billing source as Grok Build's in-TUI `/usage` command — not session token counters, not Claude subscription windows. Real account credit %.

```
Grok:11.0% Thu 09:34
```

## Why

If you run Pi with Grok (or just want account quota visible while using other models), this keeps weekly/monthly Grok credit burn in the footer — independent of the active chat provider.

## Install

Requires [Pi](https://github.com/badlogic/pi) and a working Grok CLI login (`grok login`).

```bash
pi install git:github.com/apoapostolov/pi-grok-usage
```

Or pin a tag:

```bash
pi install git:github.com/apoapostolov/pi-grok-usage@v1.0.0
```

Reload Pi (`/reload` or new session).

## Prerequisites

1. **Grok CLI installed** and on `PATH`
2. **Logged in**

```bash
grok login
# verify
grok models
```

Auth is read from `~/.grok/auth.json` (OIDC access token from Grok Build). If the access token is expired, the extension refreshes it via xAI OIDC and writes the new tokens back. No API key paste into Pi settings required.

## What you get

| Surface | Behavior |
|--------|----------|
| Footer | `Grok:<pct.1>% <Wed> <HH:mm>` local reset time |
| Colors | normal → warning ≥80% → error ≥95% |
| Refresh | every 5 minutes (also on session start / turn end, throttled) |
| `/grok-usage` | force refresh + product breakdown |
| `/grok-usage clear` | hide footer |

Footer example: `Grok:11.0% Thu 09:34` — one decimal percent, 3-char weekday, local hour:minute of period end. No `wk`/`mo` clutter.

Example detail output:

```text
Grok usage: 11.0% (weekly)
Period ends: 2026-07-24T06:34:33.775Z (local Thu 09:34)
Account: you@example.com
Products:
  - Api: 11%
  - GrokBuild: —
Fetched: 2s ago
```

## How it works

```text
~/.grok/auth.json
        │
        ▼
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
Authorization: Bearer <token>
        │
        ▼
Pi footer status: "Grok:11.0% Thu 09:34"
```

This is **account billing**, not:

- Pi session token totals (`/usage` from other extensions)
- Claude subscription hourly/weekly bars
- Model provider selection

## Commands

```text
/grok-usage          Force refresh and show details
/grok-usage clear    Hide the footer status
```

## Troubleshooting

### Footer shows `Grok:auth?`

Token missing, refresh failed, or still rejected after refresh.

```bash
grok login
# then in Pi:
/grok-usage
```

### Footer stuck on `Grok:…`

First fetch still running or network blocked. Run `/grok-usage` for the error text.

### No footer after install

1. Confirm package is listed: `pi list`
2. Reload session: `/reload`
3. Check extension path includes `src/index.ts` in package metadata

### Using Pi with DeepSeek / other models

That's fine. This extension does **not** depend on the active chat provider. Grok quota can stay visible while you code on another model.

## Privacy

- Token never leaves your machine except to Grok's billing endpoint
- No third-party analytics
- Extension only reads `~/.grok/auth.json` and the billing API response

## Uninstall

```bash
pi remove git:github.com/apoapostolov/pi-grok-usage
```

## Development

```bash
git clone https://github.com/apoapostolov/pi-grok-usage
cd pi-grok-usage

# load directly for testing
pi -e ./src/index.ts
```

Or symlink into Pi extensions:

```bash
ln -sf "$PWD/src/index.ts" ~/.pi/agent/extensions/grok-usage.ts
```

## License

MIT © Apostol Apostolov

## Related

- [Pi coding agent](https://github.com/badlogic/pi)
- [Grok Build CLI](https://x.ai/news/grok-build-cli)
