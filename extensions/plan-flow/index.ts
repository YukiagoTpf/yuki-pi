import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTodoState, makeTodoStateRecord, reconstructTodoStates } from "../todo/index.ts";
import { PLAN_STATE_CUSTOM_TYPE, TODO_STATE_CUSTOM_TYPE } from "../shared/constants.ts";
import { checkMandatoryValidation, getAllowedToolsForState as getAllowedToolsForPhase, getConvergenceKick, parsePlanCommandArgs, slugify } from "../shared/plan-helpers.ts";

export { PLAN_STATE_CUSTOM_TYPE };

const PLAN_TOOLS = new Set(["plan_write"]);
const MAX_REVIEW_REVISION_ATTEMPTS = 3;
const APPROVAL_MARKDOWN_BODY_LINES = 28;
/** customType for one-line, display:false plan-flow continuation messages. */
const PLAN_KICK_CUSTOM_TYPE = "yuki-plan-flow-kick";
const PLAN_MODE_PROMPT_CUSTOM_TYPE = "yuki-plan-flow-mode-prompt";

type Phase = "idle" | "planning" | "reviewing" | "revising" | "awaiting_approval" | "executing" | "completed" | "aborted";
type ApprovalMode = "ui" | "auto";
type ApprovalChoice = "Approve" | "Request revision" | "Cancel";

interface PlanStep {
	id: string;
	content: string;
	activeForm: string;
	rationale?: string;
	files?: string[];
	validation?: string[];
	dependsOn?: string[];
}

interface ReviewFeedback {
	summary: string;
	blockingIssues: Array<{ stepId?: string; issue: string; suggestion?: string }>;
	risks?: string[];
	missingValidation?: string[];
	raw?: string;
}

interface ReviewBlockingHistoryEntry {
	attempt: number;
	reviewedAt: string;
	issues: ReviewFeedback["blockingIssues"];
}

export interface PlanningContext {
	/** Originating command, e.g. "/ta-dev". */
	sourceCommand?: string;
	/** Declared profiles, e.g. ["csharp", "shader"]. */
	profiles?: string[];
	/** Mandatory sensor/validation requirements the plan must cover, e.g.
	 * ["unity-csharp-compile", "unity-shader-compile"]. plan_write enforces that the
	 * union of all step `validation` entries covers every mandatory item. */
	mandatoryValidation?: string[];
	/** Declared/expected touched files. */
	declaredFiles?: string[];
}

interface PlanFlowState {
	version: 1;
	active: boolean;
	phase: Phase;
	planId: string;
	request: string;
	title?: string;
	planningContext?: PlanningContext;
	previousActiveTools: string[];
	currentActiveTools: string[];
	steps: PlanStep[];
	background?: string;
	decisions: string[];
	assumptions: string[];
	risks: string[];
	approvalMode: ApprovalMode;
	reviewed: boolean;
	reviewPending: boolean;
	reviewSkipped?: boolean;
	reviewSkippedReason?: string;
	reviewFeedback?: ReviewFeedback;
	reviewRevisionAttempts: number;
	reviewBlockingHistory: ReviewBlockingHistoryEntry[];
	approved: boolean;
	draftPath: string;
	finalPath?: string;
	approvedAt?: string;
	todoListId?: string;
	executionKickSent?: boolean;
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
	decisions: Type.Optional(Type.Array(Type.String({ description: "Resolved implementation decisions that remove ambiguity" }))),
	assumptions: Type.Optional(Type.Array(Type.String({ description: "Explicit assumptions the implementation may rely on" }))),
	steps: Type.Array(PlanStepInputSchema, { minItems: 1 }),
	risks: Type.Optional(Type.Array(Type.String())),
});

type PlanWriteInput = Static<typeof PlanWriteParams>;

