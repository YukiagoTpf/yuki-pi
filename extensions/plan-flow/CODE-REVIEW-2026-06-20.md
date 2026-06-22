# plan-flow code review — 2026-06-20

Scope: `extensions/plan-flow/index.ts` (1408 lines), `extensions/shared/plan-helpers.ts`,
`extensions/shared/constants.ts`, `test/plan-helpers.test.ts`. Reviewed for correctness,
robustness, concurrency, and elegance after the convergence-loop fixes landed.

Health snapshot at review time: `tsc --noEmit` clean, `node --test` 50/50 pass, working tree
committed. The findings below are about *latent* risk and maintainability, not a broken build.

Every item cites `file:line` against the state of `index.ts` reviewed here. Severity:
**P0** = can corrupt state / re-introduce the bug class the design exists to prevent;
**P1** = real risk under realistic conditions; **P2** = elegance / hygiene / scale.

---

## What is genuinely good (keep these)

These are load-bearing and correct — don't regress them while fixing the rest:

- **Never hard-block plan tools; terminate-and-re-narrow instead.** `plan_write` is allowed
  through `tool_call` unconditionally (321-328) and exits via a terminating result
  (`buildWrongPhaseResult`, 1247-1257; success `terminate:true`, 493-497). This is the right
  cure for the frozen mid-turn tool snapshot — a blocked/thrown call would loop on the stale
  surface.
- **Queue-next-turn instead of steering the running loop** (`queueNextTurnInstruction`,
  `deliverAs:"nextTurn"`, 1115-1120) with the rationale documented inline.
- **Approval deferred past `finishRun`** via `setTimeout(…,0)` after `agent_end` (419-441) so
  the plan markdown renders into history before the selector opens — the comment explaining
  the `isStreaming` race is excellent.
- **Compaction re-persistence** (`session_before_compact` / `session_compact`, 237-249) keeps
  an active plan alive across summarization.
- **Convergence guard with a kick cap** (`MAX_CONVERGENCE_KICKS`, 379-388) that escalates to a
  visible notify instead of looping forever.
- **Path-traversal-safe context token** (regex allowlist, 1346-1348) and one-shot consume.

The core architecture (stable per-phase tool surface, extension-owned review/approval) is
sound. The issues below are concentrated in *persistence durability*, *duplicated approval
paths*, and *test coverage of the non-trivial logic*.

---

## P0 — address before relying on this in anger

### P0-1 · `plan_write` persists its transition only inside the tool result
`execute` (471-498) computes the planning→reviewing state, renders the draft, narrows tools,
and returns `details:{ state: next }` — but **never calls `persistPlanState`**. Confirmed: no
`persistPlanState` in the tool body; the nearest calls are compaction (246) and the review
handler (403).

`reconstructPlanState` (618-633) recovers this transition by reading `message.details.state`
off the `plan_write` toolResult. That makes the tool result the *sole* durable record of
`phase:"reviewing"` + `reviewPending:true` — the two flags that trigger the automatic review
(397).

Why this is P0: tool-result `details` are exactly the kind of payload a runtime may
truncate/drop during context management (they are large and "non-essential"). If that happens
outside a compaction boundary, the plan silently regresses to the last *custom-entry* snapshot
— which is the `plan_start` planning snapshot — and the model is told to plan again. That is a
re-plan loop with no counter to stop it. Compaction itself is covered (before_compact
re-persists), but non-compaction stripping is not.

**Fix:** call `persistPlanState(pi, next, "tool_result")` inside `plan_write.execute` before
returning. The `"tool_result"` reason already exists in `PlanStateRecord` (99) but is never
emitted — this is the missing producer. Then the toolResult `details` become a redundant
optimization rather than the only source of truth.

### P0-2 · `reviewInFlight` hard-blocks `plan_write`, re-opening the frozen-snapshot loop
The `tool_call` handler blocks `plan_write` with `block:true` while a review is in flight
(315-320) — directly above the comment (321-324) stating that blocking `plan_write` is wrong
*because* a blocked call has no `terminate`, so the model retries against the frozen snapshot.
The two branches contradict each other; the block wins because it runs first.

Today this is masked: during `reviewing` the allowed set is empty (helpers 132-133), so
`plan_write` isn't on the offered surface and the model usually won't call it. But the guard is
a latent re-introduction of the exact failure mode the redesign targets, sitting in the one
handler that *cannot* return a terminating result (tool_call can only block/allow).

**Fix:** drop the `reviewInFlight` block. The real protections are already in place — the
empty `reviewing` tool surface, and (with P0-1 fixed) idempotent persistence. If a guard is
still wanted, make it a no-op pass-through that lets `plan_write.execute` return a terminating
wrong-phase result, rather than `block:true`.

