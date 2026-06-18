import {
	asObject,
	windowNames,
	type JsonObject,
	type UsageSnapshot,
	type UsageWindow,
} from "./domain.ts";
import { CREDENTIALS_FILE, loadCredentials } from "./preferences.ts";

const USAGE_URL = (workspaceId: string) => `https://opencode.ai/workspace/${encodeURIComponent(workspaceId)}/go`;
const USER_AGENT = "yuki-pi-opencode-go-usage/0.1";
export const MISSING_AUTH_ERROR = "Missing opencode-go workspace/auth credentials";

type RawWindow = {
	usagePercent?: number | string | null;
	resetInSec?: number | string | null;
};

export async function requestUsage(): Promise<UsageSnapshot> {
	const { workspaceId, authCookie } = await loadCredentials();
	const response = await fetch(USAGE_URL(workspaceId), {
		headers: {
			accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			cookie: `auth=${authCookie}`,
			"user-agent": USER_AGENT,
		},
	});

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) {
			throw new Error(`opencode-go auth failed (${response.status}); refresh the auth cookie in ${CREDENTIALS_FILE}`);
		}
		throw new Error(`opencode-go usage request failed (${response.status}) for ${USAGE_URL(workspaceId)}`);
	}

	const html = await response.text();
	const snapshot = parseSnapshot(html);
	if (snapshot.windows.rolling === null && snapshot.windows.weekly === null && snapshot.windows.monthly === null) {
		throw new Error("Could not parse opencode-go quota from the page; the format may have changed.");
	}
	return snapshot;
}

function parseSnapshot(html: string): UsageSnapshot {
	const windows: UsageSnapshot["windows"] = { rolling: null, weekly: null, monthly: null };
	let isLimited = false;
	for (const name of windowNames) {
		const raw = parseObjectLiteral(html, `${name}Usage`);
		if (!raw) continue;
		const window = toWindow(raw);
		if (window) windows[name] = window;
		const usagePercent = asNumber(raw.usagePercent);
		if (asNumber(raw.limitReached) === 1 || (usagePercent !== null && usagePercent >= 100)) isLimited = true;
	}
	return { windows, isLimited };
}

function toWindow(raw: JsonObject): UsageWindow | null {
	const usagePercent = asNumber(raw.usagePercent);
	const resetInSec = asNumber(raw.resetInSec);
	if (usagePercent === null || resetInSec === null) return null;
	return {
		usagePercent: Math.min(100, Math.max(0, Math.round(usagePercent))),
		resetInSec: Math.max(0, Math.round(resetInSec)),
	};
}

function asNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * Find an object literal assigned to `fieldName` in the rendered HTML and
 * parse it. opencode.ai renders quota as JS object literals such as
 * `weeklyUsage: { usagePercent: 42, resetInSec: 3600, ... }`, sometimes via
 * a compiled reference like `weeklyUsage: $R[12] = { ... }`.
 */
function parseObjectLiteral(html: string, fieldName: string): JsonObject | null {
	const literal = extractObjectLiteral(html, fieldName);
	if (!literal) return null;
	return parseLooseObject(literal);
}

function extractObjectLiteral(html: string, fieldName: string): string | null {
	const patterns = [
		new RegExp(`${escapeRegExp(fieldName)}\\s*:\\s*\\$R\\[\\d+\\]\\s*=\\s*\\{`),
		new RegExp(`"${escapeRegExp(fieldName)}"\\s*:\\s*\\{`),
		new RegExp(`${escapeRegExp(fieldName)}\\s*:\\s*\\{`),
		new RegExp(`${escapeRegExp(fieldName)}\\s*=\\s*\\{`),
	];

	for (const pattern of patterns) {
		const match = pattern.exec(html);
		if (!match || match.index === undefined) continue;
		const start = match.index + match[0].lastIndexOf("{");
		const literal = readObjectLiteral(html, start);
		if (literal) return literal;
	}
	return null;
}

function readObjectLiteral(html: string, start: number): string | null {
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	let escaped = false;

	for (let i = start; i < html.length; i++) {
		const ch = html[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if ((inSingle || inDouble || inBacktick) && ch === "\\") {
			escaped = true;
			continue;
		}
		if (!inDouble && !inBacktick && ch === "'") {
			inSingle = !inSingle;
			continue;
		}
		if (!inSingle && !inBacktick && ch === '"') {
			inDouble = !inDouble;
			continue;
		}
		if (!inSingle && !inDouble && ch === "`") {
			inBacktick = !inBacktick;
			continue;
		}
		if (inSingle || inDouble || inBacktick) continue;
		if (ch === "{") depth++;
		if (ch === "}") {
			depth--;
			if (depth === 0) return html.slice(start, i + 1);
		}
	}
	return null;
}

function parseLooseObject(input: string): JsonObject | null {
	const normalized = input
		.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/g, '$1"$2"$3')
		.replace(/'((?:\\.|[^'\\])*)'/g, (_, v: string) => `"${v.replace(/"/g, '\\"')}"`)
		.replace(/("(?:\\.|[^"\\])*")|\bundefined\b/g, (_, quoted: string | undefined) => quoted ?? "null")
		.replace(/,\s*([}\]])/g, "$1");
	try {
		const parsed = JSON.parse(normalized);
		return asObject(parsed) ?? null;
	} catch {
		return null;
	}
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function getUsage(): Promise<UsageSnapshot> {
	return requestUsage();
}

// Re-export so the extension can surface a helpful "configure" hint.
export { CREDENTIALS_FILE };
export type { Credentials } from "./preferences.ts";
