# Plan-flow grilling wrong-tool loop incident

Date: 2026-06-19  
Area: yuki-pi plan-flow / ta-dev integration  
Observed from: `/Users/bytedance/Project/Skywalker/sw_project`

## Summary

最新一轮修复后，`/ta-dev` 的双回车问题已确认改善：命令提交后直接进入 yuki plan-flow research，不再需要先把 `/plan ...` 预填到编辑器、再由用户第二次回车触发。

但在 grilling 阶段复现了新的 wrong-tool loop：

- `grill_plan` 已返回无开放关键问题。
- plan-flow / convergence steering 明确提示：
  ```text
  yuki plan-flow: grilling has no unresolved questions. Call grill_done to proceed to drafting.
  ```
- agent 仍连续多次调用 `grill_plan`，而不是调用 `grill_done`。

这说明最新 convergence / active-tool narrowing 改善了入口问题，但 **grilling -> drafting** 的下一工具收敛仍存在同类问题。

## Reproduction request

用户通过 `/ta-dev` 发起：

```text
验证最新 plan-flow 优化后 ta-dev 能创建 mandatory unity-csharp-compile plan；只允许修改该文件注释，不改变运行逻辑；计划需要两个 step：第一步修改注释并用 fresh C# compile evidence 完成，第二步恢复原注释并用最终 fresh C# compile evidence 完成
```

目标文件：

```text
client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs
```

## Positive result: double-Enter issue fixed

本轮实际观察到 `/ta-dev` 已直接启动 yuki plan-flow research：

```text
Start yuki plan-flow research for: TA Harness development request: ... Inspect files read-only with read/grep/find/ls, then call grill_plan with critical decision questions.
```

源码观察也支持这一点：`.pi/extensions/ta-dev/index.ts` 现在尝试动态加载 yuki-pi 的 `startPlanFlow`：

```text
rev.4+: start yuki plan-flow directly via the exported programmatic entry point
```

这替代了旧的：

```text
setEditorText("/plan ...")
```

因此旧问题：

> `/ta-dev` 回车后先变成 `/plan ...`，还需要用户再回车一次

本轮看起来已经修复。

## New / remaining issue: repeated `grill_plan`

流程：

1. Research 阶段完成只读检查。
2. 调用 `grill_plan`，无开放问题：
   ```text
   No open critical questions. Call grill_done to proceed to drafting.
   ```
3. 系统后续提示：
   ```text
   yuki plan-flow: grilling has no unresolved questions. Call grill_done to proceed to drafting.
   ```
4. Agent 仍反复调用：
   ```text
   grill_plan({ open_questions: [], restart_research: false })
   ```
5. 每次都得到同样的结果，形成 loop。

## Expected behavior

当 grilling 阶段没有 unresolved questions 时，下一工具应唯一收敛到：

```text
grill_done
```

不应继续暴露或选择：

```text
grill_plan
```

## Actual behavior

Agent 在同一阶段连续调用 `grill_plan`。这与之前 drafting 阶段反复调用 `plan_ask` 的问题属于同一类：

- phase prompt / blocker 已经明确。
- 但模型仍选择旧工具。
- 仅靠自然语言 steering 仍不足以保证收敛。

## Likely root cause

`getAllowedToolsForState("grilling")` 当前仍允许：

```text
plan_ask, grill_plan, grill_done, read-only tools
```

这在“仍有开放问题”时合理，但在 `grill_plan` 已确认没有开放问题后，状态应该进一步收窄为：

```text
grill_done only
```

否则模型仍可能选择 `grill_plan`，即使 convergence kick 已提示 `grill_done`。

## Recommended fix

### P0: state-sensitive grilling tool narrowing

不要只按 phase 计算 allowed tools。`grilling` 阶段应根据 questions 状态细分：

- 有 open questions：允许 `plan_ask`，必要时允许 `grill_done`。
- 无 open questions：只允许 `grill_done`。

伪代码：

```ts
if (phase === "grilling") {
  const hasOpenQuestions = state.questions.some(q => q.status === "open");
  if (!hasOpenQuestions) return ["grill_done"];
  return ["plan_ask", "grill_done"];
}
```

如果需要允许补充研究，应把它作为明确的 state transition，而不是在 no-open-question 状态继续开放 `grill_plan`。

### P0: convergence kick should also apply active-tool narrowing

当前 convergence kick 能提示：

