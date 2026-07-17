# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-07-17

### Changed

- Footer percent always shows **one decimal** (e.g. `11.0%`)
- Removed period label (`wk` / `mo`) from the footer
- Reset time is now **local** `WWW HH:mm` (e.g. `Thu 09:34`)

## [1.0.0] - 2026-07-17

### Added

- Initial public release
- Footer status showing Grok/xAI credit usage percent
- Weekly/monthly period label and reset weekday
- Color thresholds: warning at 80%, error at 95%
- Auth via existing `~/.grok/auth.json` (from `grok login`)
- Billing fetch from `cli-chat-proxy.grok.com` (same source as Grok TUI `/usage`)
- 120s cache + in-flight request coalescing
- Auto-refresh on session start and turn end
- `/grok-usage` command for forced refresh + detailed breakdown
- `/grok-usage clear` to hide the footer

[1.0.1]: https://github.com/apoapostolov/pi-grok-usage/releases/tag/v1.0.1
[1.0.0]: https://github.com/apoapostolov/pi-grok-usage/releases/tag/v1.0.0
