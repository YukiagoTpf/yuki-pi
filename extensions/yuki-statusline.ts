import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 8;

type Theme = ExtensionContext["ui"]["theme"];

export default function yukiStatuslineExtension(pi: ExtensionAPI) {
	let enabled = true;

	pi.on("session_start", async (_event, ctx) => {
		if (enabled) installStatusline(pi, ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (enabled) installStatusline(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		if (enabled) installStatusline(pi, ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		if (enabled) installStatusline(pi, ctx);
	});

	pi.registerCommand("yuki-statusline", {
		description: "Toggle the concise Yuki footer statusline",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "toggle"];
			const matches = items.filter((item) => item.startsWith(prefix.trim().toLowerCase()));
			return matches.length ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "on") enabled = true;
			else if (arg === "off") enabled = false;
			else enabled = !enabled;

			if (enabled) {
				installStatusline(pi, ctx);
				ctx.ui.notify("Yuki statusline enabled", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Yuki statusline disabled", "info");
			}
		},
	});
}

function installStatusline(pi: ExtensionAPI, ctx: ExtensionContext) {
	if (!ctx.hasUI) return;
	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubscribeBranch = footerData.onBranchChange(() => tui.requestRender());
		const interval = setInterval(() => tui.requestRender(), 5_000);
		interval.unref?.();

		return {
			dispose: () => {
				unsubscribeBranch();
				clearInterval(interval);
			},
			invalidate() {},
			render(width: number): string[] {
				const separator = theme.fg("dim", " | ");
				const context = formatContext(ctx, theme);
				const branch = theme.fg("accent", footerData.getGitBranch() ?? "no-git");
				const model = theme.fg("muted", truncatePlain(formatModelWithEffort(pi, ctx), 40));
				const fixedWidth = visibleWidth(separator) * 3 + visibleWidth(branch) + visibleWidth(model) + visibleWidth(context);
				const cwd = theme.fg("success", basename(ctx.cwd));
				const primary = truncateToWidth(cwd + separator + branch + separator + model + separator + context, width);

				const secondaryParts = [formatTokenStats(ctx, theme), formatExtensionStatuses(footerData.getExtensionStatuses())].filter(Boolean);
				const secondary = secondaryParts.length > 0 ? truncateToWidth(theme.fg("dim", secondaryParts.join("  ")), width, theme.fg("dim", "…")) : undefined;
				return secondary ? [primary, secondary] : [primary];
			},
		};
	});
}

function modelName(ctx: ExtensionContext): string {
	const model = ctx.model as { name?: string; id?: string; provider?: string } | undefined;
	return model?.name ?? model?.id ?? "no-model";
}

function formatModelWithEffort(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const effort = formatEffort(pi.getThinkingLevel());
	const provider = providerName(ctx);
	return provider ? `${modelName(ctx)} · ${provider} · ${effort}` : `${modelName(ctx)} · ${effort}`;
}

function providerName(ctx: ExtensionContext): string | undefined {
	const model = ctx.model as { provider?: string } | undefined;
	return model?.provider;
}

function formatEffort(level: string): string {
	if (level === "xhigh") return "x-high";
	return level || "auto";
}

function formatContext(ctx: ExtensionContext, theme: Theme): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return theme.fg("dim", `ctx --%/${formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0)} ${"▱".repeat(BAR_WIDTH)}`);

	const contextWindow = usage.contextWindow || ctx.model?.contextWindow || 0;
	const percent = Math.max(0, Math.min(100, usage.percent ?? (usage.tokens / usage.contextWindow) * 100));
	const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)));
	const empty = BAR_WIDTH - filled;
	const color = percent >= 85 ? "error" : percent >= 65 ? "warning" : "success";
	return theme.fg("dim", `ctx ${Math.round(percent)}%/${formatTokens(contextWindow)} `) + theme.fg(color, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(empty));
}

function formatTokenStats(ctx: ExtensionContext, theme: Theme): string | undefined {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	let latestCacheHitRate: number | undefined;

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } };
		if (message.role !== "assistant" || !message.usage) continue;
		input += message.usage.input ?? 0;
		output += message.usage.output ?? 0;
		cacheRead += message.usage.cacheRead ?? 0;
		cacheWrite += message.usage.cacheWrite ?? 0;
		cost += message.usage.cost?.total ?? 0;

		const latestPromptTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
		latestCacheHitRate = latestPromptTokens > 0 ? ((message.usage.cacheRead ?? 0) / latestPromptTokens) * 100 : undefined;
	}

	const parts: string[] = [];
	if (input) parts.push(`↑${formatTokens(input)}`);
	if (output) parts.push(`↓${formatTokens(output)}`);
	if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
	if (cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
	if ((cacheRead > 0 || cacheWrite > 0) && latestCacheHitRate !== undefined) parts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
	const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
	if (cost || usingSubscription) parts.push(`$${cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`);

	return parts.length ? theme.fg("dim", parts.join(" ")) : undefined;
}

function formatExtensionStatuses(statuses: ReadonlyMap<string, string>): string | undefined {
	const parts = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => sanitizeStatusText(text))
		.filter(Boolean);
	return parts.length ? parts.join(" ") : undefined;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function basename(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? cwd;
}

function truncatePlain(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width));
}
