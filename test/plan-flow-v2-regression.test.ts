import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/plan-flow/index.ts", import.meta.url), "utf8");
const compactionSource = readFileSync(new URL("../extensions/yuki-compaction.ts", import.meta.url), "utf8");

function extractDrivePostReviewRevisingBranch(): string {
	const start = source.indexOf('if (state.phase === "revising") {', source.indexOf("async function drivePostReview"));
	const end = source.indexOf("\n\t// phase === awaiting_approval", start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	return source.slice(start, end);
}

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

	it("keeps plan state discoverable across compaction", () => {
		assert.match(compactionSource, /PLAN_STATE_CUSTOM_TYPE/);
		assert.match(compactionSource, /entry\.customType === PLAN_STATE_CUSTOM_TYPE/);
		assert.match(compactionSource, /readPlanState\(data\?\.state \?\? data\)/);
		assert.match(compactionSource, /message\.role === "toolResult"/);
		assert.match(source, /pi\.on\("session_before_compact"/);
		assert.match(source, /pi\.on\("session_compact"/);
		assert.match(source, /persistPlanState\(pi, state, "phase_change"\)/);
	});

	it("continues automatic review revisions immediately instead of waiting for the next user turn", () => {
		const revisingBranch = extractDrivePostReviewRevisingBranch();
		assert.doesNotMatch(revisingBranch, /queueNextTurnInstruction/);
		assert.match(revisingBranch, /continueRevisionTurn\(pi, state, issueText\)/);
		assert.match(source, /function continueRevisionTurn[\s\S]*deliverAs: "followUp"[\s\S]*triggerTurn: true/);
		assert.match(source, /First output a concise visible revision note to the user/);
		assert.match(source, /MAX_REVIEW_REVISION_ATTEMPTS/);
		assert.match(source, /function publishRevisionLoopStop/);
	});

	it("continues execution immediately after approval and keeps the plan widget compact", () => {
		assert.match(source, /function continueExecutionTurn[\s\S]*deliverAs: "followUp"[\s\S]*triggerTurn: true/);
		assert.match(source, /continueExecutionTurn\(pi, kicked\)/);
		assert.match(source, /markExecutionKickSent\(approved\)/);
		assert.match(source, /markExecutionKickSent\(outcome\.state\)/);
		assert.match(source, /executionKickSent: state\.executionKickSent/);
		assert.doesNotMatch(source, /Plan approved\. Begin execution[\s\S]{0,120}deliverAs: "nextTurn"/);
		assert.match(source, /function buildCompactPlanWidget/);
		assert.doesNotMatch(source, /state\.steps\.map\(\(step, index\) => `\$\{index \+ 1\}\. \$\{step\.content\}`\)/);
	});

	it("renders the full plan markdown inside the TUI approval surface", () => {
		assert.match(source, /import \{ getMarkdownTheme, withFileMutationQueue \}/);
		assert.match(source, /import \{ Markdown, Text, matchesKey, truncateToWidth, visibleWidth \}/);
		assert.match(source, /async function choosePlanApproval/);
		assert.match(source, /ctx\.ui\.custom<ApprovalChoice \| undefined>/);
		assert.match(source, /const markdown = renderPlanMarkdown\(current\)/);
		assert.match(source, /new Markdown\(markdown, 0, 0, mdTheme\)/);
		assert.match(source, /overlay: true/);
		assert.match(source, /overlayOptions: \{ anchor: "center"/);
		assert.match(source, /function mouseWheelDelta/);
		assert.match(source, /APPROVAL_MOUSE_WHEEL_LINES/);
		assert.match(source, /Enter\/A/);
		assert.match(source, /Request revision/);
	});
});
