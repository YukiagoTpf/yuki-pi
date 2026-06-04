import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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

			const choices = options.map((option, index) => formatChoice(option, index));
			const otherChoice = `${options.length + 1}. Other / custom answer`;
			const allChoices = allowOther ? [...choices, otherChoice] : choices;
			const selected = await ctx.ui.select(params.question, allChoices);

			if (!selected) {
				return cancelledResult(params.question, options);
			}

			const selectedIndex = allChoices.indexOf(selected);
			if (allowOther && selectedIndex === options.length) {
				const answer = await ctx.ui.input("Custom answer", "Type your answer...");
				const trimmed = answer?.trim();
				if (!trimmed) {
					return cancelledResult(params.question, options);
				}
				return answeredResult(params.question, options, trimmed, { wasCustom: true });
			}

			const option = options[selectedIndex];
			const answer = option.value ?? option.label;
			return answeredResult(params.question, options, answer, { label: option.label, wasCustom: false });
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

function formatChoice(option: QuestionOption, index: number): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	return `${index + 1}. ${option.label}${suffix}`;
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
