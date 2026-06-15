/**
 * /btw - one-shot side question for Pi.
 *
 * Ask a quick question against a compact snapshot of the current main-agent
 * context without steering/following up the main agent and without exposing any
 * tools to the BTW answerer.
 *
 * Usage:
 *   /btw <question>
 *   /btw clear
 */

import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { takeTailWithinBudget } from "./shared/transcript.ts";

const CUSTOM_TYPE = "btw";
const SNAPSHOT_BUDGET_CHARS = 12_000;
const MAX_WIDGET_LINES = 18;

const SYSTEM_PROMPT = `<system-reminder>
This is a side question from the user. You must answer it directly in a single response.

CRITICAL CONSTRAINTS:
- You have NO tools available. You cannot read files, run commands, search, edit, or take any action.
- This is a one-off response. There will be no follow-up turns in this BTW session.
- You can ONLY use information from the provided main-agent context snapshot and your general knowledge.
- Do NOT continue the main coding task.
- Do NOT give instructions to the main agent.
- NEVER say things like "Let me check", "I'll inspect", "I'll modify", "I'll run", or promise to take action.
- If you don't know the answer from the available context, say so, then provide the likely general meaning.

Simply answer the side question with the information you have.
</system-reminder>`;

export default function btwExtension(pi: ExtensionAPI) {
	let liveAssistantText = "";
	let clearDismissHandler: (() => void) | undefined;

	const clearBTWCard = (ctx: Pick<ExtensionCommandContext, "ui">) => {
		ctx.ui.setWidget(CUSTOM_TYPE, undefined);
		ctx.ui.setStatus(CUSTOM_TYPE, undefined);
		clearDismissHandler?.();
		clearDismissHandler = undefined;
	};

	const installDismissHandler = (ctx: ExtensionCommandContext) => {
		clearDismissHandler?.();
		clearDismissHandler = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === " ") {
				clearBTWCard(ctx);
				return { consume: true };
			}
			return undefined;
		});
	};

	pi.on("message_start", (event) => {
		if (event.message.role === "assistant") {
			liveAssistantText = "";
		}
	});

	pi.on("message_update", (event) => {
		if (event.message.role === "assistant") {
			liveAssistantText = messageText(event.message);
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role === "assistant") {
			liveAssistantText = "";
		}
	});

	// Defense-in-depth: if a future version displays BTW answers as custom messages,
	// keep them out of the main agent's LLM context.
	pi.on("context", (event) => ({
		messages: event.messages.filter((message) => !(message.role === "custom" && message.customType === CUSTOM_TYPE)),
	}));

	pi.registerCommand("btw", {
		description: "Ask a one-shot side question using a compact main-context snapshot",
		handler: async (args, ctx) => {
			const question = args.trim();

			if (!question) {
				ctx.ui.notify("Usage: /btw <quick side question>", "warning");
				return;
			}

			if (question === "clear") {
				clearBTWCard(ctx);
				ctx.ui.notify("BTW cleared", "info");
				return;
			}

			if (!ctx.model) {
				ctx.ui.notify("/btw requires a selected model", "error");
				return;
			}

			clearDismissHandler?.();
			clearDismissHandler = undefined;
			ctx.ui.setStatus(CUSTOM_TYPE, ctx.ui.theme.fg("accent", "BTW…"));
			ctx.ui.setWidget(CUSTOM_TYPE, createBTWCard(question, "Answering…", { dismissible: false }), { placement: "aboveEditor" });

			try {
				const answer = await answerBTW(question, buildSnapshot(ctx, liveAssistantText), ctx);
				ctx.ui.setWidget(CUSTOM_TYPE, createBTWCard(question, answer, { dismissible: true }), { placement: "aboveEditor" });
				installDismissHandler(ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.setWidget(CUSTOM_TYPE, createBTWCard(question, `Error: ${message}`, { dismissible: true }), { placement: "aboveEditor" });
				installDismissHandler(ctx);
				ctx.ui.notify(`BTW failed: ${message}`, "error");
			} finally {
				ctx.ui.setStatus(CUSTOM_TYPE, undefined);
			}
		},
	});
}

async function answerBTW(question: string, snapshot: string, ctx: ExtensionCommandContext): Promise<string> {
	const model = ctx.model!;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
	}

	const userMessage: UserMessage = {
		role: "user",
		content: [
			{
				type: "text",
				text: `Main-agent context snapshot:\n\n${snapshot}\n\nSide question:\n${question}`,
			},
		],
		timestamp: Date.now(),
	};

	const response = await complete(
		model,
		{ systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
		{ apiKey: auth.apiKey, headers: auth.headers, signal: ctx.signal, cacheRetention: "none" },
	);

	if (response.stopReason === "aborted") {
		throw new Error("aborted");
	}

	const answer = response.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();

	return answer || "No answer returned.";
}

