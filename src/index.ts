/**
 * Grok account usage footer for Pi.
 *
 * Polls Grok Build billing (same source as Grok TUI `/usage`) and shows
 * weekly/monthly credit usage in the Pi status bar.
 *
 * Auth: ~/.grok/auth.json OIDC key (from `grok login`)
 * API:  GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 *
 * Commands:
 *   /grok-usage        force refresh + show details
 *   /grok-usage clear  hide footer
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_ID = "grok-usage";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const FETCH_COOLDOWN_MS = 120_000;
const AUTH_PATH = join(homedir(), ".grok", "auth.json");

type PeriodType =
	| "USAGE_PERIOD_TYPE_WEEKLY"
	| "USAGE_PERIOD_TYPE_MONTHLY"
	| string;

interface BillingConfig {
	currentPeriod?: {
		type?: PeriodType;
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
	const weekday = end.toLocaleDateString(undefined, { weekday: "short" }); // e.g. Thu
	const hour = end.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});
	// Some locales still emit "24:xx" or include extra spaces; normalize.
	const hhmm = hour.replace(/^24:/, "00:").trim();
	return `${weekday} ${hhmm}`;
}

function readGrokAuth(): { token: string; email?: string; expiresAt?: string } | null {
	if (!existsSync(AUTH_PATH)) return null;
	try {
		const raw = JSON.parse(readFileSync(AUTH_PATH, "utf8")) as Record<string, GrokAuthEntry>;
		const entries = Object.values(raw).filter((e) => typeof e?.key === "string" && e.key.length > 0);
		if (entries.length === 0) return null;

		// Prefer non-expired token; otherwise most recently expiring entry.
		const now = Date.now();
		const scored = entries
			.map((e) => {
				const exp = e.expires_at ? Date.parse(e.expires_at) : Number.POSITIVE_INFINITY;
				const expired = Number.isFinite(exp) ? exp <= now : false;
				return { e, exp, expired };
			})
			.sort((a, b) => {
				if (a.expired !== b.expired) return a.expired ? 1 : -1;
				return b.exp - a.exp;
			});

		const best = scored[0].e;
		return {
			token: best.key!.trim(),
			email: best.email,
			expiresAt: best.expires_at,
		};
	} catch {
		return null;
	}
}

async function fetchBilling(token: string, signal?: AbortSignal): Promise<UsageSnapshot> {
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
		throw new Error(`auth ${res.status} — run \`grok login\``);
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 160);
		throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
	}

	const data = (await res.json()) as BillingResponse;
	const cfg = data.config ?? {};
	const percent = Number(cfg.creditUsagePercent ?? 0);
	const endIso = cfg.currentPeriod?.end ?? cfg.billingPeriodEnd;
	const periodLabel = periodShort(cfg.currentPeriod?.type);
	const products = (cfg.productUsage ?? [])
		.filter((p) => p.product)
		.map((p) => ({ product: String(p.product), usagePercent: p.usagePercent }));

	return {
		percent: Number.isFinite(percent) ? percent : 0,
		periodLabel,
		resetLabel: resetLocalLabel(endIso),
		endIso,
		products,
		onDemandUsed: Number(cfg.onDemandUsed?.val ?? 0),
		onDemandCap: Number(cfg.onDemandCap?.val ?? 0),
		prepaidBalance: Number(cfg.prepaidBalance?.val ?? 0),
		fetchedAt: Date.now(),
	};
}

function formatFooter(theme: ExtensionContext["ui"]["theme"], snap: UsageSnapshot | null, error?: string): string {
	const label = theme.fg("muted", "Grok:");
	if (error && !snap) {
		return label + theme.fg("warning", "auth?");
	}
	if (!snap) {
		return label + theme.fg("accent", "…");
	}

	// Always one decimal place (e.g. 11.0%, 3.5%).
	const pct = (Math.round(snap.percent * 10) / 10).toFixed(1);
	const pctNum = Number(pct);
	const hot = pctNum >= 80;
	const critical = pctNum >= 95;
	const color = critical ? "error" : hot ? "warning" : "accent";
	// Footer: Grok:11.0% Thu 09:34  (no wk/mo label)
	const parts = [`${pct}%`];
	if (snap.resetLabel) parts.push(snap.resetLabel);
	return label + theme.fg(color as "accent" | "warning" | "error", parts.join(" "));
}

class GrokUsageCache {
	private last: UsageSnapshot | null = null;
	private lastError: string | null = null;
	private lastFetchTime = 0;
	private inflight: Promise<void> | null = null;

	setStatus(ctx: ExtensionContext, forceError?: string): void {
		const status = formatFooter(ctx.ui.theme, this.last, forceError ?? this.lastError ?? undefined);
		ctx.ui.setStatus(STATUS_ID, status);
	}

	clear(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_ID, undefined);
	}

	async update(ctx: ExtensionContext, opts: { force?: boolean } = {}): Promise<UsageSnapshot | null> {
		const now = Date.now();
		if (
			!opts.force &&
			this.last &&
			this.lastFetchTime &&
			now - this.lastFetchTime < FETCH_COOLDOWN_MS
		) {
			this.setStatus(ctx);
			return this.last;
		}

		if (this.inflight && !opts.force) {
			await this.inflight;
			this.setStatus(ctx);
			return this.last;
		}

		const run = (async () => {
			const auth = readGrokAuth();
			if (!auth) {
				this.lastError = "no ~/.grok/auth.json token";
				this.setStatus(ctx, this.lastError);
				return;
			}

			// Soft-warn if token looks expired; still try (refresh may have updated key elsewhere).
			if (auth.expiresAt) {
				const exp = Date.parse(auth.expiresAt);
				if (Number.isFinite(exp) && exp <= Date.now()) {
					// Keep going; API may still accept or return 401.
				}
			}

			try {
				const snap = await fetchBilling(auth.token);
				snap.email = auth.email;
				this.last = snap;
				this.lastError = null;
				this.lastFetchTime = Date.now();
				this.setStatus(ctx);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				this.lastError = msg;
				this.lastFetchTime = Date.now();
				// Keep stale data if we have it.
				this.setStatus(ctx, this.last ? undefined : msg);
			}
		})();

		this.inflight = run.finally(() => {
			this.inflight = null;
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
		const pct = (Math.round(s.percent * 10) / 10).toFixed(1);
		const lines = [
			`Grok usage: ${pct}%` + (s.periodLabel ? ` (${s.periodLabel})` : ""),
		];
		if (s.endIso) {
			const end = new Date(s.endIso);
			lines.push(`Period ends: ${end.toISOString()} (local ${s.resetLabel || "—"})`);
		}
		if (s.email) lines.push(`Account: ${s.email}`);
		if (s.products.length) {
			lines.push("Products:");
			for (const p of s.products) {
				const pct = p.usagePercent == null ? "—" : `${p.usagePercent}%`;
				lines.push(`  - ${p.product}: ${pct}`);
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

	pi.on("session_start", async (_event, ctx) => {
		// Fire-and-forget: never block session startup.
		cache.update(ctx).catch(() => {});
	});

	pi.on("turn_end", async (_event, ctx) => {
		cache.update(ctx).catch(() => {});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cache.clear(ctx);
	});

	pi.registerCommand("grok-usage", {
		description: "Show/refresh Grok account credit usage in the footer",
		handler: async (args, ctx) => {
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
