import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;
export type WindowName = "5h" | "daily" | "weekly" | "monthly";
export type Theme = ExtensionContext["ui"]["theme"];

export type Preferences = {
	refreshWindow: WindowName;
};

export type UsageWindow = {
	quota: number | null;
	used: number | null;
	subscribeTime: number | null;
	resetTime: number | null;
};

export type UsageSnapshot = {
	planType: string | null;
	windows: Record<WindowName, UsageWindow | null>;
	isLimited: boolean;
};

export const DEFAULT_PREFERENCES = { refreshWindow: "daily" } satisfies Preferences;

const VOLCENGINE_PROVIDER = "volcengine";
const VOLCENGINE_AGENT_PLAN_BASE_URL_PATTERN = /\/api\/plan\//i;

export const windows = {
	"5h": { label: "5h:", responseField: "AFPFiveHour" },
	daily: { label: "day:", responseField: "AFPDaily" },
	weekly: { label: "wk:", responseField: "AFPWeekly" },
	monthly: { label: "mo:", responseField: "AFPMonthly" },
} as const;

export const windowNames = Object.keys(windows) as WindowName[];

export function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function finiteNumber(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isVolcengineAgentPlanModel(model: { provider?: string; baseUrl?: string } | undefined): boolean {
	if (!model) return false;
	if (model.provider === VOLCENGINE_PROVIDER) return true;
	return !!model.baseUrl && VOLCENGINE_AGENT_PLAN_BASE_URL_PATTERN.test(model.baseUrl);
}
