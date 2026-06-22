import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPlanModeStatus, checkMandatoryValidation, derivePlanModeSurface, getAllowedToolsForState, getConvergenceKick, isExecutableResolution, parsePlanCommandArgs, PLAN_STATUS_TOOL, slugify, stripPlanMutatingTools } from "../extensions/shared/plan-helpers.ts";

describe("isExecutableResolution", () => {
	it("accepts short but concrete answers", () => {
		for (const value of ["no", "v2", "用 A", "用A", "yes", "PG"]) {
			assert.equal(isExecutableResolution(value), true, `expected '${value}' to be executable`);
		}
	});

	it("rejects undefined, empty, and whitespace-only", () => {
		assert.equal(isExecutableResolution(undefined), false);
		assert.equal(isExecutableResolution(""), false);
		assert.equal(isExecutableResolution("   "), false);
	});

	it("rejects non-answer junk phrases regardless of case and surrounding space", () => {
		for (const value of ["随便", "都行", "看情况", "之后再说", "无所谓", "不知道", "whatever", "WHATEVER", " up to you ", "TBD", "idk"]) {
			assert.equal(isExecutableResolution(value), false, `expected '${value}' to be rejected`);
		}
	});

	it("accepts answers that merely contain a junk phrase as a substring", () => {
		assert.equal(isExecutableResolution("use option A, decide caching later"), true);
		assert.equal(isExecutableResolution("随便选 Postgres 就行"), true);
	});

	it("rejects punctuation-only answers", () => {
		for (const value of ["。", "？？", "...", "!!!", "—"]) {
			assert.equal(isExecutableResolution(value), false, `expected '${value}' to be rejected`);
		}
	});

	it("accepts purely numeric answers", () => {
		assert.equal(isExecutableResolution("3"), true);
		assert.equal(isExecutableResolution("v2"), true);
	});
});

describe("parsePlanCommandArgs", () => {
	it("treats a bare request as the whole request with no context", () => {
		const p = parsePlanCommandArgs("fix the bug in parser");
		assert.equal(p.request, "fix the bug in parser");
		assert.equal(p.contextToken, undefined);
		assert.deepEqual(p.unknownFlags, []);
		assert.equal(p.help, false);
	});

	it("extracts --context <token> and leaves the rest as request", () => {
		const p = parsePlanCommandArgs("--context abc123 修改 Foo 的运行逻辑");
		assert.equal(p.contextToken, "abc123");
		assert.equal(p.request, "修改 Foo 的运行逻辑");
		assert.deepEqual(p.unknownFlags, []);
	});

	it("preserves quoted segments in the request", () => {
		const p = parsePlanCommandArgs('--context t1 "add a step that says hello world"');
		assert.equal(p.contextToken, "t1");
		assert.equal(p.request, "add a step that says hello world");
	});

	it("flags --context with a missing token", () => {
		const q = parsePlanCommandArgs("--context --foo x");
		assert.ok(q.unknownFlags.some((f) => f.startsWith("--context (missing")));
	});

	it("collects unknown flags and still extracts the request", () => {
		const p = parsePlanCommandArgs("--verbose --context tok do thing");
		assert.equal(p.contextToken, "tok");
		assert.equal(p.request, "do thing");
		assert.ok(p.unknownFlags.includes("--verbose"));
	});

	it("recognizes --help/-h", () => {
		assert.equal(parsePlanCommandArgs("--help").help, true);
		assert.equal(parsePlanCommandArgs("-h something").help, true);
	});
});

