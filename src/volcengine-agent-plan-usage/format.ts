import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	windowNames,
	windows,
	type Preferences,
	type Theme,
	type UsageSnapshot,
	type UsageWindow,
} from "./domain.ts";

function leftPercent(window: UsageWindow): number | null {
	if (window.quota === null || window.used === null || window.quota <= 0) return null;
	return Math.max(0, Math.min(100, ((window.quota - window.used) / window.quota) * 100));
}

function colorForLeftPercent(percentLeft: number | null): "muted" | "error" | "warning" | "success" {
	if (percentLeft === null) return "muted";
	if (percentLeft <= 10) return "error";
	if (percentLeft <= 25) return "warning";
	return "success";
}

function formatCapacity(theme: Theme, window: UsageWindow | null): string {
	if (!window || window.quota === null || window.used === null) return theme.fg("muted", "--");

	const percentLeft = leftPercent(window);
	const color = colorForLeftPercent(percentLeft);
	return theme.fg(color, `${Math.round(percentLeft ?? 0)}%`);
}

function formatCountdownFromEpochMillis(epochMillis: number | null | undefined): string | null {
	if (epochMillis === null || epochMillis === undefined || Number.isNaN(epochMillis)) return null;

	const total = Math.max(0, Math.round((epochMillis - Date.now()) / 1000));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);

	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${minutes}m`;
	return minutes ? `${minutes}m` : `${total % 60}s`;
}

function title(snapshot: UsageSnapshot): string {
	return snapshot.planType ? `Volcengine Agent Plan(${snapshot.planType})` : "Volcengine Agent Plan";
}

export function formatStatus(ctx: ExtensionContext, usage: UsageSnapshot, preferences: Preferences): string {
	const theme = ctx.ui.theme;
	const usageText = windowNames
		.map(name => `${theme.fg("dim", windows[name].label)}${formatCapacity(theme, usage.windows[name])}`)
		.join(" ");
	const focus = usage.windows[preferences.refreshWindow];
	const reset = focus ? formatCountdownFromEpochMillis(focus.resetTime) : null;
	const resetText = reset ? theme.fg("dim", ` (${windows[preferences.refreshWindow].label}↺${reset})`) : "";
	return `${theme.fg(usage.isLimited ? "error" : "dim", title(usage))} ${usageText}${resetText}`;
}

export function unavailableStatus(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("warning", "Volcengine Agent Plan unavailable");
}
