import { complete, StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTodoState, makeTodoStateRecord } from "../todo/index.ts";
import { PLAN_STATE_CUSTOM_TYPE, TODO_STATE_CUSTOM_TYPE } from "../shared/constants.ts";
import { isExecutableResolution, slugify } from "../shared/plan-helpers.ts";

export { PLAN_STATE_CUSTOM_TYPE };

const PLAN_TOOLS = new Set(["plan_ask", "grill_plan", "grill_done", "plan_write", "plan_exit"]);
const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const TODO_TOOLS = ["todo_read", "todo_write"];
/** customType for the one-line, display:false kick messages that drive A-class
 * (turn_end) phase transitions. See advancePhase(). */
const PLAN_KICK_CUSTOM_TYPE = "yuki-plan-flow-kick";

type Phase = "idle" | "research" | "grilling" | "drafting" | "reviewing" | "revising" | "awaiting_approval" | "executing" | "aborted";

interface PlanStep {
	id: string;
	content: string;
	activeForm: string;
	rationale?: string;
	files?: string[];
	validation?: string[];
	dependsOn?: string[];
}

interface OpenQuestion {
	id: string;
	topic: string;
	question: string;
	whyMatters: string;
	status: "open" | "resolved";
	resolution?: string;
	answer?: string;
	askedAt?: string;
	answeredAt?: string;
}

interface ReviewFeedback {
	summary: string;
	blockingIssues: Array<{ stepId?: string; issue: string; suggestion?: string }>;
	risks?: string[];
	missingValidation?: string[];
	raw?: string;
}

interface PlanFlowState {
	version: 1;
	active: boolean;
	phase: Phase;
	planId: string;
	request: string;
	title?: string;
	previousActiveTools: string[];
	currentActiveTools: string[];
	questions: OpenQuestion[];
	askCount: number;
	maxAskCount: number;
	steps: PlanStep[];
	background?: string;
	risks: string[];
	reviewed: boolean;
	reviewPending: boolean;
	reviewSkipped?: boolean;
	reviewSkippedReason?: string;
	reviewFeedback?: ReviewFeedback;
	approved: boolean;
	draftPath: string;
	finalPath?: string;
	approvedAt?: string;
	todoListId?: string;
	createdAt: string;
	updatedAt: string;
	abortedAt?: string;
	abortReason?: string;
}

interface PlanStateRecord {
	kind: "snapshot" | "abort";
	reason: "plan_start" | "phase_change" | "review_complete" | "review_skipped" | "approval" | "abort" | "tool_result";
	planId: string;
	state: PlanFlowState;
}

const PlanStepInputSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable step id. If omitted, plan_write assigns step-1, step-2, ..." })),
	content: Type.String({ description: "Imperative task description" }),
	activeForm: Type.String({ description: "In-progress form of this task" }),
	rationale: Type.Optional(Type.String()),
	files: Type.Optional(Type.Array(Type.String())),
	validation: Type.Optional(Type.Array(Type.String())),
	dependsOn: Type.Optional(Type.Array(Type.String())),
});

const PlanWriteParams = Type.Object({
	title: Type.String(),
	background: Type.String(),
	steps: Type.Array(PlanStepInputSchema, { minItems: 1 }),
	risks: Type.Optional(Type.Array(Type.String())),
});

type PlanWriteInput = Static<typeof PlanWriteParams>;

const PlanExitParams = Type.Object({
	message: Type.Optional(Type.String({ description: "Short message to show before approval" })),
});

type PlanExitInput = Static<typeof PlanExitParams>;

const QuestionOptionSchema = Type.Object({
	label: Type.String(),
	description: Type.Optional(Type.String()),
	value: Type.Optional(Type.String()),
});

const PlanAskParams = Type.Object({
	topic: Type.String(),
	question: Type.String(),
	whyMatters: Type.String(),
	options: Type.Optional(Type.Array(QuestionOptionSchema, { maxItems: 6 })),
	allowOther: Type.Optional(Type.Boolean()),
});

type PlanAskInput = Static<typeof PlanAskParams>;

const GrillPlanParams = Type.Object({
	open_questions: Type.Array(
		Type.Object({
			topic: Type.String(),
			question: Type.String(),
			why_matters: Type.String(),
			status: StringEnum(["open", "resolved"] as const),
			resolution: Type.Optional(Type.String()),
		}),
		{ maxItems: 5 },
	),
	restart_research: Type.Optional(Type.Boolean()),
});

type GrillPlanInput = Static<typeof GrillPlanParams>;

const GrillDoneParams = Type.Object({
	summary: Type.String({ description: "Resolved decisions summary" }),
});

