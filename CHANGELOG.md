# Changelog

## 1.0.1

### Fixed
- Idle refresh cadence is 10 min (cooldown + 5s tick). Earlier 1.0.1 used a 4m45s tick against a 5m cooldown, so every other tick no-op'd and real idle fetches only ran every ~9.5 min
- Prompt-time refresh on `agent_start` (not only after `turn_end`)
- Failed fetches use a 30s retry instead of locking out for a full cooldown window
- Stale session context no longer kills idle refresh forever: powerbar paint does not require a live footer ctx, and the timer keeps polling when `lastCtx` is missing until a live event rebinds it
- Stop dual-writing Grok into both powerbar and the built-in footer
- When pi-powerbar is installed and the `grok-usage` segment is enabled → powerbar only
- Otherwise → footer `setStatus` only

### Changed
- Default poll / success cooldown is **10 minutes** (was documented as 5)

### Added
- Powerbar segment (`grok-usage`) via `powerbar:update` so usage shows when pi-powerbar is installed
- Keep `ctx.ui.setStatus` for non-powerbar sessions (exclusive with powerbar — never both)

## 1.0.0

Initial release: Grok/xAI account credit usage in the Pi status bar via `~/.grok/auth.json` and the Grok Build billing API.