### P0-3 · Four divergent "approve → kick → persist" paths, one shared side-effectful core
`approvePlan` (721-754) is not idempotent: it writes the final plan file, unlinks the draft,
**appends a todo-seed entry**, and returns `executing`. It is reachable from four places that
each re-assemble the surrounding persist/apply/notify/kick steps differently:

- `drivePostReview` auto branch (883-894) — persist, apply, UI, mark-kick, persist, apply, UI, notify, kick
- `driveUiApproval` approved branch (844-851) — mark-kick, persist, apply, UI, notify, kick
- `runApprovalDialog` approved branch (828-832) — approve, persist, apply, UI (then its caller does the rest)
- `input` handler approve branch (297-302) — approve, persist, mark-kick, persist

Only `agent_end`/`driveUiApproval` is mutexed (`approvalInFlight`, 417-418). The `input`-path
approve is **not** behind that mutex. A double-run yields a duplicate todo seed and a `-2.md`
final file (the dedup loop in `writeFinalPlan`, 919-923, "succeeds" by making a second file).
The current single-caller-per-path arrangement happens to avoid this, but the duplication is
the root hazard: any future edit that makes two paths co-reachable double-approves.

**Fix:** extract one `finalizeApproval(pi, ctx, state, {auto})` that does approve + mark-kick +
persist + apply + UI + notify + continueExecutionTurn exactly once, guarded by one flag, and
call it from every site. This also kills the awkward split where `runApprovalDialog` does half
the approval and `driveUiApproval` does the other half.

---

## P1 — real risk under realistic conditions

### P1-1 · The non-trivial logic is the untested logic
All 50 tests target pure helpers in `plan-helpers.ts` (slugify, arg parsing,
`getAllowedToolsForState`, `getConvergenceKick`, `checkMandatoryValidation`). The intricate,
bug-prone code has **zero** coverage:

- `parseReviewFeedback` (590-608) — JSON extraction, greedy-regex fallback, non-JSON →
  single-blocking-issue. Pure, trivially testable, untested.
- `applyPlanWrite` (640-685) — step normalization, mandatory-validation gate, phase flip. Pure
  except for `touch`'s timestamp; testable, untested.
- `normalizePlanState` (1312-1333) — legacy `research/grilling/drafting`→`planning` and
  `questions`→`decisions` migration. Pure, untested.
- `renderPlanMarkdown` (930-990) and `reconstructPlanState` precedence (618-633) — untested.

These live in `index.ts`, which imports the Pi runtime, so they can't be imported by the test
runner. The repo *already* established the fix-pattern (extract pure logic to
`shared/plan-helpers.ts`). These functions were simply left behind.

**Fix:** move `parseReviewFeedback`, `applyPlanWrite` (taking `touch`/clock injected),
`normalizePlanState`, and `renderPlanMarkdown` into a pure module and add unit tests —
especially the review-parsing fallback and the legacy-migration branch.

### P1-2 · `input`-handler approve branch: dead-or-dangerous, exact-string-coupled
The branch at 296-302 fires when an extension follow-up's text *exactly equals*
`buildExecutionKickContent(state)` while `phase==="awaiting_approval"`
(`isExecutionKickForPlan`, 1068-1070, single caller). But every producer of that kick
(`continueExecutionTurn`, 1073-1082) only runs *after* `approvePlan` already moved the phase to
`executing`, so the branch's own precondition (`awaiting_approval`) is never true when the kick
arrives. It appears unreachable today.

If unreachable: it's a silent approval-by-text-match with full side effects (final file, todo
seed) and **no UI confirmation**, waiting to become reachable after any refactor — and it's
outside the `approvalInFlight` mutex (feeds P0-3). If it *is* needed for some race, the
exact-string match is brittle: any drift in the kick wording disables it with no error.

**Fix:** delete it, or replace the string match with a structured marker on the message
(`details.kind === "plan-exec-kick"`) and bring it under the shared mutex.

### P1-3 · Self-review with no repo context, brittle JSON contract, forced revision spins
`runAutomaticReview` (517-575) calls `complete()` with **only the plan markdown** — no
codebase, no tools — using `ctx.model`, i.e. the same model that just wrote the plan grading
its own work. It can catch "vague validation / unresolved decision" but not correctness, while
paying full latency + tokens on *every* plan with no opt-out.

`parseReviewFeedback` uses a greedy `\{[\s\S]*\}` (591). A chatty or markdown-wrapped reply
that isn't clean JSON is treated as one blocking issue containing the whole reply (606). The
revision loop (drivePostReview 868-880) then re-asks the *same* model, which re-emits the same
non-JSON, three times, before `publishRevisionLoopStop` — turning a fine plan into three wasted
turns plus a scary stop message.

