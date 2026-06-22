/**
 * Pure, dependency-free helpers for the plan-flow extension.
 *
 * Kept here (rather than inline in plan-flow/index.ts) so they can be unit
 * tested without importing the extension, which pulls in the Pi runtime.
 */

/** Slugify a title into a filesystem- and id-safe segment. */
export function slugify(value: string): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 60);
	return slug || "plan";
}

/**
 * Whether a grilling answer counts as a concrete, executable decision.
 *
 * Rejects explicit non-answers regardless of length; a short but concrete
 * answer ("no", "v2", "用 A") is a valid decision and must count as resolved.
 */
export function isExecutableResolution(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	if (!normalized) return false;
	// Require at least one letter/number/ideograph so punctuation-only
	// "answers" (e.g. "。", "？？") aren't recorded as decisions.
	if (!/[\p{L}\p{N}]/u.test(normalized)) return false;
	if (/^(随便|都行|看情况|之后再说|到时候再说|无所谓|不知道|不清楚|不确定|whatever|up to you|later|tbd|idk|dunno)$/.test(normalized)) {
		return false;
	}
	return true;
}

export interface ParsedPlanCommand {
	request: string;
	contextToken?: string;
	help: boolean;
	unknownFlags: string[];
}

/** Parse `/plan [--context <token>] <request>`.
 *
 * The `--context` token references a one-shot handoff file (consumed by the /plan
 * command handler) carrying structured planning constraints, so callers like /ta-dev
 * do not have to serialize those constraints into the visible /plan prompt text.
 * Everything else forms the request string. Quoted segments are preserved. */
export function parsePlanCommandArgs(raw: string): ParsedPlanCommand {
	const tokens = tokenizePlanArgs(raw);
	let contextToken: string | undefined;
	const requestParts: string[] = [];
	const unknownFlags: string[] = [];
	let help = false;
	for (let i = 0; i < tokens.length; i += 1) {
		const token = tokens[i];
		if (token === "--help" || token === "-h") {
			help = true;
			continue;
		}
		if (token === "--context") {
			const next = tokens[i + 1];
			if (!next || next.startsWith("--")) {
				unknownFlags.push("--context (missing token)");
			} else {
				contextToken = next;
				i += 1;
			}
			continue;
		}
		if (token.startsWith("--")) {
			unknownFlags.push(token);
			continue;
		}
		requestParts.push(token);
	}
	return { request: requestParts.join(" ").trim(), contextToken, help, unknownFlags };
}