function buildSnapshot(ctx: ExtensionCommandContext, liveAssistantText: string): string {
	const branch = ctx.sessionManager.getBranch();
	const lines: string[] = [];

	for (const entry of branch) {
		if (entry.type === "message") {
			const formatted = formatMessage(entry.message);
			if (formatted) lines.push(formatted);
		} else if (entry.type === "compaction") {
			lines.push(`[Compaction summary]\n${truncate(entry.summary, 1_000)}`);
		} else if (entry.type === "branch_summary") {
			lines.push(`[Branch summary]\n${truncate(entry.summary, 1_000)}`);
		}
	}

	if (liveAssistantText.trim()) {
		lines.push(`[Assistant currently streaming]\n${truncate(liveAssistantText.trim(), 2_000)}`);
	}

	return takeTailWithinBudget(lines, SNAPSHOT_BUDGET_CHARS) || "(No main-agent context available.)";
}

function formatMessage(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "user":
			return `[User]\n${truncate(messageText(message), 2_000)}`;
		case "assistant": {
			const text = messageText(message).trim();
			const toolCalls = message.content
				.filter((part) => part.type === "toolCall")
				.map((part) => `tool_call ${part.name} ${truncate(JSON.stringify(part.arguments), 500)}`);
			const body = [text && truncate(text, 2_000), ...toolCalls].filter(Boolean).join("\n");
			return body ? `[Assistant]\n${body}` : undefined;
		}
		case "toolResult": {
			const text = truncate(messageText(message), 400);
			return `[Tool result: ${message.toolName}${message.isError ? " error" : " ok"}]${text ? `\n${text}` : ""}`;
		}
		case "bashExecution":
			return `[User bash${message.excludeFromContext ? " excluded" : ""}] ${message.command} -> ${message.exitCode ?? "?"}`;
		case "branchSummary":
			return `[Branch summary]\n${truncate(message.summary, 1_000)}`;
		case "compactionSummary":
			return `[Compaction summary]\n${truncate(message.summary, 1_000)}`;
		case "custom":
			if (message.customType === CUSTOM_TYPE) return undefined;
			return `[Custom: ${message.customType}]\n${truncate(messageText(message), 500)}`;
	}
}

function messageText(message: AgentMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function createBTWCard(question: string, answer: string, options: { dismissible: boolean }) {
	return (_tui: unknown, theme: { fg(color: string, text: string): string; bold(text: string): string }): Component => {
		return new BTWCard(question, answer, options.dismissible, theme);
	};
}

class BTWCard implements Component {
	constructor(
		private readonly question: string,
		private readonly answer: string,
		private readonly dismissible: boolean,
		private readonly theme: { fg(color: string, text: string): string; bold(text: string): string },
	) {}

	render(width: number): string[] {
		if (width < 8) return [truncateToWidth("BTW", Math.max(1, width))];

		const cardWidth = Math.min(width, 100);
		const innerWidth = Math.max(1, cardWidth - 4);
		const border = (line: string) => this.theme.fg("accent", line);

		const title = ` ${this.theme.bold("BTW")} `;
		const topPrefix = `╭─${title}`;
		const top = `${topPrefix}${"─".repeat(Math.max(0, cardWidth - visibleWidth(topPrefix) - 1))}╮`;
		const mid = `├${"─".repeat(Math.max(0, cardWidth - 2))}┤`;
		const bottom = `╰${"─".repeat(Math.max(0, cardWidth - 2))}╯`;

		const questionLines = this.wrap(this.theme.fg("muted", `Q: ${this.question}`), innerWidth);
		const answerLines = this.answer.split("\n").flatMap((line) => this.wrap(line, innerWidth));
		const hintLines = this.dismissible ? [this.theme.fg("dim", "Press Space, Enter, or Escape to dismiss")] : [];

		const maxAnswerLines = Math.max(1, MAX_WIDGET_LINES - questionLines.length - hintLines.length - 3);
		const visibleAnswerLines =
			answerLines.length > maxAnswerLines
				? [...answerLines.slice(0, maxAnswerLines - 1), this.theme.fg("dim", "… (/btw clear to hide)")]
				: answerLines;

		return [
			border(top),
			...questionLines.map((line) => this.frameLine(line, innerWidth)),
			border(mid),
			...visibleAnswerLines.map((line) => this.frameLine(line, innerWidth)),
			...hintLines.map((line) => this.frameLine(line, innerWidth)),
			border(bottom),
		];
	}

	handleInput(): void {}

	invalidate(): void {}

	private wrap(text: string, width: number): string[] {
		if (!text) return [""];
		return wrapTextWithAnsi(text, width);
	}

	private frameLine(line: string, innerWidth: number): string {
		const padded = line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line)));
		return `${this.theme.fg("accent", "│")} ${padded} ${this.theme.fg("accent", "│")}`;
	}
}

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