export default function planFlowExtension(pi: ExtensionAPI) {
	// Guards against running two automatic reviews concurrently within one process.
	let reviewInFlight = false;
	// Counts consecutive phase-discipline tool blocks so repeated wrong-tool calls escalate to a
	// shorter, stronger steer. Re-emitting the identical message on every rejected call read like a
	// deadloop in the incident; an allowed call resets it. In-memory only, like the compile guard's
	// retry counters — a reload starts fresh, which is fine for a steering hint.
	let consecutiveBlockedToolCalls = 0;

	pi.registerCommand("plan", {
		description: "Start yuki plan-flow for a requested change",
		handler: async (args, ctx) => {
			const request = args.trim();
			if (!request) {
				ctx.ui.notify("Usage: /plan <request>", "warning");
				return;
			}

			const existing = reconstructPlanState(ctx);
			if (existing?.active && existing.phase !== "aborted") {
				ctx.ui.notify(`A yuki plan is already active (${existing.phase}). Use /plan-abort first.`, "warning");
				return;
			}

			const now = new Date().toISOString();
			const previousActiveTools = pi.getActiveTools();
			const state: PlanFlowState = {
				version: 1,
				active: true,
				phase: "research",
				planId: createPlanId(),
				request,
				previousActiveTools,
				currentActiveTools: [],
				questions: [],
				askCount: 0,
				maxAskCount: 5,
				steps: [],
				risks: [],
				reviewed: false,
				reviewPending: false,
				approved: false,
				draftPath: "",
				createdAt: now,
				updatedAt: now,
			};
			state.draftPath = `.pi/plan-draft-${state.planId}.md`;
			state.currentActiveTools = getAllowedToolsForState(state);

			// rev.3 P0-1: drive the first turn with a display:false kick instead of a
			// visible sendUserMessage. The command handler itself does not start a turn
			// (slash commands execute and return without prompting), and at this point the
			// agent is not streaming, so advancePhase's sendMessage(triggerTurn) starts a
			// clean, narrowed research turn with zero visible noise. The detailed research
			// instructions come from before_agent_start -> buildPhasePrompt (research).
			ctx.ui.notify(`yuki plan-flow started · phase: research · plan ${state.planId}`, "info");
			advancePhase(pi, ctx, state, buildKickoffContent(state), "plan_start");
		},
	});

	pi.registerCommand("plan-abort", {
		description: "Abort the active yuki plan-flow",
		handler: async (args, ctx) => {
			const state = reconstructPlanState(ctx);
			if (!state?.active || state.phase === "aborted") {
				ctx.ui.notify("No active yuki plan to abort.", "info");
				return;
			}
			const aborted = await abortPlan(pi, ctx, state, args.trim() || "user aborted");
			ctx.ui.notify(`Aborted yuki plan ${aborted.planId}.`, "info");
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show yuki plan-flow status",
		handler: async (_args, ctx) => {
			const state = reconstructPlanState(ctx);
			if (!state?.active || state.phase === "aborted") {
				ctx.ui.notify("No active yuki plan.", "info");
				return;
			}
			ctx.ui.notify(formatPlanStatus(state), "info");
			updatePlanUi(ctx, state);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (state?.active && state.phase !== "aborted") {
			applyActiveTools(pi, state);
			updatePlanUi(ctx, state);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (state?.active && state.phase !== "aborted") {
			applyActiveTools(pi, state);
			updatePlanUi(ctx, state);
		} else {
			ctx.ui.setStatus("yuki-plan", undefined);
			ctx.ui.setWidget("yuki-plan", undefined);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${buildPhasePrompt(state)}` };
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted") return;
		// Block plan_write while an automatic review is running. Otherwise an
		// interjected turn could land a newer draft that the in-flight review
		// (built from the older snapshot) would then overwrite on persist.
		if (reviewInFlight && event.toolName === "plan_write") {
			return {
				block: true,
				reason: "yuki plan-flow: automatic review in progress; wait for the review result before calling plan_write again.",
			};
		}
		const allowed = getAllowedToolsForState(state);
		if (!allowed.includes(event.toolName)) {
			consecutiveBlockedToolCalls += 1;
			return {
				block: true,
				reason: buildBlockedToolReason(state, event.toolName, allowed, consecutiveBlockedToolCalls),
			};
		}
		consecutiveBlockedToolCalls = 0;
	});

	pi.on("turn_end", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		// Fire whenever a draft is awaiting its automatic review, not just on the
		// turn that produced the plan_write. If a prior review was interrupted
		// (crash/restart), the durable state is still drafting+reviewPending, and
		// the next turn_end re-triggers it instead of getting stuck until abort.
		if (!state?.active || state.phase !== "drafting" || !state.reviewPending || state.reviewed) return;
		if (reviewInFlight) return;

		reviewInFlight = true;
		try {
			const reviewed = await runAutomaticReview(ctx, state);
			persistPlanState(pi, reviewed, reviewed.reviewSkipped ? "review_skipped" : "review_complete");
			applyActiveTools(pi, reviewed);
			updatePlanUi(ctx, reviewed);
			// rev.3 P0-3/P0-4: drive approval directly from here. The turn has ended
			// (!isStreaming), so this is an A-class transition point and kickTurn's
			// triggerTurn actually starts a clean, narrowed next turn. The old
			// sendUserMessage(steer) that produced visible noise is gone.
			await drivePostReview(pi, ctx, reviewed);
		} finally {
			reviewInFlight = false;
		}
	});

	pi.registerTool({
		name: "grill_plan",
		label: "Grill Plan",
		description: "Record critical planning questions after research. Use before drafting to decide whether to ask the user or proceed.",
		promptSnippet: "Record critical yuki plan-flow questions before drafting.",
		promptGuidelines: [
			"Use grill_plan after read-only research to identify only decisions that can change implementation architecture or cause rework.",
			"Do not ask facts you can inspect from the repository; ask at most five critical questions total.",
		],
		parameters: GrillPlanParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("grill_plan: no active yuki plan.");
			if (!["research", "grilling"].includes(current.phase)) throw new Error(`grill_plan: cannot run during phase ${current.phase}.`);
			const next = applyGrillPlan(current, params);
			applyActiveTools(pi, next);
			updatePlanUi(ctx, next);
			return {
				content: [{ type: "text" as const, text: buildGrillPlanResult(next) }],
				details: { state: next },
			};
		},
	});

	pi.registerTool({
		name: "plan_ask",
		label: "Plan Ask",
		description: "Ask the user one critical yuki plan-flow question and record the answer.",
		promptSnippet: "Ask one critical yuki plan-flow question during grilling.",
		promptGuidelines: [
			"Use plan_ask only for critical decisions that cannot be answered from code inspection.",
			"Do not exceed five total plan_ask calls in one yuki plan-flow.",
		],
		parameters: PlanAskParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("plan_ask: no active yuki plan.");
			if (current.phase !== "grilling") throw new Error(`plan_ask: questions are only allowed during grilling, not ${current.phase}.`);
			if (current.askCount >= current.maxAskCount) throw new Error("plan_ask: question limit reached; call grill_done and proceed with explicit assumptions.");
			if (!ctx.hasUI) throw new Error("plan_ask: interactive UI is required to ask the user.");

			const answer = await askPlanQuestion(ctx, params);
			if (!answer) throw new Error("plan_ask: user did not answer.");
			const next = recordPlanAnswer(current, params, answer);
			updatePlanUi(ctx, next);
			return {
				content: [{ type: "text" as const, text: `User answered '${params.topic}': ${answer}` }],
				details: { state: next, answer },
			};
		},
	});

	pi.registerTool({
		name: "grill_done",
		label: "Grill Done",
		description: "Finish yuki plan-flow grilling and move to drafting.",
		promptSnippet: "Finish yuki plan-flow grilling and proceed to plan_write.",
		parameters: GrillDoneParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("grill_done: no active yuki plan.");
			if (!["research", "grilling"].includes(current.phase)) throw new Error(`grill_done: cannot run during phase ${current.phase}.`);
			const next = touch({ ...current, phase: "drafting" });
			applyActiveTools(pi, next);
			updatePlanUi(ctx, next);
			// rev.3 B-class (tool-execute) transition: triggerTurn would degrade to steer here,
			// so we do not start a new turn. The decisive result text guides the model to
			// converge on plan_write within this turn; the narrowed tool set (plan_write only)
			// takes effect on the next turn. block defends mid-turn if the model retries plan_ask.
			return {
				content: [{ type: "text" as const, text: `Phase is now drafting. Grilling summary: ${params.summary}. Call plan_write with the structured plan.` }],
				details: { state: next, summary: params.summary },
			};
		},
	});

	pi.registerTool({
		name: "plan_write",
		label: "Plan Write",
		description: "Write or revise the current yuki plan as structured steps. This writes branch-safe plan state and renders a draft file.",
		promptSnippet: "Write the yuki plan draft with structured steps before asking for approval.",
		promptGuidelines: [
			"Use plan_write after read-only research when a yuki plan-flow is active.",
			"plan_write is the source of truth for plan steps; do not create free-form plan markdown instead.",
			"Each plan_write step must include content and activeForm, and should include validation when possible.",
		],
		parameters: PlanWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("plan_write: no active yuki plan. Start with /plan <request>.");
			if (!["drafting", "revising", "awaiting_approval"].includes(current.phase)) {
				throw new Error(`plan_write: cannot write a plan during phase ${current.phase}. Finish research/grilling with grill_done first.`);
			}

			const next = applyPlanWrite(current, params);
			await renderDraft(ctx, next);
			applyActiveTools(pi, next);
			updatePlanUi(ctx, next);

			return {
				content: [{ type: "text" as const, text: buildPlanWriteResult(next) }],
				details: { state: next },
			};
		},
		renderCall(args, theme) {
			const title = typeof args.title === "string" ? args.title : "untitled";
			const count = Array.isArray(args.steps) ? args.steps.length : 0;
			return new Text(theme.fg("toolTitle", theme.bold("plan_write ")) + theme.fg("muted", `${title} `) + theme.fg("dim", `${count} step(s)`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const state = (result.details as { state?: PlanFlowState } | undefined)?.state;
			if (!state) return new Text(textContent(result), 0, 0);
			return new Text(theme.fg("success", "✓ plan draft ready ") + theme.fg("muted", `${state.steps.length} step(s), phase=${state.phase}`), 0, 0);
		},
	});

	pi.registerTool({
		name: "plan_exit",
		label: "Plan Exit",
		description: "Submit the current yuki plan for user approval. Approval promotes the plan and seeds a plan-owned todo list.",
		promptSnippet: "Submit the yuki plan for user approval before implementation.",
		promptGuidelines: [
			"Use plan_exit only after plan_write has produced the plan the user should approve.",
			"Do not start implementation before plan_exit returns approval and the plan enters executing phase.",
		],
		parameters: PlanExitParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("plan_exit: no active yuki plan.");
			if (current.phase !== "awaiting_approval") throw new Error(`plan_exit: plan is not awaiting approval (phase=${current.phase}). Call plan_write first.`);
			if (current.steps.length === 0) throw new Error("plan_exit: current plan has no steps.");

			// rev.3 P0-3/P0-4: plan_exit runs inside a tool execute() (streaming), so it is
			// a B-class transition point — triggerTurn would degrade to a steer here. We do
			// NOT kick a new turn; instead the decisive tool-result text guides the model to
			// converge (approve -> todo_write, revising -> plan_write) within this turn. The
			// narrowed tool set takes effect on the next turn.
			if (!ctx.hasUI) {
				// Headless/programmatic (E2E, cron): no dialog available. Auto-approve so
			// plan-flow can proceed — running /plan in a headless context already implies
			// intent to execute. Interactive confirmation is the hasUI path below.
				const approved = await approvePlan(pi, ctx, current);
				persistPlanState(pi, approved, "approval");
				applyActiveTools(pi, approved);
				updatePlanUi(ctx, approved);
				return {
					content: [{ type: "text" as const, text: `Plan auto-approved (headless) and saved to ${approved.finalPath}. A plan-owned todo list '${approved.todoListId}' was created. Begin execution with todo_write on the first step.` }],
					details: { state: approved },
				};
			}

			const outcome = await runApprovalDialog(pi, ctx, current, params.message);
			if (outcome.kind === "cancelled") {
				return { content: [{ type: "text" as const, text: "Plan cancelled by user." }], details: { state: outcome.state } };
			}
			if (outcome.kind === "revising") {
				return {
					content: [{ type: "text" as const, text: `User requested revision: ${outcome.revisionReason}\nCall plan_write with the revised plan.` }],
					details: { state: outcome.state, revisionReason: outcome.revisionReason },
				};
			}
			// approved (B-class): decisive result guides the model to start todo_write.
			return {
				content: [{ type: "text" as const, text: `Plan approved and saved to ${outcome.state.finalPath}. A plan-owned todo list '${outcome.state.todoListId}' was created. Begin execution with todo_write on the first step.` }],
				details: { state: outcome.state },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("plan_exit ")) + theme.fg("muted", "request approval"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const state = (result.details as { state?: PlanFlowState } | undefined)?.state;
			if (!state) return new Text(textContent(result), 0, 0);
			if (state.phase === "executing") return new Text(theme.fg("success", `✓ approved ${state.finalPath ?? ""}`), 0, 0);
			if (state.phase === "revising") return new Text(theme.fg("warning", "Revision requested"), 0, 0);
			if (state.phase === "aborted") return new Text(theme.fg("warning", "Plan cancelled"), 0, 0);
			return new Text(theme.fg("muted", `phase=${state.phase}`), 0, 0);
		},
	});
}

function applyGrillPlan(current: PlanFlowState, params: GrillPlanInput): PlanFlowState {
	const incoming = params.open_questions.map((question, index) => {
		const resolution = question.resolution?.trim();
		if (question.status === "resolved" && !isExecutableResolution(resolution)) {
			throw new Error(`grill_plan: resolved topic '${question.topic}' needs an executable resolution, not '${resolution ?? ""}'.`);
		}
		return {
			id: slugify(question.topic) || `question-${index + 1}`,
			topic: question.topic.trim(),
			question: question.question.trim(),
			whyMatters: question.why_matters.trim(),
			status: question.status,
			resolution,
		} satisfies OpenQuestion;
	});

	const byTopic = new Map<string, OpenQuestion>();
	for (const existing of current.questions) byTopic.set(existing.topic, existing);
	for (const question of incoming) {
		const previous = byTopic.get(question.topic);
		if (previous?.status === "resolved" && question.status !== "resolved") continue;
		byTopic.set(question.topic, { ...previous, ...question });
	}

	return touch({
		...current,
		phase: params.restart_research ? "research" : "grilling",
		questions: [...byTopic.values()],
	});
}

async function askPlanQuestion(ctx: ExtensionContext, params: PlanAskInput): Promise<string | undefined> {
	const options = params.options ?? [];
	if (options.length === 0) return (await ctx.ui.input(params.question, "Type your answer..."))?.trim() || undefined;
	const labels = options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
	if (params.allowOther !== false) labels.push("Other / custom answer");
	const selected = await ctx.ui.select(params.question, labels);
	if (!selected) return undefined;
	const otherIndex = labels.length - 1;
	if (params.allowOther !== false && labels.indexOf(selected) === otherIndex) {
		return (await ctx.ui.input("Custom answer", "Type your answer..."))?.trim() || undefined;
	}
	const option = options[labels.indexOf(selected)];
	return option ? option.value ?? option.label : selected;
}

function recordPlanAnswer(current: PlanFlowState, params: PlanAskInput, answer: string): PlanFlowState {
	const now = new Date().toISOString();
	const questions = [...current.questions];
	const index = questions.findIndex((question) => question.topic === params.topic);
	const nextQuestion: OpenQuestion = {
		id: index >= 0 ? questions[index].id : slugify(params.topic) || `question-${questions.length + 1}`,
		topic: params.topic,
		question: params.question,
		whyMatters: params.whyMatters,
		status: isExecutableResolution(answer) ? "resolved" : "open",
		resolution: isExecutableResolution(answer) ? answer : undefined,
		answer,
		askedAt: index >= 0 ? questions[index].askedAt ?? now : now,
		answeredAt: now,
	};
	if (index >= 0) questions[index] = { ...questions[index], ...nextQuestion };
	else questions.push(nextQuestion);
	return touch({ ...current, questions, askCount: current.askCount + 1 });
}

function buildGrillPlanResult(state: PlanFlowState): string {
	const open = state.questions.filter((question) => question.status === "open");
	if (state.phase === "research") return "Research restarted. Keep resolved decisions and inspect more files before calling grill_plan again.";
	if (open.length === 0) return "No open critical questions. Call grill_done to proceed to drafting.";
	return `Recorded ${open.length} open critical question(s). Ask them one at a time with plan_ask, or call grill_done if you can proceed with explicit assumptions. Remaining question budget: ${Math.max(0, state.maxAskCount - state.askCount)}.`;
}

function buildPlanWriteResult(state: PlanFlowState): string {
	// rev.3: positive, decisive B-class tool result. drafting plan_write is a
	// tool-execute transition (streaming), so triggerTurn cannot start a clean new
	// turn here; the decisive result text guides the model to converge (wait for
	// review) within the current turn.
	if (state.reviewPending) return `Plan draft '${state.title}' written. Automatic review is pending; wait for it before doing anything else.`;
	return `Plan '${state.title}' written. Call plan_exit to request user approval.`;
}

async function runAutomaticReview(ctx: ExtensionContext, state: PlanFlowState): Promise<PlanFlowState> {
	const reviewing = touch({ ...state, phase: "reviewing" });
	const model = ctx.model;
	if (!model) return touch({ ...reviewing, phase: "awaiting_approval", reviewPending: false, reviewSkipped: true, reviewSkippedReason: "No active model" });

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return touch({ ...reviewing, phase: "awaiting_approval", reviewPending: false, reviewSkipped: true, reviewSkippedReason: auth.error });
		if (!auth.apiKey) return touch({ ...reviewing, phase: "awaiting_approval", reviewPending: false, reviewSkipped: true, reviewSkippedReason: "No API key for active model" });

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 60_000);
		ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });
		try {
			const response = await complete(
				model,
				{
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: buildReviewPrompt(state) }],
							timestamp: Date.now(),
						},
					],
				},
				{ apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal, timeoutMs: 60_000 },
			);
			const raw = response.content.filter((block): block is { type: "text"; text: string } => block.type === "text").map((block) => block.text).join("\n");
			const feedback = parseReviewFeedback(raw);
			const hasBlocking = feedback.blockingIssues.length > 0;
			return touch({
				...reviewing,
				phase: hasBlocking ? "revising" : "awaiting_approval",
				reviewed: !hasBlocking,
				reviewPending: false,
				reviewSkipped: false,
				reviewSkippedReason: undefined,
				reviewFeedback: feedback,
			});
		} finally {
			clearTimeout(timeout);
		}
	} catch (error) {
		return touch({
			...reviewing,
			phase: "awaiting_approval",
			reviewPending: false,
			reviewSkipped: true,
			reviewSkippedReason: String(error),
		});
	}
}

function buildReviewPrompt(state: PlanFlowState): string {
	return [
		"Review this implementation plan. Do not rewrite it.",
		"Return strict JSON only with this shape:",
		'{"summary":"...","blockingIssues":[{"stepId":"step-1","issue":"...","suggestion":"..."}],"risks":["..."],"missingValidation":["step-2"]}',
		"Only include blockingIssues for problems that would cause rework, unsafe changes, or an unexecutable plan.",
		"If the plan is acceptable, return an empty blockingIssues array.",
		"",
		renderPlanMarkdown(state),
	].join("\n");
}

function parseReviewFeedback(raw: string): ReviewFeedback {
	const jsonText = raw.match(/```json\s*([\s\S]*?)```/i)?.[1] ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw;
	try {
		const parsed = JSON.parse(jsonText) as Partial<ReviewFeedback>;
		return {
			summary: typeof parsed.summary === "string" ? parsed.summary : "Review completed.",
			blockingIssues: Array.isArray(parsed.blockingIssues) ? parsed.blockingIssues.filter((issue) => issue && typeof issue.issue === "string").map((issue) => ({
				stepId: typeof issue.stepId === "string" ? issue.stepId : undefined,
				issue: issue.issue,
				suggestion: typeof issue.suggestion === "string" ? issue.suggestion : undefined,
			})) : [],
			risks: Array.isArray(parsed.risks) ? parsed.risks.filter((risk): risk is string => typeof risk === "string") : [],
			missingValidation: Array.isArray(parsed.missingValidation) ? parsed.missingValidation.filter((item): item is string => typeof item === "string") : [],
			raw,
		};
	} catch {
		return { summary: "Review returned non-JSON feedback; treat as blocking revision feedback.", blockingIssues: [{ issue: raw }], raw };
	}
}

/** rev.3 P0-3: format review blocking issues for the revising kick content. The kick
 * is display:false (not in the visible transcript) but enters the LLM context, so the
 * model sees what to fix. The old buildReviewSteeringMessage carried this via a visible
 * sendUserMessage steer; that path is gone, so the issues ride the kick instead. */
function formatReviewIssues(state: PlanFlowState): string {
	if (state.reviewSkipped) return `Automatic review was skipped: ${state.reviewSkippedReason ?? "unknown reason"}.`;
	const issues = state.reviewFeedback?.blockingIssues;
	if (!issues || issues.length === 0) return "Review requested changes.";
	return issues.map((issue, index) => `${index + 1}. ${issue.stepId ? `[${issue.stepId}] ` : ""}${issue.issue}${issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ""}`).join("\n");
}

function reconstructPlanState(ctx: ExtensionContext): PlanFlowState | undefined {
	let state: PlanFlowState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && "customType" in entry && entry.customType === PLAN_STATE_CUSTOM_TYPE) {
			const record = (entry as { data?: PlanStateRecord }).data;
			if (record?.state) state = normalizePlanState(record.state);
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult" || !PLAN_TOOLS.has(message.toolName)) continue;
		const details = message.details as { state?: PlanFlowState } | undefined;
		if (details?.state) state = normalizePlanState(details.state);
	}
	return state;
}

function persistPlanState(pi: ExtensionAPI, state: PlanFlowState, reason: PlanStateRecord["reason"]) {
	pi.appendEntry(PLAN_STATE_CUSTOM_TYPE, { kind: state.phase === "aborted" ? "abort" : "snapshot", reason, planId: state.planId, state } satisfies PlanStateRecord);
}

function applyPlanWrite(current: PlanFlowState, params: PlanWriteInput): PlanFlowState {
	const steps = params.steps.map((step, index) => ({
		id: step.id?.trim() || `step-${index + 1}`,
		content: step.content.trim(),
		activeForm: step.activeForm.trim(),
		rationale: step.rationale?.trim() || undefined,
		files: step.files?.filter(Boolean),
		validation: step.validation?.filter(Boolean),
		dependsOn: step.dependsOn?.filter(Boolean),
	}));

	if (steps.some((step) => !step.content || !step.activeForm)) {
		throw new Error("plan_write: every step must include non-empty content and activeForm.");
	}

	const nextPhase: Phase = current.phase === "drafting" ? "drafting" : "awaiting_approval";
	return touch({
		...current,
		phase: nextPhase,
		title: params.title.trim(),
		background: params.background.trim(),
		steps,
		risks: params.risks?.map((risk) => risk.trim()).filter(Boolean) ?? [],
		reviewed: current.phase !== "drafting",
		reviewPending: current.phase === "drafting",
		reviewSkipped: current.phase === "drafting" ? false : current.reviewSkipped,
		reviewSkippedReason: current.phase === "drafting" ? undefined : current.reviewSkippedReason,
	});
}

async function approvePlan(pi: ExtensionAPI, ctx: ExtensionContext, current: PlanFlowState): Promise<PlanFlowState> {
	const approvedAt = new Date().toISOString();
	const todoListId = `plan-${current.planId}`;
	const finalPath = await writeFinalPlan(ctx, { ...current, phase: "executing", approved: true, approvedAt, todoListId });
	// The draft was a working artifact; the canonical plan now lives at finalPath.
	// Remove it so approved drafts don't accumulate in the user's .pi/ directory.
	if (current.draftPath) {
		await unlink(resolve(ctx.cwd, current.draftPath)).catch(() => undefined);
	}
	const todoState = createTodoState({
		listId: todoListId,
		source: "plan",
		owner: { type: "plan", planId: current.planId },
		title: current.title ? `Plan: ${current.title}` : `Plan ${current.planId}`,
		todos: current.steps.map((step) => ({
			id: step.id,
			content: step.content,
			activeForm: step.activeForm,
			status: "pending" as const,
		})),
	});
	pi.appendEntry(TODO_STATE_CUSTOM_TYPE, makeTodoStateRecord(todoState, "seed"));

	return touch({
		...current,
		phase: "executing",
		approved: true,
		approvedAt,
		finalPath,
		todoListId,
		reviewPending: false,
	});
}

async function abortPlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanFlowState, reason: string): Promise<PlanFlowState> {
	const aborted = touch({ ...state, active: false, phase: "aborted", abortedAt: new Date().toISOString(), abortReason: reason });
	persistPlanState(pi, aborted, "abort");
	pi.setActiveTools(state.previousActiveTools);
	ctx.ui.setStatus("yuki-plan", undefined);
	ctx.ui.setWidget("yuki-plan", undefined);
	if (state.draftPath) {
		await unlink(resolve(ctx.cwd, state.draftPath)).catch(() => undefined);
	}
	return aborted;
}

type ApprovalOutcome =
	| { kind: "approved"; state: PlanFlowState }
	| { kind: "revising"; state: PlanFlowState; revisionReason: string }
	| { kind: "cancelled"; state: PlanFlowState };

/** rev.3 P0-3: the shared approval dialog used by both the automatic (turn_end)
 * path and the plan_exit tool. Shows Approve / Request revision / Cancel, performs
 * the state transition (approvePlan / revising / abortPlan), persists, narrows tools,
 * and updates the UI. Returns the outcome; the caller decides how to drive the next
 * turn (A-class turn_end callers use kickTurn; B-class plan_exit returns a tool result).
 *
 * Requires ctx.hasUI — callers must branch on hasUI first. */
async function runApprovalDialog(pi: ExtensionAPI, ctx: ExtensionContext, current: PlanFlowState, message?: string): Promise<ApprovalOutcome> {
	if (!ctx.hasUI) throw new Error("runApprovalDialog: interactive UI is required for approval.");
	if (current.steps.length === 0) throw new Error("runApprovalDialog: current plan has no steps.");

	const choice = await ctx.ui.select(message ?? `Approve yuki plan '${current.title ?? current.planId}'?`, [
		"Approve",
		"Request revision",
		"Cancel",
	]);

	if (choice === "Cancel" || choice === undefined) {
		const aborted = await abortPlan(pi, ctx, current, "cancelled during approval");
		return { kind: "cancelled", state: aborted };
	}

	if (choice === "Request revision") {
		const reason = (await ctx.ui.editor("Revision reason", ""))?.trim() || "User requested revision.";
		const next = touch({ ...current, phase: "revising" });
		persistPlanState(pi, next, "phase_change");
		applyActiveTools(pi, next);
		updatePlanUi(ctx, next);
		return { kind: "revising", state: next, revisionReason: reason };
	}

	const approved = await approvePlan(pi, ctx, current);
	persistPlanState(pi, approved, "approval");
	applyActiveTools(pi, approved);
	updatePlanUi(ctx, approved);
	return { kind: "approved", state: approved };
}

/** rev.3 P0-3/P0-4: drive the post-review flow from the turn_end handler (A-class).
 *
 * `state` has already been persisted/narrowed/UI-updated by the caller (the review
 * turn_end handler) for the reviewing->revising/awaiting_approval transition, so here
 * we only drive the next turn. For the approved branch we additionally run the dialog
 * (which re-persists the executing state) and then kickTurn the execution turn. */
async function drivePostReview(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanFlowState): Promise<void> {
	if (state.phase === "revising") {
		const issueCount = state.reviewFeedback?.blockingIssues.length ?? 0;
		if (ctx.hasUI) ctx.ui.notify(`Automatic review found ${issueCount} blocking issue(s); revising.`, "warning");
		// state already persisted/narrowed/UI-updated for revising. The kick is
		// display:false (zero visible noise) but enters the LLM context, so it carries
		// the blocking issues the model must address — replacing the old visible steer.
		kickTurn(pi, `Address the automatic review feedback and call plan_write with the revised plan.\nBlocking issues:\n${formatReviewIssues(state)}`);
		return;
	}

	// phase === awaiting_approval (review passed or skipped)
	if (ctx.hasUI) {
		// Direct approval dialog — no visible steering text, no need for the model to
		// call plan_exit. hasUI guard: headless falls through to the else branch.
		const outcome = await runApprovalDialog(pi, ctx, state);
		if (outcome.kind === "approved") {
			ctx.ui.notify(`Plan approved · ${outcome.state.finalPath ?? ""}`, "info");
			// A-class: state is executing (persisted/narrowed by runApprovalDialog);
			// kick a clean execution turn so the model starts todo_write without the
			// user having to say "continue".
			kickTurn(pi, "Plan approved. Begin execution: todo_write the first step as in_progress.");
			return;
		}
		if (outcome.kind === "revising") {
			// runApprovalDialog already persisted/narrowed/UI-updated revising.
			kickTurn(pi, "Address the revision request and call plan_write with the revised plan.");
			return;
		}
		// cancelled: abortPlan already persisted + cleared UI; no turn to kick.
		return;
	}

	// Headless (no UI): cannot show a dialog. Kick a turn so the model calls
	// plan_exit, whose headless branch auto-approves (see plan_exit execute).
	kickTurn(pi, "Plan is ready for approval; call plan_exit to approve it.");
}

async function renderDraft(ctx: ExtensionContext, state: PlanFlowState) {
	const absolutePath = resolve(ctx.cwd, state.draftPath);
	await withFileMutationQueue(absolutePath, async () => {
		await mkdir(dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, renderPlanMarkdown(state), "utf8");
	});
}

async function writeFinalPlan(ctx: ExtensionContext, state: PlanFlowState): Promise<string> {
	const docsDir = resolve(ctx.cwd, "docs");
	await mkdir(docsDir, { recursive: true });
	const slug = slugify(state.title ?? "plan");
	let relativePath = `docs/plan-${slug}-${state.planId}.md`;
	let absolutePath = resolve(ctx.cwd, relativePath);
	let suffix = 2;
	while (await exists(absolutePath)) {
		relativePath = `docs/plan-${slug}-${state.planId}-${suffix}.md`;
		absolutePath = resolve(ctx.cwd, relativePath);
		suffix++;
	}
	await withFileMutationQueue(absolutePath, async () => {
		await writeFile(absolutePath, renderPlanMarkdown({ ...state, finalPath: relativePath }), "utf8");
	});
	return relativePath;
}

function renderPlanMarkdown(state: PlanFlowState): string {
	const lines: string[] = [];
	lines.push(`# ${state.title ?? "Yuki Plan"}`);
	lines.push("");
	lines.push(`> Plan ID: ${state.planId}  `);
	lines.push(`> Status: ${state.approved ? "Approved snapshot" : "Draft"}  `);
	if (state.approvedAt) lines.push(`> Approved at: ${state.approvedAt}  `);
	if (state.todoListId) lines.push(`> Todo list ID: ${state.todoListId}  `);
	lines.push("> Execution progress source: Pi todo state (`todo_write` / `todo_read`), not this document.");
	lines.push("");
	lines.push("## Request");
	lines.push("");
	lines.push(state.request);
	lines.push("");
	lines.push("## Background");
	lines.push("");
	lines.push(state.background || "TBD");
	lines.push("");
	lines.push("## Decisions");
	lines.push("");
	const resolvedQuestions = state.questions.filter((question) => question.status === "resolved" && question.resolution);
	if (resolvedQuestions.length === 0) lines.push("- None recorded.");
	else resolvedQuestions.forEach((question) => lines.push(`- ${question.topic}: ${question.resolution}`));
	lines.push("");
	lines.push("## Steps");
	lines.push("");
	state.steps.forEach((step, index) => {
		lines.push(`${index + 1}. **${step.content}**`);
		lines.push(`   - ID: ${step.id}`);
		lines.push(`   - Active form: ${step.activeForm}`);
		if (step.rationale) lines.push(`   - Rationale: ${step.rationale}`);
		if (step.files?.length) lines.push(`   - Files: ${step.files.join(", ")}`);
		if (step.validation?.length) lines.push(`   - Validation: ${step.validation.join("; ")}`);
		if (step.dependsOn?.length) lines.push(`   - Depends on: ${step.dependsOn.join(", ")}`);
	});
	lines.push("");
	lines.push("## Risks");
	lines.push("");
	if (state.risks.length === 0) lines.push("- None identified.");
	else state.risks.forEach((risk) => lines.push(`- ${risk}`));
	lines.push("");
	lines.push("## Review");
	lines.push("");
	lines.push(`- Automatic review: ${state.reviewSkipped ? `skipped (${state.reviewSkippedReason})` : state.reviewed ? "completed" : "not completed"}`);
	lines.push("");
	return lines.join("\n");
}

function getAllowedToolsForState(state: PlanFlowState): string[] {
	const base = new Set<string>();
	if (state.phase === "research") {
		for (const tool of state.previousActiveTools) if (READ_ONLY_TOOLS.has(tool)) base.add(tool);
		base.add("grill_plan");
	} else if (state.phase === "grilling") {
		for (const tool of state.previousActiveTools) if (READ_ONLY_TOOLS.has(tool)) base.add(tool);
		base.add("plan_ask");
		base.add("grill_plan");
		base.add("grill_done");
	} else if (state.phase === "drafting" || state.phase === "revising") {
		base.add("plan_write");
	} else if (state.phase === "awaiting_approval") {
		base.add("plan_write");
		base.add("plan_exit");
	} else if (state.phase === "reviewing") {
		// Automatic review is extension-driven; no model tools should be called.
	} else if (state.phase === "executing") {
		for (const tool of state.previousActiveTools) base.add(tool);
		TODO_TOOLS.forEach((tool) => base.add(tool));
	} else {
		for (const tool of state.previousActiveTools) base.add(tool);
	}
	return [...base];
}

function applyActiveTools(pi: ExtensionAPI, state: PlanFlowState) {
	pi.setActiveTools(getAllowedToolsForState(state));
}

function updatePlanUi(ctx: ExtensionContext, state: PlanFlowState) {
	if (!ctx.hasUI) return;
	if (!state.active || state.phase === "aborted") {
		ctx.ui.setStatus("yuki-plan", undefined);
		ctx.ui.setWidget("yuki-plan", undefined);
		return;
	}
	if (state.phase === "executing") {
		ctx.ui.setStatus("yuki-plan", undefined);
		ctx.ui.setWidget("yuki-plan", undefined);
		return;
	}
	ctx.ui.setStatus("yuki-plan", `plan ${state.phase}`);
	if (state.steps.length > 0) {
		ctx.ui.setWidget("yuki-plan", state.steps.map((step, index) => `${index + 1}. ${step.content}`));
	} else {
		ctx.ui.setWidget("yuki-plan", [`Plan ${state.planId}`, `Phase: ${state.phase}`, `Request: ${state.request}`]);
	}
}

/** rev.3 P0-5: trigger a clean new turn with a one-line, display:false kick.
 *
 * `display:false` keeps the kick out of the visible transcript (zero visible noise);
 * the one-line content still enters the LLM context. Only fires a real new turn when
 * the agent is not streaming, so this is only correct from turn_end handlers (A-class
 * transition points). Inside a tool execute() the agent is streaming and triggerTurn
 * silently degrades to a steer — see advancePhase doc. */
function kickTurn(pi: ExtensionAPI, content: string) {
	pi.sendMessage(
		{ customType: PLAN_KICK_CUSTOM_TYPE, content, display: false },
		{ triggerTurn: true },
	);
}

/** rev.3 P0-5: A-class (turn_end) phase transition helper.
 *
 * Persists the next state, narrows the active tool set, updates the UI, and triggers a
 * clean new turn with a one-line `display:false` kick. The kick enters the LLM context
 * (one short line) but not the visible transcript, so there is zero visible noise.
 *
 * Only valid from turn_end handlers (where `!isStreaming` so `triggerTurn` actually
 * starts a new turn). Calling this from a tool `execute()` is a bug: tool execute runs
 * inside the streaming turn loop, so `sendCustomMessage(triggerTurn)` silently degrades
 * to a steer and does NOT start a clean narrowed turn (see rev.3 note, rev.3 §P0-5). For
 * tool-execute transitions use a positive, decisive tool-result string instead.
 */
function advancePhase(pi: ExtensionAPI, ctx: ExtensionContext, next: PlanFlowState, kickContent: string, reason: PlanStateRecord["reason"] = "phase_change") {
	persistPlanState(pi, next, reason);
	applyActiveTools(pi, next); // takes effect on the next turn (the one we are about to start)
	updatePlanUi(ctx, next);
	kickTurn(pi, kickContent);
}

/** Compact one-line research kickoff (display:false, used by advancePhase at /plan start). */
function buildKickoffContent(state: PlanFlowState): string {
	return `Start yuki plan-flow research for: ${state.request}. Inspect files read-only with read/grep/find/ls, then call grill_plan with critical decision questions.`;
}

function buildBlockedToolReason(state: PlanFlowState, _toolName: string, allowed: string[], _attempts: number): string {
	// rev.3: positive, non-pressure wording. The blocked tool name is intentionally
	// omitted so the model is not re-primed toward it. The consecutive-block counter
	// is kept for telemetry only (consecutiveBlockedToolCalls) and no longer escalates
	// into a "STOP ... rejected Nx" pressure message, which read as a deadloop in the
	// incident. block is the only real-time mid-turn defense for B-class (tool-execute)
	// transitions, so it stays first-class but calm.
	const allowedList = allowed.length > 0 ? allowed.join(", ") : "(automatic review is running)";
	return `yuki plan-flow: in phase ${state.phase}, the next tool to call is: ${allowedList}.`;
}

function nextActionHint(state: PlanFlowState): string {
	if (state.phase === "research") return "Inspect files read-only, then call grill_plan.";
	if (state.phase === "grilling") return "Call plan_ask for an unresolved critical question, or call grill_done to proceed.";
	if (state.phase === "drafting") return "Call plan_write with the structured plan, then wait for automatic review.";
	if (state.phase === "reviewing") return "Wait; automatic review is running.";
	if (state.phase === "revising") return "Call plan_write with the revised plan.";
	if (state.phase === "awaiting_approval") return "Call plan_exit to open the approval dialog.";
	if (state.phase === "executing") return `Use todo_read/todo_write on ${state.todoListId ?? "the plan-owned todo list"}.`;
	return "Follow the yuki plan-flow phase prompt.";
}

function buildPhasePrompt(state: PlanFlowState): string {
	// rev.3: positive-only wording. Each branch says only what to call, never naming
	// disallowed tools (naming them re-primes the model toward the very tool we are
	// narrowing away — the root of the drafting plan_ask deadloop in the incident).
	// Disallowed tools are removed from the model's tool set via setActiveTools at the
	// turn boundary (A-class) or defended by tool_call block mid-turn (B-class).
	if (state.phase === "research") {
		return `[YUKI PLAN FLOW: research]\nRead-only planning mode for request: ${state.request}\nInspect files with read/grep/find/ls. When ready, call grill_plan with only critical decision questions.`;
	}
	if (state.phase === "grilling") {
		return `[YUKI PLAN FLOW: grilling]\nAsk at most ${state.maxAskCount} critical decision questions total using plan_ask. Current count: ${state.askCount}. Ask only decisions you cannot inspect in the repo. Valid resolutions are concrete (not 随便/都行/看情况/之后再说/无所谓/不知道/whatever/TBD/idk or punctuation-only). Call grill_done when ready to draft.`;
	}
	if (state.phase === "drafting") {
		return "[YUKI PLAN FLOW: drafting]\nCall plan_write with the structured plan, then wait for the automatic review.";
	}
	if (state.phase === "revising") {
		return "[YUKI PLAN FLOW: revising]\nCall plan_write with the revised plan addressing the review feedback.";
	}
	if (state.phase === "awaiting_approval") {
		return "[YUKI PLAN FLOW: awaiting approval]\nThe plan is ready; the approval dialog will open automatically. If asked, call plan_exit to open it.";
	}
	if (state.phase === "executing") {
		return `[YUKI PLAN FLOW: executing]\nThe plan is approved. Use todo_read/todo_write to track progress for list ${state.todoListId}. Keep at most one in_progress and provide evidence for completed items.`;
	}
	return `[YUKI PLAN FLOW: ${state.phase}]\nFollow the yuki plan-flow phase prompt.`;
}

function formatPlanStatus(state: PlanFlowState): string {
	return [
		`Plan ${state.planId}`,
		`Phase: ${state.phase}`,
		`Title: ${state.title ?? "(none)"}`,
		`Questions: ${state.askCount}/${state.maxAskCount}`,
		`Steps: ${state.steps.length}`,
		`Review: ${state.reviewSkipped ? `skipped (${state.reviewSkippedReason})` : state.reviewed ? "completed" : state.reviewPending ? "pending" : "not completed"}`,
		`Draft: ${state.draftPath}`,
		`Final: ${state.finalPath ?? "(none)"}`,
		`Todo list: ${state.todoListId ?? "(none)"}`,
	].join("\n");
}

function normalizePlanState(state: PlanFlowState): PlanFlowState {
	return {
		...state,
		version: 1,
		questions: state.questions ?? [],
		askCount: state.askCount ?? 0,
		maxAskCount: state.maxAskCount ?? 5,
		steps: state.steps ?? [],
		risks: state.risks ?? [],
		previousActiveTools: state.previousActiveTools ?? [],
		currentActiveTools: state.currentActiveTools ?? [],
	};
}

function touch(state: PlanFlowState): PlanFlowState {
	const next = { ...state, updatedAt: new Date().toISOString() };
	next.currentActiveTools = getAllowedToolsForState(next);
	return next;
}

function createPlanId(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
	return `${stamp}-${random}`;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function textContent(result: { content?: Array<{ type?: string; text?: string }> }) {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}
