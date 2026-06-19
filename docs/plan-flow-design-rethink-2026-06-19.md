# Plan-flow v2 design: coarse planning mode, no grill tools

Date: 2026-06-19
Status: Locked for implementation

## Summary

Yuki plan-flow should stop modeling planning as a fine-grained, model-driven tool state machine.

The current flow is over-modeled:

```text
research -> grill_plan -> grilling -> grill_done -> drafting -> plan_write -> reviewing -> awaiting_approval -> plan_exit -> executing
```

This repeatedly conflicts with Pi runtime behavior: `setActiveTools()` updates extension state, but the currently running agent loop may continue with a frozen tool snapshot captured at the beginning of that turn. The persisted yuki state can be correct while the model still sees stale tools.

The long-term fix is not more phase-tool patching. The new design is:

```text
/plan <request>
  -> planning mode
     model reads/searches/asks if necessary
     model calls plan_write
  -> extension auto-review
  -> extension/UI approval
  -> execution mode
     model executes plan-owned todos
```

Only one model-facing planning submission tool remains:

```text
plan_write
```

`grill` remains as a planning discipline in the prompt and review criteria. It is no longer a phase, tool, or state machine.

Therefore v2 should remove the model-facing grill tools entirely:

```text
grill_plan  DELETE
grill_done  DELETE
plan_ask    DELETE
```

Approval should also be extension/UI-owned, not model-driven:

```text
plan_exit   no longer required/exposed in main flow
```

Because yuki plan-mode is not yet widely used, we prefer a clean breaking change over hidden compatibility stubs.

## Why change

### Current failure mode

The fine-grained flow expects this pattern:

```text
model calls tool A
extension changes phase and active tools
model immediately calls newly enabled tool B
extension changes phase and active tools again
model immediately calls newly enabled tool C
```

But Pi runtime snapshots the tool surface for the current running agent loop. Mid-turn `setActiveTools()` affects future clean turns, not necessarily the current model continuation. This produced repeated wrong-tool loops:

- `grill_plan(open_questions: [])` moved state forward, while the current turn still exposed `grill_plan`.
- `plan_write` moved to review/approval, while stale tools could still be selected.
- approval moved to execution, while the next prompt/tool surface was not necessarily fresh yet.

The rev.7 hotfix made plan tools execute-and-terminate instead of block/throw, which stabilizes the current architecture. But it is still a workaround around an over-fine state machine.

### Design diagnosis

The model should not be responsible for driving yuki's internal planning state machine. The model should produce artifacts and execute approved work. The extension/UI should own phase transitions.

Desired ownership:

| Owner | Responsibilities |
|---|---|
| Model | Explore, ask if needed, write structured plan, execute todos |
| Extension | Maintain state, run review, create todos, switch modes |
| UI | Approval/revision/cancel decisions |

## Web survey: Pi plan-mode patterns to absorb

A quick survey of public Pi plan-mode/mode extensions supports this direction. None of the useful designs use a required `grill_plan -> grill_done -> plan_write -> plan_exit` chain.

### Official Pi example: `examples/extensions/plan-mode`

Source: `earendil-works/pi`, `packages/coding-agent/examples/extensions/plan-mode`.

Useful patterns:

- Coarse plan mode vs execution mode.
- Plan mode is read-only exploration.
- Extension/UI asks whether to execute, stay in plan mode, or refine.
- Execution progress can be tracked separately.

Main lesson:

> The model produces the plan; extension/UI owns the transition into execution.

### `R-Dson/pi-modes`

Source: <https://github.com/R-Dson/pi-modes>

Useful patterns:

- Mode definitions are coarse (`ask`, `plan`, `edit`, `review`).
- Tool control is centralized per mode.
- Mode prompt is refreshed per provider interaction rather than relying only on one-shot turn-start text. Yuki v2 implements that with Pi's `context` event instead of raw `before_provider_request` payload mutation.
- README warns that multiple extensions independently calling `setActiveTools()` can conflict.

