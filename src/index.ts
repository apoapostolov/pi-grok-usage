/**
 * Grok account usage footer for Pi.
 *
 * Polls Grok Build billing (same source as Grok TUI `/usage`) and shows
 * credit usage in the Pi status bar (setStatus) and powerbar (if installed).
 *
 * Auth: ~/.grok/auth.json OIDC key (from `grok login`), with refresh support
 * API:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * Refresh:
 *   - session_start: initial fetch + start 5-min timer
 *   - agent_start:   prompt-time refresh when cooldown elapsed
 *   - turn_end:      post-turn refresh when cooldown elapsed
 *   - interval:      idle refresh (~every 5 min)
 *   - /grok-usage:   force refresh + details
 *
 * Commands:
 *   /grok-usage        force refresh + show details
 *   /grok-usage clear  hide footer / powerbar segment
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_ID = "grok-usage";
const POWERBAR_SEGMENT_ID = "grok-usage";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** Minimum time between successful fetches. */
const FETCH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
/** Retry sooner after a failed fetch (don't lock out for a full cooldown). */
const ERROR_RETRY_MS = 30 * 1000; // 30 seconds
/** Interval tick slightly under cooldown so timer edges don't no-op. */
const PERIODIC_TICK_MS = FETCH_COOLDOWN_MS - 15_000; // 4m45s
const REQUEST_TIMEOUT_MS = 10_000;
/** Refresh a bit before expiry to avoid edge races. */
const EXPIRY_SKEW_MS = 60_000;
const AUTH_PATH = join(homedir(), ".grok", "auth.json");
const DEFAULT_ISSUER = "https://auth.x.ai";

interface BillingConfig {
	currentPeriod?: {
		type?: string;
		start?: string;
		end?: string;
	};
	creditUsagePercent?: number;
	onDemandCap?: { val?: number };
	onDemandUsed?: { val?: number };
	prepaidBalance?: { val?: number };
	productUsage?: Array<{ product?: string; usagePercent?: number }>;
	isUnifiedBillingUser?: boolean;
	billingPeriodStart?: string;
	billingPeriodEnd?: string;
}

interface BillingResponse {
	config?: BillingConfig;
}

interface GrokAuthEntry {
	key?: string;
	refresh_token?: string;
	expires_at?: string;
	email?: string;
	auth_mode?: string;
	oidc_issuer?: string;
	oidc_client_id?: string;
}

interface ResolvedAuth {
	/** Map key inside auth.json */
	entryId: string;
	token: string;
	refreshToken?: string;
	email?: string;
	expiresAtMs?: number;
	issuer: string;
	clientId?: string;
}

interface UsageSnapshot {
	percent: number;
	periodLabel: string;
	resetLabel: string;
	endIso?: string;
	email?: string;
	products: Array<{ product: string; usagePercent?: number }>;
	onDemandUsed: number;
	onDemandCap: number;
	prepaidBalance: number;
	fetchedAt: number;
}

type PublishFn = (status: string | undefined, snap: UsageSnapshot | null, error?: string) => void;

function periodShort(type?: string): string {
	if (!type) return "";
	if (type.includes("WEEKLY")) return "weekly";
	if (type.includes("MONTHLY")) return "monthly";
	if (type.includes("DAILY")) return "daily";
	return "period";
}

/** Footer reset label: 3-char weekday + local hour:minute, e.g. "Thu 09:34". */
function resetLocalLabel(endIso?: string): string {
	if (!endIso) return "";
	const end = new Date(endIso);
	if (Number.isNaN(end.getTime())) return "";
	const weekday = end.toLocaleDateString(undefined, { weekday: "short" });
	const hour = end.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	const hhmm = hour.replace(/^24:/, "00:").trim();
	return `${weekday} ${hhmm}`;
}

function formatPercent(n: number): string {
	// Grok billing reports whole-number percents; keep display as integer.
	return String(Math.round(Number.isFinite(n) ? n : 0));
}

function usageColor(pctNum: number): "accent" | "warning" | "error" {
	if (pctNum >= 95) return "error";
	if (pctNum >= 80) return "warning";
	return "accent";
}

function powerbarColor(pctNum: number): string {
	if (pctNum >= 95) return "error";
	if (pctNum >= 80) return "warning";
	return "muted";
}

