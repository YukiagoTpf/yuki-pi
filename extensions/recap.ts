/**
 * /recap - one-sentence progress recap for Pi.
 *
 * Manual: `/recap` renders a transient overlay.
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const RECAP_CUSTOM_TYPE = "recap";
const TAIL_BUDGET_CHARS = 8_000;
const MIN_TRANSCRIPT_CHARS = 200;

const SYSTEM_PROMPT = `Summarize this coding session in ONE sentence: what the user is working on and the current progress.

Rules:
- Output the sentence only — no preface, quotes, or markdown.
- ≤ 30 Chinese chars or ≤ 25 English words.
- Match the language of the latest user message.`;

type BranchEntry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];

type RecapTranscript = {
	text: string;
	conversationMessageCount: number;
};

export default function recapExtension(pi: ExtensionAPI) {
	let inflight: Promise<void> | null = null;

	pi.on("context", (event) => ({
		messages: event.messages.filter(
			(message) => !(message.role === "custom" && message.customType === RECAP_CUSTOM_TYPE),
		),
	}));

	pi.registerCommand("recap", {
		description: "Summarize the current coding session in one sentence",
		handler: async (_args, ctx) => {
			if (inflight) {
				if (ctx.hasUI) ctx.ui.notify("Recap already in progress", "info");
				return;
			}

			inflight = runManualRecap(ctx).finally(() => {
				inflight = null;
			});
			await inflight;
		},
	});
}

async function runManualRecap(ctx: ExtensionContext): Promise<void> {
	if (!ctx.model) {
		if (ctx.hasUI) ctx.ui.notify("Recap requires a selected model", "error");
		return;
	}

	const transcript = buildTranscript(ctx);
	if (transcript.conversationMessageCount < 2 || transcript.text.trim().length < MIN_TRANSCRIPT_CHARS) {
		if (ctx.hasUI) ctx.ui.notify("Nothing to recap yet", "info");
		return;
	}

	if (!ctx.hasUI) return;

	try {
		const summary = await generateRecap(transcript.text, ctx, ctx.signal);
		if (isAborted(ctx.signal)) return;
		await showRecapOverlay(summary, ctx);
	} catch (error) {
		if (isAbortError(error) || isAborted(ctx.signal)) return;
		const message = error instanceof Error ? error.message : String(error);
		await showRecapOverlay(`Error: ${message}`, ctx);
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

async function showRecapOverlay(summary: string, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;

	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => {
			const container = new OverlayCard("Recap", summary, "Press Enter or Esc to close", theme, done);
			return container;
		},
		{ overlay: true },
	);
}

class OverlayCard implements Component {
	constructor(
		private readonly title: string,
		private readonly body: string,
		private readonly hint: string,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
		private readonly done: () => void,
	) {}

	render(width: number): string[] {
		if (width < 8) return [truncateToWidth(this.title, Math.max(1, width))];

		const cardWidth = Math.min(width, 88);
		const innerWidth = Math.max(1, cardWidth - 4);
		const border = (line: string) => this.theme.fg("accent", line);
		const title = ` ${this.theme.bold(this.title)} `;
		const topPrefix = `╭─${title}`;
		const top = `${topPrefix}${"─".repeat(Math.max(0, cardWidth - visibleWidth(topPrefix) - 1))}╮`;
		const bottom = `╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`;

		const bodyLines = this.body.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", innerWidth));
		const hintLines = wrapTextWithAnsi(this.theme.fg("dim", this.hint), innerWidth);

		return [
			border(top),
			...bodyLines.map((line) => this.frameLine(line, innerWidth)),
			...hintLines.map((line) => this.frameLine(line, innerWidth)),
			border(bottom),
		];
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
			this.done();
		}
	}

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