Main lesson:

> Planning mode instructions should be mode-level and compaction-safe, not one-shot phase messages.

### `narumiruna/pi-plan-mode`

Source: <https://github.com/narumiruna/pi-extensions/tree/main/extensions/pi-plan-mode>

Useful patterns:

- Codex-like planning wording: produce a decision-complete implementation plan.
- Explore first, ask second.
- Do not ask questions answerable from repo/system truth.
- Ask only high-impact questions affecting intent, approach, interfaces, edge cases, testing, migration, or compatibility.
- Non-built-in tools disabled by default, user-risk opt-in available.
- Proposed plan ready menu is UI-owned: implement / stay / exit.

Not adopted:

- Its `plan_mode_question` tool. Yuki v2 deliberately removes grill/question-specific plan-flow tools.
- Its `<proposed_plan>` text block. Yuki already has structured `plan_write`, which is a better source of truth.

### `wilfredinni/pi-openplan`

Source: <https://github.com/wilfredinni/pi-openplan>

Useful patterns:

- Prompt-size discipline. Yuki v2 does **not** adopt the full/brief split; it uses a self-contained brief every time so compaction cannot leave dangling references.
- Structured plan files.
- Plan revision/versioning ideas.
- Verification pause markers.
- Read-only bash allowlist and mutating bash blocking.

Potential future adoption:

- Version-preserved plan revisions.
- Optional verification gates.
- Read-only bash allowlist if yuki later wants `bash` in planning mode.

### `aporcelli/pi-plan-lock`

Source: <https://github.com/aporcelli/pi-plan-lock>

Useful patterns:

- Strict read-only mode.
- Runtime guard for disallowed tools.
- Sensitive path guardrails.
- Per-turn mode banner.
- Slash-command blocking while locked.

Potential future adoption:

- Sensitive path guard.
- Plan-mode banner.

Not needed now:

- Lock/unlock key flow. Yuki's plan-flow is not a general-purpose security lock.

### `milanglacier/pi-plan-mode`

Source: <https://github.com/milanglacier/pi-plan-mode>

Useful patterns:

- Very small model-facing surface.
- User-overridable planning prompt.
- Above-editor banner.
- Persistent plan file status.

Potential future adoption:

- `~/.pi/agent/PLAN.prompt.md` style prompt override.
- Better plan-mode banner/status UI.

## Final v2 architecture

### Modes

```text
idle
planning
reviewing
revising
awaiting_approval
executing
completed
aborted
```

`idle` is the initial/fallback state.

`planning` replaces the old `research`, `grilling`, and `drafting` phases.

`revising` is planning-like. It uses the same tool surface as planning but includes review/user feedback in the prompt/kick.

`reviewing` is extension-internal. The model should not receive tools for it.

`awaiting_approval` is extension/UI-owned. The model should not need to call a tool to approve.

`executing` uses plan-owned todos as the source of truth.

`completed` is required: when all plan-owned todos are complete, yuki closes the active plan so the next `/plan` is not blocked.

### Planning mode tool surface

Allowed:

```text
read
grep
find
ls
ask_user_question  optional if available
plan_write
```

Not allowed/exposed:

```text
grill_plan
grill_done
plan_ask
plan_exit
todo_read
todo_write
edit
write
bash
```

Notes:

- `ask_user_question` is a generic UI tool, not a yuki planning state tool.
- In yuki-pi it is registered by `extensions/ask-user-question.ts`; if unavailable in another runtime, the model can ask a normal assistant-text question.
- The at-most-five-question cap is prompt/review discipline only; v2 deliberately removes `askCount` enforcement with the old grill state machine.
- Do not add a yuki-specific `plan_ask`; that recreates part of the old grill state machine.
- "Search" in planning means repository search (`grep`/`find`/`ls`), not web/code search tools.
- Do not allow `bash` in v2's first implementation. If later needed, add only read-only bash with an explicit allowlist.