**Fix:** (a) add a `reviewMode: "off" | "model"` knob (and default `/ta-dev` thoughtfully —
see P1-4); (b) make parse failure *non-blocking* (skip with reason) rather than a synthetic
blocking issue, or retry the parse with a stricter extraction before treating it as blocking;
(c) consider giving the reviewer read-only repo access if it's to stay.

### P1-4 · Auto mode can execute a plan that was never reviewed and never seen
Any model/auth/timeout error in review → `reviewSkipped:true` → `awaiting_approval` (520-525,
566-574). In `approvalMode:"auto"` (`/ta-dev`), `drivePostReview` then auto-approves and starts
execution (883-894), fully headless. A transient review failure therefore removes the *only*
safety gate and runs an unreviewed plan silently.

**Fix:** in auto mode, treat a *skipped* review as "hold / notify" rather than "approve", or
require a successful review before auto-approval (fall back to a logged pause).

### P1-5 · `ctx.signal` abort-listener leak per review
`ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true })` (529) is
added on every review and only auto-removed if it *fires*. On the normal path (no abort) the
listener stays attached to the session-lifetime signal. Many plans in one session → many
dangling listeners → `MaxListenersExceededWarning` after ~10.

**Fix:** keep the handler reference and `removeEventListener` in the `finally` (564), or use a
local `AbortController` linked once.

---

## P2 — elegance, hygiene, scale

- **Dead state/data (remove or wire up):**
  - `currentActiveTools` (71) is written at 1185/1201/1329/1337 and **never read** — tool
    application always recomputes from `phase` + `previousActiveTools` (992-997). It bloats
    every persisted snapshot and can silently drift.
  - `reviewFeedback.missingValidation` (39) is parsed (602) and never used.
  - The review's parsed `risks` (601) is never surfaced (the markdown `risks` at 982-983 is the
    *plan's* risks, not the review's).
- **Three `turn_end` handlers coupled by registration order** (343 / 391 / 447) — the comment
  at 340-342 admits convergence must be registered *before* the review driver. Each re-runs a
  full-branch `reconstructPlanState`; the executing turn adds two `reconstructTodoStates`. Per
  executing turn_end that's `reconstructPlanState`×3 + `reconstructTodoStates`×2, each
  O(branch). On long sessions this is repeated linear scans. Consider one ordered handler with a
  single reconstruction memoized per event.
- **Executing-widget flicker:** `updateExecutingWidget` (787-797) enriches the widget with the
  in-progress todo at turn_end, but `updatePlanUi` (1008-1028) runs in `input` /
  `before_agent_start` / `session_tree` and overwrites it with the minimal two-liner.
- **Naming / shape:** the imported helper is aliased `getAllowedToolsForPhase` while a local
  wrapper is `getAllowedToolsForState` (10, 992) — two names, one concept. `runApprovalDialog`
  is a single-caller helper (843) that does *half* the approval; merge with `driveUiApproval`.
  Two different "begin execution" strings exist (`buildExecutionKickContent` 1064 vs the
  `executing` branch of `getConvergenceKick` in helpers 205) for the same intent.
- **No bound on the `plan_write` mandatory-validation self-correction loop.** The thrown-error
  path returns a *non-terminating* result (481-486, intentional so the model fixes and retries
  same-turn), but unlike the review loop there's no attempt cap — a stubborn model can re-submit
  the same uncovered plan indefinitely.
- **Smaller items:** TOCTOU between `exists` and `writeFile` in `writeFinalPlan` (919-926, low
  risk for a local CLI); a handoff file that fails `JSON.parse` is **not** unlinked (1357-1361)
  so a bad token sticks; `reviewSkippedReason: String(error)` (572) can splash a raw error into
  the UI and the plan markdown; the auto-approve path double-persists (885 then 889) adding an
  extra branch entry each approval.

---

## Suggested order of work

1. **P0-1** persist `plan_write` (smallest change, removes the worst regression class).
2. **P0-3** extract one `finalizeApproval`, then **P1-2** delete/neuter the `input` approve
   branch on top of it.
3. **P0-2** drop the `reviewInFlight` block.
4. **P1-1** extract `parseReviewFeedback` / `applyPlanWrite` / `normalizePlanState` /
   `renderPlanMarkdown` to a pure module + tests (this is where most regressions will be caught
   going forward).
5. **P1-4 / P1-3** auto-mode review-skip policy and review parse/opt-out.
6. **P1-5** + the **P2** dead-field cleanup as a single hygiene pass.

Nothing here blocks the current build; P0-1 and P0-3 are the two I'd not ship another change on
top of without addressing.
