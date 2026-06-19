import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/plan-flow/index.ts", import.meta.url), "utf8");
const compactionSource = readFileSync(new URL("../extensions/yuki-compaction.ts", import.meta.url), "utf8");

describe("plan-flow v2 integration guards", () => {
	it("exposes only plan_write as the model-facing yuki planning tool", () => {
		assert.match(source, /const PLAN_TOOLS = new Set\(\["plan_write"\]\)/);
		assert.match(source, /name: "plan_write"/);
		for (const removed of ["grill_plan", "grill_done", "plan_ask", "plan_exit"]) {
			assert.doesNotMatch(source, new RegExp(`name: "${removed}"`));
		}
	});

	it("injects plan-mode policy through context rather than one-shot agent start", () => {
		assert.match(source, /pi\.on\("context"/);
		assert.doesNotMatch(source, /pi\.on\("before_agent_start"/);
		assert.match(source, /PLAN_MODE_PROMPT_CUSTOM_TYPE/);
	});

	it("requires explicit approvalMode for direct callers such as ta-dev", () => {
		assert.match(source, /approvalMode: ApprovalMode;/);
		assert.match(source, /startPlanFlow\(pi, ctx, \{ request, planningContext, approvalMode: "ui" \}\)/);
		assert.match(source, /state\.approvalMode === "auto"/);
		assert.match(source, /Trusted headless callers must pass approvalMode:'auto'/);
	});

	it("keeps plan state discoverable by yuki compaction reconstruction", () => {
		assert.match(compactionSource, /PLAN_STATE_CUSTOM_TYPE/);
		assert.match(compactionSource, /entry\.customType === PLAN_STATE_CUSTOM_TYPE/);
		assert.match(compactionSource, /readPlanState\(data\?\.state \?\? data\)/);
		assert.match(compactionSource, /message\.role === "toolResult"/);
	});
});