export default function planFlowExtension(pi: ExtensionAPI) {
	// Guards against running two automatic reviews concurrently within one process.
	let reviewInFlight = false;
	let activePlanBeforeCompact: PlanFlowState | undefined;
	// Counts consecutive phase-discipline tool blocks so repeated wrong-tool calls escalate to a
	// shorter, stronger steer. Re-emitting the identical message on every rejected call read like a
	// deadloop in the incident; an allowed call resets it. In-memory only, like the compile guard's
	// retry counters — a reload starts fresh, which is fine for a steering hint.
	let consecutiveBlockedToolCalls = 0;

	// Convergence guard for constrained execution only. Planning/revising are deliberately
	// unconstrained: a turn with no tool may be a legitimate question to the user. Approval
	// and review are extension-owned, so they should not kick the model toward a tool.
	//
	// `convergenceKicks` counts consecutive no-progress continuation hints per plan id. A
	// progress turn (reviewPending flipped, phase advanced, first todo touched) resets it.
	// After MAX_CONVERGENCE_KICKS we surface a visible notify so the user can /plan-abort
	// or continue manually, avoiding an infinite hint loop.
	const convergenceKicks = new Map<string, number>();
	const MAX_CONVERGENCE_KICKS = 3;

	pi.registerCommand("plan", {
		description: "Start yuki plan-flow for a requested change: /plan [--context <token>] <request>",
		handler: async (args, ctx) => {
			const parsed = parsePlanCommandArgs(args);
			if (!parsed.request) {
				ctx.ui.notify("Usage: /plan [--context <token>] <request>", parsed.help ? "info" : "warning");
				return;
			}
			if (parsed.unknownFlags.length > 0) {
				ctx.ui.notify(`Unknown /plan option(s): ${parsed.unknownFlags.join(", ")}`, "warning");
				return;
			}

			// rev.3 P0-2: load optional structured planning context (e.g. from /ta-dev)
			// from a handoff file, so callers do not have to serialize constraints into
			// the visible /plan prompt text. The file is consumed once and deleted.
			let planningContext: PlanningContext | undefined;
			if (parsed.contextToken) {
				const loaded = await loadPlanningContext(ctx, parsed.contextToken);
				if (loaded.error) {
					ctx.ui.notify(loaded.error, "warning");
					return;
				}
				planningContext = loaded.context;
			}

			const request = parsed.request;
			await startPlanFlow(pi, ctx, { request, planningContext, approvalMode: "ui" });
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

	pi.registerCommand("plan-debug", {
		description: "Show yuki plan-flow phase, allowed tools, and next action (debug aid)",
		handler: async (_args, ctx) => {
			const state = reconstructPlanState(ctx);
			if (!state?.active || state.phase === "aborted") {
				ctx.ui.notify("No active yuki plan.", "info");
				return;
			}
			const allowed = getAllowedToolsForState(state);
			ctx.ui.notify(
				[
					`Plan ${state.planId}`,
					`Phase: ${state.phase}`,
					`Allowed tools: ${allowed.join(", ") || "(none)"}`,
					`Next action: ${nextActionHint(state)}`,
					`Todo list: ${state.todoListId ?? "(none)"}`,
					`Review: ${state.reviewSkipped ? `skipped (${state.reviewSkippedReason})` : state.reviewed ? "completed" : state.reviewPending ? "pending" : "not completed"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (state?.active && state.phase !== "aborted") {
			applyActiveTools(pi, state);
			updatePlanUi(ctx, state);
		}
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		activePlanBeforeCompact = state?.active && state.phase !== "aborted" && state.phase !== "completed" ? state : undefined;
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (!activePlanBeforeCompact) return;
		const state = touch(activePlanBeforeCompact);
		activePlanBeforeCompact = undefined;
		persistPlanState(pi, state, "phase_change");
		applyActiveTools(pi, state);
		updatePlanUi(ctx, state);
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

	pi.on("context", async (event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted" || state.phase === "completed") return;
		const messages = event.messages.filter((message) => !(message.role === "custom" && message.customType === PLAN_MODE_PROMPT_CUSTOM_TYPE));
		messages.push({
			role: "custom",
			customType: PLAN_MODE_PROMPT_CUSTOM_TYPE,
			content: buildPhasePrompt(state),
			display: false,
			timestamp: Date.now(),
		});
		return { messages };
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
		// NEVER block plan_write. A blocked call returns an error result with no
		// `terminate`, so the model can keep retrying it on the frozen mid-turn tool
		// surface. Let plan_write execute and return a terminating wrong-phase result
		// instead; clean turns get the narrowed tool surface from setActiveTools.
		if (PLAN_TOOLS.has(event.toolName)) {
			consecutiveBlockedToolCalls = 0;
			return;
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

	// Convergence guard. Registered BEFORE the review turn_end handler so that on the
	// plan_write turn_end we see reviewing+reviewPending (a progress signal) and reset
	// the counter instead of double-kicking alongside drivePostReview.
	pi.on("turn_end", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state) return;
		// Clean up the counter for any terminal/inactive state (aborted, completed, idle).
		if (!state.active || state.phase === "aborted" || state.phase === "completed") {
			convergenceKicks.delete(state.planId);
			return;
		}

		let allTodosPending = false;
		if (state.phase === "executing" && state.todoListId) {
			const todos = reconstructTodoStates(ctx).get(state.todoListId)?.todos ?? [];
			allTodosPending = todos.length > 0 && todos.every((todo) => todo.status === "pending");
		}
		const kick = getConvergenceKick({
			phase: state.phase,
			reviewPending: state.reviewPending,
			reviewed: state.reviewed,
			approved: state.approved,
			todoListId: state.todoListId,
			allTodosPending,
			executionKickSent: state.executionKickSent,
			reviewIssuesText: formatReviewIssues(state),
		});

		if (!kick) {
			// Progress (or unconstrained phase): reset the consecutive no-progress counter.
			convergenceKicks.delete(state.planId);
			return;
		}

		// Re-narrow the active tool set for the next real prompt. Do not trigger an
		// immediate steering continuation here: turn_end can still be inside the same
		// running agent loop, whose tool snapshot may not contain the phase's next tool.
		applyActiveTools(pi, state);

		const count = (convergenceKicks.get(state.planId) ?? 0) + 1;
		if (count > MAX_CONVERGENCE_KICKS) {
			ctx.ui.notify(
				`yuki plan-flow: stalled in ${state.phase} after ${MAX_CONVERGENCE_KICKS} continuation hints. Use /plan-debug, /plan-abort, or tell me to continue.`,
				"warning",
			);
			return;
		}
		convergenceKicks.set(state.planId, count);
		queueNextTurnInstruction(pi, kick);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		// Fire whenever a draft is awaiting its automatic review, not just on the
		// turn that produced the plan_write. If a prior review was interrupted
		// (crash/restart), the durable state is still reviewing+reviewPending, and
		// the next turn_end re-triggers it instead of getting stuck until abort.
		if (!state?.active || state.phase !== "reviewing" || !state.reviewPending || state.reviewed) return;
		if (reviewInFlight) return;

		reviewInFlight = true;
		try {
			const reviewed = await runAutomaticReview(ctx, state);
			persistPlanState(pi, reviewed, reviewed.reviewSkipped ? "review_skipped" : "review_complete");
			applyActiveTools(pi, reviewed);
			updatePlanUi(ctx, reviewed);
			// Drive post-review state changes, but queue any model continuation for the
			// next real prompt so it sees the narrowed tool surface.
			await drivePostReview(pi, ctx, reviewed);
		} finally {
			reviewInFlight = false;
		}
	});

	// rev.3 P1-1: auto-close a plan once its plan-owned todo list is fully completed.
	// This is an A-class transition (turn has ended, !isStreaming). Without it, a
	// completed plan stays active/executing and blocks new /plan until /plan-abort
	// (incident #4). Also enriches the executing widget with the in_progress todo.
	pi.on("turn_end", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase !== "executing" || !state.todoListId) return;
		const todoStates = reconstructTodoStates(ctx);
		const todoState = todoStates.get(state.todoListId);
		if (!todoState || todoState.todos.length === 0) return;
		updateExecutingWidget(ctx, state, todoState);
		if (todoState.todos.every((todo) => todo.status === "completed")) {
			await closePlan(pi, ctx, state);
		}
	});

	pi.registerTool({
		name: "plan_write",
		label: "Plan Write",
		description: "Write or revise the current yuki plan as structured steps. This writes branch-safe plan state and renders a draft file.",
		promptSnippet: "Write or revise the yuki plan draft with structured steps, decisions, and assumptions.",
		promptGuidelines: [
			"Use plan_write only after read-only planning when a yuki plan-flow is active.",
			"plan_write is the source of truth for plan steps; do not create free-form plan markdown instead.",
			"Each plan_write step must include content and activeForm, and should include validation when possible.",
			"Include decisions and assumptions explicitly so the implementation has no unresolved branches.",
		],
		parameters: PlanWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted") throw new Error("plan_write: no active yuki plan. Start with /plan <request>.");
			if (!["planning", "revising"].includes(current.phase)) {
				return buildWrongPhaseResult("plan_write", current);
			}

			let next: PlanFlowState;
			try {
				next = applyPlanWrite(current, params);
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: (error as Error).message }],
					details: { state: current },
				};
			}
			await renderDraft(ctx, next);
			applyActiveTools(pi, next);
			updatePlanUi(ctx, next);

			// Terminate the turn after a successful plan_write so automatic review runs
			// at turn_end and the next turn sees a fresh, narrowed tool snapshot.
			return {
				content: [{ type: "text" as const, text: buildPlanWriteResult(next) }],
				details: { state: next },
				terminate: true,
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
}

function buildPlanWriteResult(state: PlanFlowState): string {
	if (state.reviewPending) return `Plan draft '${state.title}' written. Automatic review is pending; wait for it before doing anything else.`;
	return `Plan '${state.title}' written. Wait for extension-owned approval.`;
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
			const reviewRevisionAttempts = hasBlocking ? reviewing.reviewRevisionAttempts + 1 : reviewing.reviewRevisionAttempts;
			const reviewBlockingHistory = hasBlocking ? [
				...reviewing.reviewBlockingHistory,
				{ attempt: reviewRevisionAttempts, reviewedAt: new Date().toISOString(), issues: feedback.blockingIssues },
			] : reviewing.reviewBlockingHistory;
			return touch({
				...reviewing,
				phase: hasBlocking ? "revising" : "awaiting_approval",
				reviewed: !hasBlocking,
				reviewPending: false,
				reviewSkipped: false,
				reviewSkippedReason: undefined,
				reviewFeedback: feedback,
				reviewRevisionAttempts,
				reviewBlockingHistory,
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
		"Check specifically: unresolved implementation decisions, assumptions presented as facts, vague validation, missing mandatory validation, and steps too underspecified for another agent to execute.",
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

/** Format review blocking issues for revising prompts and hidden next-turn content. */
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

	// rev.3 P0-2: when a planning context declared mandatory validation/sensors, the
	// plan as a whole must cover every mandatory item across its steps' validation
	// entries (case-insensitive substring match, so "unity-csharp-compile" matches a
	// step validation phrase that contains it). Missing items are reported so the
	// model can add them rather than silently dropping the constraint.
	const mandatory = current.planningContext?.mandatoryValidation?.filter(Boolean) ?? [];
	if (mandatory.length > 0) {
		const check = checkMandatoryValidation(steps.map((step) => step.validation ?? []), mandatory);
		if (!check.ok) {
			throw new Error(
				`plan_write: mandatory validation not covered by any step: [${check.missing.join(", ")}]. Add the missing sensor(s) to the relevant steps' validation.`,
			);
		}
	}

	return touch({
		...current,
		phase: "reviewing",
		title: params.title.trim(),
		background: params.background.trim(),
		decisions: params.decisions?.map((decision) => decision.trim()).filter(Boolean) ?? [],
		assumptions: params.assumptions?.map((assumption) => assumption.trim()).filter(Boolean) ?? [],
		steps,
		risks: params.risks?.map((risk) => risk.trim()).filter(Boolean) ?? [],
		reviewed: false,
		reviewPending: true,
		reviewSkipped: false,
		reviewSkippedReason: undefined,
		reviewFeedback: undefined,
	});
}

async function choosePlanApproval(ctx: ExtensionContext, current: PlanFlowState, message?: string): Promise<ApprovalChoice | undefined> {
	if (ctx.mode !== "tui") {
		const choice = await ctx.ui.select(message ?? `Approve yuki plan '${current.title ?? current.planId}'?`, ["Approve", "Request revision", "Cancel"]);
		return choice === "Approve" || choice === "Request revision" || choice === "Cancel" ? choice : undefined;
	}

	const markdown = renderPlanMarkdown(current);
	const title = message ?? `Approve yuki plan '${current.title ?? current.planId}'?`;
	return await ctx.ui.custom<ApprovalChoice | undefined>((tui, theme, _keybindings, done) => {
		let scroll = 0;
		let cachedWidth = 0;
		let cachedLines: string[] = [];
		const mdTheme = getMarkdownTheme();

		function getMarkdownLines(width: number): string[] {
			if (width !== cachedWidth) {
				cachedWidth = width;
				cachedLines = new Markdown(markdown, 0, 0, mdTheme).render(Math.max(20, width));
			}
			return cachedLines;
		}

		function moveScroll(delta: number, width: number) {
			const lines = getMarkdownLines(width);
			const maxScroll = Math.max(0, lines.length - APPROVAL_MARKDOWN_BODY_LINES);
			scroll = Math.max(0, Math.min(maxScroll, scroll + delta));
			tui.requestRender();
		}

		return {
			handleInput(data: string): void {
				if (matchesKey(data, "enter") || data === "a" || data === "A") return done("Approve");
				if (data === "r" || data === "R") return done("Request revision");
				if (matchesKey(data, "escape") || data === "q" || data === "Q") return done("Cancel");
				if (matchesKey(data, "down") || data === "j" || data === "J") return moveScroll(1, cachedWidth || 80);
				if (matchesKey(data, "up") || data === "k" || data === "K") return moveScroll(-1, cachedWidth || 80);
				if (data === " " || data === "f" || data === "F") return moveScroll(APPROVAL_MARKDOWN_BODY_LINES, cachedWidth || 80);
				if (data === "b" || data === "B") return moveScroll(-APPROVAL_MARKDOWN_BODY_LINES, cachedWidth || 80);
				if (matchesKey(data, "home") || data === "g") {
					scroll = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "end") || data === "G") {
					const lines = getMarkdownLines(cachedWidth || 80);
					scroll = Math.max(0, lines.length - APPROVAL_MARKDOWN_BODY_LINES);
					tui.requestRender();
				}
			},
			invalidate(): void {
				cachedWidth = 0;
			},
			render(width: number): string[] {
				const lines = getMarkdownLines(width);
				const maxScroll = Math.max(0, lines.length - APPROVAL_MARKDOWN_BODY_LINES);
				scroll = Math.max(0, Math.min(maxScroll, scroll));
				const body = lines.slice(scroll, scroll + APPROVAL_MARKDOWN_BODY_LINES);
				const controls = `${theme.fg("success", theme.bold("Enter/A"))} approve  ${theme.fg("warning", theme.bold("R"))} request revision  ${theme.fg("error", theme.bold("Esc/Q"))} cancel  ${theme.fg("muted", "↑↓/jk/Space scroll")}`;
				const position = maxScroll > 0 ? theme.fg("dim", `Showing ${scroll + 1}-${Math.min(scroll + APPROVAL_MARKDOWN_BODY_LINES, lines.length)} of ${lines.length}`) : theme.fg("dim", `${lines.length} lines`);
				return [
					truncateToWidth(theme.bold(title), width),
					truncateToWidth(controls, width),
					truncateToWidth(position, width),
					"",
					...body,
				];
			},
		};
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
		executionKickSent: false,
	});
}

function markExecutionKickSent(state: PlanFlowState): PlanFlowState {
	return touch({ ...state, executionKickSent: true });
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

/** rev.3 P1-1: close a plan whose plan-owned todo list is fully completed. Restores
 * the user's original active tool set, clears the plan UI, and records a `completed`
 * snapshot so a new /plan is not blocked by a stale active plan (incident #4). */
async function closePlan(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanFlowState): Promise<PlanFlowState> {
	const closed = touch({ ...state, active: false, phase: "completed" });
	persistPlanState(pi, closed, "phase_change");
	pi.setActiveTools(state.previousActiveTools);
	ctx.ui.setStatus("yuki-plan", undefined);
	ctx.ui.setWidget("yuki-plan", undefined);
	if (ctx.hasUI) ctx.ui.notify(`yuki plan ${state.planId} completed · all todos done.`, "info");
	return closed;
}

/** rev.3 P1-2: enrich the executing widget with the current in_progress todo so the
 * user can see live progress without running /plan-debug. */
function updateExecutingWidget(ctx: ExtensionContext, state: PlanFlowState, todoState: { todos: Array<{ status: string; id: string; content: string; activeForm: string }> }): void {
	if (!ctx.hasUI) return;
	const completed = todoState.todos.filter((todo) => todo.status === "completed").length;
	const total = todoState.todos.length;
	const inProgress = todoState.todos.find((todo) => todo.status === "in_progress");
	const lines = [`Plan executing · ${completed}/${total} done · list ${state.todoListId ?? "?"}`];
	if (inProgress) lines.push(`▶ ${inProgress.id}: ${inProgress.activeForm || inProgress.content}`);
	else if (completed === total) lines.push("All steps completed.");
	else lines.push("Next: pick the next pending step with todo_write.");
	ctx.ui.setWidget("yuki-plan", lines);
}

type ApprovalOutcome =
	| { kind: "approved"; state: PlanFlowState }
	| { kind: "revising"; state: PlanFlowState; revisionReason: string }
	| { kind: "cancelled"; state: PlanFlowState };

/** Shared extension-owned approval dialog. Shows Approve / Request revision / Cancel,
 * performs the state transition (approvePlan / revising / abortPlan), persists, narrows
 * tools, and updates the UI. Requires ctx.hasUI — callers must branch on hasUI first. */
async function runApprovalDialog(pi: ExtensionAPI, ctx: ExtensionContext, current: PlanFlowState, message?: string): Promise<ApprovalOutcome> {
	if (!ctx.hasUI) throw new Error("runApprovalDialog: interactive UI is required for approval.");
	if (current.steps.length === 0) throw new Error("runApprovalDialog: current plan has no steps.");

	const choice = await choosePlanApproval(ctx, current, message);

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

/** Drive post-review state changes from the turn_end handler.
 *
 * `state` has already been persisted/narrowed/UI-updated by the caller for the
 * reviewing->revising/awaiting_approval transition. Blocking review feedback is an
 * internal revision loop, not a user stop point: trigger an immediate follow-up turn so
 * the agent explains the rejection and calls plan_write again without waiting for a new
 * user prompt. Approval may synchronously transition to executing; execution kickoff is
 * also triggered as a follow-up turn so approval is not a user-visible stop point. */
async function drivePostReview(pi: ExtensionAPI, ctx: ExtensionContext, state: PlanFlowState): Promise<void> {
	if (state.phase === "revising") {
		const issueCount = state.reviewFeedback?.blockingIssues.length ?? 0;
		const issueText = formatReviewIssues(state);
		if (state.reviewRevisionAttempts >= MAX_REVIEW_REVISION_ATTEMPTS) {
			if (ctx.hasUI) ctx.ui.notify(`Automatic review still has ${issueCount} blocking issue(s) after ${state.reviewRevisionAttempts} attempt(s); waiting for intervention.`, "warning");
			publishRevisionLoopStop(pi, state, issueText);
			return;
		}
		if (ctx.hasUI) ctx.ui.notify(`Automatic review found ${issueCount} blocking issue(s); revising automatically (${state.reviewRevisionAttempts}/${MAX_REVIEW_REVISION_ATTEMPTS}).`, "warning");
		continueRevisionTurn(pi, state, issueText);
		return;
	}

	// phase === awaiting_approval (review passed or skipped)
	if (state.approvalMode === "auto") {
		const approved = await approvePlan(pi, ctx, state);
		persistPlanState(pi, approved, "approval");
		applyActiveTools(pi, approved);
		updatePlanUi(ctx, approved);
		const kicked = markExecutionKickSent(approved);
		persistPlanState(pi, kicked, "phase_change");
		applyActiveTools(pi, kicked);
		updatePlanUi(ctx, kicked);
		if (ctx.hasUI) ctx.ui.notify(`Plan auto-approved · ${kicked.finalPath ?? ""}`, "info");
		continueExecutionTurn(pi, kicked);
		return;
	}

	if (!ctx.hasUI) {
		await abortPlan(pi, ctx, state, "approvalMode ui requires an interactive UI");
		return;
	}

	const outcome = await runApprovalDialog(pi, ctx, state);
	if (outcome.kind === "approved") {
		const kicked = markExecutionKickSent(outcome.state);
		persistPlanState(pi, kicked, "phase_change");
		applyActiveTools(pi, kicked);
		updatePlanUi(ctx, kicked);
		ctx.ui.notify(`Plan approved · ${kicked.finalPath ?? ""}`, "info");
		continueExecutionTurn(pi, kicked);
		return;
	}
	if (outcome.kind === "revising") {
		queueNextTurnInstruction(pi, "Address the revision request and call plan_write with the revised plan.");
		return;
	}
	// cancelled: abortPlan already persisted + cleared UI; no turn to kick.
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
	if (state.decisions.length === 0) lines.push("- None recorded.");
	else state.decisions.forEach((decision) => lines.push(`- ${decision}`));
	lines.push("");
	lines.push("## Assumptions");
	lines.push("");
	if (state.assumptions.length === 0) lines.push("- None recorded.");
	else state.assumptions.forEach((assumption) => lines.push(`- ${assumption}`));
	lines.push("");
	const pc = state.planningContext;
	if (pc && (pc.sourceCommand || pc.profiles?.length || pc.mandatoryValidation?.length || pc.declaredFiles?.length)) {
		lines.push("## Planning context");
		lines.push("");
		if (pc.sourceCommand) lines.push(`- Source: ${pc.sourceCommand}`);
		if (pc.profiles?.length) lines.push(`- Profiles: ${pc.profiles.join(", ")}`);
		if (pc.mandatoryValidation?.length) lines.push(`- Mandatory validation: ${pc.mandatoryValidation.join(", ")}`);
		if (pc.declaredFiles?.length) lines.push(`- Declared files: ${pc.declaredFiles.join(", ")}`);
		lines.push("");
	}
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
	return getAllowedToolsForPhase(state.phase, state.previousActiveTools);
}

function applyActiveTools(pi: ExtensionAPI, state: PlanFlowState) {
	pi.setActiveTools(getAllowedToolsForState(state));
}

function buildCompactPlanWidget(state: PlanFlowState): string[] {
	return [
		`Plan ${state.planId} · ${state.phase}`,
		state.title ? `Title: ${state.title}` : `Request: ${state.request}`,
		`${state.steps.length} step(s)${state.phase === "awaiting_approval" ? " · awaiting approval" : ""} · /plan-debug for details`,
	];
}

function updatePlanUi(ctx: ExtensionContext, state: PlanFlowState) {
	if (!ctx.hasUI) return;
	if (!state.active || state.phase === "aborted") {
		ctx.ui.setStatus("yuki-plan", undefined);
		ctx.ui.setWidget("yuki-plan", undefined);
		return;
	}
	if (state.phase === "executing" || state.phase === "completed") {
		ctx.ui.setStatus("yuki-plan", state.phase === "executing" ? `plan executing · ${state.todoListId ?? ""}` : undefined);
		if (state.phase === "completed") {
			ctx.ui.setWidget("yuki-plan", undefined);
		} else {
			// Show a minimal executing widget; the turn_end handler enriches it with
			// the in_progress todo via updateExecutingWidget once todo state is read.
			ctx.ui.setWidget("yuki-plan", [`Plan executing · list ${state.todoListId ?? "?"}`, "Use /plan-debug for details."]);
		}
		return;
	}
	ctx.ui.setStatus("yuki-plan", `plan ${state.phase}`);
	ctx.ui.setWidget("yuki-plan", buildCompactPlanWidget(state));
}

/** Start an immediate hidden continuation turn.
 *
 * Only use this from command/programmatic entry points that are not already inside the
 * agent loop. Do not use it from tool_result/turn_end driven phase transitions: Pi may
 * deliver triggerTurn messages as steering in the same frozen tool snapshot, so the
 * newly-enabled execution tool (todo_write) may still be unavailable.
 */
function triggerPlanTurn(pi: ExtensionAPI, content: string) {
	pi.sendMessage(
		{ customType: PLAN_KICK_CUSTOM_TYPE, content, display: false },
		{ triggerTurn: true },
	);
}

/** Continue the automatic-review revision loop now, without waiting for user input. */
function continueRevisionTurn(pi: ExtensionAPI, state: PlanFlowState, issueText: string) {
	pi.sendMessage(
		{
			customType: PLAN_KICK_CUSTOM_TYPE,
			display: false,
			content: [
				"Automatic review blocked the plan. This is an internal revision loop, not a user stop point.",
				`Automatic review block ${state.reviewRevisionAttempts}/${MAX_REVIEW_REVISION_ATTEMPTS}; revise now. The internal loop stops at ${MAX_REVIEW_REVISION_ATTEMPTS} repeated block(s).`,
				"First output a concise visible revision note to the user explaining: why the review rejected the plan, how you will revise it, and that you will immediately re-run plan_write.",
				"Then call plan_write with the revised, decision-complete plan in this same turn.",
				"Do not ask the user unless the blocking feedback exposes a genuine decision that cannot be resolved from repository facts or a low-risk assumption.",
				"Blocking issues:",
				issueText,
			].join("\n"),
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/** Start execution immediately after approval using the freshly narrowed execution tools. */
function continueExecutionTurn(pi: ExtensionAPI, state: PlanFlowState) {
	pi.sendMessage(
		{
			customType: PLAN_KICK_CUSTOM_TYPE,
			display: false,
			content: `Plan approved. Begin execution now: call todo_write to mark the first step in_progress for list ${state.todoListId}.`,
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/** Publish the exceptional stop after repeated automatic-review failures. */
function publishRevisionLoopStop(pi: ExtensionAPI, state: PlanFlowState, issueText: string) {
	const history = state.reviewBlockingHistory.length > 0 ? state.reviewBlockingHistory.map((entry) => {
		const issues = entry.issues.map((issue, index) => `${index + 1}. ${issue.stepId ? `[${issue.stepId}] ` : ""}${issue.issue}${issue.suggestion ? ` Suggestion: ${issue.suggestion}` : ""}`).join("\n");
		return `Attempt ${entry.attempt} at ${entry.reviewedAt}:\n${issues}`;
	}).join("\n\n") : "(no blocking history recorded)";
	pi.sendMessage(
		{
			customType: PLAN_KICK_CUSTOM_TYPE,
			display: true,
			content: [
				`Automatic review is still blocking plan ${state.planId} after ${state.reviewRevisionAttempts} attempt(s), so yuki plan-flow stopped the internal revision loop to avoid spinning.`,
				"Current blocking issues:",
				issueText,
				"",
				"Blocking history:",
				history,
				"",
				"You can inspect with /plan-debug, abort with /plan-abort, or give a concrete revision instruction.",
			].join("\n"),
		},
		{ deliverAs: "followUp" },
	);
}

/** Queue a hidden continuation instruction for the next real user/external prompt.
 *
 * This is the conservative yuki-pi-layer recovery for frozen tool snapshots: phase
 * transitions still persist/narrow tools immediately, but we do not ask the current
 * running agent loop to continue with tools it cannot see yet.
 */
function queueNextTurnInstruction(pi: ExtensionAPI, content: string) {
	pi.sendMessage(
		{ customType: PLAN_KICK_CUSTOM_TYPE, content, display: false },
		{ deliverAs: "nextTurn" },
	);
}

/** Plan-flow entry phase helper.
 *
 * Persists the next state, narrows the active tool set, updates the UI, and starts the
 * first planning turn. This is used by /plan/startPlanFlow, not by turn_end phase
 * convergence.
 */
function advancePhase(pi: ExtensionAPI, ctx: ExtensionContext, next: PlanFlowState, kickContent: string, reason: PlanStateRecord["reason"] = "phase_change") {
	persistPlanState(pi, next, reason);
	applyActiveTools(pi, next);
	updatePlanUi(ctx, next);
	triggerPlanTurn(pi, kickContent);
}

/** rev.4 P1-1: programmatic entry point for callers like /ta-dev that want to start a
 * yuki plan-flow WITHOUT going through the `/plan` slash command.
 *
 * Background: `pi.sendUserMessage("/plan ...")` deliberately skips slash-command
 * handling (the runtime calls `prompt(text, { expandPromptTemplates: false })`), so a
 * programmatic caller cannot trigger `/plan` that way. The previous workaround was to
 * prefill the editor with `/plan ...` via `setEditorText`, which forces the user to
 * press Enter a SECOND time (incident #1: "/ta-dev 回车后会先弄成 /plan 再回车才能发出去").
 * Callers that instead call this function skip the editor entirely and start the
 * planning turn directly, so a single command submission is enough.
 *
 * Accepts the same `ctx` shape as the `/plan` command handler (ExtensionCommandContext
 * extends ExtensionContext), and an optional pre-built `PlanningContext` so callers do
 * not need to write+consume a `--context` handoff file either. Programmatic callers such
 * as /ta-dev must pass `approvalMode: "auto"` explicitly; `/plan` passes `"ui"`.
 */
export interface StartPlanFlowOptions {
	request: string;
	planningContext?: PlanningContext;
	approvalMode: ApprovalMode;
}

export async function startPlanFlow(pi: ExtensionAPI, ctx: ExtensionContext, opts: StartPlanFlowOptions): Promise<void> {
	const request = opts.request.trim();
	if (!request) {
		ctx.ui.notify("yuki plan-flow: request is required.", "warning");
		return;
	}
	const existing = reconstructPlanState(ctx);
	if (existing?.active && existing.phase !== "aborted") {
		ctx.ui.notify(`A yuki plan is already active (${existing.phase}). Use /plan-abort first.`, "warning");
		return;
	}

	const approvalMode = opts.approvalMode;
	if (!ctx.hasUI && approvalMode === "ui") {
		ctx.ui.notify("yuki plan-flow: approvalMode 'ui' requires an interactive UI. Trusted headless callers must pass approvalMode:'auto'.", "warning");
		return;
	}

	const now = new Date().toISOString();
	const previousActiveTools = pi.getActiveTools();
	const state: PlanFlowState = {
		version: 1,
		active: true,
		phase: "planning",
		planId: createPlanId(),
		request,
		planningContext: opts.planningContext,
		previousActiveTools,
		currentActiveTools: [],
		steps: [],
		decisions: [],
		assumptions: [],
		risks: [],
		approvalMode,
		reviewed: false,
		reviewPending: false,
		reviewRevisionAttempts: 0,
		reviewBlockingHistory: [],
		approved: false,
		draftPath: "",
		createdAt: now,
		updatedAt: now,
	};
	state.draftPath = `.pi/plan-draft-${state.planId}.md`;
	state.currentActiveTools = getAllowedToolsForState(state);

	// Drive the first turn with a display:false kick instead of a visible
	// sendUserMessage. The command handler itself does not start a turn, and at this
	// point the agent is not streaming, so advancePhase's sendMessage(triggerTurn)
	// starts a clean, narrowed planning turn with zero visible noise. The detailed
	// planning instructions come from the context event mode prompt.
	ctx.ui.notify(`yuki plan-flow started · phase: planning · plan ${state.planId}`, "info");
	advancePhase(pi, ctx, state, buildKickoffContent(state), "plan_start");
}

/** Compact one-line planning kickoff (display:false, used by advancePhase at /plan start). */
function buildKickoffContent(state: PlanFlowState): string {
	return `Start yuki planning mode for: ${state.request}. Inspect files read-only with read/grep/find/ls, ask only critical questions if needed, then call plan_write with a decision-complete structured plan.`;
}

function buildBlockedToolReason(state: PlanFlowState, _toolName: string, allowed: string[], attempts: number): string {
	// rev.4: calm on the first block, then escalate to a short, action-only message
	// that names only the ALLOWED tool. The blocked tool name is intentionally never
	// mentioned (naming it re-primes the model toward a disallowed tool). The mid-turn
	// block is a stopgap; the durable fix is stable tool surfaces plus queued next-turn
	// instructions, so stale running-loop snapshots are not steered further.
	const allowedList = allowed.length > 0 ? allowed.join(", ") : "(automatic review is running)";
	if (attempts >= 2) {
		// Short, direct, action-only. Repeating the long calm line verbatim read like a
		// deadloop in the incident; escalate the wording instead of the pressure.
		return `yuki plan-flow: call ${allowedList} next.`;
	}
	return `yuki plan-flow: in phase ${state.phase}, the next tool to call is: ${allowedList}.`;
}

function nextActionHint(state: PlanFlowState): string {
	if (state.phase === "planning") return "Inspect read-only, ask only critical questions if needed, then call plan_write.";
	if (state.phase === "reviewing") return "Wait; automatic review is running.";
	if (state.phase === "revising") return "Call plan_write with the revised plan.";
	if (state.phase === "awaiting_approval") return state.approvalMode === "auto" ? "Wait; extension auto-approval is running." : "Use the approval dialog.";
	if (state.phase === "executing") return `Use todo_read/todo_write on ${state.todoListId ?? "the plan-owned todo list"}.`;
	return "Follow the yuki plan-flow phase prompt.";
}

/** A terminating "you called a plan tool in the wrong phase/state" result.
 *
 * plan_write must never throw on a phase mismatch and must never be blocked by the
 * tool_call handler: blocked/thrown tool calls do not terminate the turn, so the model can
 * retry against the frozen mid-turn tool snapshot. A terminating result exits cleanly; the
 * active tool set is narrowed for the next real prompt. */
function buildWrongPhaseResult(toolName: string, state: PlanFlowState, extra?: string): { content: Array<{ type: "text"; text: string }>; details: { state: PlanFlowState }; terminate: true } {
	const hint = nextActionHint(state);
	const text = extra
		? `yuki plan-flow: ${toolName} is not valid right now (${extra}). ${hint} Ending this turn; the next turn will expose the correct tool.`
		: `yuki plan-flow: ${toolName} is not valid in phase ${state.phase}. ${hint} Ending this turn; the next turn will expose the correct tool.`;
	return {
		content: [{ type: "text" as const, text }],
		details: { state },
		terminate: true,
	};
}

function buildPhasePrompt(state: PlanFlowState): string {
	if (state.phase === "planning" || state.phase === "revising") {
		const reviewText = state.phase === "revising" ? `\nAddress these review issues before plan_write:\n${formatReviewIssues(state)}` : "";
		return [
			`[YUKI PLAN FLOW: ${state.phase}]`,
			`Request: ${state.request}`,
			"Read-only planning mode. Use read/grep/find/ls for repository facts.",
			"Do not ask facts that can be inspected from the repo or runtime.",
			"Ask at most five high-impact questions total using ask_user_question if available, otherwise plain assistant text.",
			"If ambiguity is low-risk, proceed with an explicit assumption and record it in plan_write.assumptions.",
			"Call plan_write only when the plan is decision-complete enough for another agent to execute.",
			"plan_write must include files/rationale/validation where relevant, plus decisions and assumptions.",
			renderPlanningContextGuidance(state),
			reviewText,
		].filter(Boolean).join("\n");
	}
	if (state.phase === "reviewing") {
		return "[YUKI PLAN FLOW: reviewing]\nAutomatic review is running. Do not call tools unless the extension asks for a revised plan.";
	}
	if (state.phase === "awaiting_approval") {
		return "[YUKI PLAN FLOW: awaiting approval]\nApproval is extension/UI-owned. Do not call an approval tool.";
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
		`Approval mode: ${state.approvalMode}`,
		`Steps: ${state.steps.length}`,
		`Review: ${state.reviewSkipped ? `skipped (${state.reviewSkippedReason})` : state.reviewed ? "completed" : state.reviewPending ? "pending" : "not completed"}`,
		`Draft: ${state.draftPath}`,
		`Final: ${state.finalPath ?? "(none)"}`,
		`Todo list: ${state.todoListId ?? "(none)"}`,
		`Planning context: ${formatPlanningContextSummary(state)}`,
	].join("\n");
}

function formatPlanningContextSummary(state: PlanFlowState): string {
	const ctx = state.planningContext;
	if (!ctx) return "(none)";
	const parts: string[] = [];
	if (ctx.sourceCommand) parts.push(`source=${ctx.sourceCommand}`);
	if (ctx.profiles?.length) parts.push(`profiles=${ctx.profiles.join(",")}`);
	if (ctx.mandatoryValidation?.length) parts.push(`mandatory=${ctx.mandatoryValidation.join(",")}`);
	return parts.length > 0 ? parts.join(" ") : "(empty)";
}

function normalizePlanState(state: PlanFlowState): PlanFlowState {
	const rawState = state as unknown as { phase?: string; questions?: Array<{ topic?: string; status?: string; resolution?: string }> };
	const rawPhase = rawState.phase;
	const phase: Phase = rawPhase === "research" || rawPhase === "grilling" || rawPhase === "drafting" ? "planning" : (rawPhase as Phase) ?? "idle";
	const legacyDecisions = (rawState.questions ?? []).filter((question) => question.status === "resolved" && question.resolution).map((question) => `${question.topic ?? "Decision"}: ${question.resolution}`);
	return {
		...state,
		version: 1,
		phase,
		steps: state.steps ?? [],
		decisions: state.decisions ?? legacyDecisions,
		assumptions: state.assumptions ?? [],
		risks: state.risks ?? [],
		approvalMode: state.approvalMode ?? "ui",
		reviewRevisionAttempts: state.reviewRevisionAttempts ?? 0,
		reviewBlockingHistory: state.reviewBlockingHistory ?? [],
		previousActiveTools: state.previousActiveTools ?? [],
		currentActiveTools: state.currentActiveTools ?? [],
		planningContext: state.planningContext ?? undefined,
		executionKickSent: state.executionKickSent ?? false,
	};
}

function touch(state: PlanFlowState): PlanFlowState {
	const next = { ...state, updatedAt: new Date().toISOString() };
	next.currentActiveTools = getAllowedToolsForState(next);
	return next;
}

/** rev.3 P0-2: directory for one-shot planning-context handoff files written by
 * callers like /ta-dev and consumed (and deleted) by /plan --context <token>. */
const PLAN_CONTEXT_DIR = ".pi/plan-context";

async function loadPlanningContext(ctx: ExtensionContext, token: string): Promise<{ context?: PlanningContext; error?: string }> {
	if (!/^[A-Za-z0-9_-]+$/.test(token)) {
		return { error: `Invalid --context token '${token}' (allowed: letters, digits, '-', '_').` };
	}
	const path = resolve(ctx.cwd, PLAN_CONTEXT_DIR, `${token}.json`);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return { error: `Planning context '${token}' not found at ${PLAN_CONTEXT_DIR}/${token}.json.` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { error: `Planning context '${token}' is not valid JSON: ${(error as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { error: `Planning context '${token}' must be a JSON object.` };
	}
	const obj = parsed as Partial<PlanningContext>;
	const context: PlanningContext = {
		sourceCommand: typeof obj.sourceCommand === "string" ? obj.sourceCommand : undefined,
		profiles: Array.isArray(obj.profiles) ? obj.profiles.filter((v): v is string => typeof v === "string") : undefined,
		mandatoryValidation: Array.isArray(obj.mandatoryValidation) ? obj.mandatoryValidation.filter((v): v is string => typeof v === "string") : undefined,
		declaredFiles: Array.isArray(obj.declaredFiles) ? obj.declaredFiles.filter((v): v is string => typeof v === "string") : undefined,
	};
	// Consume the handoff file once it has been read into state.
	await unlink(path).catch(() => undefined);
	return { context };
}

/** Render planning-context mandatory validation into the planning prompt so the model
 * knows which sensors each step's `validation` must cover (plan_write enforces it). */
function renderPlanningContextGuidance(state: PlanFlowState): string {
	const mandatory = state.planningContext?.mandatoryValidation?.filter(Boolean) ?? [];
	if (mandatory.length === 0) return "";
	const files = state.planningContext?.declaredFiles?.filter(Boolean) ?? [];
	const lines = [``, `Mandatory validation (every step that touches a relevant file must include these in its validation): ${mandatory.join(", ")}.`];
	if (files.length > 0) lines.push(`Declared/expected files: ${files.join(", ")}.`);
	return lines.join("\n");
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
