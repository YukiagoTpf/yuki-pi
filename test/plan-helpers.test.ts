import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkMandatoryValidation, getAllowedToolsForState, isExecutableResolution, parsePlanCommandArgs, slugify } from "../extensions/shared/plan-helpers.ts";

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

	it("allows grilling tools plus read-only previous tools during grilling", () => {
		assert.deepEqual(getAllowedToolsForState("grilling", previous), ["read", "grep", "plan_ask", "grill_plan", "grill_done"]);
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