### Execution mode tool surface

Allowed:

```text
previous normal tools
todo_read
todo_write
```

Execution remains todo-driven:

- approved plan steps seed a plan-owned todo list;
- the model uses `todo_write` to mark one in progress and then complete with evidence;
- validation evidence remains mandatory when required by plan context.

## Grill in v2

Grill is not deleted as a behavior. It is deleted as a tool chain.

Old:

```text
grill_plan -> plan_ask -> grill_done
```

New:

```text
planning prompt discipline + normal questions + review checks
```

Planning prompt must instruct:

- Explore first, ask second.
- Do not ask facts that can be inspected from the repository or runtime.
- Ask only high-impact questions that can change scope, architecture, implementation strategy, validation, migration, compatibility, or user-facing behavior.
- Ask at most five critical questions total. This is enforced by prompt/review, not by `askCount` state.
- If ambiguity is low-risk, proceed with an explicit assumption and record it in the plan's `assumptions` field.
- Do not produce `plan_write` until the plan is decision-complete enough for another agent to execute.
- If no blocking question exists, call `plan_write` directly.
- Planning/revising are unconstrained while the model is reading, asking, or waiting for an answer; do not convergence-kick these phases toward `plan_write` just because no tool was called in a turn.

Review must check:

- Did the plan skip a critical unresolved question?
- Did it treat an assumption as a fact?
- Are scope and non-goals clear?
- Are validation steps concrete?
- Are mandatory validations covered?
- Are implementation steps specific enough for execution?

This preserves the value of grilling without exposing `grill_*` tools.

## Approval in v2

Approval is extension/UI-owned.

Main UI flow:

```text
plan_write
  -> extension auto-review
  -> if review fails: revising + next-turn instruction to call plan_write again
  -> if review passes: UI approval dialog
       approve: create plan-owned todos, enter executing
       revise: enter revising, include user revision request
       cancel: abort
```

The model should not be required to call `plan_exit`.

Headless behavior is explicit, not accidental. v2 only supports:

```ts
approvalMode: "ui" | "auto"
```

`external` is dropped from v2. Without a concrete command/event resolver it would create an `awaiting_approval` hang after deleting `plan_exit`.

Locked approval matrix:

| has UI | approvalMode | behavior |
| --- | --- | --- |
| yes | `ui` | run the approval dialog |
| yes | `auto` | approve automatically |
| no | `auto` | approve automatically |
| no | `ui` | fail fast with a clear error/notification; do not enter an unresolvable wait |

Defaults:

- UI `/plan`: `approvalMode: "ui"`.
- `/ta-dev`, E2E, and other trusted programmatic entry points: pass `approvalMode: "auto"` explicitly.
- General headless callers must pass `approvalMode: "auto"` explicitly or fail fast.

## Prompt injection

Planning/execution mode prompt should be injected in a compaction-safe way.

Locked choice:

- Use the Pi `context` event to inject or refresh a self-contained hidden mode message before each LLM call.
- Do **not** use `before_provider_request` for this; it exists in the pinned runtime, but operates on raw provider payloads and is too provider-specific for prompt-policy injection.
- Do **not** also inject through `before_agent_start`; using both risks duplicate/conflicting mode prompts.

The injected message should be a self-contained brief every time, not a "full first turn + dangling later reminder" split. This survives compaction, resumed sessions, mid-loop provider requests, and `/reload`.

## Proposed planning prompt shape

```text
[Planning Mode]
You are producing a decision-complete implementation plan. Do not edit files or implement.

Workflow:
1. Explore repository/runtime with read-only repo tools.
2. Ask only critical non-discoverable questions.
3. If ambiguity is low-risk, state an assumption.
4. Submit the final structured plan with plan_write.

Rules:
- Do not use edit/write/bash.
- Do not ask questions answerable from the repo.
- Ask at most five critical questions.
- Final plan must leave no implementation decisions unresolved.
- Include files, rationale, validation, risks, decisions, assumptions, and mandatory validation coverage.
```

