import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../extensions/plan-mode/index.ts", import.meta.url), "utf8");
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

describe("plan-mode v2 integration guards", () => {
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
		assert.match(source, /Normal\/idle mode: continue normal assistance/);
		// P3: banner must carry a do-not-echo constraint so internal routing metadata
		// is never restated in the visible assistant reply.
		assert.match(source, /Internal routing metadata: do not echo this banner/);
		assert.match(source, /do not echo this banner or restate plan mode\/idle\/active-plan status/);
		assert.doesNotMatch(source, /Disabled plan tools/);
		// P3+: idle (no active plan) must NOT inject the banner at all — skip injection so
		// there is nothing to echo, instead of relying on a do-not-echo constraint.
		assert.match(source, /Idle \(no active plan\): skip injecting the plan-mode banner entirely/);
		assert.match(source, /if \(activeState\) \{[\s\S]*PLAN_MODE_PROMPT_CUSTOM_TYPE/);
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
		assert.match(source, /append:\[\.\.\.\]/);
		assert.match(source, /draft\.steps, \.\.\.normalizePlanWriteSteps/);
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
		assert.match(source, /If it reports idle, continue normal assistance/);
	});

	it("keeps plan_write unblocked and persists successful draft state", () => {
		assert.match(source, /NEVER block plan_write/);
		assert.doesNotMatch(source, /reviewInFlight && event\.toolName === "plan_write"/);
		assert.match(source, /persistPlanState\(pi, next, "tool_result"\)/);
	});

	it("returns a terminating result for stale plan_write calls with no active plan", () => {
		assert.match(source, /function buildNoActivePlanResult/);
		assert.match(source, /return buildNoActivePlanResult\("plan_write"\)/);
		assert.match(source, /there is no active plan/);
		assert.doesNotMatch(source, /throw new Error\("plan_write: no active yuki plan/);
	});

	it("makes approval idempotent across repeated entry paths", () => {
		assert.match(source, /latest\?\.planId === current\.planId && latest\.approved && latest\.phase === "executing"/);
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

	it("uses a human-readable slugified plan id seeded from the request (P3)", () => {
		assert.match(source, /function createPlanId\(seed\?: string\)/);
		assert.match(source, /const slug = seed \? slugify\(seed\) : "";/);
		assert.match(source, /slug \? `\$\{stamp\}-\$\{slug\}-\$\{random\}`/);
		assert.match(source, /planId: createPlanId\(request\),/);
	});

	it("keeps the executing widget de-duplicated from the todo list (P3)", () => {
		assert.match(source, /P3降噪: widget only shows plan title\/phase \+ progress \+ next action/);
		// widget must NOT duplicate the todo list id line or the bare "list <id>" form.
		const widgetFn = source.slice(source.indexOf("function updateExecutingWidget"), source.indexOf("type ApprovalOutcome"));
		assert.doesNotMatch(widgetFn, /list \$\{state\.todoListId/);
		assert.match(widgetFn, /executing · \$\{completed\}\/\$\{total\} done/);
	});

	it("prints a compact plan summary to history and uses an inline select for approval", () => {
		assert.match(source, /import \{[^}]*getMarkdownTheme[^}]*withFileMutationQueue[^}]*\}/);
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
		// P3: preview is now a compact summary, not the full renderPlanMarkdown.
		assert.doesNotMatch(source, /renderPlanMarkdown\(state\)\.trim\(\)/);
		assert.match(source, /P3: compact approval preview/);
		assert.match(source, /### Request/);
		assert.match(source, /### Steps/);
		assert.match(source, /### Review/);
		assert.match(source, /Full plan: `\" \+ state\.draftPath \+ "`/);
		assert.match(source, /publishApprovalPreview\(pi, current, message\)/);
		// Approval must use the inline select (same mechanism as ask_user_question),
		// never a floating overlay that obscures the history preview.
		assert.match(source, /ctx\.ui\.select\(title, \["Approve", "Request revision", "Cancel"\]\)/);
		// P3: selector title no longer promises the full plan is shown above; it points
		// to the compact summary plus /plan-debug for the full plan.
		assert.match(source, /summary shown above; \/plan-debug for full plan/);
		assert.doesNotMatch(source, /full plan shown above/);
		assert.doesNotMatch(source, /overlayOptions/);
		assert.doesNotMatch(source, /anchor: "bottom-center"/);
		assert.doesNotMatch(source, /ctx\.ui\.custom<ApprovalChoice/);
		assert.doesNotMatch(source, /function mouseWheelDelta/);
		assert.doesNotMatch(source, /APPROVAL_MOUSE_WHEEL_LINES/);
	});

	it("uses a bounded read-only plan-reviewer subagent for automatic review", () => {
		assert.match(source, /PLAN_REVIEWER_AGENT_NAME = "plan-reviewer"/);
		assert.match(source, /PLAN_REVIEWER_TIMEOUT_MS = 60_000/);
		assert.match(source, /async function runPlanReviewerSubagent/);
		assert.match(source, /await import\("\.\.\/\.\.\/pi-subagent\/runner\.ts"\)/);
		assert.match(source, /agentName: PLAN_REVIEWER_AGENT_NAME/);
		assert.match(source, /initialContext: "empty"/);
		assert.match(source, /maxDepth: 1/);
		assert.match(source, /preventCycles: true/);
		assert.match(source, /subagentReviewUsed/);
		assert.match(source, /if \(!reviewing\.subagentReviewUsed\)/);
		assert.match(source, /plan-reviewer subagent failed or timed out; fell back to direct review/);
		assert.match(source, /normalizeReviewFindings/);
		assert.match(source, /evidence/);
	});

	it("natively checks harness contract gaps during review (P4)", () => {
		assert.match(source, /P4: structural harness-contract gap check/);
		assert.match(source, /function mergeHarnessContractGaps\(feedback: ReviewFeedback, state: PlanFlowState\)/);
		assert.match(source, /function deriveHarnessContractGaps\(state: PlanFlowState\)/);
		assert.match(source, /function validationDeclaresCaptureTarget/);
		assert.match(source, /function validationDeclaresIntermediateResource/);
		assert.match(source, /function validationDeclaresConsumersCheck/);
		// gaps are merged into review feedback on both subagent and direct paths
		assert.match(source, /return applyReviewFeedback\(reviewing, mergeHarnessContractGaps\(feedback, reviewing\), true\)/);
		assert.match(source, /return applyReviewFeedback\(reviewing, mergeHarnessContractGaps\(direct\.feedback, reviewing\)/);
		// capture-target gap message
		assert.match(source, /RenderFeature\/effect plan does not declare a capture target/);
		// intermediate-resource consumers-check gap message
		assert.match(source, /declares intermediate render resources but no step validates their consumers/);
		// per-step files-without-validation gap
		assert.match(source, /touches files but declares no validation intent/);
	});

	it("surfaces a validation matrix in the approval preview (P4)", () => {
		assert.match(source, /P4: render the harness validation matrix for the approval preview/);
		assert.match(source, /function renderValidationMatrixLines\(state: PlanFlowState\)/);
		assert.match(source, /### Validation matrix/);
		assert.match(source, /Mandatory sensors:/);
		assert.match(source, /All mandatory sensors covered by step validation\./);
		assert.match(source, /\*\*Missing coverage:\*\*/);
		assert.match(source, /Per-step validation intents:/);
		// the matrix is wired into the compact approval preview
		assert.match(source, /lines\.push\(\.\.\.renderValidationMatrixLines\(state\)\);/);
	});
});
