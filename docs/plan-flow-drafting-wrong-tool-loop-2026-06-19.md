# Plan-flow drafting wrong-tool loop incident

Date: 2026-06-19  
Area: yuki-pi plan-flow  
Observed from: `/Users/bytedance/Project/Skywalker/sw_project`

## Summary

在最新一轮 plan-flow 优化后，`drafting` 阶段仍稳定复现模型反复调用错误工具的问题：

- plan-flow 已明确提示下一步必须调用 `plan_write`。
- blocker 文案已从之前高压的 `STOP ... rejected Nx` 改为更短、更平和的提示：
  ```text
  yuki plan-flow: call plan_write next.
  ```
- 但 agent 仍连续多次调用 `plan_ask`。

结论：**仅靠优化自然语言 steering / blocker 文案不足以解决 wrong-tool loop。** 需要 runtime / tool exposure 层面的更强约束。

## Reproduction context

用户发起最新 plan-flow 测试：

```text
TA Harness development request: 验证最新 plan-flow 优化后 ta-dev 能创建 mandatory unity-csharp-compile plan；只允许修改该文件注释，不改变运行逻辑；计划需要两个 step：第一步修改注释并用 fresh C# compile evidence 完成，第二步恢复原注释并用最终 fresh C# compile evidence 完成
```

目标文件：

```text
client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs
```

read-only research 阶段成功读取了：

- C# probe 文件。
- `.pi/extensions/ta-dev/index.ts`。
- yuki-pi `extensions/plan-flow/index.ts`。
- yuki-pi `extensions/todo/index.ts`。

随后：

1. `grill_plan` 无开放关键问题。
2. `grill_done` 进入 drafting。
3. plan-flow 明确提示：
   ```text
   Phase is now drafting... Call plan_write with the structured plan.
   ```
4. 用户侧也出现 steering：
   ```text
   yuki plan-flow: still in drafting. Call plan_write with the structured plan now.
   Mandatory validation ... unity-csharp-compile.
   Declared/expected files: client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs.
   ```
5. Agent 却连续调用 `plan_ask`。
6. blocker 返回：
   ```text
   yuki plan-flow: in phase drafting, the next tool to call is: plan_write.
   ```
   后续更短：
   ```text
   yuki plan-flow: call plan_write next.
   ```
7. Agent 仍继续误调 `plan_ask` 多次。
8. 用户要求退出 plan mode，并记录问题。

## Expected behavior

进入 drafting 后，agent 应该只调用一次：

```text
plan_write
```

并写入结构化 plan。此时不应再调用：

- `plan_ask`
- `grill_plan`
- `grill_done`
- `read`
- `grep`
- `bash`
- `edit`
- `write`

## Actual behavior

Agent 在 drafting 阶段连续调用 `plan_ask`。plan-flow 每次都正确 block，但 block 结果没有改变 agent 的下一次工具选择。

这造成用户体验上的“死循环”：虽然 runtime 没有卡死，但 agent 一直撞同一个 guard。

## Why the latest wording optimisation was insufficient

最新 blocker 文案相比之前更短、更冷静，避免了 `STOP` / `rejected Nx` 这种可能加剧混乱的表达。

但这次复现说明：

- 模型并不总能把 blocker 文案转化为下一次正确工具调用。
- 即使提示里只剩 `call plan_write next`，模型仍可能沿用上一轮错误工具模式。
- 因此问题不只是“文案太长/太强硬”，而是 tool selection 层面缺少硬约束。

## Root cause hypothesis

1. **Tool surface 仍包含错误工具**
   - 如果模型仍能看到/选择 `plan_ask`，就可能继续选错。
   - Blocking 是事后纠错；模型已经做出了错误选择。

2. **Tool result steering 不够强制**
   - Tool block 返回的是文本，模型可能忽略或未正确内化。

3. **Phase transition 后没有 forced-next-tool mode**
   - `grill_done` 已确定下一步唯一合法工具是 `plan_write`。
   - 但 runtime 没有进入“只允许/只暴露 plan_write 直到成功”的强制模式。

4. **Repeated wrong-tool 没有自动 recovery**
   - 多次同类错误后，runtime 仍只是返回提示。
   - 没有触发更强机制，例如隐藏其他工具、清空可用工具列表、或启动 plan_write-only retry turn。

## Impact

- 用户需要反复说“继续”。
- Plan-flow 看起来像卡死，实际上是 agent 重复撞 guard。
- 会浪费 turns 和上下文。
- 容易让用户误判 yuki-pi plan-flow 状态损坏。
- 对 `/ta-dev` 这类入口验证尤其明显，因为流程高度依赖 phase discipline。

## Recommended fixes

### P0: phase-specific active tool narrowing

在每个 phase 真正缩小 active tools，而不是仅依赖 tool_call blocker：