## Implementation plan

### Phase 1: State model

- Add `planning` as the initial plan-flow phase.
- Treat `revising` as planning-like.
- Remove old main-flow dependence on `research`, `grilling`, and `drafting`.
- Remove `questions`, `askCount`, and `maxAskCount` from the required main state. If historical entries exist, ignore them.
- Add `decisions?: string[]` and `assumptions?: string[]` to the plan draft state and `plan_write` schema so v2 keeps a structured replacement for the old resolved-question Decisions section.
- Update all old question readers: `formatPlanStatus`, `nextActionHint`, `buildPhasePrompt`, `renderPlanMarkdown`, `buildKickoffContent`, and `normalizePlanState`.

### Phase 2: Tool registration cleanup

Delete model-facing registration for:

```text
grill_plan
grill_done
plan_ask
```

Do not add hidden compatibility stubs. This is an intentional breaking change while usage is low.

Delete the `plan_exit` tool registration from the model-facing surface. Approval logic should run from extension code (`turn_end`/post-review) via `approvePlan`/`runApprovalDialog`, not through an internal tool-shaped compatibility shim.

### Phase 3: Active tool calculation

Implement planning-like surface:

```text
read/grep/find/ls + ask_user_question? + plan_write
```

Implement execution surface:

```text
previous normal tools + todo_read + todo_write
```

Remove special cases such as:

```text
grilling no-open -> [grill_done]
drafting -> [plan_write]
awaiting_approval -> [plan_exit]
```

They should no longer exist in the default v2 path.

### Phase 4: Entry points

Update `/plan` and `startPlanFlow(...)`:

- initial phase: `planning`;
- active tools: planning surface;
- hidden kick: research/ask-if-critical/plan_write instruction;
- `/ta-dev` continues to call `startPlanFlow(...)` directly, inherits v2, and passes `approvalMode: "auto"` explicitly so trusted headless/programmatic flows do not stall.

### Phase 5: `plan_write`

Allow `plan_write` in:

```text
planning
revising
```

No transitional allowance for legacy phases. v2 is a clean break: old in-progress `research`/`grilling`/`drafting` sessions are not migrated.

`plan_write` behavior:

1. Validate structured steps (`content`, `activeForm`).
2. Validate `decisions`/`assumptions` arrays if present and trim empty values.
3. Validate mandatory validation coverage.
4. On validation failure, return a non-terminating tool error/result so the model can fix and retry in the same stable planning surface.
5. On success, persist draft and set review pending.
6. On success only, return `terminate: true` so review runs from a clean turn boundary.

### Phase 6: Review and approval

Keep the current automatic review machinery but retarget it to v2 phases.

Review failure:

```text
phase = revising
active tools = planning surface
queue next-turn instruction: fix issues and call plan_write
```

Review pass:

```text
hasUI && approvalMode === "ui"   -> open UI approval dialog
approvalMode === "auto"          -> approve automatically
!hasUI && approvalMode === "ui"  -> fail fast; do not wait forever
```

Approval outcomes:

```text
approve -> create plan-owned todos -> phase executing -> queue or trigger execution instruction
revise  -> phase revising -> queue plan_write instruction
cancel  -> phase aborted
```

Execution start UX is explicit: after approval, queue a next-turn `todo_write` instruction as today. Auto-triggering execution from the dialog can be a later UX improvement, but v2 should not depend on it.

### Phase 7: Prompt injection

Add planning/execution mode prompt injection through the Pi `context` event.

Rules:

- inject one self-contained brief hidden message for the current mode;
- filter/replace stale yuki plan-mode prompt messages to avoid duplicates;
- do not also use `before_agent_start` or `before_provider_request` for plan-mode policy;
- verify custom `PLAN_STATE` entries survive compaction, because state reconstruction is more important than prompt text.

