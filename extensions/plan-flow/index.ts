import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createTodoState, makeTodoStateRecord, reconstructTodoStates } from "../todo/index.ts";
import { PLAN_STATE_CUSTOM_TYPE, TODO_STATE_CUSTOM_TYPE } from "../shared/constants.ts";
import { buildPlanModeStatus, checkMandatoryValidation, derivePlanModeSurface, getAllowedToolsForState as getAllowedToolsForPhase, getConvergenceKick, parsePlanCommandArgs, PLAN_STATUS_TOOL, stripPlanMutatingTools, slugify } from "../shared/plan-helpers.ts";

export { PLAN_STATE_CUSTOM_TYPE };

const PLAN_TOOLS = new Set(["plan_write"]);
const MAX_REVIEW_REVISION_ATTEMPTS = 3;
/** customType for one-line, display:false plan-flow continuation messages. */
const PLAN_KICK_CUSTOM_TYPE = "yuki-plan-flow-kick";
const PLAN_MODE_PROMPT_CUSTOM_TYPE = "yuki-plan-flow-mode-prompt";
const PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE = "yuki-plan-flow-approval-preview";
const PLAN_WRITE_BUDGET_GUIDANCE = "Keep each plan_write call well below the model max output tokens (initial heuristic: 40%-60%). If the plan is large, first send a skeleton or concise stage-level plan: background 5-8 core lines, decisions short, each step a stage, validation <= 2 items per step.";

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
	mode: Type.Optional(Type.Union([
		Type.Literal("full"),
		Type.Literal("skeleton"),
		Type.Literal("patch"),
	], { description: "full overwrites and submits for review; skeleton saves title+steps only; patch updates fields on the current draft" })),
	title: Type.Optional(Type.String()),
	background: Type.Optional(Type.String()),
	decisions: Type.Optional(Type.Array(Type.String({ description: "Resolved implementation decisions that remove ambiguity" }))),
	assumptions: Type.Optional(Type.Array(Type.String({ description: "Explicit assumptions the implementation may rely on" }))),
	steps: Type.Optional(Type.Array(PlanStepInputSchema, { minItems: 1 })),
	risks: Type.Optional(Type.Array(Type.String())),
	field: Type.Optional(Type.Union([
		Type.Literal("title"),
		Type.Literal("background"),
		Type.Literal("decisions"),
		Type.Literal("assumptions"),
		Type.Literal("steps"),
		Type.Literal("risks"),
	], { description: "For mode:'patch', a single field to replace" })),
	value: Type.Optional(Type.Any({ description: "For mode:'patch', replacement value for field" })),
});

type PlanWriteInput = Static<typeof PlanWriteParams>;

