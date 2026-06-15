import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { takeTailWithinBudget } from "../extensions/shared/transcript.ts";

describe("takeTailWithinBudget", () => {
	it("returns an empty string for no items", () => {
		assert.equal(takeTailWithinBudget([], 100), "");
	});

	it("keeps all items when within budget, preserving order", () => {
		assert.equal(takeTailWithinBudget(["a", "b", "c"], 100), "a\n\nb\n\nc");
	});

	it("keeps only the most recent items that fit, preserving order", () => {
		// Each item costs length + 2 = 5. Budget 11 fits the two newest (10), not the third (15).
		assert.equal(takeTailWithinBudget(["111", "222", "333"], 11), "222\n\n333");
	});

	it("always keeps at least the most recent item even if it alone exceeds budget", () => {
		assert.equal(takeTailWithinBudget(["old", "huge-item"], 1), "huge-item");
	});
});
