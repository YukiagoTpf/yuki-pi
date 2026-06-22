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

function extractHandler(eventName: string): string {
	const start = source.indexOf(`pi.on("${eventName}"`);
	const end = source.indexOf("\n\t});", start);
	assert.notEqual(start, -1);
	assert.notEqual(end, -1);
	return source.slice(start, end);
}

describe("plan-flow v2 integration guards", () => {
	it("exposes only plan_write as the model-facing yuki mutating planning tool", () => {
		assert.match(source, /const PLAN_TOOLS = new Set\(\["plan_write"\]\)/);
		assert.match(source, /name: "plan_write"/);
		for (const removed of ["grill_plan", "grill_done", "plan_ask", "plan_exit"]) {
			assert.doesNotMatch(source, new RegExp(`name: "${removed}"`));
		}
	});

	it("injects plan-mode policy through context and only uses before_agent_start for tool refresh", () => {
		assert.match(source, /pi\.on\("context"/);
		assert.match(source, /PLAN_MODE_PROMPT_CUSTOM_TYPE/);
		assert.match(source, /buildPlanModePrompt\(activeState, status\)/);
		assert.match(source, /Normal\/idle mode: do not call plan_write/);
		const beforeAgentStart = extractHandler("before_agent_start");
		assert.match(beforeAgentStart, /applyActiveTools\(pi, state\)/);
		assert.match(beforeAgentStart, /updatePlanUi\(ctx, state\)/);
		assert.doesNotMatch(beforeAgentStart, /PLAN_MODE_PROMPT_CUSTOM_TYPE/);
	});

	it("supports skeleton and patch plan_write modes before full review", () => {
		assert.match(source, /Type\.Literal\("skeleton"\)/);
		assert.match(source, /Type\.Literal\("patch"\)/);
		assert.match(source, /mode === "skeleton"/);
		assert.match(source, /mode === "patch"/);
		assert.match(source, /mode:'full' when ready for review/);
		assert.match(source, /params\.steps !== undefined \? normalizePlanWriteSteps\(params\.steps\) : normalizePlanWriteSteps\(current\.steps/);
		assert.match(source, /terminate: next\.reviewPending \? true as const : undefined/);
	});

	it("steers plan_write payloads to stay within an output budget", () => {
		assert.match(source, /PLAN_WRITE_BUDGET_GUIDANCE/);
		assert.match(source, /40%-60%/);
		assert.match(source, /validation <= 2 items per step/);
	});

	it("registers get_plan_mode_status as the read-only status protocol tool", () => {
		assert.match(source, /name: PLAN_STATUS_TOOL/);
		assert.match(source, /buildPlanModeStatus\(state, pi\.getActiveTools\(\)\)/);
		assert.match(source, /If it reports idle, do not call plan_write/);
	});

	it("returns a terminating result for stale plan_write calls with no active plan", () => {
		assert.match(source, /function buildNoActivePlanResult/);
		assert.match(source, /return buildNoActivePlanResult\("plan_write"\)/);
		assert.match(source, /there is no active plan/);
		assert.doesNotMatch(source, /throw new Error\("plan_write: no active yuki plan/);
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
		assert.match(source, /function buildExecutionKickContent/);
		assert.match(source, /pi\.on\("input"[\s\S]*event\.source === "extension"[\s\S]*event\.streamingBehavior === "followUp"[\s\S]*applyActiveTools\(pi, state\)/);
		assert.match(source, /state\.phase === "awaiting_approval"[\s\S]*isExecutionKickForPlan\(event\.text, state\)[\s\S]*approvePlan\(pi, ctx, state\)/);
		assert.doesNotMatch(source, /Plan approved\. Begin execution[\s\S]{0,120}deliverAs: "nextTurn"/);
		assert.match(source, /function buildCompactPlanWidget/);
		assert.doesNotMatch(source, /state\.steps\.map\(\(step, index\) => `\$\{index \+ 1\}\. \$\{step\.content\}`\)/);
	});

	it("prints the full plan markdown to history and uses an inline select for approval", () => {
		assert.match(source, /import \{ getMarkdownTheme, withFileMutationQueue \}/);
		assert.match(source, /import \{ Markdown, Text \}/);
		assert.doesNotMatch(source, /matchesKey/);
		assert.doesNotMatch(source, /truncateToWidth/);
		assert.match(source, /PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE = "yuki-plan-flow-approval-preview"/);
		assert.match(source, /registerMessageRenderer\(PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE/);
		assert.match(source, /message\.customType === PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE/);
		assert.match(source, /function publishApprovalPreview/);
		assert.match(source, /customType: PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE[\s\S]*display: true/);
		assert.match(source, /pi\.on\("agent_end"[\s\S]*setTimeout\(\(\) => \{[\s\S]*driveUiApproval\(pi, ctx, planId\)/);
		assert.match(source, /function driveUiApproval\(pi: ExtensionAPI, ctx: ExtensionContext, planId: string\)/);
		assert.match(source, /agent_end fires while isStreaming is STILL true/);
		assert.match(source, /finishRun\(\) only AFTER all agent_end listeners settle/);
		assert.match(source, /route[\s\S]*pi\.sendMessage[\s\S]*into agent\.steer/);
		assert.match(source, /UI approval is deferred until the next macrotask after agent_end/);
		assert.match(source, /function renderApprovalPreviewMarkdown/);
		assert.match(source, /renderPlanMarkdown\(state\)\.trim\(\)/);
		assert.match(source, /publishApprovalPreview\(pi, current, message\)/);
		// Approval must use the inline select (same mechanism as ask_user_question),
		// never a floating overlay that obscures the history preview.
		assert.match(source, /ctx\.ui\.select\(title, \["Approve", "Request revision", "Cancel"\]\)/);
		assert.match(source, /full plan shown above/);
		assert.doesNotMatch(source, /overlayOptions/);
		assert.doesNotMatch(source, /anchor: "bottom-center"/);
		assert.doesNotMatch(source, /ctx\.ui\.custom<ApprovalChoice/);
		assert.doesNotMatch(source, /function mouseWheelDelta/);
		assert.doesNotMatch(source, /APPROVAL_MOUSE_WHEEL_LINES/);
	});
});