- `research`: read-only tools + `grill_plan`
- `grilling`: `plan_ask`, `grill_done`
- `drafting`: `plan_write` only
- `awaiting_approval`: `plan_exit` only（或仅在明确 revision 时 `plan_write`）
- `executing`: `todo_read`, `todo_write` plus allowed execution tools

关键是：**drafting 阶段不要让模型看到 `plan_ask`。**

### P0: forced-next-tool recovery

当 blocker 发现当前 phase 只有一个合法 next tool 时，进入 forced-next-tool mode：

```ts
forcedNextTool = "plan_write"
```

直到 `plan_write` 成功或 plan 被 abort。

在 forced mode 下：

- 隐藏其他 plan tools。
- block 任何非 forced tool。
- 可选：向模型注入 hidden steering：
  ```text
  The next and only tool call must be plan_write. Do not call any other tool. Do not explain.
  ```

### P1: repeated wrong-tool telemetry and escalation

记录重复错误：

```json
{
  "phase": "drafting",
  "blockedTool": "plan_ask",
  "requiredTool": "plan_write",
  "count": 8
}
```

达到阈值后：

- UI 提示用户：agent is repeatedly choosing a disallowed tool。
- 自动切换到 stricter active tools。
- 或建议用户 `/plan-abort`。

### P1: structured block result

Tool block 不只返回自然语言，也返回结构化 details：

```json
{
  "phase": "drafting",
  "allowedTools": ["plan_write"],
  "requiredNextTool": "plan_write",
  "blockedTool": "plan_ask",
  "recovery": "call_required_tool_only"
}
```

这方便未来 runtime / adapter 根据 details 自动修正，而不是依赖 LLM 读文本。

### P2: regression tests

新增 plan-flow regression tests：

1. `grill_done -> drafting -> repeated plan_ask`
   - 应 block。
   - 应进入 forced plan_write mode。
   - 不应无限返回相同自然语言提示。

2. `drafting -> read/grep/bash/edit`
   - 应 block，并保持 forced plan_write。

3. `awaiting_approval -> non-plan_exit`
   - 应提示/强制 `plan_exit`。

4. `executing -> plan_write`
   - 应 block，并提示 todo tools / execution tools。

## Suggested immediate experiment

下一轮实验可以这样设计：

1. 修改 plan-flow：drafting phase active tools 只保留 `plan_write`。
2. `/reload`。
3. 重新发起相同 `/ta-dev` 双步骤 smoke。
4. 观察进入 drafting 后工具面板/模型是否还能调用 `plan_ask`。
5. 如果仍能调用，说明 active tool narrowing 没有作用到当前 tool registry 或 API harness；继续查 tool exposure 链路。

## Intended structured plan that failed to be written

本轮 drafting 阶段应该写入的 plan 是：

```json
{
  "title": "验证最新 plan-flow 优化后的 ta-dev C# mandatory validation 双步骤流程",
  "background": "通过最新 /ta-dev + yuki plan-flow 优化，验证 mandatory unity-csharp-compile planning context、drafting/review/approval、execution evidence gate 和 auto-close 在双步骤 smoke 中端到端工作。",
  "steps": [
    {
      "id": "modify-probe-comment",
      "content": "修改 C# probe 注释并用 fresh C# compile evidence 完成",
      "activeForm": "正在修改 C# probe 注释并等待 fresh C# compile evidence",
      "files": ["client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs"],
      "validation": [
        "mandatory unity-csharp-compile",
        "only modify comment text",
        "completion evidence must include unity-csharp-compile passed timestamp and fingerprint"
      ]
    },
    {
      "id": "restore-probe-comment",
      "content": "恢复 C# probe 原注释并用最终 fresh C# compile evidence 完成",
      "activeForm": "正在恢复 C# probe 原注释并等待最终 fresh C# compile evidence",
      "files": ["client/skywalker/Assets/PiGuardProbe/PiGuardBrokenCSharp.cs"],
      "validation": [
        "mandatory unity-csharp-compile",
        "restore original comment text",
        "completion evidence must include final unity-csharp-compile passed timestamp and fingerprint"
      ]
    }
  ],
  "risks": [
    "每个 step 都必须等待对应 edit 之后的 fresh unity-csharp-compile pass，不能复用旧 evidence。"
  ]
}
```

## Bottom line

本次复现说明：

> plan-flow 的 phase prompt / blocker 文案已经足够明确，但模型仍可能重复选择错误工具；要解决 drafting wrong-tool loop，需要 runtime 层面的硬约束，而不是继续调文案。

## rev.5 fixes (2026-06-19)

re-test 暴露三个问题，逐一处理：

