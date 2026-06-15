/**
 * Pure parser for `/todos` command arguments.
 *
 * Kept dependency-free so the (surprisingly fiddly) clear-scope/listId parsing
 * can be unit tested without importing the todo extension.
 */

export type TodosCommand =
	| { action: "show"; listId?: string }
	| { action: "clear"; scope?: "completed" | "all"; listId?: string };

export function parseTodosCommandArgs(args: string): TodosCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens[0] !== "clear") return { action: "show", listId: tokens.join(" ") || undefined };

	const [, first, ...rest] = tokens;
	if (first === "completed" || first === "all") {
		return { action: "clear", scope: first, listId: rest.join(" ") || undefined };
	}
	return { action: "clear", scope: "completed", listId: [first, ...rest].filter(Boolean).join(" ") || undefined };
}
