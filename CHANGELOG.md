# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-17

### Added

- Initial public release
- Footer status showing Grok/xAI account credit usage
- Always one-decimal percent (e.g. `11.0%`)
- Local reset label as 3-char weekday + hour:minute (e.g. `Thu 23:34`)
- Color thresholds: warning at 80%, error at 95%
- Auth via existing `~/.grok/auth.json` (from `grok login`)
- Billing fetch from `cli-chat-proxy.grok.com` (same source as Grok TUI `/usage`)
- 120s cache + in-flight request coalescing
- Auto-refresh on session start and turn end
- `/grok-usage` command for forced refresh + detailed breakdown
- `/grok-usage clear` to hide the footer

### Footer format

```text
Grok:11.0% Thu 23:34
```

[1.0.0]: https://github.com/apoapostolov/pi-grok-usage/releases/tag/v1.0.0
