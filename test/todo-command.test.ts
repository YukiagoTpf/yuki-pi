import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTodosCommandArgs } from "../extensions/shared/todo-command.ts";

describe("parseTodosCommandArgs", () => {
	it("treats empty or whitespace input as show-current", () => {
		assert.deepEqual(parseTodosCommandArgs(""), { action: "show", listId: undefined });
		assert.deepEqual(parseTodosCommandArgs("   "), { action: "show", listId: undefined });
	});

	it("treats a bare token as show <listId>", () => {
		assert.deepEqual(parseTodosCommandArgs("mylist"), { action: "show", listId: "mylist" });
	});

	it("clears completed by default", () => {
		assert.deepEqual(parseTodosCommandArgs("clear"), { action: "clear", scope: "completed", listId: undefined });
	});

	it("clears with an explicit scope and no list", () => {
		assert.deepEqual(parseTodosCommandArgs("clear all"), { action: "clear", scope: "all", listId: undefined });
		assert.deepEqual(parseTodosCommandArgs("clear completed"), { action: "clear", scope: "completed", listId: undefined });
	});

	it("clears a named list with an explicit scope", () => {
		assert.deepEqual(parseTodosCommandArgs("clear all mylist"), { action: "clear", scope: "all", listId: "mylist" });
		assert.deepEqual(parseTodosCommandArgs("clear completed mylist"), { action: "clear", scope: "completed", listId: "mylist" });
	});

	it("treats a non-scope token after clear as a listId with default scope", () => {
		assert.deepEqual(parseTodosCommandArgs("clear mylist"), { action: "clear", scope: "completed", listId: "mylist" });
	});

	it("normalizes extra whitespace and keeps multi-word list ids", () => {
		assert.deepEqual(parseTodosCommandArgs("  clear   all   my list  "), { action: "clear", scope: "all", listId: "my list" });
	});

	it("documents the limitation: a list literally named 'all' can't be cleared by name", () => {
		// "clear all" is always read as scope=all, so a list named "all" is unreachable here.
		assert.deepEqual(parseTodosCommandArgs("clear all"), { action: "clear", scope: "all", listId: undefined });
	});
});
