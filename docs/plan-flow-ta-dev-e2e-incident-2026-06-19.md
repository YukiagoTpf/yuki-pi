# Plan-flow / ta-dev E2E incident notes

Date: 2026-06-19  
Source project: `/Users/bytedance/Project/Skywalker/sw_project`  
Target for follow-up optimisation: yuki-pi plan-flow

## Summary

本轮目标是验证 `/ta-dev` 入口能创建带 `mandatory unity-csharp-compile` validation 的 yuki plan，并在 execution 阶段用 fresh TA Harness evidence 完成 plan-owned todo。

最终 E2E 验证通过，但过程中多次暴露 plan-flow/extension UX 问题：

1. Drafting 阶段 agent 反复调用被禁止的 `plan_ask`，形成“死循环”观感。
2. Agent 误判 `plan_write` / `plan_exit` 不可用；实际工具可用，后来都调用成功。
3. `/ta-dev` 第一版用 `pi.sendUserMessage("/plan ...")`，但该 API 跳过 slash-command handling，导致 `/plan` 被当普通文本发给模型。
4. 旧 plan todo 已完成，但 plan-flow 状态仍是 active/executing，导致新 `/plan` 被拒绝，需要 `/plan-abort`。
5. TA Harness evidence freshness 曾只看 fingerprint，真实 C# pass fingerprint 多次运行相同，导致 stale evidence 漏放行；已修复为 timestamp + fingerprint，并做过真实 runtime 复测。

## Final successful path

最终有效流程如下：

1. `/ta-dev --profile csharp --file client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs ...`
2. `/ta-dev` 预填完整 `/plan ...` 到 TUI editor。
3. 用户按 Enter，真实触发 yuki `/plan`。
4. Plan-flow research 阶段读取：
   - `client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs`
   - `.pi/extensions/ta-dev/index.ts`
   - `.pi/extensions/harness-execution-policy/index.ts`
   - `.pi/AGENT.md` 相关 Harness 规则
5. `grill_plan` 无开放问题。
6. `grill_done` 进入 drafting。
7. 应调用 `plan_write`；期间 agent 又错误调用了多次 `plan_ask`，被 plan-flow 拦截。
8. 用户提示继续后，agent 调用 `plan_write` 成功。
9. Automatic review passed。
10. `plan_exit` 后进入 executing。
11. `todo_write` 标记 in_progress。
12. 只修改 C# probe 注释：
    - file: `client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs`
13. Unity C# compile guard 产出 fresh pass。
14. `sensor_evidence_read` 获取 fresh evidence：
    - timestamp: `2026-06-18T16:13:18.617Z`
    - fingerprint: `011f6120f417f22e`
15. `todo_write` completed 成功。
16. 为避免留下 probe diff，重新打开 todo 为 in_progress，恢复注释 baseline。
17. 再次等待 fresh C# compile pass。
18. 用最终 fresh evidence completed：
    - timestamp: `2026-06-18T16:14:52.371Z`
    - fingerprint: `011f6120f417f22e`
19. 验证 probe 文件 diff 为空。

最终 plan todo list：

```text
plan-20260619-000656-b8a49231
[x] verify-ta-dev-csharp-plan-validation
```

最终 evidence：

```text
TA Harness evidence: unity-csharp-compile passed; at 2026-06-18T16:14:52.371Z; fingerprint=011f6120f417f22e; file=client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs; summary=unity-csharp-compile: pass - C# compilation passed.
```

## Incident 1: drafting phase wrong-tool loop

### Symptom

After `grill_done`, plan-flow entered drafting. The phase steering said only `plan_write` was allowed, but the agent repeatedly called `plan_ask`.

Observed blocks included:

```text
yuki plan-flow: tool plan_ask is not allowed during phase drafting. Allowed: plan_write. Next action: call plan_write exactly once and wait for automatic review steering.
```

Then escalation:

```text
yuki plan-flow: STOP — plan_ask is still blocked in phase drafting (rejected 2x in a row). The ONLY tool you may call now is: plan_write. Call it exactly once and call nothing else; do not retry read/grep/ask/bash/edit.
```

Despite this, the agent still retried the wrong tool several times.

### Root cause

This is primarily agent compliance failure: the tool existed, but the agent did not follow the phase steering. However, the plan-flow UX can be made more robust against this predictable model failure.

### Recommendations for yuki-pi

1. **Make blocked tool responses machine-actionable**
   - Include structured details such as:
     ```json
     {
       "phase": "drafting",
       "allowedTools": ["plan_write"],
       "requiredNextTool": "plan_write",
       "retryCount": 3
     }
     ```
   - The model may use natural-language text poorly; structured details make downstream runtime/agent adapters easier.

