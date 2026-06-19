import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Input, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface QuestionOption {
	label: string;
	description?: string;
	value?: string;
}

interface AskUserQuestionDetails {
	question: string;
	options: QuestionOption[];
	answer: string | null;
	label?: string;
	wasCustom?: boolean;
	cancelled: boolean;
}

const QuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional trade-off or impact shown next to the option" })),
	value: Type.Optional(Type.String({ description: "Optional machine-readable value; defaults to label" })),
});

const MAX_QUESTION_LINES = 6;

const AskUserQuestionParams = Type.Object({
	question: Type.String({ description: "Clear question to ask the user" }),
	options: Type.Optional(
		Type.Array(QuestionOptionSchema, {
			description: "Optional choices. If omitted or empty, the user gets a free-text input.",
			maxItems: 6,
		}),
	),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow custom free-text answer when options are provided. Defaults to true." })),
});

export default function askUserQuestionExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description:
			"Ask the user a question, optionally with choices, and return the answer to the model so it can continue with the user's input.",
		promptSnippet: "Ask the user a question and collect an answer before continuing.",
		promptGuidelines: [
			"Use ask_user_question when you are blocked by ambiguous requirements, need a preference, or need the user to choose between concrete implementation options.",
			"Do not use ask_user_question for routine confirmation when you can proceed safely from the existing instructions.",
			"When using ask_user_question with options, keep labels short; if recommending one, put that option first and include '(Recommended)' in its label.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options ?? [];
			const allowOther = params.allowOther !== false;

			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No interactive UI is available, so no answer was collected. Ask the user in plain text instead.",
						},
					],
					details: makeDetails(params.question, options, null, { cancelled: true }),
				};
			}

			if (options.length === 0) {
				const answer = await ctx.ui.input(params.question, "Type your answer...");
				const trimmed = answer?.trim();
				if (!trimmed) {
					return cancelledResult(params.question, options);
				}
				return answeredResult(params.question, options, trimmed, { wasCustom: true });
			}

			const selected = await askWithOptions(ctx, params.question, options, allowOther, signal);

			if (!selected) {
				return cancelledResult(params.question, options);
			}

			return answeredResult(params.question, options, selected.answer, {
				label: selected.label,
				wasCustom: selected.wasCustom,
			});
		},

		renderCall(args, theme, _context) {
			const question = typeof args.question === "string" ? args.question : "";
			const options = Array.isArray(args.options) ? (args.options as QuestionOption[]) : [];
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", question);
			if (options.length > 0) {
				text += "\n" + theme.fg("dim", `  Options: ${options.map((option) => option.label).join(", ")}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as AskUserQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.cancelled || details.answer === null) {
				return new Text(theme.fg("warning", "No answer collected"), 0, 0);
			}

			const prefix = details.wasCustom ? theme.fg("muted", "(custom) ") : "";
			const label = details.label && details.label !== details.answer ? theme.fg("dim", ` [${details.label}]`) : "";
			return new Text(theme.fg("success", "✓ ") + prefix + theme.fg("accent", details.answer) + label, 0, 0);
		},
	});
}

interface AskSelection {
	answer: string;
	label?: string;
	wasCustom: boolean;
}

function askWithOptions(
	ctx: ExtensionContext,
	question: string,
	options: QuestionOption[],
	allowOther: boolean,
	signal?: AbortSignal,
): Promise<AskSelection | null> {
	if (signal?.aborted) return Promise.resolve(null);

	return ctx.ui.custom<AskSelection | null>((tui, theme, _keybindings, done) => {
		let selectedIndex = 0;
		let focused = false;
		let cachedLines: string[] | undefined;
		let cachedWidth: number | undefined;
		let completed = false;
		const customIndex = allowOther ? options.length : -1;
		const input = new Input();

		const finish = (result: AskSelection | null) => {
			if (completed) return;
			completed = true;
			done(result);
		};

		const onAbort = () => finish(null);
		signal?.addEventListener("abort", onAbort, { once: true });

		const refresh = () => {
			cachedLines = undefined;
			cachedWidth = undefined;
			input.focused = focused && selectedIndex === customIndex;
			tui.requestRender();
		};

		const submitCustom = () => {
			const answer = input.getValue().trim();
			if (answer) {
				finish({ answer, wasCustom: true });
			}
		};

		const component = {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				input.focused = focused && selectedIndex === customIndex;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					finish(null);
					return;
				}

				if (matchesKey(data, Key.up)) {
					selectedIndex = Math.max(0, selectedIndex - 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.down)) {
					selectedIndex = Math.min((allowOther ? options.length : options.length - 1), selectedIndex + 1);
					refresh();
					return;
				}

				if (matchesKey(data, Key.enter) || data === "\n") {
					if (selectedIndex === customIndex) {
						submitCustom();
						return;
					}

					const option = options[selectedIndex];
					if (option) {
						finish({ answer: option.value ?? option.label, label: option.label, wasCustom: false });
					}
					return;
				}

				if (selectedIndex === customIndex) {
					input.handleInput(data);
					refresh();
					return;
				}

				if (allowOther && isTextEntry(data)) {
					selectedIndex = customIndex;
					input.handleInput(data);
					refresh();
				}
			},
			render(width: number) {
				if (cachedLines && cachedWidth === width) return cachedLines;

				input.focused = focused && selectedIndex === customIndex;
				const safeWidth = Math.max(1, width);
				const lines: string[] = [];
				const add = (line: string) => lines.push(truncateToWidth(line, safeWidth));
				const wrappedStyledLines = (text: string, style: (value: string) => string, prefix = "", continuationPrefix = prefix): string[] => {
					const result: string[] = [];
					const contentWidth = Math.max(1, safeWidth - Math.max(visibleWidth(prefix), visibleWidth(continuationPrefix)));
					for (const physicalLine of text.split(/\r?\n/)) {
						if (!physicalLine) {
							result.push("");
							continue;
						}
						const wrappedLines = wrapTextWithAnsi(style(physicalLine), contentWidth);
						wrappedLines.forEach((wrappedLine, index) => result.push(truncateToWidth((index === 0 ? prefix : continuationPrefix) + wrappedLine, safeWidth)));
					}
					return result;
				};
				const addWrappedStyled = (text: string, style: (value: string) => string, prefix = "", continuationPrefix = prefix) => {
					lines.push(...wrappedStyledLines(text, style, prefix, continuationPrefix));
				};
				const addLimitedWrappedStyled = (text: string, style: (value: string) => string, maxLines: number, prefix = "", continuationPrefix = prefix) => {
					const wrapped = wrappedStyledLines(text, style, prefix, continuationPrefix);
					if (wrapped.length <= maxLines) {
						lines.push(...wrapped);
						return;
					}
					lines.push(...wrapped.slice(0, maxLines));
					add(theme.fg("dim", `… ${wrapped.length - maxLines} more lines`));
				};
				const border = theme.fg("accent", "─".repeat(Math.max(0, width)));

				add(border);
				addLimitedWrappedStyled(question, (text) => theme.fg("accent", theme.bold(text)), MAX_QUESTION_LINES);
				lines.push("");

				for (let index = 0; index < options.length; index++) {
					const option = options[index];
					const selected = index === selectedIndex;
					const prefix = selected ? theme.fg("accent", "→ ") : "  ";
					const continuationPrefix = selected ? theme.fg("accent", "  ") : "  ";
					const text = `${index + 1}. ${option.label}`;
					addWrappedStyled(text, (value) => theme.fg(selected ? "accent" : "text", value), prefix, continuationPrefix);
					if (selected && option.description) {
						const descriptionLines = wrappedStyledLines(option.description, (value) => theme.fg("muted", value), "    ");
						if (descriptionLines[0]) add(descriptionLines[0]);
					}
				}

				if (allowOther) {
					const selected = selectedIndex === customIndex;
					const prefix = selected ? theme.fg("accent", "→ ") : "  ";
					const continuationPrefix = selected ? theme.fg("accent", "  ") : "  ";
					addWrappedStyled(`${customIndex + 1}. Other / custom answer`, (value) => theme.fg(selected ? "accent" : "text", value), prefix, continuationPrefix);
					for (const line of input.render(Math.max(1, safeWidth - 4))) {
						add(`    ${line}`);
					}
				}

				lines.push("");
				addWrappedStyled(
					allowOther ? "↑↓ navigate • Enter select/submit • type custom answer • Esc cancel" : "↑↓ navigate • Enter select • Esc cancel",
					(value) => theme.fg("dim", value),
				);
				add(border);

				cachedLines = lines;
				cachedWidth = width;
				return lines;
			},
			invalidate() {
				cachedLines = undefined;
				cachedWidth = undefined;
			},
			dispose() {
				signal?.removeEventListener("abort", onAbort);
			},
		};

		return component;
	});
}

function isTextEntry(data: string): boolean {
	if (data.includes("\x1b[200~")) return true;
	if (decodeKittyPrintable(data) !== undefined) return true;
	return [...data].length > 0 && ![...data].some((char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
	});
}

function makeDetails(
	question: string,
	options: QuestionOption[],
	answer: string | null,
	extra: Omit<Partial<AskUserQuestionDetails>, "question" | "options" | "answer"> = {},
): AskUserQuestionDetails {
	return {
		question,
		options,
		answer,
		cancelled: answer === null,
		...extra,
	};
}

function cancelledResult(question: string, options: QuestionOption[]) {
	return {
		content: [{ type: "text" as const, text: "User did not answer the question." }],
		details: makeDetails(question, options, null, { cancelled: true }),
	};
}

function answeredResult(
	question: string,
	options: QuestionOption[],
	answer: string,
	extra: { label?: string; wasCustom: boolean },
) {
	const labelText = extra.label && extra.label !== answer ? ` (label: ${extra.label})` : "";
	return {
		content: [
			{
				type: "text" as const,
				text: `User answered your question: "${question}" = "${answer}"${labelText}. Continue with this answer in mind.`,
			},
		],
		details: makeDetails(question, options, answer, { ...extra, cancelled: false }),
	};
}