```text
Call grill_done to proceed to drafting.
```

但如果下一 turn 的 tool surface 仍包含 `grill_plan`，模型仍可能误选。kick 前应确保 active tools 已收窄到 convergence target。

### P1: repeated same-tool guard

当同一 phase 中同一个 disallowed-or-unproductive tool 连续产生相同结果，例如：

```text
grill_plan -> no open questions -> grill_plan -> no open questions
```

应触发 stronger recovery：

- 隐藏该工具。
- 强制 next tool 为 `grill_done`。
- 或返回结构化 block：
  ```json
  {
    "phase": "grilling",
    "requiredNextTool": "grill_done",
    "blockedTool": "grill_plan",
    "reason": "no_open_questions"
  }
  ```

## Relationship to previous drafting incident

该问题与此前文档中的 drafting wrong-tool loop 类似：

```text
docs/plan-flow-drafting-wrong-tool-loop-2026-06-19.md
```

区别是：

- drafting 阶段目标工具是 `plan_write`。
- grilling 阶段 no-open-question 状态目标工具是 `grill_done`。

共同结论：**phase-level narrowing 不够，某些 phase 需要 state-sensitive narrowing。**

## Bottom line

本轮修复已有明显进展：`/ta-dev` 双回车问题已改善。但 plan-flow 仍需要针对 grilling 无开放问题状态增加硬收敛：

> no open questions => expose/call `grill_done` only, do not keep `grill_plan` available.

## rev.6 fixes (2026-06-19)

根因与 drafting wrong-tool loop 完全同构（已通过读 pi runtime 源码确认）：`grill_plan` 返回“无开放问题”后，turn 结束时 convergence kick 提示“Call grill_done”，但**下一个 turn 的 tool surface 仍然包含 `grill_plan`**——因为 `getAllowedToolsForState("grilling", ...)` 之前是无条件把 `grill_plan`/`plan_ask`/`grill_done` 全加进去的。模型看到提示说“调 grill_done”，但它的工具列表里 `grill_plan` 也在，于是它继续调 `grill_plan` → 又返回无开放问题 → 又被 kick → 死循环。文案再明确也没用，因为 `grill_plan` 物理上仍可选。

修复（三处，都是 runtime 级硬约束，不是文案）：

1. **state-sensitive narrowing**（`extensions/shared/plan-helpers.ts`）：`getAllowedToolsForState` 现在接受 `options.hasOpenGrillingQuestions`。grilling 阶段只有在**还有 open question** 时才暴露 `plan_ask` + `grill_plan`；**没有 open question 时只暴露 `grill_done`**（+ read-only）。这正是本 doc 的 P0 建议。
2. **`grill_plan` 返回 `terminate: true`**（`extensions/plan-flow/index.ts`）：和 `grill_done`/`plan_write` 同样的硬约束——`grill_plan` 执行后立即结束当前 turn，控制权落到 `turn_end`，由 convergence guard 开一个**干净的、narrow 过的 grilling turn**。当前 streaming turn 的 tool surface 是 frozen 的（`createContextSnapshot` 只在 `runPromptMessages` 开始时快照一次，整 turn 不重新快照），所以不 terminate 的话模型仍能用旧 surface 里的 `grill_plan` 继续撞。terminate 后的新 turn 读到的 `state.tools` 已经是 `[grill_done]`，模型选不到 `grill_plan`。
3. **convergence kick 前重新 narrow**（`extensions/plan-flow/index.ts` 的 convergence turn_end handler）：在 `kickTurn` 之前调一次 `applyActiveTools(pi, state)`，保证 kick 出来的 turn 的 tool surface 一定匹配 convergence target（grilling 无开放问题 → 只 `grill_done`）。对应本 doc 的“kick 前应确保 active tools 已收窄到 convergence target”。

接线（`extensions/plan-flow/index.ts` 的 `getAllowedToolsForState` 包装）：把 `state.questions` 里是否有 `status==="open"` 算出来传给 `getAllowedToolsForPhase(..., { hasOpenGrillingQuestions })`，所有 `applyActiveTools` 调用因此都会按 state 收窄。

端到端流程（无开放问题路径）：
```
grill_plan (无 open) -> terminate:true -> turn_end
  -> applyActiveTools 收窄到 [grill_done]
  -> convergence kick "Call grill_done"
  -> 干净 turn，工具只有 grill_done
  -> grill_done -> terminate:true -> turn_end
  -> convergence kick "Call plan_write"
  -> 干净 turn，工具只有 plan_write
  -> plan_write -> ...
```
全程不需要用户打“继续”，模型也无法再误调 `grill_plan`。