export default function planFlowExtension(pi: ExtensionAPI) {
	// Guards against running two automatic reviews concurrently within one process.
	let reviewInFlight = false;
	let approvalInFlight = false;
	let activePlanBeforeCompact: PlanFlowState | undefined;
	// Counts consecutive phase-discipline tool blocks so repeated wrong-tool calls escalate to a
	// shorter, stronger steer. Re-emitting the identical message on every rejected call read like a
	// deadloop in the incident; an allowed call resets it. In-memory only, like the compile guard's
	// retry counters — a reload starts fresh, which is fine for a steering hint.
	let consecutiveBlockedToolCalls = 0;

	pi.registerMessageRenderer(PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE, (message) => new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme()));

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
		if (state?.active && state.phase !== "aborted" && state.phase !== "completed") {
			applyActiveTools(pi, state);
			updatePlanUi(ctx, state);
			return;
		}
		applyIdleTools(pi);
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
		if (state?.active && state.phase !== "aborted" && state.phase !== "completed") {
			applyActiveTools(pi, state);
			updatePlanUi(ctx, state);
		} else {
			applyIdleTools(pi);
			ctx.ui.setStatus("yuki-plan", undefined);
			ctx.ui.setWidget("yuki-plan", undefined);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted" || state.phase === "completed") {
			applyIdleTools(pi);
			return;
		}
		// Last-chance tool refresh: input handlers can transition state, and queued
		// extension follow-ups can be prepared before the prompt/tool surface catches up.
		// Re-applying here guarantees the next model call sees the durable plan phase.
		applyActiveTools(pi, state);
		updatePlanUi(ctx, state);
	});

	pi.on("context", async (event, ctx) => {
		const messages = event.messages.filter((message) => !(message.role === "custom" && (message.customType === PLAN_MODE_PROMPT_CUSTOM_TYPE || message.customType === PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE)));
		const state = reconstructPlanState(ctx);
		const activeState = state?.active && state.phase !== "aborted" && state.phase !== "completed" ? state : undefined;
		const status = buildPlanModeStatus(activeState, pi.getActiveTools());
		messages.push({
			role: "custom",
			customType: PLAN_MODE_PROMPT_CUSTOM_TYPE,
			content: buildPlanModePrompt(activeState, status),
			display: false,
			timestamp: Date.now(),
		});
		return { messages };
	});

	pi.on("input", async (event, ctx) => {
		let state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted" || state.phase === "completed") {
			applyIdleTools(pi);
			return { action: "continue" as const };
		}

		// Extension follow-ups can be submitted after a phase transition but before the
		// prompt builder has observed the narrowed tool surface. Re-apply the durable
		// state at the earliest input hook so approval's execution kick starts with
		// todo_write available instead of the stale planning surface.
		const extensionFollowUp = event.source === "extension" || event.streamingBehavior === "followUp";
		if (extensionFollowUp && state.phase === "awaiting_approval" && isExecutionKickForPlan(event.text, state)) {
			const approved = await approvePlan(pi, ctx, state);
			persistPlanState(pi, approved, "approval");
			state = markExecutionKickSent(approved);
			persistPlanState(pi, state, "phase_change");
		}

		applyActiveTools(pi, state);
		updatePlanUi(ctx, state);
		return { action: "continue" as const };
	});

	pi.on("tool_call", async (event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase === "aborted") return;
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
		if (!state) {
			applyIdleTools(pi);
			return;
		}
		// Clean up the counter for any terminal/inactive state (aborted, completed, idle).
		if (!state.active || state.phase === "aborted" || state.phase === "completed") {
			applyIdleTools(pi);
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

	pi.on("agent_end", async (_event, ctx) => {
		const state = reconstructPlanState(ctx);
		if (!state?.active || state.phase !== "awaiting_approval" || state.approvalMode !== "ui") return;
		if (approvalInFlight) return;
		approvalInFlight = true;
		// agent_end fires while isStreaming is STILL true: agent-core clears
		// isStreaming in finishRun() only AFTER all agent_end listeners settle
		// (see runWithLifecycle in agent.js). Publishing the preview now would route
		// pi.sendMessage({display:true}) into agent.steer() (the isStreaming branch
		// of sendCustomMessage), so the preview stays hidden in the steering queue
		// and only renders after the next agent continuation — i.e. AFTER the user
		// approves. It also pollutes LLM context as a steering message. Defer to the
		// next macrotask so finishRun() has run, isStreaming is false, sendMessage
		// renders the full plan into the chat history, and only then the approval
		// selector opens below it.
		const planId = state.planId;
		setTimeout(() => {
			(async () => {
				try {
					await driveUiApproval(pi, ctx, planId);
				} catch (err) {
					ctx.ui.notify?.(`yuki plan-flow: approval failed: ${err instanceof Error ? err.message : String(err)}`, "error");
				} finally {
					approvalInFlight = false;
				}
			})();
		}, 0);
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
		name: PLAN_STATUS_TOOL,
		label: "Plan Mode Status",
		description: "Read the current yuki plan-mode status and available plan tools.",
		promptSnippet: "Read the current yuki plan-mode status before deciding whether plan_write is available.",
		promptGuidelines: [
			"Use get_plan_mode_status when unsure whether a yuki plan is active.",
			"If it reports idle, do not call plan_write; the user must start /plan <request> first.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const state = reconstructPlanState(ctx);
			const status = buildPlanModeStatus(state, pi.getActiveTools());
			return {
				content: [{ type: "text" as const, text: JSON.stringify(status) }],
				details: { status },
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("get_plan_mode_status")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const status = (result.details as { status?: ReturnType<typeof buildPlanModeStatus> } | undefined)?.status;
			if (!status) return new Text(textContent(result), 0, 0);
			return new Text(theme.fg("success", "✓ plan mode ") + theme.fg("muted", `${status.mode} · tools=${status.availablePlanTools.join(",") || "none"}`), 0, 0);
		},
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
			"For large plans, use mode:'skeleton' for title+steps, mode:'patch' for local additions (field/value or {append:[...]} for array fields), and mode:'full' only when ready for review.",
			PLAN_WRITE_BUDGET_GUIDANCE,
		],
		parameters: PlanWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const current = reconstructPlanState(ctx);
			if (!current?.active || current.phase === "aborted" || current.phase === "completed") {
				applyIdleTools(pi);
				return buildNoActivePlanResult("plan_write");
			}
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
			persistPlanState(pi, next, "tool_result");
			await renderDraft(ctx, next);
			applyActiveTools(pi, next);
			updatePlanUi(ctx, next);

			// Terminate only when a full plan was submitted for automatic review. Skeleton
			// and patch writes are incremental authoring operations; keeping the turn alive
			// lets the model continue patching or finish with mode:'full' on the same tool surface.
			return {
				content: [{ type: "text" as const, text: buildPlanWriteResult(next) }],
				details: { state: next },
				terminate: next.reviewPending ? true as const : undefined,
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
	if (state.phase === "planning" || state.phase === "revising") return `Partial plan draft '${state.title ?? state.planId}' saved. Continue with plan_write mode:'patch' to add details, or mode:'full' when ready for review.`;
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

function normalizePlanWriteSteps(rawSteps: PlanWriteInput["steps"], indexOffset = 0): PlanStep[] {
	const steps = (rawSteps ?? []).map((step, index) => ({
		id: step.id?.trim() || `step-${indexOffset + index + 1}`,
		content: step.content.trim(),
		activeForm: step.activeForm.trim(),
		rationale: step.rationale?.trim() || undefined,
		files: step.files?.filter(Boolean),
		validation: step.validation?.filter(Boolean),
		dependsOn: step.dependsOn?.filter(Boolean),
	}));

	if (steps.length === 0) throw new Error("plan_write: steps must include at least one item.");
	if (steps.some((step) => !step.content || !step.activeForm)) {
		throw new Error("plan_write: every step must include non-empty content and activeForm.");
	}
	return steps;
}

function normalizeStringArray(value: string[] | undefined): string[] {
	return value?.map((item) => item.trim()).filter(Boolean) ?? [];
}

function requirePlanWriteString(value: string | undefined, field: string): string {
	const normalized = value?.trim();
	if (!normalized) throw new Error(`plan_write: ${field} is required for this mode.`);
	return normalized;
}

function assertMandatoryValidationCovered(current: PlanFlowState, steps: PlanStep[]) {
	// rev.3 P0-2: when a planning context declared mandatory validation/sensors, the
	// plan as a whole must cover every mandatory item across its steps' validation
	// entries (case-insensitive substring match, so "unity-csharp-compile" matches a
	// step validation phrase that contains it). Missing items are reported so the
	// model can add them rather than silently dropping the constraint.
	const mandatory = current.planningContext?.mandatoryValidation?.filter(Boolean) ?? [];
	if (mandatory.length === 0) return;
	const check = checkMandatoryValidation(steps.map((step) => step.validation ?? []), mandatory);
	if (!check.ok) {
		throw new Error(
			`plan_write: mandatory validation not covered by any step: [${check.missing.join(", ")}]. Add the missing sensor(s) to the relevant steps' validation.`,
		);
	}
}

function stringArrayPatch(value: unknown, current: string[]): string[] {
	if (Array.isArray(value)) return normalizeStringArray(value.filter((item): item is string => typeof item === "string"));
	if (value && typeof value === "object" && Array.isArray((value as { append?: unknown }).append)) {
		return [...current, ...normalizeStringArray((value as { append: unknown[] }).append.filter((item): item is string => typeof item === "string"))];
	}
	throw new Error("plan_write: patch value must be an array or {append:[...]} for this field.");
}

function applySinglePlanPatch(draft: PlanFlowState, field: PlanWriteInput["field"], value: unknown): PlanFlowState {
	if (!field) return draft;
	if (field === "title") return { ...draft, title: requirePlanWriteString(typeof value === "string" ? value : undefined, "value") };
	if (field === "background") return { ...draft, background: requirePlanWriteString(typeof value === "string" ? value : undefined, "value") };
	if (field === "steps") {
		if (Array.isArray(value)) return { ...draft, steps: normalizePlanWriteSteps(value as PlanWriteInput["steps"]) };
		if (value && typeof value === "object" && Array.isArray((value as { append?: unknown }).append)) {
			return { ...draft, steps: [...draft.steps, ...normalizePlanWriteSteps((value as { append: PlanWriteInput["steps"] }).append, draft.steps.length)] };
		}
		throw new Error("plan_write: patch value must be a steps array or {append:[...]} for steps.");
	}
	if (field === "decisions") return { ...draft, decisions: stringArrayPatch(value, draft.decisions) };
	if (field === "assumptions") return { ...draft, assumptions: stringArrayPatch(value, draft.assumptions) };
	if (field === "risks") return { ...draft, risks: stringArrayPatch(value, draft.risks) };
	return draft;
}

function applyPlanWrite(current: PlanFlowState, params: PlanWriteInput): PlanFlowState {
	const mode = params.mode ?? "full";
	if (mode === "skeleton") {
		const steps = normalizePlanWriteSteps(params.steps);
		return touch({
			...current,
			title: requirePlanWriteString(params.title, "title"),
			background: params.background?.trim() || current.background,
			decisions: params.decisions ? normalizeStringArray(params.decisions) : current.decisions,
			assumptions: params.assumptions ? normalizeStringArray(params.assumptions) : current.assumptions,
			steps,
			risks: params.risks ? normalizeStringArray(params.risks) : current.risks,
			reviewed: false,
			reviewPending: false,
			reviewSkipped: false,
			reviewSkippedReason: undefined,
			reviewFeedback: undefined,
		});
	}

	if (mode === "patch") {
		let patched = applySinglePlanPatch(current, params.field, params.value);
		if (params.title !== undefined) patched = { ...patched, title: requirePlanWriteString(params.title, "title") };
		if (params.background !== undefined) patched = { ...patched, background: requirePlanWriteString(params.background, "background") };
		if (params.steps !== undefined) patched = { ...patched, steps: normalizePlanWriteSteps(params.steps) };
		if (params.decisions !== undefined) patched = { ...patched, decisions: normalizeStringArray(params.decisions) };
		if (params.assumptions !== undefined) patched = { ...patched, assumptions: normalizeStringArray(params.assumptions) };
		if (params.risks !== undefined) patched = { ...patched, risks: normalizeStringArray(params.risks) };
		return touch({
			...patched,
			reviewed: false,
			reviewPending: false,
			reviewSkipped: false,
			reviewSkippedReason: undefined,
			reviewFeedback: undefined,
		});
	}

	const steps = params.steps !== undefined ? normalizePlanWriteSteps(params.steps) : normalizePlanWriteSteps(current.steps as PlanWriteInput["steps"]);
	assertMandatoryValidationCovered(current, steps);
	return touch({
		...current,
		phase: "reviewing",
		title: requirePlanWriteString(params.title ?? current.title, "title"),
		background: requirePlanWriteString(params.background ?? current.background, "background"),
		decisions: params.decisions !== undefined ? normalizeStringArray(params.decisions) : current.decisions,
		assumptions: params.assumptions !== undefined ? normalizeStringArray(params.assumptions) : current.assumptions,
		steps,
		risks: params.risks !== undefined ? normalizeStringArray(params.risks) : current.risks,
		reviewed: false,
		reviewPending: true,
		reviewSkipped: false,
		reviewSkippedReason: undefined,
		reviewFeedback: undefined,
	});
}

async function choosePlanApproval(ctx: ExtensionContext, current: PlanFlowState, message?: string): Promise<ApprovalChoice | undefined> {
	// Approval uses the same inline selector mechanism as ask_user_question: no
	// floating overlay. The full plan markdown is published to the history stream by
	// publishApprovalPreview() before this call, so it stays visible above the selector.
	const title = message ?? `Approve yuki plan '${current.title ?? current.planId}'? (full plan shown above)`;
	const choice = await ctx.ui.select(title, ["Approve", "Request revision", "Cancel"]);
	return choice === "Approve" || choice === "Request revision" || choice === "Cancel" ? (choice as ApprovalChoice) : undefined;
}

function publishApprovalPreview(pi: ExtensionAPI, state: PlanFlowState, message?: string): void {
	pi.sendMessage({
		customType: PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE,
		content: renderApprovalPreviewMarkdown(state, message),
		display: true,
		details: { planId: state.planId, phase: state.phase },
	});
}

function renderApprovalPreviewMarkdown(state: PlanFlowState, message?: string): string {
	const title = message ?? `Approve yuki plan '${state.title ?? state.planId}'?`;
	return [
		"---",
		"## Yuki plan awaiting approval",
		"",
		`**${title}**`,
		"",
		"The approval controls are shown below. This preview is in the normal history stream, so use terminal scrollback to read it.",
		"",
		renderPlanMarkdown(state).trim(),
		"",
		"---",
	].join("\n");
}

async function approvePlan(pi: ExtensionAPI, ctx: ExtensionContext, current: PlanFlowState): Promise<PlanFlowState> {
	const latest = reconstructPlanState(ctx);
	if (latest?.planId === current.planId && latest.approved && latest.phase === "executing" && latest.todoListId) {
		return latest;
	}
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
	pi.setActiveTools(stripPlanMutatingTools(state.previousActiveTools));
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
	pi.setActiveTools(stripPlanMutatingTools(state.previousActiveTools));
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

	publishApprovalPreview(pi, current, message);
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

async function driveUiApproval(pi: ExtensionAPI, ctx: ExtensionContext, planId: string): Promise<void> {
	const current = reconstructPlanState(ctx);
	if (!current?.active || current.phase !== "awaiting_approval" || current.planId !== planId) return;
	if (!ctx.hasUI) {
		await abortPlan(pi, ctx, current, "approvalMode ui requires an interactive UI");
		return;
	}

	const outcome = await runApprovalDialog(pi, ctx, current);
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
	}
	// cancelled: abortPlan already persisted + cleared UI; no turn to kick.
}

/** Drive post-review state changes from the turn_end handler.
 *
 * `state` has already been persisted/narrowed/UI-updated by the caller for the
 * reviewing->revising/awaiting_approval transition. Blocking review feedback is an
 * internal revision loop, not a user stop point: trigger an immediate follow-up turn so
 * the agent explains the rejection and calls plan_write again without waiting for a new
 * user prompt. UI approval is deferred until the next macrotask after agent_end so
 * its history preview can render once isStreaming is false (agent_end itself fires
 * before finishRun clears isStreaming) and before the inline approval selector opens. */
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
	}
	// Interactive approval is run by the agent_end handler, outside the streaming
	// turn_end path, so the markdown preview is appended visibly before controls open.
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

function getAllowedToolsForState(state: PlanFlowState, currentTools: string[] = []): string[] {
	return getAllowedToolsForPhase(state.phase, state.previousActiveTools, currentTools);
}

function applyActiveTools(pi: ExtensionAPI, state: PlanFlowState) {
	const surface = derivePlanModeSurface(state, pi.getActiveTools());
	pi.setActiveTools(surface.allowedTools);
}

function applyIdleTools(pi: ExtensionAPI) {
	const surface = derivePlanModeSurface(undefined, pi.getActiveTools());
	pi.setActiveTools(surface.allowedTools);
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

function buildExecutionKickContent(state: PlanFlowState): string {
	return `Plan approved. Begin execution now: call todo_write to mark the first step in_progress for list ${state.todoListId ?? `plan-${state.planId}`}.`;
}

function isExecutionKickForPlan(text: string, state: PlanFlowState): boolean {
	return text.trim() === buildExecutionKickContent(state);
}

/** Start execution immediately after approval using the freshly narrowed execution tools. */
function continueExecutionTurn(pi: ExtensionAPI, state: PlanFlowState) {
	pi.sendMessage(
		{
			customType: PLAN_KICK_CUSTOM_TYPE,
			display: false,
			content: buildExecutionKickContent(state),
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
 * not need to write+consume a `--context` handoff file either. Programmatic callers must
 * pass an explicit approval mode: interactive callers can pass `"ui"`; trusted headless
 * callers can pass `"auto"`.
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
function buildNoActivePlanResult(toolName: string): { content: Array<{ type: "text"; text: string }>; details: { active: false; phase: "idle" }; terminate: true } {
	return {
		content: [{ type: "text" as const, text: `yuki plan-flow: ${toolName} is not valid right now because there is no active plan. Normal/idle mode is active. Ending this turn; start a plan with /plan <request> before calling plan_write.` }],
		details: { active: false, phase: "idle" },
		terminate: true,
	};
}

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

function buildPlanModePrompt(state: PlanFlowState | undefined, status: ReturnType<typeof buildPlanModeStatus>): string {
	const available = status.availablePlanTools.length > 0 ? status.availablePlanTools.join(", ") : "none";
	const disabled = status.availablePlanTools.includes("plan_write") ? "none" : "plan_write";
	const header = [
		`[YUKI PLAN MODE: ${status.mode}]`,
		`Active plan: ${status.active ? "yes" : "no"}`,
		`Available plan tools: ${available}. Always available for self-check: ${PLAN_STATUS_TOOL}.`,
		`Disabled plan tools: ${disabled}.`,
		status.guidance,
	];
	if (!state) {
		return [
			...header,
			"Normal/idle mode: do not call plan_write. To plan a task, the user must start /plan <request>.",
		].join("\n");
	}
	return [...header, "", buildPhasePrompt(state)].join("\n");
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
			"plan_write modes: skeleton saves title+steps without review; patch updates draft fields or appends via {append:[...]}; full submits the accumulated plan for review.",
			"plan_write full mode must include files/rationale/validation where relevant, plus decisions and assumptions.",
			PLAN_WRITE_BUDGET_GUIDANCE,
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
