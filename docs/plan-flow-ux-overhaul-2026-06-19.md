# yuki-pi plan-flow UX 改造方案

Date: 2026-06-19
Owner: yuki-pi
Status: draft (rev.3 — 修正 triggerTurn 在 tool-execute 转换点的失效问题)
背景事件: `docs/plan-flow-ta-dev-e2e-incident-2026-06-19.md`

> rev.2 校订:本稿所有平台能力断言已对 `node_modules/@earendil-works/pi-coding-agent` 运行时源码核实。关键修正两处:
> 1. `setActiveTools` 的工具收窄**只在下一个 agent turn 生效**(`core/agent-session.js` `setActiveToolsByName` JSDoc:"Changes take effect on the next agent turn."),**不在 in-flight turn 内生效**。这直接改变了 P0-5 的根因判断与做法(见 P0-5)。
> 2. command handler **不会自动触发 turn**;`sendUserMessage` **总是触发 turn**(`agent-session.d.ts` "Always triggers a turn.")。因此 P0-1 删掉 `sendUserMessage` 后必须自带 turn 触发器,否则流程不启动(见 P0-1)。
>
> rev.3 校订:核实 `sendCustomMessage`(`agent-session.js:969`)的分支后发现 **`triggerTurn` 只在 `!isStreaming` 时生效**;streaming 时退化为 `steer()`/`followUp()`,`triggerTurn` 被忽略。由于 **tool execute 总在 streaming 中运行**(工具调用是 turn 内 loop 的一部分),凡发生在 tool execute 内的 phase 转换(grill_done→drafting、plan_write→review、approve→executing)用 `sendMessage(triggerTurn)` 都会被静默降级成 steer,**不会产生干净的新 turn,narrowing 仍不生效**。据此:
> - P0-5 拆为「turn_end 类转换」(triggerTurn 有效,narrowing 生效)与「tool-execute 类转换」(triggerTurn 失效,靠正向 tool result + block 兜底)两类,P4 根治归因改回 block + 正向文案。
> - P0-3 补 headless 分支的 turn 触发器(否则删掉 review steer 后模型不会调 plan_exit)。
> - P0-2 标注 `--context <token>` 仍可见为已知折中。
> - 风险节增补 turn_end 内阻塞式审批弹框对 emit 管线的影响。

## 一、问题归纳（对应代码定位）

| # | 痛点 | 根因 | 代码定位 |
|---|------|------|---------|
| P1 | `/plan` 后输入框上方顶一大坨**可见的 user 消息** | 把"给模型的指令"用 `sendUserMessage`（role=user，进对话历史+用户可见）投递。注意它**确实**会触发 turn、驱动了流程，问题只是"可见噪音"，不是"死文本" | `extensions/plan-flow/index.ts:201` `buildKickoffMessage`；`:294` `buildReviewSteeringMessage` |
| P2 | `/ta-dev` 输入也产生一大坨文字，用户误解 | ta-dev 把 Harness/profile/mandatory validation 约束序列化进**用户可见的 `/plan` prompt 文本**，再预填编辑器 | Skywalker `.pi/extensions/ta-dev/index.ts:52-60` + `buildPlanPrompt:128` |
| P3 | 流程不是"展示 plan → 直接 ask approve"，审批框只在模型主动调 `plan_exit` 时才弹 | 推进/弹审批的责任交给"模型主动调下一个工具"，而非扩展自己驱动 UI | `:429` `plan_exit` 的 `ctx.ui.select`；review steer 靠 `sendUserMessage` `:294` |
| P3b | approve 后还得说"继续"才执行 | tool（`plan_exit`）返回 tool result 后 turn 结束，**没有任何东西 re-trigger 下一个 turn**；approve→executing 之间没有触发器 | `:451-463` |
| P4 | drafting 阶段模型频繁调 `plan_ask` 失败（死循环观感） | **核心**:`grill_done` 在本 turn 内把 phase 切到 drafting 并 `setActiveTools([plan_write])`，但收窄要下一个 turn 才生效；**本 turn 模型手里仍是 grilling 工具面（含 plan_ask）**，只能靠 `tool_call` 的 block 事后拦，重试即成环。反向文案（"Do not call plan_ask..."）和 block 措辞是次要诱因 | `buildPhasePrompt:913-915` drafting 分支；`buildBlockedToolReason:887`；`getAllowedToolsForState` drafting 分支 `:835-836` |

