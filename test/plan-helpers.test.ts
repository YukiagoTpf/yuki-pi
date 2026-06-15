import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isExecutableResolution, slugify } from "../extensions/shared/plan-helpers.ts";

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
