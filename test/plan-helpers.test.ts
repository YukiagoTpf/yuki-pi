import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkMandatoryValidation, getAllowedToolsForState, getConvergenceKick, isExecutableResolution, parsePlanCommandArgs, slugify } from "../extensions/shared/plan-helpers.ts";

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
	const previous = ["read", "grep", "bash", "edit", "todo_read"];

	it("allows only read-only previous tools plus grill_plan during research", () => {
		assert.deepEqual(getAllowedToolsForState("research", previous), ["read", "grep", "grill_plan"]);
	});

	it("allows grilling tools plus read-only previous tools during grilling with open questions", () => {
		assert.deepEqual(getAllowedToolsForState("grilling", previous, { hasOpenGrillingQuestions: true }), ["read", "grep", "plan_ask", "grill_plan", "grill_done"]);
	});

	it("narrows grilling to exactly grill_done when there are no open questions", () => {
		// rev.7: state-sensitive narrowing — without this the model keeps re-calling
		// grill_plan after it already returned "no open questions" (grilling wrong-tool loop).
		// The clean turn must offer ONLY grill_done (no read/grep, no grill_plan).
		assert.deepEqual(getAllowedToolsForState("grilling", previous), ["grill_done"]);
		assert.deepEqual(getAllowedToolsForState("grilling", previous, { hasOpenGrillingQuestions: false }), ["grill_done"]);
	});

	it("narrows drafting and revising to plan_write", () => {
		assert.deepEqual(getAllowedToolsForState("drafting", previous), ["plan_write"]);
		assert.deepEqual(getAllowedToolsForState("revising", previous), ["plan_write"]);
	});

	it("narrows awaiting approval to plan_write and plan_exit", () => {
		assert.deepEqual(getAllowedToolsForState("awaiting_approval", previous), ["plan_write", "plan_exit"]);
	});

	it("allows no model tools while automatic review is running", () => {
		assert.deepEqual(getAllowedToolsForState("reviewing", previous), []);
	});

	it("restores previous tools plus todo tools while executing", () => {
		assert.deepEqual(getAllowedToolsForState("executing", ["read", "edit"]), ["read", "edit", "todo_read", "todo_write"]);
	});

	it("restores previous tools for completed, aborted, idle, and unknown phases", () => {
		for (const phase of ["completed", "aborted", "idle", "unknown"]) {
			assert.deepEqual(getAllowedToolsForState(phase, ["read", "edit"]), ["read", "edit"]);
		}
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
	it("kicks when drafting has no review pending and no review yet", () => {
		assert.match(getConvergenceKick({ phase: "drafting", reviewPending: false, reviewed: false }) ?? "", /Call plan_write/);
	});

	it("does not kick drafting when a review is pending (review handler owns the next step)", () => {
		assert.equal(getConvergenceKick({ phase: "drafting", reviewPending: true, reviewed: false }), undefined);
	});

	it("does not kick drafting when the review already ran (drivePostReview owns the next step)", () => {
		assert.equal(getConvergenceKick({ phase: "drafting", reviewPending: false, reviewed: true }), undefined);
	});

	it("appends planning-context guidance to the drafting kick", () => {
		const kick = getConvergenceKick({ phase: "drafting", planningContextGuidance: "\nMandatory validation: unity-csharp-compile." });
		assert.match(kick ?? "", /Mandatory validation: unity-csharp-compile/);
	});

	it("kicks when still revising, embedding the review issues text", () => {
		const kick = getConvergenceKick({ phase: "revising", reviewIssuesText: "1. [step-1] missing validation" });
		assert.match(kick ?? "", /Call plan_write with the revised plan/);
		assert.match(kick ?? "", /1\. \[step-1\] missing validation/);
	});

	it("kicks when awaiting approval and not yet approved", () => {
		assert.match(getConvergenceKick({ phase: "awaiting_approval", approved: false }) ?? "", /call plan_exit/);
	});

	it("does not kick awaiting approval once approved", () => {
		assert.equal(getConvergenceKick({ phase: "awaiting_approval", approved: true }), undefined);
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

	it("does not kick executing without a todo list id", () => {
		assert.equal(getConvergenceKick({ phase: "executing", allTodosPending: true }), undefined);
	});

	it("does not kick unconstrained phases (research, reviewing, idle, completed, aborted)", () => {
		for (const phase of ["research", "reviewing", "idle", "completed", "aborted", "unknown"]) {
			assert.equal(getConvergenceKick({ phase }), undefined, `expected ${phase} to be unconstrained`);
		}
	});

	it("kicks grilling toward grill_done when there are no open questions", () => {
		assert.match(getConvergenceKick({ phase: "grilling", hasOpenQuestions: false }) ?? "", /Call grill_done/);
	});

	it("does not kick grilling when there are still open questions", () => {
		assert.equal(getConvergenceKick({ phase: "grilling", hasOpenQuestions: true }), undefined);
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