平台能力已核实（决定方案可行性，含 rev.2 新核实项）：

- `pi.setActiveTools` 会把白名单外工具**真正从 `agent.state.tools` 移除并重建 system prompt**（`agent-session.js` `setActiveToolsByName`）。**但 JSDoc 明确："Changes take effect on the next agent turn."——收窄只对下一个 turn 生效，对正在进行的 turn 无效。** 这意味着"事前 narrowing"只能在 **turn 边界**挡工具，挡不住"phase 在本 turn 中途切换后、同一 turn 内的下一个工具调用"。
- `before_agent_start` → `systemPrompt` 是**不进会话历史**的干净注入通道（`buildPhasePrompt` 已在用）；它**只在 turn 启动时 fire**，同样是 turn 边界级。
- command handler **不会自动触发 turn**（对比 `/plan-status` 只 notify 即返回）。要让模型动起来，必须有人显式触发一个 turn。
- `pi.sendUserMessage` **总是触发 turn**（`agent-session.d.ts` "Always triggers a turn."），但内容是 role=user、**用户可见**、进上下文；且走 `expandPromptTemplates: false`，不触发 slash-command handling。
- `pi.sendMessage(message, { triggerTurn?, deliverAs? })` 存在（`core/extensions/types.d.ts:859-862`）。`message.display: boolean` 控制**是否进可见 transcript**；`display:false` → 用户完全看不到，但 `content` **仍进 LLM 上下文**（`CustomMessage` 无 `excludeFromContext`，custom→role:user）。`triggerTurn:true` 可触发一个新 turn。`deliverAs` 支持 `"steer" | "followUp" | "nextTurn"`。→ **这是本方案的主力机制:`sendMessage({display:false,...}, {triggerTurn:true})` = 零可见噪音 + 触发 turn。**
- `appendEntry(customType, data)` 是**不入 LLM、纯持久化**通道（`:871` 注释 "not sent to LLM"；state 重建已用）。
- `ui.select / notify / setWidget / setStatus` 是**用户可见、不进上下文**的 UI 通道。`ctx.ui.select` 在 `turn_end` event handler 里**可用**（handler 收到完整 `ExtensionContext`，`types.d.ts:210` `ui: ExtensionUIContext`），但非交互会话需 `ctx.hasUI` 守卫。

## 二、改造目标

1. **零可见噪音**：流程推进不再产生"用户可见的 user 消息形式"大段指令文本。驱动用 `sendMessage({display:false}, {triggerTurn:true})`（仅 A 类转换点），内容进上下文但不进可见 transcript（可见噪音与上下文字节是两件事，前者用 `display:false` 彻底解决）。
2. **直通审批**：review 通过后扩展直接弹审批 UI，不等模型调 `plan_exit`。
3. **直通执行**：approve 后自动进入执行 turn，不需要用户再说"继续"（A 类用 triggerTurn，B 类用正向 tool result）。
4. **纪律按转换点分类**（rev.3 修正）：A 类（turn_end）转换用 `triggerTurn` 起干净新 turn，使 `setActiveTools` 收窄生效于新 turn；B 类（tool-execute）转换本 turn narrowing 不生效，靠正向 tool result 引导收敛 + `tool_call` block 作为唯一 mid-turn 兜底（不降级）。正向 phase 文案 + 收窄/block 双重防线。
5. **ta-dev 透明**：Harness 约束作为内部 plan state 注入，用户输入框里只看到自己原始的 `/ta-dev ...`，不看到拼出来的大段 prompt。

## 三、改造项

### P0-5 统一机制：按转换点位置分类编排 phase 转换（基础设施，最先做）

> 这是本方案的骨架，P0-1 / P0-3 / P0-4 都复用它。最先做是因为它同时承担 P4 防线的改造，并为 P0-1 提供启动触发器。