Ensure prompt survives:

- compaction;
- resumed sessions;
- mid-loop provider requests;
- `/reload`.

### Phase 8: UI/status

Keep or improve existing plan-flow UI.

Optional later additions:

- plan-mode banner above editor;
- current plan title/status;
- approval/revision status;
- execution todo progress.

### Phase 9: Tests

Update tests for v2 behavior:

- `/plan` starts in `planning`.
- `planning` active tools include read-only + `plan_write` + optional `ask_user_question`.
- `grill_plan`, `grill_done`, and `plan_ask` are not registered/exposed.
- `plan_write` is allowed immediately after `/plan`.
- `plan_write` validation failures are non-terminating and retryable in the same stable planning surface.
- Successful `plan_write` triggers review and terminates.
- Review failure returns to `revising` with planning surface.
- Review pass opens approval/creates todos without model calling `plan_exit`.
- Approval enters `executing` and exposes todo tools.
- `/ta-dev` direct start still enters plan-flow with mandatory validation context and explicit `approvalMode: "auto"`.
- Mandatory validation enforcement still works.
- Add a runtime/integration test if feasible for the `plan_write terminate:true -> next turn fresh tool snapshot` path. If the harness cannot exercise real runtime snapshot timing, document mandatory manual verification for this path before release.
- No tests expect `grill_done`/`plan_ask`/`grill_plan` chains.

### Phase 10: Docs

Update incident docs to state:

- rev.7 stabilized the old flow;
- v2 removes the underlying fine-grained chain;
- grill is now a planning discipline, not a tool phase;
- approval is UI-owned;
- `plan_write` is the only required planning submission tool.

## Breaking changes

Intentional removals from model-facing plan-flow:

```text
grill_plan
grill_done
plan_ask
```

Intentional behavior change:

```text
/plan no longer starts a research->grilling->drafting chain.
/plan starts planning mode directly.
```

`plan_exit` is removed from the model-facing main flow.

Because adoption is still low, no compatibility stubs are planned.

## Non-goals for first v2 implementation

- No read-only bash in planning mode.
- No lock/unlock security mode.
- No user-risk custom tool selector.
- No plan prompt override file.
- No plan version history beyond current draft/final paths.
- No migration of old in-progress fine-grained sessions.

These can be revisited after v2 is stable.

## Acceptance criteria

A successful v2 implementation satisfies:

1. New `/plan` starts a stable planning mode with no phase-tool chain.
2. The model can complete planning by calling only `plan_write`.
3. There is no model-facing `grill_plan`, `grill_done`, or `plan_ask`.
4. The model never has to call `plan_exit` to reach execution.
5. Review and approval are extension/UI-owned.
6. Approved plans create plan-owned todos as before.
7. Execution uses `todo_read`/`todo_write` as before.
8. `/ta-dev` still starts plan-flow directly in one enter and passes `approvalMode:"auto"`.
9. Mandatory validation remains enforced.
10. `decisions` and `assumptions` are captured and rendered structurally.
11. `idle` and `completed` continue to release/restore plan state correctly.
12. Tests and typecheck pass, plus runtime snapshot verification or documented manual verification.

## Recommendation

Implement v2 now as a clean breaking change.

Do not keep legacy grill tools. Do not add hidden compatibility stubs. The clean design is easier for the model, easier for users, and avoids reintroducing the same frozen-tool-snapshot class of bugs under different names.

---

## Review findings / Resolved decisions (added 2026-06-19)

This section is a deep-review addendum. The design above has been updated to lock the
P0/P1 decisions. The direction (single stable planning tool surface, `plan_write` as the
only model tool, extension/UI-owned transitions) is sound and does structurally remove the
mid-turn tool-switch chain. The items below document the gaps that were found during review
and the implementation checklist derived from them. Severity tags: **P0** breaks/hangs the
flow or re-introduces the original bug class; **P1** significant omission or under-scoped
change; **P2** consistency/polish. File references are to `extensions/plan-flow/index.ts`
and `extensions/shared/plan-helpers.ts` at the time of review.