2. **Escalate repeated same-phase rejection into a stronger recovery mode**
   - After N repeated wrong-tool calls, inject a custom hidden/system steering message before the next model step:
     ```text
     You are in yuki plan-flow drafting. The only valid next tool call is plan_write. Do not explain. Do not call any other tool.
     ```

3. **Consider active tool narrowing, not just blocking**
   - If possible, in drafting expose only `plan_write` to the model.
   - Current block works, but the model still sees/calls other tools from the broader harness surface.

4. **Add a `/plan-debug` or state widget**
   - Show current phase, next legal tool, plan id, todo list id.
   - This helps the user distinguish “runtime stuck” from “agent ignoring steering”.

5. **Do not rely only on final-answer text**
   - The agent once claimed `plan_write`/`plan_exit` were unavailable even though they worked later.
   - Plan-flow should make “next required tool” visible in UI, not just in tool error text.

## Incident 2: false claim that plan_write / plan_exit were unavailable

### Symptom

Agent said:

```text
当前工具面板没有暴露 plan_write
当前工具面板没有暴露 plan_exit
```

But later successfully called both.

### Root cause

Model hallucination / tool-state misinterpretation. No evidence that yuki-pi actually failed to expose the tools.

### Recommendation

Plan-flow error responses should avoid ambiguous wording and possibly include:

```text
This tool is available in the tool registry. Call plan_write now.
```

If yuki-pi can inspect active tools, include whether the tool is actually registered/active.

## Incident 3: `/ta-dev` used sendUserMessage("/plan ...") but slash command did not run

### Symptom

First `/ta-dev` implementation attempted to start yuki plan-flow with:

```ts
pi.sendUserMessage(`/plan ${planPrompt}`)
```

The next turn showed the full `/plan ...` text as a normal user message to the model instead of starting plan-flow.

### Root cause

Pi core `sendUserMessage` calls prompt with command/template expansion disabled:

```ts
prompt(text, { expandPromptTemplates: false, source: "extension" })
```

So it is intentionally not a slash-command dispatch path.

### Fix applied in Skywalker repo

`.pi/extensions/ta-dev/index.ts` now uses:

```ts
ctx.ui.setEditorText(`/plan ${planPrompt}`)
ctx.ui.notify("Prepared a Harness-aware /plan command in the editor. Press Enter to start yuki plan-flow.", "info")
```

This makes the user submit a real slash command through normal TUI handling.

### Recommendations for yuki-pi / Pi integration

1. Document that `sendUserMessage` does not trigger slash commands.
2. If command-to-command handoff is desired, add a first-class API, e.g.:
   ```ts
   ctx.runSlashCommand("plan", planPrompt)
   ```
   or
   ```ts
   pi.sendUserMessage(`/plan ...`, { expandPromptTemplates: true })
   ```
3. For now, editor prefill is safer but requires user Enter.

## Incident 4: active completed plan blocks new /plan

### Symptom

After the earlier plan todo was completed, starting a new `/plan` returned:

```text
Warning: A yuki plan is already active (executing). Use /plan-abort first.
```

### Root cause

Plan-flow active state remains `executing` even if all plan-owned todos are completed. There is no automatic “plan complete / close” transition.

### Recommendations

1. Add a completion affordance when all plan-owned todos are completed:
   - `/plan-complete`
   - or automatic transition to `completed` / `idle` after confirming all todos are completed.
2. When `/plan` is invoked while an executing plan has all todos completed, suggest:
   ```text
   Existing plan has all todos completed. Use /plan-complete to close it or /plan-abort to discard active state.
   ```
   Instead of only `/plan-abort`.
3. Consider making `plan_exit` / execution flow create a clear terminal state distinct from aborted.

## Incident 5: evidence freshness bug exposed by real plan-flow

### Symptom

Reusing old C# compile evidence after a new edit was initially accepted.

Old evidence:

```text
at 2026-06-18T14:26:10.239Z; fingerprint=011f6120f417f22e
```

New pass:

```text
at 2026-06-18T14:28:17.814Z; fingerprint=011f6120f417f22e
```

Fingerprint stayed the same.

### Root cause

`unity-csharp-compile` pass fingerprint is content-independent / status-like. It is not a unique run id and does not prove freshness.

### Fix already applied

`harness-execution-policy` now requires evidence to include both:

- latest passed fingerprint
- latest passed timestamp