**根因重述（rev.2 修正）**：P4 死循环发生在 **`grill_done` 之后的同一个 turn 内**。`grill_done.execute`（`:362-364`）把 phase 切到 drafting 并 `applyActiveTools([plan_write])`，但收窄**下一个 turn 才生效**；本 turn 模型手里仍是 grilling 工具面（plan_ask 仍在），模型继续本 turn 调 `plan_ask` → 只能靠 `tool_call` block（`:269`）事后拦 → 重试成环。**narrowing 在事故现场是失效的，真正挡住的是 block。** 因此不能把 block 降级为"纯防御"。

**rev.3 关键修正：`triggerTurn` 不能用于 tool-execute 内的转换。** `sendCustomMessage`（`agent-session.js:969`）在 `isStreaming` 时走 `steer()`/`followUp()`，**`triggerTurn` 被忽略**；而 tool execute 总在 streaming 中运行（工具调用是 turn 内 loop 的一部分）。因此发生在 tool execute 里的转换（grill_done→drafting、plan_write→review、approve→executing）调 `sendMessage(triggerTurn)` 会被静默降级成 steer，**不会产生干净的新 turn，narrowing 在本 turn 仍不生效**。只有发生在 turn_end handler 里（streaming 已结束、`!isStreaming`）的转换，`triggerTurn` 才真正起一个干净新 turn。

**据此把 phase 转换分两类处理：**

#### A 类 · turn_end 类转换（triggerTurn 有效，narrowing 在新 turn 生效）

发生在 `turn_end` handler 里，此时 streaming 已结束。抽 helper：

```ts
// 收窄工具 + 注入下一 phase 的正向指令 + 触发一个干净的新 turn
function advancePhase(pi, ctx, next: PlanFlowState, kickContent: string) {
  persistPlanState(pi, next, "phase_change");
  applyActiveTools(pi, next);          // 对“下一个 turn”生效
  updatePlanUi(ctx, next);
  pi.sendMessage(
    { customType: "plan-flow-kick", content: kickContent, display: false },
    { triggerTurn: true },             // !isStreaming → 真正起新 turn，narrowing 生效
  );
}
```

适用：review→awaiting_approval（实由 P0-3 直接弹框接管，通常不需要 kick）、未来 executing→completed（P1-1 自动 close 路径）、以及任何在 turn_end 里决定要推进的分支。

#### B 类 · tool-execute 类转换（triggerTurn 失效，靠正向 tool result + block）

发生在 tool `execute()` 内（grill_done→drafting、plan_write→review、approve→executing）。**不调 `sendMessage(triggerTurn)`**（会降级为 steer，无益且产生噪音）。改为：

- tool execute 内只做 `persistPlanState` + `applyActiveTools`（给下一 turn 收窄，本 turn 不生效）+ `updatePlanUi`。
- 返回**正向、决定性**的 tool result 文案，引导模型在本 turn 自然收敛到调用下一允许工具。例如 `grill_done` 返回 `"Phase is now drafting. Call plan_write with the structured plan."`；`plan_write`(drafting) 返回 `"Plan draft written. Automatic review is pending; wait for it."`；`plan_exit`(approve) 返回 `"Plan approved. Begin execution with todo_write on the first step."`。
- 同 turn 兜底**完全交给 `tool_call` block**（见下）。承认本 turn narrowing 不生效，block 是 B 类转换的唯一实时防线。
- 模型若在本 turn 反复调被禁工具，block 正向文案 + （必要时）turn 自然结束收敛；下一 turn 起工具面才被收窄。

**`buildBlockedToolReason` 保留为一等 mid-turn 兜底（不降级，B 类转换的唯一实时防线）**：
- 措辞正向化：`"In phase <X>, the next tool to call is <allowed>."`，去掉 "STOP ... rejected Nx" 的施压式文案。
- 计数 `consecutiveBlockedToolCalls` 保留用于遥测；可在 detail 里返回结构化 `{phase, allowedTools, requiredNextTool, retryCount}`（incident 建议 1），但**不靠加压文案**。
- **P4 的根治归因**（rev.3 修正）：P4 不靠"turn 边界对齐根治"（grill_done 是 B 类，对齐不了），而靠 **block 正向文案 + grill_done tool result 正向引导模型收敛**。turn 编排只对 A 类负责。