/** Quote-aware whitespace tokenizer for /plan argument parsing. */
export function tokenizePlanArgs(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Read-only tools permitted during planning/revising. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
export const ASK_USER_TOOL = "ask_user_question";

/** Todo tools always permitted during executing. */
export const TODO_TOOLS = ["todo_read", "todo_write"];

export const PLAN_MUTATING_TOOLS = new Set(["plan_write"]);

export type PlanModePhase = "idle" | "planning" | "reviewing" | "revising" | "awaiting_approval" | "executing" | "completed" | "aborted";

export interface PlanModeStateLike {
	active?: boolean;
	phase?: string;
	previousActiveTools?: string[];
}

export interface PlanModeSurface {
	mode: PlanModePhase;
	allowedTools: string[];
	availablePlanTools: string[];
	guidance: string;
}

export function stripPlanMutatingTools(tools: string[] = []): string[] {
	return tools.filter((tool) => !PLAN_MUTATING_TOOLS.has(tool));
}

function normalizePlanMode(state?: PlanModeStateLike): PlanModePhase {
	if (!state?.active) return "idle";
	if (state.phase === "planning" || state.phase === "reviewing" || state.phase === "revising" || state.phase === "awaiting_approval" || state.phase === "executing" || state.phase === "completed" || state.phase === "aborted") {
		return state.phase;
	}
	return "idle";
}

/**
 * Compute the allowed tool set for a plan-flow phase.
 *
 * Planning/revising expose one stable model-facing plan tool (`plan_write`) plus
 * repository read/search tools. Approval/review are extension-owned and expose no
 * model tools. Execution restores the caller's normal surface plus todo tools after
 * removing plan mutating tools from the ambient surface. Idle/terminal states only
 * remove plan mutating tools from the current surface, so other extensions keep
 * ownership of tools they dynamically add.
 */
export function getAllowedToolsForState(
	phase: string,
	previousActiveTools: string[] = [],
	currentActiveTools: string[] = previousActiveTools,
): string[] {
	const base = new Set<string>();
	if (phase === "planning" || phase === "revising") {
		for (const tool of previousActiveTools) if (READ_ONLY_TOOLS.has(tool) || tool === ASK_USER_TOOL) base.add(tool);
		base.add("plan_write");
	} else if (phase === "reviewing" || phase === "awaiting_approval") {
		// Automatic review and approval are extension/UI-owned.
	} else if (phase === "executing") {
		for (const tool of stripPlanMutatingTools(previousActiveTools.length > 0 ? previousActiveTools : currentActiveTools)) base.add(tool);
		for (const tool of TODO_TOOLS) base.add(tool);
	} else {
		// idle / completed / aborted / unknown → keep the current surface, minus plan mutators.
		for (const tool of stripPlanMutatingTools(currentActiveTools)) base.add(tool);
	}
	return [...base];
}

export function derivePlanModeSurface(state: PlanModeStateLike | undefined, currentActiveTools: string[] = []): PlanModeSurface {
	const mode = normalizePlanMode(state);
	const allowedTools = getAllowedToolsForState(mode, state?.previousActiveTools ?? [], currentActiveTools);
	const availablePlanTools = allowedTools.filter((tool) => PLAN_MUTATING_TOOLS.has(tool));
	return {
		mode,
		allowedTools,
		availablePlanTools,
		guidance: mode === "idle"
			? "No active yuki plan. Start /plan <request> before calling plan_write."
			: `Yuki plan mode is ${mode}.`,
	};
}

/**
 * Check that a plan's steps cover every mandatory validation/sensor declared by a
 * planning context. Returns the missing items (case-insensitive substring match, so
 * "unity-csharp-compile" matches a step validation phrase containing it). Pure so the
 * P0-2 enforcement can be unit tested.
 */
export function checkMandatoryValidation(stepValidations: string[][], mandatory: string[]): { ok: boolean; missing: string[] } {
	if (mandatory.length === 0) return { ok: true, missing: [] };
	const union = stepValidations.flat().join("\n").toLowerCase();
	if (union.trim() === "") return { ok: false, missing: [...mandatory] };
	const missing = mandatory.filter((item) => !union.includes(item.toLowerCase()));
	return { ok: missing.length === 0, missing };
}

/**
 * rev.4 P0: convergence guard input. The turn_end handler builds this from the
 * current plan state (+ todo state for executing) and calls getConvergenceKick to
 * decide whether the model ended a turn without making the expected next tool call.
 *
 * `allTodosPending` is only meaningful for the executing phase; callers should pass
 * `true` only when every plan-owned todo is still `pending` (no `todo_write` has ever
 * run for this plan). `planningContextGuidance` / `reviewIssuesText` are optional
 * rich-text fragments appended to the drafting / revising kick content.
 */
export interface ConvergenceSignal {
	phase: string;
	reviewPending?: boolean;
	reviewed?: boolean;
	approved?: boolean;
	todoListId?: string;
	allTodosPending?: boolean;
	/** True once approval already sent the immediate execution-start follow-up. */
	executionKickSent?: boolean;
	/** Whether any grilling question is still unresolved (status "open"). Only
	 * meaningful for the grilling phase; pass false/undefined otherwise. */
	hasOpenQuestions?: boolean;
	/** Optional rich text appended to queued next-turn drafting/revising instructions. */
	planningContextGuidance?: string;
	reviewIssuesText?: string;
}

/**
 * Return hidden continuation content for a no-progress turn_end in a constrained phase,
 * or `undefined` when the phase made progress (or is unconstrained). The extension queues
 * this with deliverAs:"nextTurn"; it must not be steered into the current running loop.
 *
 * Why this exists: B-class (tool-execute) transitions like grill_done -> drafting do NOT
 * start a clean new turn, and `setActiveTools` does not narrow the current running loop's
 * frozen tool snapshot. Immediate steering can therefore ask the model to call a tool
 * that is not visible yet. Queueing the instruction for the next real prompt preserves
 * guidance without continuing on a stale tool surface.
 */
export function getConvergenceKick(signal: ConvergenceSignal): string | undefined {
	if (signal.phase === "planning" || signal.phase === "revising" || signal.phase === "reviewing" || signal.phase === "awaiting_approval") {
		return undefined;
	}
	if (signal.phase === "executing") {
		// Only nudge if NO todo has been touched yet and approval did not already send
		// the immediate execution-start follow-up. Once either happens, repeated turn-end
		// warnings are noise rather than useful convergence.
		if (!signal.todoListId || !signal.allTodosPending || signal.executionKickSent) return undefined;
		return `yuki plan-flow: plan approved. Begin execution now: call todo_write to mark the first step in_progress for list ${signal.todoListId}.`;
	}
	return undefined;
}
