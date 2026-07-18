# Changelog

## 1.0.1

### Fixed
- Refresh actually runs on schedule: interval tick is 4m45s so it no longer no-ops against the 5-min cooldown edge
- Prompt-time refresh on `agent_start` (not only after `turn_end`)
- Failed fetches use a 30s retry instead of locking out for a full 5 minutes
- Stale session context on the idle timer no longer kills refresh silently forever
- Stop dual-writing Grok into both powerbar and the built-in footer
- When pi-powerbar is installed and the `grok-usage` segment is enabled → powerbar only
- Otherwise → footer `setStatus` only

### Added
- Powerbar segment (`grok-usage`) via `powerbar:update` so usage shows when pi-powerbar is installed
- Keep `ctx.ui.setStatus` for non-powerbar sessions (exclusive with powerbar — never both)

## 1.0.0

Initial release: Grok/xAI account credit usage in the Pi status bar via `~/.grok/auth.json` and the Grok Build billing API.