**`buildBlockedToolReason` 保留为一等 mid-turn 兜底（不降级，B 类转换的唯一实时防线）**：A 类转换起的新 turn 里，仍可能出现"模型乱调"的情况，block 是唯一 mid-turn 防线。仅做两项：
- 措辞正向化：`"In phase <X>, the next tool to call is <allowed>."`，去掉 "STOP ... rejected Nx" 的施压式文案。
- 计数 `consecutiveBlockedToolCalls` 保留用于遥测；可在 detail 里返回结构化 `{phase, allowedTools, requiredNextTool, retryCount}`（incident 建议 1），但**不靠加压文案**。

**`buildPhasePrompt` 各分支正向化**（只说该调什么，不提被禁工具名）：
- research：`"Inspect files read-only, then call grill_plan with critical decision questions."`
- drafting：`"Call plan_write with structured steps."`（删 "Do not call plan_ask, grill_plan, grill_done, or plan_exit"）。
- awaiting_approval：`"Plan is ready; the approval dialog will open automatically. If asked, call plan_exit."`
- revising：`"Revise the plan according to feedback by calling plan_write."`
- 其余同理。

**验收**：
- A 类转换（turn_end）后新 turn 模型工具面不含被禁工具（narrowing 已生效）；
- B 类转换（tool-execute）：本 turn 仍可能 attempt 被禁工具，被 block 以正向文案拦住；grill_done 的 tool result 引导模型收敛到 plan_write 而非 plan_ask；
- block 文案全程正向、非施压式；
- 不再出现 grill_done 后同 turn 反复 plan_ask 的施压式死循环观感。

### P0-1 消除 kickoff / review steering 的可见噪音（复用 P0-5 机制）

**改 `registerCommand("plan")` handler（`:201`）**：
- 删除 `pi.sendUserMessage(buildKickoffMessage(state))`。
- 改为 `ctx.ui.notify("yuki plan-flow started · phase: research", "info")` + `updatePlanUi`，**并显式触发首个 turn**（command handler 自身不触发 turn，否则流程卡死）：

```ts
pi.sendMessage(
  { customType: "plan-flow-kick", content: buildKickoffContent(state), display: false },
  { triggerTurn: true },
);
```

- `buildKickoffContent` 是原 `buildKickoffMessage` 的一行精简版（`"Start yuki plan-flow research for: <request>. Inspect files read-only, then call grill_plan."`），`display:false` 保证零可见噪音；其余 research 指令由 `before_agent_start → buildPhasePrompt` research 分支承载（已存在 `:907-909`）。

**改 `turn_end` review 完成（`:294`）**：
- 删除 `pi.sendUserMessage(buildReviewSteeringMessage(reviewed), { deliverAs: "steer" })`。
- review 通过（→awaiting_approval）：扩展直接驱动审批 UI（见 P0-3）。
- review 有 blocking（→revising）：`ctx.ui.notify("Review found N blocking issues; revising", "warning")` + widget 展示 issues；revise 指令走 P0-5 的 `advancePhase`，`kickContent` 为一行 `"Address review feedback and call plan_write."`（`display:false`，进上下文但零可见噪音）。

**验收**：`/plan foo` 后输入框上方**无新增可见 user 消息**；模型仍在首个 turn 进入 research（turn 已被显式触发）。

### P0-2 ta-dev 约束改为注入 plan state，不再拼进 prompt 文本（文件 handoff 为主方案）

> rev.2 调整:把"文件 handoff"提为**主方案**,跨扩展 `import` 降为长期可选。理由:ta-dev 在 Skywalker 的 `.pi/extensions/`、plan-flow 在 yuki-pi,两个独立加载目录间跨扩展 import 的加载顺序/可见性都不确定（原风险节自己点出的最大不确定性）；文件 handoff 不需要任何新平台 API,也不需要跨扩展链接。

**Skywalker `ta-dev/index.ts:52-60` 改造**：
- 不再 `setEditorText("/plan ${大段 planPrompt}")`。
- 改为：把 Harness 约束作为 structured context 写入 `.pi/plan-context-<token>.json`，编辑器只预填 `/plan --context <token> <原始 request>`（或把 token 编进一个不显眼的尾注）。用户按 Enter 触发真实 `/plan`，输入框只看到干净的 request。