1. **双回车 `/ta-dev` → `/plan`（仍然存在）。** 根因：`pi.sendUserMessage("/plan ...")` 内部走 `prompt(text, { expandPromptTemplates: false })`，**故意跳过 slash command 处理**，所以程序化调用方无法用它触发 `/plan`。Skywalker 的 `/ta-dev` 仍然用 `ctx.ui.setEditorText("/plan ...")` 预填编辑器，于是第一次回车只是把文案变成 `/plan` 开头，需要第二次回车才真正发送。yuki-pi 在 rev.4 已经导出了程序化入口 `startPlanFlow(pi, ctx, { request, planningContext })`（`extensions/plan-flow/index.ts`），**不需要 `--context` handoff 文件、不需要预填编辑器、不需要第二次回车**。这一条必须改 Skywalker 侧的 `/ta-dev`：把 `setEditorText("/plan ...")` 替换成 `await startPlanFlow(pi, ctx, { request, planningContext })`。yuki-pi 侧的 API 已就绪，无法从 yuki-pi 仓库内部修复 Skywalker。

2. **drafting 反复调用 `plan_ask`（硬约束已落地）。** 真正根因（已通过读 pi runtime 源码确认）：`grill_done` 是 B-class（tool-execute）转入 drafting 的转换点，但 **当前 turn 的 tool surface 在 `runPromptMessages` 开始时由 `createContextSnapshot` 冻结一次，整个 turn 不会重新快照**（Agent 类没有暴露会重新 narrow 的 `prepareNextTurn`）。所以 `grill_done` 在 execute 里调 `applyActiveTools([plan_write])` 只对**下一个** turn 生效，**当前 streaming turn 仍然挂着 grilling 的工具集**（含 `plan_ask`，不含 `plan_write`）。模型看到“call plan_write”却无法调用 plan_write（不在它的工具列表里），只能反复尝试它能看到的 `plan_ask` → 被 `tool_call` block → 再试 → 死循环观感。文案再短也无法解决，因为模型物理上选不到 plan_write。
   硬约束修复：`grill_done`（以及 `plan_write`）的 `execute()` 返回 `AgentToolResult` 时带上 **`terminate: true`**（`@earendil-works/pi-agent-core` 的 `AgentToolResult.terminate`）。`runAgentLoop` 在 `executeToolCalls` 后用 `hasMoreToolCalls = !executedToolBatch.terminate` 决定是否继续内层循环——`terminate: true` 会**立即结束当前 turn**。于是控制权落到 `turn_end`，由 convergence guard 用 `kickTurn`（A-class，`triggerTurn: true`）开一个**全新的、narrow 过的 drafting turn**，其 `createContextSnapshot` 读到的 `state.tools` 已经是 `[plan_write]`。新 turn 里模型**根本看不到 `plan_ask`**，只能调 `plan_write`。这是 runtime 层面的硬约束，不是文案 nudge——模型无法再选错，因为它选不到。

3. **grilling 停下来问 “ok”，要 “继续” 才 grill_done（已修复）。** 根因：`getConvergenceKick` 之前对 grilling 返回 `undefined`（不约束），所以模型用文本结束 turn 后没有任何 auto-continue，必须用户打 “继续”。修复：`getConvergenceKick` 新增 grilling 分支——当 `!hasOpenQuestions`（所有问题已 resolved，或 grill_plan 没有开放问题）时，kick “Call grill_done to proceed to drafting”。于是 grill_plan（全部 resolved）→ turn 结束 → 自动 kick grill_done → grill_done（terminate）→ 自动 kick plan_write → 全程不需要 “继续”。

改动文件：
- `extensions/plan-flow/index.ts`：`grill_done` 与 `plan_write` 的 `execute()` 返回 `terminate: true`；convergence turn_end handler 计算 `hasOpenQuestions` 并传入。
- `extensions/shared/plan-helpers.ts`：`ConvergenceSignal` 新增 `hasOpenQuestions`；`getConvergenceKick` 新增 grilling 分支。
- `test/plan-helpers.test.ts`：新增 grilling kick / no-kick 用例，调整 unconstrained-phases 用例。

验证：`npm test` 52/52 通过；`npm run typecheck` 对 plan-flow / plan-helpers 无新增错误（仓库里其余 5 个 pre-existing 错误来自其它扩展，与本次改动无关）。

剩余（rev.5 未做）：
- **Skywalker `/ta-dev` 仍需改用 `startPlanFlow`** 才能真正消掉双回车（见上 #1）。
- 真正的 mid-turn active-tool narrowing（让当前 streaming turn 的工具集也实时收缩）需要 pi runtime 改动（在 Agent 类暴露一个会重新 `createContextSnapshot` 的 `prepareNextTurn`，或让 `setActiveToolsByName` 立即对当前 turn 生效）。`terminate: true` + A-class convergence kick 是当前 runtime 能力范围内的等价硬约束：它把“当前 turn 不要再选工具”变成强制，然后在干净的 turn 里只暴露正确工具。