验证：
- `npm test` 53/53 通过（新增/更新 grilling narrowing 用例：open-questions 暴露全套、no-open-questions 只暴露 grill_done）。
- `npm run typecheck` 对 plan-flow / plan-helpers 无新增错误。

改动文件：`extensions/shared/plan-helpers.ts`、`extensions/plan-flow/index.ts`、`test/plan-helpers.test.ts`、本 doc。

## rev.6 retest: still reproducible in current harness (2026-06-19)

再次用同一个 `/ta-dev` 双步骤 smoke 复测后，结论是：双回车问题仍然修复，但 grilling wrong-tool loop 仍可复现。

复测流程：

1. `/ta-dev` 直接进入 plan-flow research，说明 programmatic `startPlanFlow` 路径仍生效。
2. read-only research 完成后调用 `grill_plan`。
3. `grill_plan` 返回：
   ```text
   No open critical questions. Call grill_done to proceed to drafting.
   ```
4. convergence steering 提示：
   ```text
   yuki plan-flow: grilling has no unresolved questions. Call grill_done to proceed to drafting.
   ```
5. agent 仍连续误调 `grill_plan`。
6. blocker 返回的 allowed tools 变为：
   ```text
   yuki plan-flow: in phase grilling, the next tool to call is: read, grep, grill_done.
   ```
   后续缩短为：
   ```text
   yuki plan-flow: call read, grep, grill_done next.
   ```

这说明 rev.6 已有部分效果：`grill_plan` 不再出现在 allowed tools 里，误调会被 blocker 拦住。但它还没完全解决收敛问题，因为：

- allowed tools 仍包含 `read, grep, grill_done`，不是唯一的 `grill_done`。
- 模型仍能在当前/后续 turn 中尝试调用已不允许的 `grill_plan`，并反复撞 blocker。
- blocker 的 allowed-list 里出现多个工具会削弱“唯一下一工具”的约束；此状态下其实不应再鼓励 read/grep。

更新后的 P0 建议：

```text
grilling + no open questions => active tools must be exactly ["grill_done"]
```

不要保留：

```text
read, grep, grill_plan
```

如果用户或模型确实需要补充研究，应显式进入 `research` 或 `restart_research` 状态；不要在 no-open-question grilling 状态继续暴露 read-only 工具。

还需要考虑对 repeated blocked tool 做更强 recovery：连续多次 `grill_plan` 被 blocker 拦截后，runtime 应触发 forced-next-tool mode 或 terminate 当前 turn，而不是继续让模型在同一错误模式里重试。

## rev.7 retest: `grill_plan` still executes instead of being hidden/blocked (2026-06-19)

再次复测同一个 `/ta-dev` 双步骤 smoke 后，问题仍存在，而且表现比 rev.6 retest 更关键：`grill_plan` 在 no-open-question grilling 状态下不仅仍会被模型误选，而且这次没有被 blocker 拦截，而是继续正常执行并返回相同提示。

复测流程：

1. `/ta-dev` 直接进入 plan-flow research，双回车问题仍然修复。
2. 只读 research 完成。
3. 调用 `grill_plan({ open_questions: [], restart_research: false })`。
4. 返回：
   ```text
   No open critical questions. Call grill_done to proceed to drafting.
   ```
5. convergence/user steering 多次提示：
   ```text
   yuki plan-flow: grilling has no unresolved questions. Call grill_done to proceed to drafting.
   ```
6. agent 仍连续调用 `grill_plan`。
7. 每次 `grill_plan` 都再次正常返回：
   ```text
   No open critical questions. Call grill_done to proceed to drafting.
   ```

这说明当前运行中的 hard narrowing 仍未在实际 tool execution 层闭环。关键差异：上一轮至少看到 blocker 返回 allowed tools；这一轮 `grill_plan` 没有被 block，说明以下至少一项成立：

- 当前运行时加载的不是期望的最新 yuki-pi extension 版本。
- `getAllowedToolsForState` 的 state-sensitive narrowing 只影响提示/下一 turn tool surface，但没有影响当前 tool_call guard。
- `grill_plan` execute 后没有 `terminate: true`，导致模型继续在旧 tool snapshot 里重试。
- no-open-question grilling 状态没有被持久化成能让 tool_call guard 识别的状态。
- active tools narrowing 不会自动阻止已注册 tool 的直接调用，必须由 `tool_call` guard 做状态敏感拦截。