**plan-flow 侧配套**：
- 给 `PlanFlowState` 增 `planningContext?: { profiles?: string[]; mandatoryValidation?: string[]; declaredFiles?: string[]; sourceCommand?: string }`。
- `/plan` 命令支持 `--context <token>`：handler 读 `.pi/plan-context-<token>.json`，填入 `state.planningContext`，读后删除该文件。
- `buildPhasePrompt` 的 drafting 分支把 `planningContext.mandatoryValidation` 渲染进 system prompt（给模型看，用户不看到输入框大段文本）。
- `plan_write` 校验：若 `planningContext.mandatoryValidation` 存在，校验每个 step 的 `validation` 覆盖了 mandatory 项（原 ta-dev 文本约束的硬化版）。

**长期可选**：等确认 pi 的 extension 加载顺序/可见性允许跨扩展 import 后,ta-dev 可直接 `import` plan-flow 导出的 `startPlan(ctx, { request, planningContext })`,省掉文件 handoff;或等 pi 提供 first-class command handoff API（incident backlog P1 #1）。

**用户侧表现**：用户输入框只保留 `/ta-dev --profile csharp --file X.cs 修改逻辑`，按 Enter 后无大段文本；约束在 system prompt / plan state 里对模型生效。

> rev.3 已知折中：`--context <token>` 仍会作为参数出现在预填的 `/plan` 行里，对用户是"看不懂的额外字符"——比大段文本好，但未完全达到"只看到自己原始的 `/ta-dev ...`"。更彻底的方案（ta-dev 写 context 文件后预填纯 `/plan <request>`、plan-flow 启动时按时间窗读最近未消费的 context 文件）列为 P0-2 的后续优化，不阻塞本期。

**验收**：`/ta-dev ...` 后输入框上方无大段 plan prompt；plan draft 的 steps 的 validation 包含 mandatory sensors。

### P0-3 review 通过后扩展直接驱动审批 UI（不等模型调 plan_exit）

**核心改动**：把"审批"从"模型调 plan_exit → 弹框"改为"扩展在 review 通过后直接弹框"。抽 `runApprovalDialog(pi, ctx, state)` 共享函数（复用 `plan_exit` 现有 `ctx.ui.select` 逻辑 `:429-463`）。

**`turn_end` review 通过分支**（`hasUI` 守卫，A 类转换点：此时 `!isStreaming`，`triggerTurn` 有效）：
- `reviewInFlight` 释放后，若 `phase=awaiting_approval && reviewed`：
  - **若 `ctx.hasUI`**：扩展内直接 `runApprovalDialog`：
    - Approve → `approvePlan` → 写 final plan + seed todo + 切 executing → 走 P0-4 的 A 类路径触发执行 turn（此处 triggerTurn 有效）。
    - Request revision → `advancePhase` 切 revising + notify（A 类，triggerTurn 有效）。
    - Cancel/undefined → `abortPlan` + notify。
  - **若 `!ctx.hasUI`**（ta-dev E2E / cron / 非交互）：**不自动弹框**，回落到模型驱动——保持 awaiting_approval，并**显式触发一个 turn 让模型调 `plan_exit`**（rev.3 补：P0-1 删掉了原 review steer，这是原驱动模型调 plan_exit 的触发器，删掉后 headless 下没有任何 turn 被触发，模型不会自调 plan_exit）：
    ```ts
    pi.sendMessage(
      { customType: "plan-flow-kick", content: "Plan is ready for approval; call plan_exit.", display: false },
      { triggerTurn: true },   // turn_end 里 !isStreaming，有效
    );
    ```
    模型在新 turn 调 `plan_exit`（仍走同一个 `runApprovalDialog`，内部对 `!hasUI` 已有 `plan_exit:427` 的报错保护，需改为可降级/直接 approve 的策略由后续定）。

**`plan_exit` 工具的处理**：
- 保留 `plan_exit` 作为"模型主动请求审批"的兜底入口（自动审批被跳过/中断、或 headless 时），其 execute 内部直接调同一个 `runApprovalDialog`。
- awaiting_approval 的 phase prompt 改为正向：`"Plan is ready; the approval dialog will open automatically. If asked, call plan_exit."`

