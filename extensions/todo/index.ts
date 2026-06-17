import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { PLAN_STATE_CUSTOM_TYPE, TODO_STATE_CUSTOM_TYPE } from "../shared/constants.ts";
import { parseTodosCommandArgs } from "../shared/todo-command.ts";

export { PLAN_STATE_CUSTOM_TYPE, TODO_STATE_CUSTOM_TYPE };
export const DEFAULT_STANDALONE_LIST_ID = "standalone-default";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoSource = "standalone" | "plan" | "workflow";

export interface TodoItem {
	id: string;
	content: string;
	activeForm: string;
	status: TodoStatus;
	evidence?: string;
	updatedAt: string;
}

export interface TodoState {
	version: 1;
	listId: string;
	source: TodoSource;
	owner?: {
		type: "plan";
		planId: string;
	};
	title?: string;
	todos: TodoItem[];
	createdAt: string;
	updatedAt: string;
}

export interface TodoStateRecord {
	kind: "snapshot";
	reason: "seed" | "command" | "import" | "session_restore";
	todoState: TodoState;
}

interface ActivePlanRef {
	planId: string;
	phase: string;
	active: boolean;
	todoListId?: string;
}

const TodoItemInputSchema = Type.Object({
	id: Type.String({ description: "Stable todo id" }),
	content: Type.String({ description: "Imperative task description" }),
	activeForm: Type.String({ description: "In-progress form of the task" }),
	status: StringEnum(["pending", "in_progress", "completed"] as const),
	evidence: Type.Optional(Type.String({ description: "Required for completed plan-owned todos" })),
});

const TodoWriteParams = Type.Object({
	listId: Type.Optional(Type.String({ description: "Todo list id. Omit to use the current/default list." })),
	todos: Type.Array(TodoItemInputSchema, { description: "Full desired todo list snapshot. Existing ids may not be omitted." }),
	note: Type.Optional(Type.String({ description: "Optional update note" })),
});

type TodoWriteInput = Static<typeof TodoWriteParams>;

const TodoClearParams = Type.Object({
	listId: Type.Optional(Type.String({ description: "Todo list id. Omit to use the current/default list." })),
	scope: Type.Optional(StringEnum(["completed", "all"] as const)),
	note: Type.Optional(Type.String({ description: "Optional clear note" })),
});

type TodoClearInput = Static<typeof TodoClearParams>;

const TodoReadParams = Type.Object({
	listId: Type.Optional(Type.String({ description: "Todo list id. Omit to use the current/default list." })),
});

type TodoReadInput = Static<typeof TodoReadParams>;