### P0 — would break the flow or regress the original bug

- **P0-1: No test exercises the mechanism the whole design rests on.** v2 correctness
  depends entirely on `terminate:true` + `setActiveTools` + `deliverAs:"nextTurn"`
  producing a fresh tool snapshot on the next turn. That exact assumption is what rev.4/7/8
  repeatedly half-broke (see the incident comments at index.ts:172-186, 305-312,
  1364-1380). Yet Phase 9 and the existing `test/plan-helpers.test.ts` are **pure-helper
  unit tests** that never touch real runtime snapshot timing. v2 can ship green and still
  regress. **Resolved:** add a runtime/integration (or e2e) test if feasible asserting that
  after `plan_write` terminates, the next turn's tool surface is the narrowed
  planning/execution set; otherwise document a mandatory manual verification. Without one
  of those, Phase 9 "passing" proves nothing about the bug class this redesign targets.

- **P0-2: Headless / `external` approval path is undefined and will hang `/ta-dev`.**
  Today headless approval relies on the `plan_exit` `!ctx.hasUI` branch auto-approving
  (index.ts:649-662) and `drivePostReview`'s headless branch queueing "call plan_exit"
  (index.ts:1099-1102). v2 deletes `plan_exit`, but Phase 6 only specifies the hasUI dialog
  path. With no UI, no model tool, and `external` left undefined, `awaiting_approval` has
  **no resolution path** and hangs forever. `external` has no described trigger (no
  `/plan-approve` command, no event). **Resolved:** drop `external` from v2, support only
  `approvalMode: "ui" | "auto"`, fail fast for `!hasUI && approvalMode:"ui"`, and make
  `/ta-dev` pass `approvalMode:"auto"` explicitly.

- **P0-3: "No migration" non-goal contradicts the Phase 5 transitional `plan_write`
  allowance.** Non-goals say "No migration of old in-progress fine-grained sessions", but
  Phase 5 keeps allowing `plan_write` in `research/grilling/drafting/awaiting_approval`
  while also asserting new sessions never enter those phases. If they are never entered and
  not migrated, that allowance is dead, self-contradictory code. **Resolved:** clean break;
  allow `plan_write` only in `planning`/`revising`.

- **P0-4: Modes list omits `completed` (and `idle`), but `completed` is required.**
  `closePlan` sets `phase = "completed"` when all plan-owned todos finish (index.ts:998),
  and `updatePlanUi` depends on it (index.ts:1206-1209). Dropping it loses the
  auto-close-on-all-todos-done behavior (incident #4 fix: a finished plan must release
  `active` so the next `/plan` is not blocked). **Resolved:** add `completed` to the Modes
  list and keep `idle` as the initial/fallback state.

### P1 — significant omissions / under-scoped changes

- **P1-1: `getConvergenceKick` is a second, parallel state machine that Phase 3/6 never
  mention.** plan-helpers.ts:228-257 still returns "call plan_exit to approve it" for
  `awaiting_approval` (line 246-248), special-cases grilling, and reads `hasOpenQuestions`.
  After v2 deletes those tools/phases it would kick a nonexistent tool. **Resolved:** rewrite
  `getConvergenceKick` in lockstep with `getAllowedToolsForState` — planning/revising are
  unconstrained (no no-progress kick), `awaiting_approval` does not kick, and the
  grilling/`plan_exit` branches are deleted.

- **P1-2: Removing `questions`/`askCount`/`maxAskCount` touches at least six readers.**
  Phase 1 says "remove" in one line, but these fields are read by `formatPlanStatus`
  (index.ts:1425), `nextActionHint` (1354-1355), `buildPhasePrompt` (1399-1403),
  `renderPlanMarkdown`'s `## Decisions` section (1149-1153), `buildKickoffContent`
  (1333-1335), and `normalizePlanState` (1449-1451). **Resolved:** enumerate this reader
  list in Phase 1 and the implementation checklist so none are missed.