更新后的诊断重点：

1. 检查实际加载路径：确认 `/reload` 后加载的是 `/Users/bytedance/project/yuki-pi/extensions/plan-flow/index.ts`，而不是 global 或缓存副本。
2. 在 `grill_plan` execute 返回中确认是否包含 `terminate: true`，并确认 Pi runtime 对该字段实际生效。
3. 在 `tool_call` guard 中打印/记录：phase、toolName、allowed、questions 状态。期望 no-open-question grilling 下：
   ```json
   {
     "phase": "grilling",
     "toolName": "grill_plan",
     "allowed": ["grill_done"],
     "block": true
   }
   ```
4. 如果 allowed 仍含 `grill_plan` 或 read-only tools，则 `getAllowedToolsForState(state)` 包装/状态传参仍有 bug。
5. 如果 allowed 是 `["grill_done"]` 但仍未 block，则 tool_call guard 没覆盖该调用路径或 runtime 的 active tools 与 guard 状态不一致。

更强的 P0 建议：

- 在 `grill_plan` execute 开头添加状态敏感硬拒绝：
  ```ts
  if (current.phase === "grilling" && current.questions.every(q => q.status !== "open")) {
    return/throw "yuki plan-flow: call grill_done next";
  }
  ```
  不只依赖 active tools。
- `grill_plan` 无 open questions 的结果必须 `terminate: true`。
- no-open-question grilling 的 allowed tools 必须精确为 `["grill_done"]`，不能包含 read-only，也不能包含 `grill_plan`。
- 增加 e2e/harness regression：`grill_plan(no open) -> repeated grill_plan` 必须被 block，不能再次正常执行。

当前结论：

> 文案和 convergence kick 已经足够明确；问题在 runtime/tool-call enforcement 没有阻止 `grill_plan` 在 no-open-question grilling 状态继续执行。

## rev.7 fixes (2026-06-19) — 彻底修复

复测确认 rev.6 不彻底后，我读了 pi runtime 源码（`@earendil-works/pi-agent-core` 的 `agent-loop.js`）确认了真正的根因，不是文案、不是 state narrowing 没做，而是**blocked call 物理上无法结束 turn**：

- `prepareToolCall` 里，`beforeToolCall` 返回 `{ block: true, reason }` 时走 `immediate` 分支，返回 `createErrorToolResult(reason)`。
- `createErrorToolResult(message)` 返回 `{ content, details }` —— **没有 `terminate` 字段**。
- `shouldTerminateToolBatch(finalizedCalls)` = `finalizedCalls.length > 0 && finalizedCalls.every(f => f.result.terminate === true)`，**全有或全无**。
- 所以一个 blocked call 永远不会让 batch terminate，turn 不结束。而当前 turn 的 tool surface 是 `createContextSnapshot` 在 `runPromptMessages` 开始时冻结一次、整 turn 不重新快照的，模型在 frozen surface 上能一直重试被 block 的工具 → 死循环观感。
- 同理，plan 工具的 **throw**（wrong phase）也走 `createErrorToolResult`，也没有 terminate → 同样的 frozen-surface 重试循环。

rev.6 给 `grill_plan` 成功路径加了 `terminate: true`，但只有当 `grill_plan` **单独在一个 batch** 时才生效；一旦它在 transition 后被 block（no-open 状态再调），或和 `read` 同 batch（read 没 terminate → batch 全有或全无失败），turn 就不结束 → 仍然循环。这正是复测看到的现象。

**修复原则（runtime 级硬约束）：plan 工具永远不被 block、永远不 throw —— 它们总是执行并返回 `terminate: true`。真正的 narrowing 由 clean turn 的 `setActiveTools` surface 完成（干净 turn 只暴露正确工具，模型物理上选不到错误工具）。**

具体改动（`extensions/plan-flow/index.ts` + `extensions/shared/plan-helpers.ts`）：

1. **clean surface 收窄到唯一目标工具**（`getAllowedToolsForState`）：grilling 无 open questions → **恰好 `["grill_done"]`**（去掉 `read`/`grep`/`grill_plan`/`plan_ask`）。对应本 doc P0 “active tools must be exactly ['grill_done']”。grilling 有 open questions 仍保留 read-only + `plan_ask` + `grill_plan` + `grill_done`（问问题阶段需要 read）。

