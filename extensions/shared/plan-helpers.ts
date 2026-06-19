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

/** Read-only tools permitted during research/grilling. */
export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Todo tools always permitted during executing. */
export const TODO_TOOLS = ["todo_read", "todo_write"];

/**
 * Compute the allowed tool set for a plan-flow phase.
 *
 * Pure (no Pi runtime) so the A/B-class narrowing contract can be unit tested.
 * The result is the model's tool set for the NEXT turn when `setActiveTools` is
 * applied at a turn boundary (A-class). For B-class (tool-execute) transitions
 * the model is still mid-turn with the previous tool set, so this is the contract
 * the `tool_call` block defends mid-turn and that takes effect on the next turn.
 *
 * `options.hasOpenGrillingQuestions` enables state-sensitive narrowing for the
 * grilling phase: when there are no unresolved questions, `grill_plan` and
 * `plan_ask` are removed and only `grill_done` (+ read-only) is exposed. Without
 * this the model keeps re-calling `grill_plan` after it already returned "no open
 * questions", because the next turn's tool surface still listed `grill_plan` (the
 * grilling wrong-tool loop incident, 2026-06-19).
 */
export function getAllowedToolsForState(
	phase: string,
	previousActiveTools: string[] = [],
	options: { hasOpenGrillingQuestions?: boolean } = {},
): string[] {
	const base = new Set<string>();
	if (phase === "research") {
		for (const tool of previousActiveTools) if (READ_ONLY_TOOLS.has(tool)) base.add(tool);
		base.add("grill_plan");
	} else if (phase === "grilling") {
		if (options.hasOpenGrillingQuestions) {
			// Questions still to resolve: allow reading (to formulate questions), asking,
			// re-grilling, and finishing.
			for (const tool of previousActiveTools) if (READ_ONLY_TOOLS.has(tool)) base.add(tool);
			base.add("plan_ask");
			base.add("grill_plan");
			base.add("grill_done");
		} else {
			// No open questions: the ONLY productive next action is grill_done. Exposing
			// read/grep/grill_plan here let the model re-call grill_plan (grilling wrong-tool
			// loop, 2026-06-19) or burn turns on redundant read-only research. The clean turn
			// must offer exactly grill_done so the model converges. (If more research is truly
			// needed, that is a restart_research state transition, not a grilling-no-open turn.)
			base.add("grill_done");
		}
	} else if (phase === "drafting" || phase === "revising") {
		base.add("plan_write");
	} else if (phase === "awaiting_approval") {
		base.add("plan_write");
		base.add("plan_exit");
	} else if (phase === "reviewing") {
		// Automatic review is extension-driven; no model tools should be called.
	} else if (phase === "executing") {
		for (const tool of previousActiveTools) base.add(tool);
		for (const tool of TODO_TOOLS) base.add(tool);
	} else {
		// idle / completed / aborted / unknown → restore the user's tool set.
		for (const tool of previousActiveTools) base.add(tool);
	}
	return [...base];
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
	/** Whether any grilling question is still unresolved (status "open"). Only
	 * meaningful for the grilling phase; pass false/undefined otherwise. */
	hasOpenQuestions?: boolean;
	planningContextGuidance?: string;
	reviewIssuesText?: string;
}

/**
 * Return the kick content for a no-progress turn_end in a constrained phase, or
 * `undefined` when the phase made progress (or is unconstrained and should not be
 * auto-kicked). Pure so the rev.4 convergence contract can be unit tested.
 *
 * Why this exists: B-class (tool-execute) transitions like grill_done -> drafting do
 * NOT start a clean new turn, and `setActiveTools` does not narrow the current
 * (streaming) turn's tool set. So when the model ends such a turn without calling the
 * expected next tool, the flow used to stall until the user typed "继续" (incident #3),
 * and the stale mid-turn tool set still exposed disallowed tools like `plan_ask` so the
 * model kept retrying them (incident #2). Re-kicking a clean, narrowed turn (A-class)
 * both removes the disallowed tool from the model's view and auto-continues the flow.
 */
export function getConvergenceKick(signal: ConvergenceSignal): string | undefined {
	if (signal.phase === "grilling") {
		// rev.4 P0: auto-continue grilling once there are no unresolved questions, so the
		// flow does not stall until the user types "继续" (incident #3: "停下来问 ok，我说
		// 继续，然后它才 grill_done"). When questions remain open, leave it unconstrained so
		// the model can keep reading or call plan_ask without a nudge. grill_plan always
		// transitions research -> grilling, so reaching grilling implies grill_plan ran.
		if (signal.hasOpenQuestions) return undefined;
		return "yuki plan-flow: grilling has no unresolved questions. Call grill_done to proceed to drafting.";
	}
	if (signal.phase === "drafting") {
		// reviewPending true  -> plan_write was called; the review turn_end handler owns the next step.
		// reviewed   true     -> review already ran; drivePostReview owns the next step.
		if (signal.reviewPending || signal.reviewed) return undefined;
		return `yuki plan-flow: still in drafting. Call plan_write with the structured plan now.${signal.planningContextGuidance ?? ""}`;
	}
	if (signal.phase === "revising") {
		return `yuki plan-flow: still in revising. Call plan_write with the revised plan addressing the review feedback.\nBlocking issues:\n${signal.reviewIssuesText ?? "Review requested changes."}`;
	}
	if (signal.phase === "awaiting_approval") {
		if (signal.approved) return undefined;
		return "yuki plan-flow: plan is ready for approval; call plan_exit to approve it.";
	}
	if (signal.phase === "executing") {
		// Only nudge if NO todo has been touched yet. Once execution has started the model
		// does legitimate multi-turn read/bash work and must NOT be re-kicked every turn.
		if (!signal.todoListId || !signal.allTodosPending) return undefined;
		return `yuki plan-flow: plan approved. Begin execution now: call todo_write to mark the first step in_progress for list ${signal.todoListId}.`;
	}
	return undefined;
}