- **P1-3: v2 loses the structured place to record decisions/assumptions.** The old flow
  carried decisions as resolved questions and rendered `## Decisions`. v2 removes
  `questions`, but the `plan_write` schema is only `title/background/steps/risks`
  (index.ts:112-117) — no `assumptions`/`decisions` field — while the prompt rules still
  require "state an assumption and record it in the plan" (doc rules). Result: assumptions
  collapse into freeform `background` and `## Decisions` is always empty. **Decision
  required:** add an `assumptions`/`decisions` field to `plan_write` (and render it), or
  drop the Decisions section and accept assumptions living in `background`.

- **P1-4: Planning-mode no-progress policy was undefined → risk of kicking the model while it
  waits for a user answer.** v2 lets the model ask via `ask_user_question` or, when
  unavailable, plain assistant text (which ends the turn awaiting the user). Any "still in
  planning, call plan_write" kick would fight a legitimate wait-for-answer — the original
  loop smell. **Resolved:** planning/revising are unconstrained while reading, asking, or
  waiting; do not convergence-kick them toward `plan_write`.

- **P1-5: `before_provider_request` is the wrong foundation for Phase 7.** The pinned
  runtime does expose it, but it mutates raw provider payloads. **Resolved:** use the Pi
  `context` event for self-contained hidden mode prompt injection before each LLM call, and
  do not also inject via `before_agent_start` or `before_provider_request`.

- **P1-6: `ask_user_question` availability / exact tool name needed confirmation.** After
  deleting `plan_ask`, structured asking depends on a generic UI tool. **Resolved:** in
  yuki-pi the tool is registered by `extensions/ask-user-question.ts` as `ask_user_question`.
  Other runtimes may degrade to plain-text questions. The five-question cap is prompt/review
  discipline only because `askCount` is intentionally removed.

### P2 — consistency / polish / scoping

- **P2-1: "Keep `plan_exit` as an internal helper" is muddled.** Approval logic already
  lives in `approvePlan`/`runApprovalDialog` (index.ts:948, 1033). Just say "delete the
  `plan_exit` tool registration; approval runs from `turn_end` via
  `approvePlan`/`runApprovalDialog`."

- **P2-2: The `PLAN_TOOLS` set is never named but must shrink to `{plan_write}`.** It is
  defined at index.ts:14 and used by the tool_call NEVER-block branch (313) and
  `reconstructPlanState`'s filter (892). Call it out so it is not missed.

- **P2-3: Execution start after approval is intentionally conservative in v2.** Approval
  currently uses `deliverAs:"nextTurn"` (index.ts:1087), so after approving, the user may
  need to send another message before execution begins. When the dialog resolves we are
  outside the agent loop and could `triggerTurn` to auto-start. **Resolved for v2:** keep
  the existing queued next-turn execution instruction; auto-triggering execution is a later
  UX improvement.

- **P2-4: Compaction impact on *state reconstruction* is not analyzed — and it matters more
  than prompt injection.** `reconstructPlanState` rebuilds from custom `PLAN_STATE` entries
  + `plan_write` tool results in `ctx.sessionManager.getBranch()` (index.ts:881-897). The
  doc worries about compaction-safe prompts but never confirms the custom state entries
  survive compaction; if state is lost the whole flow collapses. **Resolved:** verify or
  guarantee custom state-entry survival across compaction as part of the implementation
  checklist.

- **P2-5: Full/brief prompt split is in tension with compaction safety.** "Full first turn,
  brief afterwards" needs a way to detect the first turn, and if the full prompt is
  compacted away a brief that references it dangles. Safer: always inject a self-contained
  brief. Resolve this in Phase 7.