describe("getAllowedToolsForState", () => {
	const previous = ["read", "grep", "bash", "edit", "todo_read", "ask_user_question"];

	it("allows read/search, generic ask, and plan_write during planning", () => {
		assert.deepEqual(getAllowedToolsForState("planning", previous), [PLAN_STATUS_TOOL, "read", "grep", "ask_user_question", "plan_write"]);
	});

	it("narrows revising to the same stable planning surface", () => {
		assert.deepEqual(getAllowedToolsForState("revising", previous), [PLAN_STATUS_TOOL, "read", "grep", "ask_user_question", "plan_write"]);
	});

	it("allows no model tools while automatic review or approval is extension-owned", () => {
		assert.deepEqual(getAllowedToolsForState("reviewing", previous), [PLAN_STATUS_TOOL]);
		assert.deepEqual(getAllowedToolsForState("awaiting_approval", previous), [PLAN_STATUS_TOOL]);
	});

	it("restores sanitized ambient tools plus todo tools while executing", () => {
		assert.deepEqual(getAllowedToolsForState("executing", ["read", "edit", "plan_write"]), [PLAN_STATUS_TOOL, "read", "edit", "todo_read", "todo_write"]);
	});

	it("falls back to current tools for executing when no ambient snapshot exists", () => {
		assert.deepEqual(getAllowedToolsForState("executing", [], ["read", "bash", "plan_write"]), [PLAN_STATUS_TOOL, "read", "bash", "todo_read", "todo_write"]);
	});

	it("strips plan mutating tools from completed, aborted, idle, and unknown current surfaces", () => {
		for (const phase of ["completed", "aborted", "idle", "unknown"]) {
			assert.deepEqual(getAllowedToolsForState(phase, ["read"], ["read", "edit", "plan_write"]), [PLAN_STATUS_TOOL, "read", "edit"]);
		}
	});

	it("derives idle from current tools and executing from sanitized ambient tools", () => {
		assert.deepEqual(stripPlanMutatingTools(["read", "plan_write", "grep"]), ["read", "grep"]);
		assert.deepEqual(derivePlanModeSurface(undefined, ["read", "grep", "plan_write"]).allowedTools, [PLAN_STATUS_TOOL, "read", "grep"]);
		assert.deepEqual(
			derivePlanModeSurface({ active: true, phase: "executing", previousActiveTools: ["read", "edit", "plan_write"] }, ["todo_read"]).allowedTools,
			[PLAN_STATUS_TOOL, "read", "edit", "todo_read", "todo_write"],
		);
	});

	it("builds a stable plan-mode status protocol", () => {
		assert.deepEqual(buildPlanModeStatus(undefined, ["read", "plan_write"]), {
			active: false,
			mode: "idle",
			phase: "idle",
			planId: undefined,
			title: undefined,
			stepCount: undefined,
			availablePlanTools: [],
			guidance: "No active yuki plan. To plan a task, the user must start /plan <request>.",
		});
		assert.deepEqual(buildPlanModeStatus({ active: true, phase: "planning", planId: "plan-1", title: "T", steps: [{}, {}], previousActiveTools: ["read"] }, ["read"]), {
			active: true,
			mode: "planning",
			phase: "planning",
			planId: "plan-1",
			title: "T",
			stepCount: 2,
			availablePlanTools: ["plan_write"],
			guidance: "Yuki plan mode is planning.",
		});
	});
});

describe("checkMandatoryValidation", () => {
	it("passes when no mandatory validation is declared", () => {
		assert.deepEqual(checkMandatoryValidation([], []), { ok: true, missing: [] });
	});

	it("passes when the union of step validations covers all mandatory items", () => {
		assert.deepEqual(
			checkMandatoryValidation([
				["Run UNITY-CSHARP-COMPILE after changes"],
				["Also run unity-shader-compile for shader files"],
			], ["unity-csharp-compile", "unity-shader-compile"]),
			{ ok: true, missing: [] },
		);
	});

	it("returns all mandatory items as missing when no validation is provided", () => {
		assert.deepEqual(checkMandatoryValidation([[], []], ["unity-csharp-compile", "unity-shader-compile"]), {
			ok: false,
			missing: ["unity-csharp-compile", "unity-shader-compile"],
		});
	});

	it("returns only uncovered mandatory items", () => {
		assert.deepEqual(checkMandatoryValidation([["unity-csharp-compile pass"]], ["unity-csharp-compile", "unity-playmode-log"]), {
			ok: false,
			missing: ["unity-playmode-log"],
		});
	});
});

describe("getConvergenceKick", () => {
	it("does not kick planning, revising, reviewing, or awaiting approval", () => {
		for (const phase of ["planning", "revising", "reviewing", "awaiting_approval"]) {
			assert.equal(getConvergenceKick({ phase, reviewIssuesText: "blocking" }), undefined, `expected ${phase} to be extension/model-owned without kicks`);
		}
	});

	it("kicks executing only when every todo is still pending", () => {
		assert.match(
			getConvergenceKick({ phase: "executing", todoListId: "plan-x", allTodosPending: true }) ?? "",
			/todo_write to mark the first step in_progress for list plan-x/,
		);
	});

	it("does not kick executing once any todo has been touched", () => {
		assert.equal(getConvergenceKick({ phase: "executing", todoListId: "plan-x", allTodosPending: false }), undefined);
	});

	it("does not repeat the executing kick after approval already sent one", () => {
		assert.equal(getConvergenceKick({ phase: "executing", todoListId: "plan-x", allTodosPending: true, executionKickSent: true }), undefined);
	});

	it("does not kick executing without a todo list id", () => {
		assert.equal(getConvergenceKick({ phase: "executing", allTodosPending: true }), undefined);
	});

	it("does not kick unconstrained terminal or unknown phases", () => {
		for (const phase of ["idle", "completed", "aborted", "unknown"]) {
			assert.equal(getConvergenceKick({ phase }), undefined, `expected ${phase} to be unconstrained`);
		}
	});
});

describe("slugify", () => {
	it("lowercases and replaces non-alphanumerics with dashes", () => {
		assert.equal(slugify("Add Plan Flow!"), "add-plan-flow");
	});

	it("collapses repeats and trims edge dashes", () => {
		assert.equal(slugify("  --Foo__Bar--  "), "foo-bar");
	});

	it("falls back to 'plan' for empty or non-ascii-only input", () => {
		assert.equal(slugify(""), "plan");
		assert.equal(slugify("中文标题"), "plan");
	});

	it("caps length at 60 characters", () => {
		assert.equal(slugify("a".repeat(100)).length, 60);
	});
});
