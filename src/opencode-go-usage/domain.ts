import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type JsonObject = Record<string, unknown>;
export type PercentMode = "left" | "used";
export type WindowName = "rolling" | "weekly" | "monthly";
export type Theme = ExtensionContext["ui"]["theme"];

export type Preferences = {
	usageMode: PercentMode;
	refreshWindow: WindowName;
};

export type UsageWindow = {
	usagePercent: number | null;
	resetInSec: number | null;
};

export type UsageSnapshot = {
	windows: Record<WindowName, UsageWindow | null>;
	isLimited: boolean;
};

export const DEFAULT_PREFERENCES = { usageMode: "left", refreshWindow: "weekly" } satisfies Preferences;

export const OPENCODE_GO_PROVIDER = "opencode-go";

export const windows = {
	rolling: { label: "roll:", short: "R" },
	weekly: { label: "wk:", short: "W" },
	monthly: { label: "mo:", short: "M" },
} as const;

export const windowNames = Object.keys(windows) as WindowName[];

export function asObject(value: unknown): JsonObject | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isOpenCodeGoProvider(provider: string | undefined): boolean {
	return !!provider && provider === OPENCODE_GO_PROVIDER;
}