- **P2-6: v2 leans harder on the LLM review, which is probabilistic.** Replacing the
  deterministic `grill_done` gate with prompt discipline + an LLM review (JSON scraped by
  regex, failure treated as blocking — index.ts:850-868) makes review reliability more
  load-bearing. Acceptable at low usage, but acknowledge the trade.

- **P2-7: Scope is overstated; much of the target machinery already exists.** `turn_end` →
  auto review → `drivePostReview` opens the approval dialog → seeds todos → queues the next
  turn already works today (index.ts:395-416, 1070-1097). The real work is collapsing
  research/grilling/drafting into planning, deleting four tools, and cleaning the two state
  machines. Framing it as reuse lowers risk.

- **P2-8: List the rev.4/7/8 scaffolding to delete (net code removal).** With a stable
  planning surface, `buildWrongPhaseResult`, `shouldAutoAdvanceResolvedGrilling`,
  `consecutiveBlockedToolCalls` escalation, and most of `getConvergenceKick` become
  unnecessary. A good v2 nets *less* code; enumerate the deletions.

- **P2-9: `plan_write` validation-failure path needed simplification.**
  Today missing mandatory validation throws (index.ts:927-930). In v2 the planning surface
  is stable, so `plan_write` is always available. **Resolved:** validation failures should
  be non-terminating and retryable in the same turn; only a successful `plan_write` returns
  `terminate:true`.

### Locked decisions before coding

1. **Runtime snapshot verification:** add a runtime/integration test for the `plan_write terminate:true -> next turn fresh tool snapshot` path if feasible. If the current harness cannot exercise real runtime snapshot timing, document mandatory manual verification before release.
2. **Approval modes:** v2 supports only `approvalMode: "ui" | "auto"`; `external` is dropped. `/ta-dev` and trusted E2E/programmatic flows pass `approvalMode:"auto"` explicitly.
3. **Migration:** clean break. Do not add transitional `plan_write` allowances for `research`/`grilling`/`drafting`/`awaiting_approval`.
4. **Modes:** include `idle` and `completed` in addition to `planning/reviewing/revising/awaiting_approval/executing/aborted`.
5. **Structured decisions:** add `decisions?: string[]` and `assumptions?: string[]` to `plan_write`, draft state, and markdown rendering.
6. **Prompt injection:** use the Pi `context` event with a self-contained hidden mode prompt; do not use `before_provider_request` or double-inject with `before_agent_start`.
7. **Planning asks:** use existing generic `ask_user_question` when available; otherwise plain assistant questions are acceptable. The five-question cap is prompt/review discipline only.
8. **Planning convergence:** planning/revising do not get no-progress kicks toward `plan_write`; waiting for a user answer is a valid planning state.

### Change/delete checklist for implementation

- Shrink `PLAN_TOOLS` to `{ plan_write }`.
- Delete model-facing registration for `grill_plan`, `grill_done`, `plan_ask`, and `plan_exit`.
- Delete or retire rev.4/7/8 scaffolding made unnecessary by the stable planning surface: `buildWrongPhaseResult`, `shouldAutoAdvanceResolvedGrilling`, `consecutiveBlockedToolCalls` escalation, and most `getConvergenceKick` branches.
- Rewrite `getAllowedToolsForState` around `planning/revising` and `executing`; `reviewing`/`awaiting_approval` are extension-owned.
- Rewrite `getConvergenceKick`: no planning/revising kick, no `plan_exit` branch, only the initial executing todo nudge remains if needed.
- Update old question/ask-count readers: `formatPlanStatus`, `nextActionHint`, `buildPhasePrompt`, `renderPlanMarkdown`, `buildKickoffContent`, and `normalizePlanState`.
- Render `decisions` and `assumptions`; remove the old question-derived Decisions rendering.
- Confirm compaction preserves custom `PLAN_STATE` entries or add a guarantee/test around reconstruction after compaction.
