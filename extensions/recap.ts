/**
 * /recap - one-sentence progress recap for Pi.
 *
 * Manual: `/recap` renders a dismissible widget above the editor.
 * Auto: after 10 minutes without a new turn_end, silently generates a recap
 * and renders a non-intercepting widget above the editor until the next prompt.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const RECAP_CUSTOM_TYPE = "recap";
const TAIL_BUDGET_CHARS = 8_000;
const MIN_TRANSCRIPT_CHARS = 200;
const IDLE_MS = 10 * 60 * 1000;
const MAX_WIDGET_LINES = 10;

const SYSTEM_PROMPT = `Summarize this coding session in ONE sentence: what the user is working on and the current progress.

Rules:
- Output the sentence only — no preface, quotes, or markdown.
- ≤ 30 Chinese chars or ≤ 25 English words.
- Match the language of the latest user message.`;

type RecapMode = "manual" | "auto";

type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

type RecapTranscript = {
	text: string;
	conversationMessageCount: number;
};

export default function recapExtension(pi: ExtensionAPI) {
	let lastActivityAt = Date.now();
	let alreadyFired = false;
	let idleTimer: ReturnType<typeof setTimeout> | null = null;
	let inflight: Promise<void> | null = null;
	let clearDismissHandler: (() => void) | undefined;
	let autoAbortController: AbortController | undefined;
	let disposed = false;
	let activityVersion = 0;
	let visibleWidgetMode: RecapMode | null = null;

	const clearRecapWidget = (ctx: Pick<ExtensionContext, "ui">) => {
		ctx.ui.setWidget(RECAP_CUSTOM_TYPE, undefined);
		ctx.ui.setStatus(RECAP_CUSTOM_TYPE, undefined);
		clearDismissHandler?.();
		clearDismissHandler = undefined;
		visibleWidgetMode = null;
	};

	const installDismissHandler = (ctx: ExtensionContext) => {
		clearDismissHandler?.();
		clearDismissHandler = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ") {
				clearRecapWidget(ctx);
				return { consume: true };
			}
			return undefined;
		});
	};

	const clearAutoRecapWidget = (ctx: Pick<ExtensionContext, "ui">) => {
		if (visibleWidgetMode === "auto") {
			clearRecapWidget(ctx);
		}
	};

	const showRecapWidget = (summary: string, ctx: ExtensionContext, mode: RecapMode) => {
		clearDismissHandler?.();
		clearDismissHandler = undefined;
		visibleWidgetMode = mode;
		ctx.ui.setWidget(RECAP_CUSTOM_TYPE, createRecapCard(summary, { dismissible: mode === "manual" }), {
			placement: "aboveEditor",
		});
		ctx.ui.setStatus(RECAP_CUSTOM_TYPE, undefined);

		if (mode === "manual") {
			installDismissHandler(ctx);
		}
	};

	const clearIdleTimer = () => {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = null;
		}
	};

	const scheduleIdleTimer = (ctx: ExtensionContext) => {
		clearIdleTimer();
		idleTimer = setTimeout(() => {
			idleTimer = null;
			if (disposed || alreadyFired) return;
			if (Date.now() - lastActivityAt < IDLE_MS) return;
			void startRecap("auto", ctx);
		}, IDLE_MS);
		(idleTimer as unknown as { unref?: () => void }).unref?.();
	};

	const startRecap = (mode: RecapMode, ctx: ExtensionContext): Promise<void> | undefined => {
		if (inflight) {
			if (mode === "manual" && ctx.hasUI) {
				ctx.ui.notify("Recap already in progress", "info");
			}
			return undefined;
		}

		if (mode === "manual" && ctx.hasUI) {
			clearRecapWidget(ctx);
		}

		autoAbortController = mode === "auto" ? new AbortController() : undefined;
		const signal = mode === "auto" ? autoAbortController.signal : ctx.signal;
		const recapActivityVersion = activityVersion;

		inflight = (async () => {
			try {
				await runRecap(mode, ctx, signal, recapActivityVersion);
			} finally {
				inflight = null;
				if (mode === "auto") {
					autoAbortController = undefined;
				}
			}
		})();

		return inflight;
	};

	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === RECAP_CUSTOM_TYPE),
		),
	}));

	pi.on("before_agent_start", (_event, ctx) => {
		clearAutoRecapWidget(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		lastActivityAt = Date.now();
		activityVersion += 1;
		alreadyFired = false;
		disposed = false;
		scheduleIdleTimer(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		disposed = true;
		clearIdleTimer();
		autoAbortController?.abort();
		autoAbortController = undefined;
		alreadyFired = false;
		inflight = null;
		try {
			clearRecapWidget(ctx);
		} catch {
			// Runtime may already be tearing down; best-effort cleanup only.
		}
	});

	pi.registerCommand("recap", {
		description: "Summarize the current coding session in one sentence",
		handler: async (_args, ctx) => {
			await startRecap("manual", ctx);
		},
	});

	async function runRecap(
		mode: RecapMode,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		recapActivityVersion: number,
	): Promise<void> {
		const manual = mode === "manual";

		if (!ctx.model) {
			if (manual && ctx.hasUI) ctx.ui.notify("Recap requires a selected model", "error");
			return;
		}

		const transcript = buildTranscript(ctx);
		if (transcript.conversationMessageCount < 2 || transcript.text.trim().length < MIN_TRANSCRIPT_CHARS) {
			if (manual && ctx.hasUI) ctx.ui.notify("Nothing to recap yet", "info");
			return;
		}

		if (!ctx.hasUI) {
			return;
		}

		try {
			const summary = await generateRecap(transcript.text, ctx, signal);
			if (disposed || isAborted(signal)) return;

			if (manual) {
				showRecapWidget(summary, ctx, "manual");
			} else {
				if (activityVersion !== recapActivityVersion || visibleWidgetMode === "manual" || disposed || !ctx.hasUI) return;
				alreadyFired = true;
				showRecapWidget(summary, ctx, "auto");
			}
		} catch (error) {
			if (isAbortError(error) || isAborted(signal)) return;
			if (disposed) return;
			const message = error instanceof Error ? error.message : String(error);
			if (manual && ctx.hasUI) {
				showRecapWidget(`Error: ${message}`, ctx, "manual");
			}
			// Auto mode intentionally swallows recap errors.
		}
	}
}

async function generateRecap(transcript: string, ctx: ExtensionContext, signal: AbortSignal | undefined): Promise<string> {
	const model = ctx.model!;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (auth.ok === false) {
		throw new Error(auth.error);
	}
	if (!auth.apiKey) {
		throw new Error(`No API key for ${model.provider}`);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: `<transcript>\n${transcript}\n</transcript>`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, reasoningEffort: "low", cacheRetention: "none", signal },
	);

	if (response.stopReason === "aborted") {
		throw new Error("aborted");
	}
	if (response.stopReason === "error") {
		throw new Error(response.errorMessage ?? "LLM error");
	}

	const summary = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim()
		.replace(/^['"“”‘’]+|['"“”‘’]+$/g, "");

	return summary || "No recap returned.";
}

function buildTranscript(ctx: ExtensionContext): RecapTranscript {
	const leafId = ctx.sessionManager.getLeafId();
	const branch = leafId ? ctx.sessionManager.getBranch(leafId) : ctx.sessionManager.getBranch();
	const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
	const summaryBlocks: string[] = [];
	const tailBlocks: string[] = [];
	let conversationMessageCount = 0;

	for (const entry of branch) {
		const summary = formatSummaryEntry(entry);
		if (summary) summaryBlocks.push(summary);

		if (entry.type !== "message") continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;

		const text = messageText(entry.message).trim();
		if (!text) continue;

		conversationMessageCount += 1;
		const label = role === "user" ? "User" : "Assistant";
		tailBlocks.push(`[${label}]\n${text}`);
	}

	const sections: string[] = [];
	if (firstUser?.type === "message") {
		const firstUserText = messageText(firstUser.message).trim();
		if (firstUserText) sections.push(`[Initial user task]\n${firstUserText}`);
	}
	if (summaryBlocks.length > 0) {
		sections.push(summaryBlocks.join("\n\n"));
	}
	const tail = takeTailWithinBudget(tailBlocks, TAIL_BUDGET_CHARS);
	if (tail) sections.push(tail);

	return {
		text: sections.join("\n\n"),
		conversationMessageCount,
	};
}

function formatSummaryEntry(entry: BranchEntry): string | undefined {
	if (entry.type === "compaction") {
		return `[Compaction summary]\n${entry.summary}`;
	}
	if (entry.type === "branch_summary") {
		return `[Branch summary]\n${entry.summary}`;
	}
	if (entry.type === "message") {
		if (entry.message.role === "compactionSummary") {
			return `[Compaction summary]\n${entry.message.summary}`;
		}
		if (entry.message.role === "branchSummary") {
			return `[Branch summary]\n${entry.message.summary}`;
		}
	}
	return undefined;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function takeTailWithinBudget(items: string[], budget: number): string {
	const selected: string[] = [];
	let used = 0;

	for (let i = items.length - 1; i >= 0; i--) {
		const item = items[i]!;
		const cost = item.length + 2;
		if (selected.length > 0 && used + cost > budget) break;
		selected.unshift(item);
		used += cost;
	}

	return selected.join("\n\n");
}

function createRecapCard(summary: string, options: { dismissible: boolean }) {
	return (_tui: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }): Component => {
		return new RecapWidgetCard(summary, options.dismissible, theme);
	};
}

class RecapWidgetCard implements Component {
	constructor(
		private readonly summary: string,
		private readonly dismissible: boolean,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
	) {}

	render(width: number): string[] {
		if (width < 8) return [truncateToWidth("Recap", Math.max(1, width))];

		const cardWidth = Math.min(width, 100);
		const innerWidth = Math.max(1, cardWidth - 4);
		const border = (line: string) => this.theme.fg("accent", line);
		const title = ` ${this.theme.bold("Recap")} `;
		const topPrefix = `╭─${title}`;
		const top = `${topPrefix}${"─".repeat(Math.max(0, cardWidth - visibleWidth(topPrefix) - 1))}╮`;
		const bottom = `╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`;

		const answerLines = this.summary.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth));
		const hintLines = this.dismissible ? [this.theme.fg("dim", "Press Space, Enter, or Escape to dismiss")] : [];
		const maxAnswerLines = Math.max(1, MAX_WIDGET_LINES - hintLines.length - 2);
		const visibleAnswerLines =
			answerLines.length > maxAnswerLines
				? [...answerLines.slice(0, maxAnswerLines - 1), this.theme.fg("dim", "…")]
				: answerLines;

		return [
			border(top),
			...visibleAnswerLines.map((line) => this.frameLine(line, innerWidth)),
			...hintLines.map((line) => this.frameLine(line, innerWidth)),
			border(bottom),
		];
	}

	handleInput(): void {}

	invalidate(): void {}

	private frameLine(line: string, innerWidth: number): string {
		const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		return `${this.theme.fg("accent", "│")} ${padded} ${this.theme.fg("accent", "│")}`;
	}
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) {
		return error.name === "AbortError" || error.message === "aborted" || error.message.toLowerCase().includes("abort");
	}
	return String(error).toLowerCase().includes("abort");
}

function isAborted(signal: AbortSignal | undefined): boolean {
	return signal?.aborted ?? false;
}