/** Never surface raw upstream bodies (may contain tokens or HTML dumps). */
function sanitizeError(err: unknown): string {
	if (err instanceof Error) {
		const msg = err.message || "unknown error";
		if (/^auth \d+/.test(msg) || msg.startsWith("HTTP ")) return msg;
		if (msg.includes("abort") || msg.includes("Timeout") || msg.includes("timeout")) {
			return "request timeout";
		}
		if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("ECONN")) {
			return "network error";
		}
		if (msg.includes("refresh")) return "token refresh failed — run `grok login`";
		if (msg.includes("auth.json")) return msg;
		if (msg.includes("stale after session")) return "stale context";
		return "request failed";
	}
	return "request failed";
}

function isStaleContextError(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err);
	return msg.includes("stale after session") || msg.includes("extension ctx is stale");
}

function isAllowedXaiUrl(raw: string): boolean {
	try {
		const url = new URL(raw);
		return url.protocol === "https:" && (url.hostname === "x.ai" || url.hostname.endsWith(".x.ai"));
	} catch {
		return false;
	}
}

function readAuthFile(): Record<string, GrokAuthEntry> | null {
	if (!existsSync(AUTH_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, GrokAuthEntry>;
		if (!raw || typeof raw !== "object") return null;
		return raw;
	} catch {
		return null;
	}
}

function pickAuthEntry(file: Record<string, GrokAuthEntry>): ResolvedAuth | null {
	const now = Date.now();
	const scored = Object.entries(file)
		.map(([entryId, e]) => {
			const token = typeof e?.key === "string" ? e.key.trim() : "";
			const exp = e?.expires_at ? Date.parse(e.expires_at) : Number.POSITIVE_INFINITY;
			const expired = Number.isFinite(exp) ? exp <= now + EXPIRY_SKEW_MS : false;
			const hasRefresh = typeof e?.refresh_token === "string" && e.refresh_token.length > 0;
			return { entryId, e, token, exp, expired, hasRefresh };
		})
		.filter((x) => x.token.length > 0 || x.hasRefresh);

	if (scored.length === 0) return null;

	scored.sort((a, b) => {
		// Prefer usable access tokens, then ones with refresh, then latest expiry.
		if (a.expired !== b.expired) return a.expired ? 1 : -1;
		if (a.hasRefresh !== b.hasRefresh) return a.hasRefresh ? -1 : 1;
		return b.exp - a.exp;
	});

	const best = scored[0];
	const issuer = (best.e.oidc_issuer || DEFAULT_ISSUER).replace(/\/$/, "");
	return {
		entryId: best.entryId,
		token: best.token,
		refreshToken: best.e.refresh_token?.trim() || undefined,
		email: best.e.email,
		expiresAtMs: Number.isFinite(best.exp) ? best.exp : undefined,
		issuer,
		clientId: best.e.oidc_client_id?.trim() || undefined,
	};
}

function writeRefreshedTokens(
	entryId: string,
	update: { access: string; refresh?: string; expiresAtIso: string },
): void {
	const file = readAuthFile();
	if (!file || !file[entryId]) return;
	const next = {
		...file,
		[entryId]: {
			...file[entryId],
			key: update.access,
			...(update.refresh ? { refresh_token: update.refresh } : {}),
			expires_at: update.expiresAtIso,
		},
	};
	// Keep permissions as restrictive as we can without chmod portability issues.
	writeFileSync(AUTH_PATH, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8" });
}

async function discoverTokenEndpoint(issuer: string, signal: AbortSignal): Promise<string> {
	const discoveryUrl = `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
	if (!isAllowedXaiUrl(discoveryUrl)) {
		throw new Error("invalid oidc issuer");
	}
	const res = await fetch(discoveryUrl, {
		headers: { Accept: "application/json" },
		signal,
	});
	if (!res.ok) throw new Error(`token refresh failed (discovery HTTP ${res.status})`);
	const json = (await res.json()) as { token_endpoint?: string };
	const endpoint = String(json.token_endpoint || "");
	if (!isAllowedXaiUrl(endpoint)) throw new Error("invalid token endpoint");
	return endpoint;
}

async function refreshAccessToken(auth: ResolvedAuth, signal: AbortSignal): Promise<ResolvedAuth> {
	if (!auth.refreshToken) {
		throw new Error("auth expired — run `grok login`");
	}
	if (!auth.clientId) {
		throw new Error("auth missing client id — run `grok login`");
	}

	const tokenEndpoint = await discoverTokenEndpoint(auth.issuer, signal);
	const res = await fetch(tokenEndpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"User-Agent": "pi-grok-usage/1.0",
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: auth.clientId,
			refresh_token: auth.refreshToken,
		}).toString(),
		signal,
	});

	if (!res.ok) {
		throw new Error(`token refresh failed (HTTP ${res.status})`);
	}

	const payload = (await res.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	const access = String(payload.access_token || "").trim();
	if (!access) throw new Error("token refresh failed (empty access token)");

	const expiresInSec = Number(payload.expires_in || 3600);
	const expiresAtMs = Date.now() + Math.max(60, expiresInSec) * 1000;
	const expiresAtIso = new Date(expiresAtMs).toISOString();
	const refresh = String(payload.refresh_token || auth.refreshToken).trim();

	try {
		writeRefreshedTokens(auth.entryId, {
			access,
			refresh,
			expiresAtIso,
		});
	} catch {
		// Non-fatal: still use the fresh token in-memory this session.
	}

	return {
		...auth,
		token: access,
		refreshToken: refresh,
		expiresAtMs,
	};
}

function needsRefresh(auth: ResolvedAuth): boolean {
	if (!auth.token) return true;
	if (auth.expiresAtMs == null) return false;
	return auth.expiresAtMs <= Date.now() + EXPIRY_SKEW_MS;
}

async function resolveAuth(signal: AbortSignal): Promise<ResolvedAuth> {
	const file = readAuthFile();
	if (!file) throw new Error("no ~/.grok/auth.json — run `grok login`");
	const auth = pickAuthEntry(file);
	if (!auth) throw new Error("no usable Grok credentials — run `grok login`");

	if (needsRefresh(auth)) {
		return refreshAccessToken(auth, signal);
	}
	return auth;
}

async function fetchBilling(token: string, signal: AbortSignal): Promise<UsageSnapshot> {
	const res = await fetch(BILLING_URL, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"User-Agent": "pi-grok-usage/1.0",
			"x-grok-client-mode": "cli",
		},
		signal,
	});

	if (res.status === 401 || res.status === 403) {
		throw new Error(`auth ${res.status}`);
	}
	if (!res.ok) {
		// Do not include response body in errors.
		throw new Error(`HTTP ${res.status}`);
	}

	const data = (await res.json()) as BillingResponse;
	const cfg = data.config ?? {};
	const percent = Number(cfg.creditUsagePercent ?? 0);
	const endIso = cfg.currentPeriod?.end ?? cfg.billingPeriodEnd;
	const products = (cfg.productUsage ?? [])
		.filter((p) => p.product)
		.map((p) => ({ product: String(p.product), usagePercent: p.usagePercent }));

	return {
		percent: Number.isFinite(percent) ? percent : 0,
		periodLabel: periodShort(cfg.currentPeriod?.type),
		resetLabel: resetLocalLabel(endIso),
		endIso,
		products,
		onDemandUsed: Number(cfg.onDemandUsed?.val ?? 0),
		onDemandCap: Number(cfg.onDemandCap?.val ?? 0),
		prepaidBalance: Number(cfg.prepaidBalance?.val ?? 0),
		fetchedAt: Date.now(),
	};
}

function formatFooter(
	theme: ExtensionContext["ui"]["theme"],
	snap: UsageSnapshot | null,
	error?: string,
): string {
	const label = theme.fg("muted", "Grok:");
	if (error && !snap) {
		return label + theme.fg("warning", "auth?");
	}
	if (!snap) {
		return label + theme.fg("accent", "…");
	}

	const pct = formatPercent(snap.percent);
	const pctNum = Number(pct);
	const color = usageColor(pctNum);
	const parts = [`${pct}%`];
	if (snap.resetLabel) parts.push(snap.resetLabel);
	return label + theme.fg(color, parts.join(" "));
}

class GrokUsageCache {
	private last: UsageSnapshot | null = null;
	private lastError: string | null = null;
	/** Timestamp of last successful fetch (drives success cooldown). */
	private lastSuccessTime = 0;
	/** Timestamp of last failed fetch (drives short error backoff). */
	private lastErrorTime = 0;
	private inflight: Promise<void> | null = null;
	private generation = 0;
	private publish: PublishFn = () => {};

	setPublisher(publish: PublishFn): void {
		this.publish = publish;
	}

	private emit(ctx: ExtensionContext, forceError?: string): void {
		const error = forceError ?? this.lastError ?? undefined;
		const status = formatFooter(ctx.ui.theme, this.last, error);
		// Always attempt setStatus (built-in footer). Powerbar publish is separate.
		ctx.ui.setStatus(STATUS_ID, status);
		this.publish(status, this.last, error);
	}

	setStatus(ctx: ExtensionContext, forceError?: string): void {
		this.emit(ctx, forceError);
	}

	clear(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, undefined);
		this.publish(undefined, null);
	}

	/** True when a network fetch is allowed under cooldown rules. */
	private canFetch(force: boolean): boolean {
		if (force) return true;
		const now = Date.now();

		// Successful fetch: full 5-min cooldown.
		if (this.lastSuccessTime && now - this.lastSuccessTime < FETCH_COOLDOWN_MS) {
			return false;
		}

		// Failed fetch (and no newer success): short backoff only.
		if (this.lastErrorTime > this.lastSuccessTime && now - this.lastErrorTime < ERROR_RETRY_MS) {
			return false;
		}

		return true;
	}

	async update(ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
		const force = opts.force === true;

		if (!this.canFetch(force)) {
			this.setStatus(ctx);
			return this.last;
		}

		if (this.inflight && !force) {
			await this.inflight;
			this.setStatus(ctx);
			return this.last;
		}

		const gen = ++this.generation;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

		const run = (async () => {
			try {
				let auth = await resolveAuth(controller.signal);
				try {
					const snap = await fetchBilling(auth.token, controller.signal);
					if (gen !== this.generation) return; // superseded by a newer force refresh
					snap.email = auth.email;
					this.last = snap;
					this.lastError = null;
					this.lastSuccessTime = Date.now();
					this.lastErrorTime = 0;
					this.setStatus(ctx);
					return;
				} catch (err) {
					// One retry after forced refresh on auth failure.
					const msg = err instanceof Error ? err.message : "";
					if (msg.startsWith("auth ") && auth.refreshToken) {
						auth = await refreshAccessToken(auth, controller.signal);
						const snap = await fetchBilling(auth.token, controller.signal);
						if (gen !== this.generation) return;
						snap.email = auth.email;
						this.last = snap;
						this.lastError = null;
						this.lastSuccessTime = Date.now();
						this.lastErrorTime = 0;
						this.setStatus(ctx);
						return;
					}
					throw err;
				}
			} catch (err) {
				if (gen !== this.generation) return;
				if (isStaleContextError(err)) {
					// Don't burn cooldown on stale ctx — caller should rebind.
					throw err;
				}
				this.lastError = sanitizeError(err);
				this.lastErrorTime = Date.now();
				// Keep stale data if we have it; do NOT advance success cooldown.
				this.setStatus(ctx, this.last ? undefined : this.lastError);
			} finally {
				clearTimeout(timeout);
			}
		})();

		this.inflight = run.finally(() => {
			if (this.inflight === run) this.inflight = null;
		});
		await this.inflight;
		return this.last;
	}

	details(): string {
		if (this.lastError && !this.last) {
			return `Grok usage unavailable: ${this.lastError}\nRun: grok login`;
		}
		if (!this.last) return "Grok usage: not fetched yet.";

		const s = this.last;
		const pct = formatPercent(s.percent);
		const lines = [
			`Grok usage: ${pct}%` + (s.periodLabel ? ` (${s.periodLabel})` : ""),
		];
		if (s.endIso) {
			lines.push(`Period ends: ${new Date(s.endIso).toISOString()} (local ${s.resetLabel || "—"})`);
		}
		if (s.email) lines.push(`Account: ${s.email}`);
		if (s.products.length) {
			lines.push("Products:");
			for (const p of s.products) {
				const pPct = p.usagePercent == null ? "—" : `${formatPercent(Number(p.usagePercent))}%`;
				lines.push(`  - ${p.product}: ${pPct}`);
			}
		}
		if (s.onDemandCap > 0 || s.onDemandUsed > 0) {
			lines.push(`On-demand: ${s.onDemandUsed} / ${s.onDemandCap}`);
		}
		if (s.prepaidBalance > 0) {
			lines.push(`Prepaid balance: ${s.prepaidBalance}`);
		}
		if (this.lastError) lines.push(`Last error: ${this.lastError}`);
		const ageSec = Math.round((Date.now() - s.fetchedAt) / 1000);
		lines.push(`Fetched: ${ageSec}s ago`);
		return lines.join("\n");
	}
}

export default function (pi: ExtensionAPI) {
	const cache = new GrokUsageCache();
	let lastCtx: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let powerbarRegistered = false;

	const ensurePowerbarSegment = () => {
		if (powerbarRegistered) return;
		powerbarRegistered = true;
		try {
			pi.events.emit("powerbar:register-segment", {
				id: POWERBAR_SEGMENT_ID,
				label: "Grok Usage",
			});
		} catch {
			// powerbar may not be installed — fine
		}
	};

	const publishToPowerbar: PublishFn = (_status, snap, error) => {
		try {
			ensurePowerbarSegment();
			if (!snap && error) {
				pi.events.emit("powerbar:update", {
					id: POWERBAR_SEGMENT_ID,
					text: "auth?",
					color: "warning",
				});
				return;
			}
			if (!snap) {
				// Loading or cleared
				if (_status === undefined) {
					pi.events.emit("powerbar:update", {
						id: POWERBAR_SEGMENT_ID,
						text: undefined,
					});
				} else {
					pi.events.emit("powerbar:update", {
						id: POWERBAR_SEGMENT_ID,
						text: "…",
						color: "muted",
					});
				}
				return;
			}

			const pctNum = Math.round(snap.percent);
			const reset = snap.resetLabel || "";
			const textParts = ["Grok"];
			if (reset) textParts.push(reset);

			pi.events.emit("powerbar:update", {
				id: POWERBAR_SEGMENT_ID,
				text: textParts.join(" "),
				suffix: `${pctNum}%`,
				bar: pctNum,
				barSegments: 10,
				color: powerbarColor(pctNum),
			});
		} catch {
			// powerbar absent or event bus unavailable
		}
	};

	cache.setPublisher(publishToPowerbar);

	const remember = (ctx: ExtensionContext) => {
		lastCtx = ctx;
	};

	const stopPeriodicRefresh = () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
	};

	const startPeriodicRefresh = () => {
		if (refreshTimer) return;
		refreshTimer = setInterval(() => {
			const ctx = lastCtx;
			if (!ctx) return;
			// Cooldown still applies; tick is slightly under 5m so edges don't miss.
			cache.update(ctx).catch((err) => {
				if (isStaleContextError(err)) {
					// Session was replaced — drop dead ctx and wait for a live event.
					lastCtx = null;
					return;
				}
				// Soft-fail: keep last known status; next tick/event retries.
			});
		}, PERIODIC_TICK_MS);
		// Don't keep the process alive solely for this timer if Pi exits.
		if (typeof refreshTimer === "object" && refreshTimer && "unref" in refreshTimer) {
			(refreshTimer as NodeJS.Timeout).unref?.();
		}
	};

	const kick = (ctx: ExtensionContext, opts?: { force?: boolean }) => {
		remember(ctx);
		startPeriodicRefresh();
		cache.update(ctx, opts).catch((err) => {
			if (isStaleContextError(err)) {
				lastCtx = null;
			}
		});
	};

	// Register powerbar segment early so settings UI can list it.
	ensurePowerbarSegment();

	pi.on("session_start", async (_event, ctx) => {
		// Fire-and-forget: never block session startup.
		kick(ctx);
	});

	// Prompt-time: refresh as soon as a new agent run starts if cooldown elapsed.
	pi.on("agent_start", async (_event, ctx) => {
		kick(ctx);
	});

	// Post-turn: catch usage that landed during the turn.
	pi.on("turn_end", async (_event, ctx) => {
		kick(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPeriodicRefresh();
		lastCtx = null;
		try {
			cache.clear(ctx);
		} catch {
			// ctx may already be tearing down
			try {
				pi.events.emit("powerbar:update", {
					id: POWERBAR_SEGMENT_ID,
					text: undefined,
				});
			} catch {
				// ignore
			}
		}
	});

	pi.registerCommand("grok-usage", {
		description: "Show/refresh Grok account credit usage in the footer",
		handler: async (args, ctx) => {
			remember(ctx);
			startPeriodicRefresh();
			const cmd = (args ?? "").trim().toLowerCase();
			if (cmd === "clear" || cmd === "hide" || cmd === "off") {
				cache.clear(ctx);
				ctx.ui.notify("Grok usage footer cleared", "info");
				return;
			}
			await cache.update(ctx, { force: true });
			ctx.ui.notify(cache.details(), "info");
		},
	});
}