**收益**：交互会话 review 通过 → 审批框立即出现，用户无需说"继续"；headless 仍可用 plan_exit 兜底；无 steering 文本噪音。

**验收**：交互会话 drafting → review pass → 审批框自动弹出（无用户输入）；选 Approve 后直接进入 executing；非交互会话 review pass 后模型经显式触发的 turn 调 `plan_exit` 完成审批。

### P0-4 approve 后自动进入执行 turn（不等用户说"继续"）

**rev.3 修正：approve 有两个发生点，按 P0-5 分类处理。**

- **A 类来源（turn_end 自动审批，`hasUI`）**：`approvePlan` 在 turn_end handler 内完成，此时 `!isStreaming`，`triggerTurn` 有效。切 executing + `applyActiveTools`（恢复全工具集 + todo 工具，对下一个 turn 生效）+ `updatePlanUi` 后，复用 P0-5 A 类机制触发执行 turn：
  ```ts
  pi.sendMessage(
    { customType: "plan-flow-kick", content: "Plan approved. Begin execution: todo_write the first step as in_progress.", display: false },
    { triggerTurn: true },   // A 类：!isStreaming，有效
  );
  ```
  `display:false` → 零可见噪音；新 turn 的 `before_agent_start` 注入 executing 分支指令，模型在新 turn（已绑定 executing 工具面）开始 `todo_write`。

- **B 类来源（`plan_exit` tool execute 内审批，headless 兜底路径）**：approve 发生在 `plan_exit.execute()` 里，**`isStreaming=true`，`triggerTurn` 会降级为 steer**。不调 `sendMessage(triggerTurn)`。改为：`approvePlan` 后 tool result 返回正向决定性文案 `"Plan approved. Begin execution with todo_write on the first step."`，引导模型在本 turn 收敛到调 `todo_write`；narrowing 本 turn 不生效，靠下一 turn 才收窄（executing 工具面本就宽松，B 类无被禁工具冲突问题）。若用户走交互 A 类路径则不会落到 B 类。

**验收**：
- 交互会话审批 Approve（A 类）后模型立即在新 turn 开始 todo_write，输入框上方无新增可见消息，无需用户"继续"。
- headless 经 plan_exit 审批（B 类）后，tool result 引导模型在本 turn 继续调 todo_write。

### P1-1 plan todo 全完成 → 自动 close plan

**hook 落点（需明确）**：plan-flow 不拥有 `todo_write`（在 `extensions/todo`）。在 `executing` 期的 **`turn_end`** 里,用现有 `reconstructPlanState` 同款思路从 branch 读 plan-owned todo list（`state.todoListId`）的完成情况；当全部 completed 时触发收尾：
- phase → `completed`（新增 phase），`active=false`，清 status/widget，`applyActiveTools` 恢复 `previousActiveTools`，`appendEntry` 记录 close。
- 防止 incident #4（旧 plan 完成仍 active，新 `/plan` 被拒）。

**验收**：plan todos 全完成后 `/plan` 可直接开新 plan，无需 `/plan-abort`。

### P1-2 流程可见性：`/plan-debug` + widget 增强

- 新增 `/plan-debug`：notify 展示 phase / allowed tools / next action / planId / todoListId（incident backlog P1 #3）。
- executing 阶段不清空 widget（`updatePlanUi:862-866` 当前清空），改为展示当前 in_progress todo。

### P2-1 active tool narrowing 的回归测试

> 注意 rev.3：narrowing 是 **turn 边界级**，且只对 A 类转换生效。测试要以"新 turn 的工具面"为断言对象，不能断言 B 类（tool-execute）转换同 turn 内工具被移除。

- grill_done（B 类）：**本 turn** 仍可能 attempt plan_ask → 被 block 正向拦住；**下一个 turn** 工具面 = `[plan_write]`（断言新 turn active tools）。
- review pass（A 类）：新 turn 工具面不含被禁工具。
- awaiting_approval 的 turn + 模型 attempt plan_write（非 revision）→ 挡住。
- executing 的 turn + 模型 attempt plan-flow 工具 → 挡住。
- plan 全完成 → 自动 close → 新 `/plan` 可用。

## 四、风险与兼容