A later runtime retest after `/reload` confirmed stale timestamp evidence is blocked:

```text
evidence for unity-csharp-compile does not include the latest passed timestamp (2026-06-18T15:37:58.050Z)
```

Current policy also has content-hash support when `SensorRunEntry.contentHashes` exists.

## Incident 6: turn-ending too early after edit

### Symptom

After editing a file that backs a plan todo, the agent sometimes ended the turn before reading fresh sensor evidence and completing the todo.

### Current mitigation

The C# compile guard now emits a steering message after pass:

```text
A yuki plan is executing. Do not end the turn yet if this change backs a plan todo: call sensor_evidence_read and mark the todo completed with the fresh passed evidence (fingerprint + timestamp).
```

This worked in the final `/ta-dev` E2E: after compile pass, the agent called `sensor_evidence_read` and `todo_write` without ending the turn.

### Recommendation

Plan-flow could reinforce this by adding executing-phase prompt guidance:

```text
If a mandatory sensor pass message appears and it backs the current in_progress todo, immediately call sensor_evidence_read and todo_write before final response.
```

## Environment warning: duplicate pi-web-access

During `/reload`, Pi reported duplicate `pi-web-access` packages:

```text
librarian collision
Tool web_search/code_search/fetch_content/get_search_content conflicts
shortcut ctrl+shift+s / ctrl+shift+w conflicts
```

This is unrelated to `/ta-dev` and plan-flow logic, but it makes reload output noisy. Two copies are loaded:

```text
/Users/bytedance/project/yuki-pi/node_modules/pi-web-access
/Users/bytedance/.pi/agent/npm/node_modules/pi-web-access
```

Recommendation: choose one source and disable/remove the other from Pi settings.

## Files / commits in Skywalker repo

Relevant commits made in `/Users/bytedance/Project/Skywalker/sw_project`:

```text
31ef6292b4 Document harness evidence policy validation
3980046751 Add ta-dev plan entry command
4f039f2659 Fix ta-dev plan command handoff
```

Relevant generated plan docs in Skywalker:

```text
docs/plan-ta-harness-c-compile-evidence-policy-20260618-215551-cb15df43.md
docs/plan-ta-dev-c-mandatory-validation-plan-flow-20260619-000656-b8a49231.md
```

Incident doc in Skywalker:

```text
docs/plan-flow-incident-analysis-2026-06-18.md
```

## Re-test after plan-flow optimisation

Date: 2026-06-19  
Plan todo list: `plan-20260619-112148-dd9ce35c`

Optimisations observed in source/runtime:

- `/ta-dev` writes a compact one-shot planning context under `.pi/plan-context/<token>.json` and pre-fills `/plan --context <token> ...`, avoiding huge visible `/plan` prompts.
- `/plan` can load structured planning context via `--context`.
- plan-flow has a `turn_end` auto-close path for executing plans whose plan-owned todos are all completed.
- blocked-tool wording changed from high-pressure `STOP ... rejected Nx` to a calmer message: `yuki plan-flow: in phase drafting, the next tool to call is: plan_write.`

Re-test result:

1. Research/grill path worked and recognised the optimised `/ta-dev` + `/plan --context` handoff.
2. The wrong-tool loop still reproduced in drafting: the agent repeatedly called `plan_ask` even though the blocker calmly said the next tool was `plan_write`.
3. User said “继续”; agent then successfully called `plan_write`.
4. Approval entered executing. The agent initially miscalled `plan_write` in executing, but recovered once the todo list id was known.
5. Execution succeeded: only C# probe comment was modified; C# compile passed; `sensor_evidence_read` was called; plan-owned todo completed with fresh evidence:

```text
TA Harness evidence: unity-csharp-compile passed; at 2026-06-19T03:27:02.975Z; fingerprint=011f6120f417f22e; file=client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs; summary=unity-csharp-compile: pass - C# compilation passed.
```

6. Auto-close worked immediately after completion: attempting to reopen the completed plan todo failed with:

```text
todo_write: plan-owned todo lists may only be updated while their owning plan is executing.
```

This confirms the completed executing plan was no longer considered executing for plan-owned todo writes.

7. Probe comment was restored to baseline outside the plan-owned todo because the plan had already auto-closed. A fresh C# compile pass for the restored file was observed:

```text
unity-csharp-compile pass at 2026-06-19T03:28:03.125Z; fingerprint=011f6120f417f22e
```

Updated conclusions:

- The `/ta-dev` structured-context handoff is better and avoids visible prompt bloat.
- Auto-close solves the old “completed plan blocks new /plan until /plan-abort” problem, but it can close before cleanup/restoration steps if the agent marks the only todo completed too early.
- Calmer blocked-tool text improves UX but does not stop model wrong-tool loops. Root fix likely needs phase-specific active tool narrowing, automatic recovery, or hiding disallowed tools from the model.
- Executing phase has the same class of issue: if only todo tools are valid, exposing/calling plan tools still causes avoidable blocked calls.

Backlog adjustment from re-test:

- Keep P0 for stricter phase tool narrowing/recovery.
- Add a cleanup convention: for smoke tests that restore probe files, either include restoration as a separate plan step or delay completed until final restored-file evidence is available. Otherwise auto-close prevents updating final evidence after cleanup.

## rev.4 fixes (2026-06-19)

Addressed the three issues reported after the re-test:

1. **Double-Enter `/ta-dev` → `/plan` handoff (incident #1).** Root cause: `pi.sendUserMessage("/plan ...")` deliberately calls `prompt(text, { expandPromptTemplates: false })`, which skips slash-command handling, so programmatic callers cannot trigger `/plan` that way. The previous workaround prefilled the editor via `setEditorText`, forcing a second Enter. Fix: plan-flow now exports a programmatic entry point `startPlanFlow(pi, ctx, { request, planningContext })` (and the `PlanningContext` type) so callers like `/ta-dev` can start a plan directly — no editor prefill, no second Enter, and no `--context` handoff file needed (the context can be passed inline). The `/plan` command handler was refactored to delegate to the same function.
2. **Drafting keeps calling `plan_ask` (incident #2).** Root cause: B-class (tool-execute) transitions like `grill_done → drafting` do NOT start a clean new turn, and `setActiveTools` does not narrow the current streaming turn's tool set, so `plan_ask` stays visible mid-turn and the model keeps retrying it. Fix: a new `turn_end` convergence guard (`getConvergenceKick` in `extensions/shared/plan-helpers.ts`, wired in `extensions/plan-flow/index.ts`) detects no-progress turns in drafting/revising/awaiting_approval/executing and re-kicks a clean, narrowed turn (A-class) where the disallowed tool is no longer presented to the model at all. The blocked-tool reason also escalates after 2 consecutive blocks to a short, action-only message that names only the allowed tool.
3. **Flow stops mid-way and waits for "继续" (incident #3).** Same convergence guard: instead of stalling until the user types "继续", the flow auto-continues by re-kicking the narrowed turn. A per-plan counter caps auto-kicks at `MAX_CONVERGENCE_KICKS = 3`; after that it surfaces a visible notify and leaves the plan for the user to `/plan-debug`, `/plan-abort`, or continue manually, avoiding an infinite kick loop.

Regression coverage added in `test/plan-helpers.test.ts` for the pure `getConvergenceKick` contract (per-phase kick / no-kick decisions).

Remaining (not addressed in rev.4):

- True mid-turn active-tool narrowing (hiding disallowed tools from the current streaming turn) requires a pi runtime change; the convergence guard is the in-scope equivalent because it re-kicks a clean turn where narrowing already applies.
- Executing-phase cleanup convention for smoke tests that restore probe files (see backlog adjustment above).
- `/ta-dev` itself (in the Skywalker project) must be updated to call `startPlanFlow` instead of `setEditorText("/plan ...")` to actually eliminate the double-Enter; yuki-pi now provides the API.

## Proposed yuki-pi optimisation backlog

### P0

1. ~~Add explicit completed/close path for executing plans whose todos are all completed.~~ Done (rev.3 P1-1).
2. ~~Strengthen repeated blocked-tool recovery in drafting/revising/awaiting_approval.~~ Done (rev.4 convergence guard + blocked-reason escalation).
3. Make blocked-tool response structured and visible in UI.

### P1

1. ~~Add first-class command handoff API or document command handoff limitations clearly.~~ Done (rev.4 `startPlanFlow` export).
2. Improve executing-phase guidance around sensor pass messages + `sensor_evidence_read` + `todo_write`.
3. ~~Add `/plan-status` or `/plan-debug` showing phase, allowed tools, next action, plan id, todo list id.~~ Done (rev.3 `/plan-debug`).

### P2

1. Consider active tool narrowing so disallowed tools are not presented to the model in constrained phases.
2. Add regression tests for repeated wrong-tool loops:
   - drafting + repeated `plan_ask`
   - awaiting_approval + repeated non-`plan_exit`
   - executing + attempted plan tools
3. Add tests for active completed plan behavior and transition to closed/completed state.