export default function todoExtension(pi: ExtensionAPI) {
	let states = new Map<string, TodoState>();

	const refresh = (ctx: ExtensionContext) => {
		states = reconstructTodoStates(ctx);
		updateTodoWidget(ctx, states, getActivePlanRef(ctx));
	};

	pi.on("session_start", async (_event, ctx) => refresh(ctx));
	pi.on("session_tree", async (_event, ctx) => refresh(ctx));

	pi.registerTool({
		name: "todo_read",
		label: "Todo Read",
		description: "Read the current yuki-pi todo list. Works independently of plan-flow.",
		promptSnippet: "Read the current yuki-pi todo list and progress.",
		promptGuidelines: [
			"Use todo_read to inspect yuki-pi todo progress before updating todos with todo_write.",
			"todo_read works for standalone todos and for plan-owned todos created by plan-flow.",
		],
		parameters: TodoReadParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			states = reconstructTodoStates(ctx);
			const activePlan = getActivePlanRef(ctx);
			const state = selectTodoState(states, params, activePlan) ?? createStandaloneState(params.listId);
			updateTodoWidget(ctx, states, activePlan);

			return {
				content: [{ type: "text" as const, text: formatTodoStateForModel(state) }],
				details: { todoState: state, summary: summarizeTodoState(state) },
			};
		},
		renderCall(args, theme) {
			const listId = typeof args.listId === "string" ? args.listId : "current";
			return new Text(theme.fg("toolTitle", theme.bold("todo_read ")) + theme.fg("muted", listId), 0, 0);
		},
		renderResult(result, _options, theme) {
			const state = (result.details as { todoState?: TodoState } | undefined)?.todoState;
			if (!state) return new Text(textContent(result), 0, 0);
			const summary = summarizeTodoState(state);
			return new Text(theme.fg("accent", `${state.title ?? state.listId}: `) + theme.fg("muted", `${summary.completed}/${summary.total} completed`), 0, 0);
		},
	});

	pi.registerTool({
		name: "todo_write",
		label: "Todo Write",
		description:
			"Create or update a yuki-pi todo list. Works standalone; plan-owned lists apply stricter execution policy.",
		promptSnippet: "Create or update yuki-pi todos with branch-safe state.",
		promptGuidelines: [
			"Use todo_write to maintain task progress when the user asks for a todo list or when executing a yuki-pi plan.",
			"todo_write may be used without an active plan for standalone todos.",
			"For plan-owned todos, todo_write must keep at most one in_progress item and must include evidence when marking an item completed.",
			"Do not omit existing todo ids from todo_write; use todo_clear when the user explicitly wants to clear completed or all standalone todos.",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			states = reconstructTodoStates(ctx);
			const activePlan = getActivePlanRef(ctx);
			const current = selectTodoState(states, params, activePlan) ?? createStandaloneState(params.listId);
			const next = applyTodoWrite(current, params, activePlan);
			states.set(next.listId, next);
			updateTodoWidget(ctx, states, activePlan);

			return {
				content: [{ type: "text" as const, text: formatTodoStateForModel(next) }],
				details: { todoState: next, summary: summarizeTodoState(next), note: params.note },
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			const listId = typeof args.listId === "string" ? args.listId : "current";
			return new Text(
				theme.fg("toolTitle", theme.bold("todo_write ")) + theme.fg("muted", `${listId} `) + theme.fg("dim", `${count} item(s)`),
				0,
				0,
			);
		},
		renderResult(result, { expanded }, theme) {
			const state = (result.details as { todoState?: TodoState } | undefined)?.todoState;
			if (!state) return new Text(textContent(result), 0, 0);
			const summary = summarizeTodoState(state);
			let text = theme.fg("success", "todo updated ") + theme.fg("muted", `${summary.completed}/${summary.total} completed`);
			const display = expanded ? state.todos : state.todos.slice(0, 6);
			for (const todo of display) {
				text += "\n" + renderTodoLine(todo, theme);
			}
			if (!expanded && state.todos.length > display.length) {
				text += "\n" + theme.fg("dim", `... ${state.todos.length - display.length} more`);
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool({
		name: "todo_clear",
		label: "Todo Clear",
		description: "Clear completed or all todos from a standalone yuki-pi todo list. Plan-owned lists cannot be cleared.",
		promptSnippet: "Clear completed or all standalone yuki-pi todos explicitly.",
		promptGuidelines: [
			"Use todo_clear when starting a new standalone task list or when the user explicitly asks to clear completed todos.",
			"todo_clear defaults to scope 'completed'; use scope 'all' only when the user asks to reset or clear the whole standalone list.",
			"todo_clear must not be used for plan-owned todo lists because plan todos are execution records.",
		],
		parameters: TodoClearParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			states = reconstructTodoStates(ctx);
			const activePlan = getActivePlanRef(ctx);
			const current = selectTodoState(states, params, activePlan) ?? createStandaloneState(params.listId);
			const { state: next, cleared, scope } = applyTodoClear(current, params);
			states.set(next.listId, next);
			updateTodoWidget(ctx, states, activePlan);

			return {
				content: [
					{
						type: "text" as const,
						text: `Cleared ${cleared.length} ${scope === "completed" ? "completed " : ""}todo(s) from list '${next.listId}'. ${summarizeTodoState(next).completed}/${next.todos.length} completed remain.`,
					},
				],
				details: {
					todoState: next,
					summary: summarizeTodoState(next),
					note: params.note,
					scope,
					clearedIds: cleared.map((todo) => todo.id),
				},
			};
		},
		renderCall(args, theme) {
			const listId = typeof args.listId === "string" ? args.listId : "current";
			const scope = args.scope === "all" ? "all" : "completed";
			return new Text(
				theme.fg("toolTitle", theme.bold("todo_clear ")) + theme.fg("muted", `${listId} `) + theme.fg("dim", scope),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { todoState?: TodoState; scope?: "completed" | "all"; clearedIds?: string[] } | undefined;
			const state = details?.todoState;
			if (!state) return new Text(textContent(result), 0, 0);
			const clearedCount = details?.clearedIds?.length ?? 0;
			const scope = details?.scope === "all" ? "all" : "completed";
			const summary = summarizeTodoState(state);
			return new Text(
				theme.fg("success", "todo cleared ") +
					theme.fg("muted", `${clearedCount} ${scope === "completed" ? "completed " : ""}item(s); ${summary.completed}/${summary.total} completed remain`),
				0,
				0,
			);
		},
	});

	pi.registerCommand("todos", {
		description: "Show or clear yuki-pi todos on the current branch",
		handler: async (args, ctx) => {
			states = reconstructTodoStates(ctx);
			const activePlan = getActivePlanRef(ctx);
			const parsed = parseTodosCommandArgs(args);

			if (parsed.action === "clear") {
				try {
					const current = selectTodoState(states, { listId: parsed.listId }, activePlan) ?? createStandaloneState(parsed.listId);
					const { state: next, cleared, scope } = applyTodoClear(current, { listId: parsed.listId, scope: parsed.scope });
					states.set(next.listId, next);
					pi.appendEntry(TODO_STATE_CUSTOM_TYPE, makeTodoStateRecord(next, "command"));
					updateTodoWidget(ctx, states, activePlan);
					ctx.ui.notify(`Cleared ${cleared.length} ${scope === "completed" ? "completed " : ""}todo(s) from ${next.listId}.`, "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}

			const state = selectTodoState(states, { listId: parsed.listId }, activePlan);

			if (!state) {
				ctx.ui.notify("No yuki-pi todos on this branch yet. Ask the agent to use todo_write.", "info");
				return;
			}

			ctx.ui.notify(formatTodoStateForHuman(state), "info");
			updateTodoWidget(ctx, states, activePlan);
		},
	});
}

export function makeTodoStateRecord(todoState: TodoState, reason: TodoStateRecord["reason"] = "seed"): TodoStateRecord {
	return { kind: "snapshot", reason, todoState };
}

export function createTodoState(input: {
	listId: string;
	source: TodoSource;
	title?: string;
	owner?: TodoState["owner"];
	todos?: Array<Omit<TodoItem, "updatedAt"> & { updatedAt?: string }>;
	now?: string;
}): TodoState {
	const now = input.now ?? new Date().toISOString();
	return normalizeTodoState({
		version: 1,
		listId: input.listId,
		source: input.source,
		owner: input.owner,
		title: input.title,
		todos: (input.todos ?? []).map((todo) => ({ ...todo, updatedAt: todo.updatedAt ?? now })),
		createdAt: now,
		updatedAt: now,
	});
}

export function reconstructTodoStates(ctx: ExtensionContext): Map<string, TodoState> {
	const states = new Map<string, TodoState>();

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && "customType" in entry && entry.customType === TODO_STATE_CUSTOM_TYPE) {
			const record = (entry as { data?: TodoStateRecord }).data;
			if (record?.kind === "snapshot" && record.todoState) {
				states.set(record.todoState.listId, normalizeTodoState(record.todoState));
			}
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		if (message.toolName !== "todo_write" && message.toolName !== "todo_read" && message.toolName !== "todo_clear") continue;

		const details = message.details as { todoState?: TodoState } | undefined;
		if (details?.todoState) {
			states.set(details.todoState.listId, normalizeTodoState(details.todoState));
		}
	}

	return states;
}

function applyTodoWrite(current: TodoState, params: TodoWriteInput, activePlan: ActivePlanRef | undefined): TodoState {
	const now = new Date().toISOString();
	const incoming = params.todos.map((todo) => ({
		...todo,
		id: todo.id.trim(),
		content: todo.content.trim(),
		activeForm: todo.activeForm.trim(),
		evidence: todo.evidence?.trim() || undefined,
		updatedAt: now,
	}));

	validateIncomingTodos(incoming);
	validateNoSilentDeletion(current, incoming);
	validatePolicy(current, incoming, activePlan);

	const existingById = new Map(current.todos.map((todo) => [todo.id, todo]));
	const mergedTodos = incoming.map((todo) => {
		const existing = existingById.get(todo.id);
		if (!existing) return todo;
		const changed =
			existing.content !== todo.content ||
			existing.activeForm !== todo.activeForm ||
			existing.status !== todo.status ||
			(existing.evidence ?? undefined) !== (todo.evidence ?? undefined);
		return changed ? todo : existing;
	});

	return normalizeTodoState({
		...current,
		todos: mergedTodos,
		updatedAt: now,
	});
}

function applyTodoClear(current: TodoState, params: TodoClearInput): { state: TodoState; cleared: TodoItem[]; scope: "completed" | "all" } {
	if (current.source !== "standalone") {
		throw new Error("todo_clear: only standalone todo lists can be cleared; plan-owned and workflow todo lists are execution records.");
	}

	const now = new Date().toISOString();
	const scope = params.scope ?? "completed";
	const cleared = scope === "all" ? current.todos : current.todos.filter((todo) => todo.status === "completed");
	const clearedIds = new Set(cleared.map((todo) => todo.id));
	const remaining = current.todos.filter((todo) => !clearedIds.has(todo.id));

	return {
		state: normalizeTodoState({
			...current,
			todos: remaining,
			updatedAt: now,
		}),
		cleared,
		scope,
	};
}

function validateIncomingTodos(todos: TodoItem[]) {
	const seen = new Set<string>();
	for (const todo of todos) {
		if (!todo.id) throw new Error("todo_write: todo id must be non-empty.");
		if (seen.has(todo.id)) throw new Error(`todo_write: duplicate todo id '${todo.id}'.`);
		seen.add(todo.id);
		if (!todo.content) throw new Error(`todo_write: todo '${todo.id}' content must be non-empty.`);
		if (!todo.activeForm) throw new Error(`todo_write: todo '${todo.id}' activeForm must be non-empty.`);
	}
}

function validateNoSilentDeletion(current: TodoState, incoming: TodoItem[]) {
	const incomingIds = new Set(incoming.map((todo) => todo.id));
	const missing = current.todos.filter((todo) => !incomingIds.has(todo.id));
	if (missing.length > 0) {
		throw new Error(`todo_write: refusing to delete existing todo id(s): ${missing.map((todo) => todo.id).join(", ")}.`);
	}
}

function validatePolicy(current: TodoState, incoming: TodoItem[], activePlan: ActivePlanRef | undefined) {
	const planOwned = current.source === "plan" || current.owner?.type === "plan";
	const inProgressCount = incoming.filter((todo) => todo.status === "in_progress").length;

	if (inProgressCount > 1) {
		throw new Error("todo_write: at most one todo may be in_progress.");
	}

	if (!planOwned) return;

	if (!activePlan?.active || activePlan.phase !== "executing" || activePlan.planId !== current.owner?.planId) {
		throw new Error("todo_write: plan-owned todo lists may only be updated while their owning plan is executing.");
	}

	const existingIds = new Set(current.todos.map((todo) => todo.id));
	const unknown = incoming.filter((todo) => !existingIds.has(todo.id));
	if (unknown.length > 0) {
		throw new Error(`todo_write: cannot append new todo id(s) to a plan-owned list: ${unknown.map((todo) => todo.id).join(", ")}.`);
	}

	const withoutEvidence = incoming.filter((todo) => todo.status === "completed" && !todo.evidence);
	if (withoutEvidence.length > 0) {
		throw new Error(
			`todo_write: completed plan-owned todo(s) require evidence: ${withoutEvidence.map((todo) => todo.id).join(", ")}.`,
		);
	}
}

function selectTodoState(states: Map<string, TodoState>, params: { listId?: string }, activePlan: ActivePlanRef | undefined): TodoState | undefined {
	if (params.listId) return states.get(params.listId);
	if (activePlan?.active && activePlan.phase === "executing" && activePlan.todoListId) {
		const planState = states.get(activePlan.todoListId);
		if (planState) return planState;
	}
	return states.get(DEFAULT_STANDALONE_LIST_ID) ?? [...states.values()][0];
}

function createStandaloneState(listId = DEFAULT_STANDALONE_LIST_ID): TodoState {
	return createTodoState({
		listId,
		source: "standalone",
		title: listId === DEFAULT_STANDALONE_LIST_ID ? "Standalone Todos" : listId,
	});
}

function normalizeTodoState(state: TodoState): TodoState {
	const now = new Date().toISOString();
	return {
		version: 1,
		listId: state.listId || DEFAULT_STANDALONE_LIST_ID,
		source: state.source ?? "standalone",
		owner: state.owner,
		title: state.title,
		todos: (state.todos ?? []).map((todo) => ({
			id: String(todo.id),
			content: String(todo.content),
			activeForm: String(todo.activeForm),
			status: todo.status,
			evidence: todo.evidence,
			updatedAt: todo.updatedAt ?? state.updatedAt ?? now,
		})),
		createdAt: state.createdAt ?? now,
		updatedAt: state.updatedAt ?? now,
	};
}

function getActivePlanRef(ctx: ExtensionContext): ActivePlanRef | undefined {
	let plan: ActivePlanRef | undefined;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && "customType" in entry && entry.customType === PLAN_STATE_CUSTOM_TYPE) {
			const data = (entry as { data?: { state?: unknown } }).data;
			const candidate = readPlanLike(data?.state ?? data);
			if (candidate) plan = candidate;
			continue;
		}

		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "toolResult") continue;
		const details = message.details as { state?: unknown } | undefined;
		const candidate = readPlanLike(details?.state);
		if (candidate) plan = candidate;
	}

	return plan;
}

function readPlanLike(value: unknown): ActivePlanRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const data = value as { planId?: unknown; phase?: unknown; active?: unknown; todoListId?: unknown };
	if (typeof data.planId !== "string" || typeof data.phase !== "string") return undefined;
	return {
		planId: data.planId,
		phase: data.phase,
		active: data.active === true,
		todoListId: typeof data.todoListId === "string" ? data.todoListId : undefined,
	};
}

function summarizeTodoState(state: TodoState) {
	const total = state.todos.length;
	const completed = state.todos.filter((todo) => todo.status === "completed").length;
	const inProgress = state.todos.find((todo) => todo.status === "in_progress");
	return { total, completed, pending: total - completed - (inProgress ? 1 : 0), inProgress: inProgress?.id };
}

function formatTodoStateForModel(state: TodoState): string {
	if (state.todos.length === 0) {
		return `Todo list '${state.listId}' is empty.`;
	}
	return [
		`Todo list '${state.listId}' (${state.source}${state.owner ? `:${state.owner.planId}` : ""})`,
		...state.todos.map((todo) => `${statusBox(todo.status)} ${todo.id}: ${todo.content}${todo.evidence ? `\n   evidence: ${todo.evidence}` : ""}`),
	].join("\n");
}

function formatTodoStateForHuman(state: TodoState): string {
	const summary = summarizeTodoState(state);
	return [
		`${state.title ?? state.listId} - ${summary.completed}/${summary.total} completed`,
		...state.todos.map((todo) => `${statusBox(todo.status)} ${todo.id}: ${todo.content}${todo.evidence ? `\n   evidence: ${todo.evidence}` : ""}`),
	].join("\n");
}

function updateTodoWidget(ctx: ExtensionContext, states: Map<string, TodoState>, activePlan: ActivePlanRef | undefined) {
	if (!ctx.hasUI) return;
	const state = selectTodoState(states, {}, activePlan);
	if (!state || state.todos.length === 0) {
		ctx.ui.setWidget("yuki-todos", undefined);
		ctx.ui.setStatus("yuki-todos", undefined);
		return;
	}

	ctx.ui.setStatus("yuki-todos", undefined);
	ctx.ui.setWidget(
		"yuki-todos",
		state.todos.slice(0, 8).map((todo) => `${statusGlyph(todo.status)} ${todo.content}`),
	);
}

function statusBox(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[>]";
		case "pending":
			return "[ ]";
	}
}

function statusGlyph(status: TodoStatus): string {
	switch (status) {
		case "completed":
			return "[x]";
		case "in_progress":
			return "[>]";
		case "pending":
			return "[ ]";
	}
}

function renderTodoLine(todo: TodoItem, theme: { fg(name: string, text: string): string; strikethrough(text: string): string }) {
	const glyph = statusGlyph(todo.status);
	if (todo.status === "completed") return theme.fg("success", glyph) + " " + theme.fg("dim", theme.strikethrough(todo.content));
	if (todo.status === "in_progress") return theme.fg("accent", glyph) + " " + theme.fg("accent", todo.content);
	return theme.fg("dim", glyph) + " " + theme.fg("muted", todo.content);
}

function textContent(result: { content?: Array<{ type?: string; text?: string }> }) {
	return result.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n") ?? "";
}