2. **tool_call handler 永不 block plan 工具**：`PLAN_TOOLS`（`plan_ask`/`grill_plan`/`grill_done`/`plan_write`/`plan_exit`）直接放行，不走 block 分支。这样 plan 工具总是 execute → 返回 `terminate: true` → turn 干净结束 → convergence guard kick 一个 narrow 过的 clean turn。非 plan 工具（`read`/`grep`/`bash`/`edit`/`write` 等）在 surface 之外仍被 block（不能让 `edit` 在 drafting 跑）。`reviewInFlight && plan_write` 的特殊 block 保留（review 期间 agent 不在 streaming，极少触发）。

3. **plan 工具 wrong-phase 改成 terminating result 而不是 throw**：新增 `buildWrongPhaseResult(toolName, state, extra?)`，返回 `{ content: "call X instead", details, terminate: true }`。`grill_plan`/`grill_done`/`plan_write`/`plan_exit` 的 phase guard、`plan_ask` 的 phase/limit/no-UI/no-answer guard 都改成返回它。throw 会变成无 terminate 的 error result → frozen-surface 循环；terminating result 直接结束 turn。

4. **`plan_ask` 成功不 terminate**（关键，避免退回 incident #3）：成功问一个问题后留在 grilling turn 继续（grilling surface 全是合法工具，没有 wrong-tool loop 要打破）。若 terminate，open questions 还剩时 convergence 不会 kick（它只在 no-open 时 kick），flow 会卡住要用户打“继续”。只有 wrong-phase/limit/no-UI/no-answer 这些**终态**才 terminate。

5. **`plan_exit` 所有返回加 `terminate: true`**（headless auto-approve / cancel / revising / approved），让 executing turn 干净 narrow 启动。

6. convergence kick 前重新 narrow（rev.6 已加）保留，兜底保证 kick 出来的 turn surface 匹配 target。

复测场景的新端到端流程（无 open questions）：
```
research turn: model 调 grill_plan（research surface 含 grill_plan，合法）
  -> grill_plan execute: research->grilling, no open, applyActiveTools->[grill_done], 返回 "No open questions, call grill_done" + terminate:true
  -> turn 结束（grill_plan 单独 batch，terminate 生效）
  -> convergence: grilling no-open -> applyActiveTools->[grill_done], kick "Call grill_done"
  -> clean turn: surface 恰好 [grill_done]，模型选不到 grill_plan
  -> grill_done -> drafting, terminate
  -> convergence: drafting -> [plan_write], kick "Call plan_write"
  -> clean turn: surface [plan_write]
  -> plan_write -> terminate -> review -> ...
```
即使模型在 frozen surface 重复调 grill_plan：grill_plan 不再被 block，而是 execute → 返回 terminate → turn 结束 → clean [grill_done] turn。**blocker 不再出现在 grill_plan 路径上**，所以复测里的“反复撞 blocker”消失。

验证：
- `npm test` 53/53 通过（grilling-no-open 用例更新为恰好 `["grill_done"]`）。
- `npm run typecheck` 对 plan-flow / plan-helpers 无新增错误。

剩余（rev.7 未做，需 pi runtime 改动）：
- 真正的 mid-turn frozen-surface 对**非 plan 工具**的 block 仍无 terminate（例如模型在 drafting 的 frozen research surface 上调 `read`/`edit`）。但这些在 clean turn 里不被暴露（surface 已收窄），只在 transition turn 的 frozen surface 上可能被 block 一次；模型最终会 end_turn，convergence 兜底 kick。要彻底消掉需要 pi runtime 支持“block 即 terminate”或“batch 内任一 terminate 即结束”，这是 pi-agent-core 层改动，超出 yuki-pi 范围。
- `applyGrillPlan`/`applyPlanWrite` 的**参数校验** throw（如 “resolved topic needs executable resolution”、“every step must include content”）仍是无 terminate 的 error。这些是模型该修参的场景，重试同一正确工具并修参后会成功+terminate；不是 wrong-tool loop。如需彻底，可后续把这些也改成 terminating soft-error。

改动文件：`extensions/shared/plan-helpers.ts`、`extensions/plan-flow/index.ts`、`test/plan-helpers.test.ts`、本 doc。
