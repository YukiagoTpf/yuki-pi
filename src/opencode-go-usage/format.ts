import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	windowNames,
	windows,
	type PercentMode,
	type Preferences,
	type Theme,
	type UsageSnapshot,
} from "./domain.ts";

function formatPercent(theme: Theme, usagePercent: number | null, mode: PercentMode): string {
	if (usagePercent === null) return theme.fg("muted", "--");

	const leftPercent = Math.max(0, Math.min(100, 100 - usagePercent));
	const color = leftPercent <= 10 ? "error" : leftPercent <= 25 ? "warning" : "success";
	const displayed = mode === "left" ? leftPercent : usagePercent;
	return theme.fg(color, `${Math.round(displayed)}% ${mode}`);
}

function formatCountdown(seconds: number | null): string | null {
	if (seconds === null || Number.isNaN(seconds)) return null;
	const total = Math.max(0, Math.round(seconds));
	const days = Math.floor(total / 86_400);
	const hours = Math.floor((total % 86_400) / 3_600);
	const minutes = Math.floor((total % 3_600) / 60);
	if (days) return `${days}d${hours}h`;
	if (hours) return `${hours}h${minutes}m`;
	return minutes ? `${minutes}m` : `${total % 60}s`;
}

export function formatStatus(ctx: ExtensionContext, usage: UsageSnapshot, preferences: Preferences): string {
	const theme = ctx.ui.theme;
	const title = theme.fg(usage.isLimited ? "error" : "dim", "opencode-go");
	const usageText = windowNames
		.map(name => {
			const window = usage.windows[name];
			if (!window) return "";
			return `${theme.fg("dim", windows[name].label)}${formatPercent(theme, window.usagePercent, preferences.usageMode)}`;
		})
		.filter(Boolean)
		.join(" ");
	const focus = usage.windows[preferences.refreshWindow];
	const reset = focus ? formatCountdown(focus.resetInSec) : null;
	const resetText = reset ? theme.fg("dim", ` (${windows[preferences.refreshWindow].label}↺${reset})`) : "";
	return `${title} ${usageText}${resetText}`;
}

export function unavailableStatus(ctx: ExtensionContext): string {
	return ctx.ui.theme.fg("warning", "opencode-go unavailable");
}