- **P0-5 turn 编排（rev.3 修正后）**：只有 A 类（turn_end）转换能用 `triggerTurn` 起干净新 turn；B 类（tool-execute）转换 `triggerTurn` 会降级为 steer，不做 turn 编排，靠正向 tool result + block。两类划分以运行时 `isStreaming` 状态为准（已核实 `sendCustomMessage:969`）。风险点：分类若误判（把 B 类当 A 类用 triggerTurn）会静默退化为 steer、既无新 turn 又加了上下文噪音——实现时需在转换点代码旁标注它属 A/B 类并对应核验。
- **narrowing 只对下一个 turn 生效**（已核实）：A 类转换新 turn 生效；B 类转换本 turn 不生效，靠 block。回归测试不能断言"B 类转换同 turn 内工具被移除"。
- **P0-3 在 turn_end handler 内调 `ctx.ui.select` 阻塞**（rev.3 新增风险）：`runApprovalDialog` 是阻塞 promise，turn_end handler 被 runner `emit` 串行 await（`runner.js` emit）。审批弹框会阻塞 turn_end emit 管线直到用户点选，可能挡住 compaction/auto-retry 等其它 turn_end 后续逻辑的时序。`plan_exit` 现在也是 tool execute 内阻塞（同样在 streaming 串行路径），有先例，但 turn_end 阻塞影响面更广。落地时需确认：是否有其它 turn_end handler 依赖本 handler 先返回，以及长时阻塞会不会触发 agent 的 idle/超时。退路：把审批弹框从 turn_end 移到一个极短的独立触发 turn（先 `sendMessage(kick,{triggerTurn:true})` 起新 turn，在新 turn 的 `before_agent_start` 或 turn_start 里弹框），避免阻塞 turn_end emit。
- **P0-3 直接弹审批框**改变了"模型调 plan_exit"的契约：保留 `plan_exit` 兜底，且 phase prompt 仍告知模型可调；**必须 `ctx.hasUI` 守卫**，非交互会话回落到模型驱动（并补 turn 触发器，见 P0-3 headless 分支）。
- **P0-1/P0-4 的 triggerTurn 消息**用 `display:false` → 零可见噪音；其 `content` 仍进 LLM 上下文（一行），远小于当前大段 steering，可接受。若要连上下文字节也省掉，需 pi 提供"触发 turn 但消息不进上下文"的能力（长期 backlog）。
- **P0-2 文件 handoff**：`.pi/plan-context-<token>.json` 由 ta-dev 写、plan-flow 读后删；需约定 token 命名与清理，避免残留。`--context <token>` 仍可见为已知折中（见 P0-2 rev.3 注）。跨扩展 import 作为长期可选，不阻塞本期。
- **正向文案**可能让模型在某些边缘情况缺少"不要做什么"的约束；靠 A 类 narrowing + B 类 block 双重兜底，风险可控。

## 五、落地顺序

1. **P0-5** 按 A/B 类拆分的 phase 转换编排骨架（`advancePhase` 仅供 A 类；B 类用正向 tool result + block 不降级）。**最先做**：它同时承担 P4 防线（block 正向化 + grill_done tool result 正向引导），并为 P0-1 提供启动触发器，P0-3/P0-4 复用其 A 类 triggerTurn 机制。
2. **P0-1** 删 kickoff/review steering 的 `sendUserMessage`，改 `notify` + `sendMessage({display:false},{triggerTurn:true})`（command handler 是 A 类，有效；缓解 P1 可见噪音）。
3. **P0-3 + P0-4** 抽 `runApprovalDialog`，review 通过后扩展直接弹框（带 `hasUI` 守卫；评估 turn_end 阻塞影响）+ approve 后 A 类路径 triggerTurn 执行 turn、B 类路径正向 tool result（解决 P3/P3b，核心体验改动）。
4. **P0-2** ta-dev 约束改注入 plan state（文件 handoff 为主；需 plan-flow `--context` + state 增字段 + plan_write 校验；`--context <token>` 可见为已知折中）。
5. **P1-1 / P1-2** 自动 close（executing 期 turn_end 判全完成，A 类转换）+ `/plan-debug`。
6. **P2-1** 回归测试（断言以 turn 边界 + A/B 类为准）。

每步独立可验证，建议按此顺序提 PR。
