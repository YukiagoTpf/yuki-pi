# plan-flow: plan_write 的两类 UX 失败（payload 截断 + mode 泄漏）

日期: 2026-06-21
上下文: 同一天诊断出 `plan_write` 的两类 UX 失败，根因不同但共享同一主线——**plan_write 的错误语义没有指向真正的问题**，导致 agent 在错误方向上反复纠正，陷入循环。

- **Incident 1（payload 截断）**：TA Harness P2 plan（render-output-capture 扩展 + rt-consumers-check 新增）在 drafting phase 反复无法通过 `plan_write` 校验，调用 7 次失败。根因不是 schema 设计问题，是 **plan_write 调用大小 × 错误消息表达** 的复合 UX 问题。这是"**该调时调不对**"。
- **Incident 2（mode 泄漏）**：用户在正常对话（无活跃 yuki plan）中观察到 agent 调用了 `plan_write`，而 plan 相关工具理应只在主动进入 plan mode 后才出现。调研社区工具 `Luan-Vn4/pi-mode` 后确认这是 yuki plan-flow 工具面模型的缺口。这是"**不该调时能调**"。

共同主线：plan_write 把"传输层/工具面层"的问题误报成"schema/运行时"问题，agent 拿到的反馈和真因方向不一致，于是死循环。

---

## Incident 1：plan_write 大请求字段截断 / 错误消息不够指向根因

### 症状

drafting phase 内 agent 调 `plan_write`，连续 7 次失败，错误轮换：
- `title: must have required properties title, steps`
- `steps: must have required properties steps`
- `steps.0.activeForm: must have required properties activeForm`
- `title: must have required properties title`

每次 agent 把上一次报错指出的缺失字段补齐再发，下一次又缺别的字段。表面看像 agent 不会用 schema，实际是单次工具调用 JSON 在传输/解析层被截断，错误消息只报"第一个缺失字段"，不报"哪里被截断"。

### 根因（按可能性排序）

**R1：plan_write 单次调用 JSON 在 token / 字节预算上溢出，message 末尾被截断**

每次失败的 `received arguments` 里可以清楚看到，JSON 字符串在 `decisions` 或 `risks` 数组末尾就戛然而止，`steps` 字段根本没出现，或 `steps[0].content` 中文截断在半句：

```
"decisions": [..., "Stage 3 ta-dev PROFILE_MANDATORY_VALIDATION 加 rt-consumers-check; harness-execution-policy"
}
```

中文字符按 UTF-8 是 3 bytes/字符，比英文密度高 3 倍。一段中文密度高的 background + 8 条 decisions + 8 条 risks + 5 步 steps，很容易把单次 tool_use 块推到 model 输出预算上限。模型停止输出 → JSON 不闭合 → harness 解析时按"截断处之前的字段"校验 → 报告"缺失 steps"或"steps[0].activeForm 缺失"。

**R2：错误消息只指出"第一个缺失字段"，不指出"输入被截断"**

harness 的 schema 校验器走 ajv 或类似的 fail-fast 模式：找到第一个 required 缺失就停止报错。但当输入是被截断的 JSON 时，截断点之后所有字段都"缺失"，错误消息只指其中一个，agent 看到的语义是"这个字段没填"，不是"你的输出爆了"。

agent 的纠正策略（"我下次记得加这个字段"）和实际问题（"我下次要写短一点"）方向不同，循环出不来。

**R3：plan-flow drafting phase 没有"先发骨架，再补内容"的渐进式 plan_write 接口**

`plan_write` 要求单次调用提交完整 plan（title + background + decisions + assumptions + risks + steps[]）。没有"先发短骨架，再分次 patch"的形态。中文密度高的大 plan 在单次调用里几乎必然溢出。

每次都是 JSON 在中文密度高的位置截断。没有一次是真的"字段拼写错"或"schema 理解错"。

### 影响

- agent 在 drafting phase 死循环，消耗多轮 model 调用，用户被迫看到一长串相似的失败消息。
- 用户能看到 agent 在"努力工作"但毫无进展，体验上等同于卡死。本次会话用户最终主动打断 "你为什么一直在被反复阻断？"，agent 才有机会诊断。
- 信任成本：用户开始怀疑 plan-flow / yuki schema / agent capability，而非真正的根因（输出预算）。

### 立即可做的临时缓解（不改 yuki-pi 代码）

agent 侧：drafting phase 自我约束
- background ≤ 12 行
- decisions ≤ 6 条且每条 ≤ 80 字
- risks ≤ 4 条
- steps 一次只列 stage 级（不下钻 sub-step），后续在 todo 层细化

用户侧：看到 plan_write 反复失败时，告诉 agent "把 decisions/risks 各精简到 5 条以内再重发"。

---

## Incident 2：plan_write 在非 plan mode 泄漏 / mode gating 缺失

### 症状

- 用户未运行 `/plan`，无活跃 plan-flow。
- agent 在正常回答里调用了 `plan_write`。
- 调用以 `throw "plan_write: no active yuki plan. Start with /plan <request>."` 终止，浪费一个 turn，并把用户搞懵：为什么这个工具此时可见？

### 根因

工具面策略是 **"默认全放 + 有 plan 才收窄"**，而正确的模型应是 **"每个状态都由 mode 推导工具面，idle 也是一种 mode"**。

**R1：plan_write 在扩展加载时无条件永久注册**

`extensions/plan-flow/index.ts` L459 `pi.registerTool({ name: "plan_write", ... })` 在扩展初始化时执行，与是否存在活跃 plan 无关。注册即进入全局工具表，模型可见。

**R2：收窄工具面的唯一机制只在 plan 活跃时触发**

唯一能从 active surface 移除 plan_write 的是 `pi.setActiveTools(getAllowedToolsForState(state))`。而所有调用点都是条件触发：

- `session_start`（L229）：`if (state?.active && phase !== aborted) applyActiveTools(...)` —— 否则 early return，不碰工具面。
- `before_agent_start`（L262）：`if (!state?.active || phase === aborted/completed) return;` —— idle 直接 return。
- `input`（L288）、各 `turn_end`：同理只在活跃 plan 上动作。

结论：**idle 时工具面从未被 plan-flow 触碰**，停留在"扩展加载后含 plan_write 的全量集"。

**R3：idle 分支本身不排除 plan_write**

`extensions/shared/plan-helpers.ts` `getAllowedToolsForState`：

```
} else {
    // idle / completed / aborted / unknown → restore the user's tool set.
    for (const tool of previousActiveTools) base.add(tool);
}
```

`previousActiveTools` 是进入 plan 之前快照的"用户原始工具集"，而 plan_write 是扩展 `registerTool` 注入的、**不经过 previousActiveTools** 的工具。于是"还原用户工具集"这个语义在 idle 分支里是失真的：它没还原出"没有 plan_write 的那个状态"，因为那个状态在扩展加载那一刻就已经不存在了。

**R4：idle/no-active-plan 的 `plan_write` 运行时结果不干净**

`extensions/plan-flow/index.ts` L321-324 注释明确写了 "NEVER block plan_write"，理由是中途 stale call 被 block 后会在冻结工具面上反复重试。深度 review 后确认这个理由对 idle 同样成立：不应在 `tool_call` guard 里 block `plan_write`。真正的问题是 idle/no-active-plan 下 `plan_write.execute()` 仍然 `throw`，浪费整个 turn；它应返回 `terminate: true` 的干净 result，并让下一轮暴露正确工具面。

**R5：泄漏不止在"全新 idle"，`executing` 与 completed/aborted 还原路径同样漏**

同一个 `previousActiveTools` 快照污染（快照在 `index.ts:1176` 于工具注册*之后*取得，本就含 `plan_write`）会沿三条路复现泄漏，不只 fresh idle：

- **`executing` 阶段**：`plan-helpers.ts:134-136` 执行期是 `for (const tool of previousActiveTools) base.add(tool)` + todo tools，于是 `plan_write` 在执行期又回到 active set（虽会被 wrong-phase 终止，但仍"不该可见却可见"）。
- **completed / aborted 还原**：`abortPlan`（`index.ts:763`）与 `closePlan`（`index.ts:778`）都做 `pi.setActiveTools(state.previousActiveTools)`。快照含 `plan_write`，所以**一个 plan 跑完或中止后，active set 直接把 `plan_write` 还回来**。

这很可能正是用户实际撞到的场景：本会话先前跑过一个 plan 并 completed，之后在正常对话里 `plan_write` 仍可见——并非"全新 idle"，而是"plan 收尾后的 idle"。结论：减法式、不信快照的工具面推导必须是**全局不变量**，覆盖 idle / executing 还原 / abort / close 四处，而不只是 idle 专项。

### 与 pi-mode 的对照（`Luan-Vn4/pi-mode`）

pi-mode 的核心机制，恰好是本 incident 缺的三件事：

1. **mode 是工具面的唯一真源，每轮在 `before_agent_start` 重新推导。** 不是"进入特殊模式才收窄"，而是 ask/plan/agent **每个** mode 都有显式工具策略。不存在"没有 mode"的状态——idle 就是 ask 或 agent。
2. **非法调用需要兜底 + 清晰语义。** pi-mode 用 `tool_call` guard 返回 `block: true` + 可读 `reason`；但 yuki 的 `plan_write` 已有“blocked call 无 `terminate` 会导致重试循环”的特殊教训，所以 plan_write 不照搬 guard-block，而是在 execute 层返回 terminating result。
3. **`get_pi_mode` 自省工具。** 让 LLM 在不确定时先问"我现在在哪个 mode"，而不是盲调试错。

pi-mode 的方向是 **"默认全禁 + 按 mode 放开"**；yuki plan-flow 是 **"默认全放 + 有 plan 才收窄"**。后者正是泄漏来源。

---

## 统一修复方案

两个 incident 共享同一修复哲学：**让 plan_write 的错误语义指向真因，并从源头/接口形态上不让问题发生。** 按三条线组织。

### 线 A：让错误语义指向真因（但只在正确层修）

**A1：截断诊断降级为运行时 hook 调研项**（来自 Incident 1）

深度 review 后确认：Incident 1 的 `must have required properties ...` 报错发生在 tool `parameters` schema 校验阶段，早于 `plan_write.execute()`。因此 plan-flow handler 当前拿不到 schema 非法 / 被截断的 payload，无法在“进入 schema 校验之前”自行检测截断。

行动调整：

- A1 不再作为 plan-flow 内部的立即可交付项。
- 2026-06-22 调研结果：`ToolDefinition.prepareArguments(args)` 是 per-tool、schema validation 前的兼容 shim，可用于把已解析的 raw args 规范化；但 docs/types 未暴露全局“schema validation failed”事件或统一 error formatter，`tool_call` hook 也发生在已形成 tool call 之后，不能拦截所有参数校验失败。
- 因此本轮不承诺统一重写 runtime validation error；Incident 1 的 plan-flow 侧真修复是 B2（steering 预算，预防）与 C2（skeleton/patch/full，结构性）。
- 由于 C2 已把 `plan_write` schema 改为兼容 skeleton/patch/full，并让 full 模式的必填缺失进入 `execute()` 内的清晰错误，原先 “must have required properties” 的主要触发面已经缩小；若未来仍需要处理 malformed JSON / 通用 schema error，应在 pi/pi-ai runtime 层新增正式 hook。

**A2：丢弃 idle 下 `tool_call` guard-block，改为 no-active-plan 的 terminating result**（来自 Incident 2）

深度 review 后确认：`extensions/plan-flow/index.ts` 已有注释说明 `plan_write` 不能被 `tool_call` guard block。blocked tool call 返回 error result 且无 `terminate`，模型可能在冻结的 mid-turn 工具面上反复重试，重新制造循环。

正确修法：

- 保留“永不 block `plan_write`”的不变量。
- B1 负责把 `plan_write` 从 idle 工具面移除。
- 若仍出现 stale / hidden / 旧 turn 中的 idle `plan_write` 调用，`plan_write.execute()` 不应 `throw`，而应返回 `terminate: true` 的干净结果。
- 由于 idle/no-active-plan 没有完整 `PlanFlowState`，应新增类似 `buildNoActivePlanResult()` 的 helper，而不是复用需要 state 的 `buildWrongPhaseResult()`。

**待验证假设**：这条退路依赖 runtime 会把"已注册但不在 active set"的 `plan_write` 调用照样派发到 `execute()`，而不是在 execute 之前用通用错误拒掉。现有 wrong-phase 终止逻辑已隐含依赖此行为，所以大概率成立——但实施前应显式确认。若 runtime 改为对 inactive-but-registered 工具提前拒绝，`buildNoActivePlanResult()` 这条退路会失效，需另寻 hook。

结果语义应明确告诉模型：当前是 normal/idle mode，没有活跃 plan；本 turn 结束，下一轮会暴露正确工具面。

### 线 B：从源头不让问题发生（立即/一周内做）

**B1：idle 也是一种工具面策略，且必须是减法式策略**（来自 Incident 2，根因修复）

让"无活跃 plan"成为显式 mode，而不是 early-return 的盲区。但 idle 工具面推导只能做**减法**：

```
idleAllowedTools = pi.getActiveTools().filter((tool) => !PLAN_MUTATING_TOOLS.has(tool))
```

但 executing 不能直接从当前 restricted tools 推导，否则可能丢掉 edit/bash 等正常执行工具。应区分两类输入：

- `currentTools`：当前真实 active set，用于 idle 纯减法，避免覆盖其他扩展动态加入的工具。
- `ambientTools` / `previousActiveTools`：进入 plan 前的用户工具面，用于 executing 恢复正常工具 + todo tools；它不可信任为“干净”，必须先 strip plan mutating tools。

建议规则：

```
stripPlanMutatingTools(tools) = tools.filter((tool) => !PLAN_MUTATING_TOOLS.has(tool))
idleTools = stripPlanMutatingTools(currentTools)
executingBaseTools = stripPlanMutatingTools(state.previousActiveTools ?? currentTools)
executingTools = union(executingBaseTools, TODO_TOOLS)
```

硬不变量：

- `session_start` / `before_agent_start` / `input` / `turn_end` 的非活跃分支不要直接 return，必须应用 idle mode surface。
- idle 下只移除 plan mutating tools（如 `plan_write`），绝不重建一整套“默认工具”。
- 不依赖 `previousActiveTools` 快照；该快照在扩展注册工具之后取得，本身可能已经包含 `plan_write`。
- `get_plan_mode_status` / 只读 status 工具不能放进 `PLAN_MUTATING_TOOLS`，否则 idle 减法会把自省入口也删掉。
- **减法不变量必须覆盖全部还原路径，不止 fresh idle**（见根因 R5）：
  - `executing` 阶段（`plan-helpers.ts:134-136`）：执行期工具面也要从 `previousActiveTools` 里剔除 plan mutating tools，避免 `plan_write` 在执行期回到 active set。
  - `abortPlan`（`index.ts:763`）与 `closePlan`（`index.ts:778`）：还原工具面时不能直接 `setActiveTools(state.previousActiveTools)`，必须先减去 `PLAN_MUTATING_TOOLS`，否则 plan 收尾后 `plan_write` 又被还回来。

原因：plan-flow 不是工具面的唯一所有者。比如 `extensions/enable-grep.ts` 会在 `session_start` 动态把 `grep` 加进 active tools；未来其他扩展也可能动态加工具。plan-mode kernel 一旦每轮无条件应用工具面，就事实上参与全局工具面管理，因此 idle 只能删自己拥有的 plan mutating tools，不能覆盖其他扩展的变更。

**B2：drafting phase 文档明确单次 plan_write 预算上限**（来自 Incident 1，一周内做）

在 plan-flow drafting steering prompt 里加预算约束。预算数字先作为待校准启发值，不写死为协议：

> 单次 plan_write 调用应显著低于当前模型 max output tokens（建议先按上限的 40%-60% 估算）。如果预计 plan 超出该体量，请：(1) 精简 background 为 5-8 行核心事实；(2) decisions 每条尽量 ≤ 80 字；(3) steps 拆为 stage（每 stage 一步），不要拆 stage.A/stage.B 多步；(4) validation 数组每步 ≤ 2 条。

把"输出预算"这件事从隐性变显性。由于 A1 需要 runtime hook 调研，B2 是 Incident 1 最便宜、最可控的近期修复。

### 线 C：接口形态演进（本迭代/下迭代）

**C1：`get_plan_mode_status` 与稳定 status protocol**（来自 Incident 2，本迭代做，高价值）

仿 pi-mode 的 `get_pi_mode`，注册一个让 LLM 自问"我现在在 plan mode 吗"的只读工具。它把"是否在 plan mode"从隐性的工具面推导，变成模型可主动查询的显式信号，阻断"盲调 plan_write 试错"这条路径——与 Incident 1 的"盲补字段试错"是同一类循环，用同一类自省能力解。

同时要把它背后的 status 形态设计成稳定协议：LLM 通过 tool 读取；扩展代码（例如 TA Harness）应通过共享 helper / 稳定 custom snapshot / 明确协议读取，而不是硬编码 plan-flow 内部 tool names 或散落扫描内部消息。

工具形态建议：

- `name: "get_plan_mode_status"`
- `parameters: {}`（无参，纯读取）
- 返回：
  - `active: boolean`
  - `phase: "idle" | "planning" | "revising" | "reviewing" | "awaiting_approval" | "executing" | "completed" | "aborted"`
  - `planId?: string`、`title?: string`、`stepCount?: number`
  - `availablePlanTools: string[]` —— 当前 mode 下实际可用的 plan 工具（idle 时为 `[]`）
  - 一句人类可读的 `guidance`，例如 idle 时 `"No active plan. To plan a task, the user must start /plan <request>. Do not call plan_write now."`
- `promptSnippet` / `promptGuidelines`：明确"当不确定是否处于 plan mode 时，先调用本工具确认，再决定是否调用 plan_write"。

关键设计点（与 pi-mode 对齐）：

1. **始终注册、始终可用**（不像 plan_write 需要收窄）。它是自省入口，本身不是 mutating 工具，在 idle 也应可见——这正是模型从"idle 状态"获取正确信号的方式。
2. **它不替代 B1 与 no-active-plan terminating result**。B1 收窄 plan_write 的可见性；stale 调用由 `plan_write.execute()` 返回 `terminate: true` 的干净结果；C1 给模型主动查询能力。三者叠加：模型"看不见 plan_write（B1）→ 若仍有旧调用则终止本 turn → 或先自省拿到 guidance（C1）"。
3. **返回值里带 `availablePlanTools`**，让模型在一条响应里既知道"现在能不能 plan"又知道"该用什么工具"，减少二次试错。
4. **cost 极低**：纯读 plan state 文件 + 序列化，无副作用，可放心让模型频繁调用。

**C2：plan_write 支持渐进式构建**（来自 Incident 1，下迭代评估，接口变更需 schema 兼容）

新增可选 `mode` 参数：
- `mode: "skeleton"` — 只要求 title + steps（每步 content/activeForm），其它字段允许 omit
- `mode: "patch"` — 在已有 plan 草稿上追加/修改单个字段（如 `field: "decisions", value: [...]`）
- `mode: "full"` — 当前行为，全量 overwrite

agent 可以先 `skeleton` 发框架（短），再 `patch` 逐段补 background / decisions / risks / 每步 validation。每次调用都在预算内，渐进收敛。

drafting phase 的语义不变："想清楚再 commit"，但实施路径从"一次想完写完"变为"一次想完分次写完"。

### 线 D：暂不做

**D1：plan_write 接受流式 / 多轮 tool_use**（来自 Incident 1）

让 `plan_write` 在 tool_use 协议层支持 "first call writes draft, subsequent calls extend"。这是 anthropic / openai tool_use 当前都不天然支持的（每个 tool_use 块独立），实施成本高。先做 C2 的"应用层渐进 mode"更现实。

### 从补丁视角改为迭代视角：plan-flow 应收敛为 plan-mode

现在的问题已经不再只是一个线性 `flow`（draft → review → approve → execute），而是一个完整的 **plan-mode runtime**：

- 当前是否处于 plan mode。
- 当前 mode 允许哪些工具。
- 每轮 prompt 如何注入 mode 语义。
- tool guard 如何兜底非法工具调用。
- LLM 如何自省当前状态。
- `plan_write` / `todo_write` 等工具在 mode 内外的权限边界。

因此后续优先级不应再按“修哪个 incident 的补丁”排序，而应按“把 plan-flow 演进成 plan-mode”的架构顺序推进。

### 迭代优先级

#### Iteration 1：Mode kernel（最高优先级）

目标：把系统从“有 plan 才收窄工具面”改成“每一轮都由 mode 推导工具面”。

要做：

1. 定义显式 mode：`idle`、`drafting`、`reviewing`、`awaiting_approval`、`executing`、`completed`、`aborted`。
2. 新增统一的 `derivePlanModeSurface(state, currentTools)`：输入 plan state 与当前 active tools，输出 allowed tools、prompt block、guidance。
3. `idle` 也必须是显式 mode，且 idle 工具面是硬不变量：`currentTools - PLAN_MUTATING_TOOLS`，只删 plan mutating tools，不重建全局工具面。同一减法不变量必须覆盖 `abortPlan`、`closePlan`（见根因 R5），不能只修 idle。
4. `executing` 从 sanitized ambient tools 推导：`stripPlanMutatingTools(state.previousActiveTools ?? currentTools) + TODO_TOOLS`。不能直接信任 `previousActiveTools` 干净，也不能只从当前 restricted tools 推导。
5. `derivePlanModeSurface` 放进 pure 的 `extensions/shared/plan-helpers.ts`，按现有 `getAllowedToolsForState` 的模式写单测。
6. 在 `session_start` / `before_agent_start` / `input` / `turn_end` 等入口无条件应用 mode surface；事件接线保持薄层。

这取代原来的 B1：它不是“修 idle 泄漏”的补丁，而是 plan-mode 的底座。

#### Iteration 2：Mode contract / terminating result / introspection

目标：让 LLM 清楚知道“我现在在哪个 mode、能做什么、不能做什么”。

要做：

1. 继续保持 `plan_write` 不被 `tool_call` guard block；idle/no-active-plan 的 stale 调用由 `plan_write.execute()` 返回 `terminate: true` 的 `buildNoActivePlanResult()`。
2. 新增只读自省工具 `get_plan_mode_status`（替代原建议名 `get_plan_flow_status`），返回 `mode`、`active`、`phase`、`availablePlanTools`、`guidance`。
3. 把 `get_plan_mode_status` 背后的返回形态作为稳定 plan-mode status protocol；LLM 通过 tool 读，扩展代码通过共享 helper / 稳定 snapshot / 明确协议读。
4. `before_agent_start` 注入短 mode prompt：当前 mode、可用 plan tools、禁用 plan tools、切换方式。

这吸收修正后的 A2 + C1，并与 pi-mode 的 mode contract 对齐；关键区别是不用 guard-block 制造冻结工具面的重试循环。

#### Iteration 3：plan_write UX 稳定化

目标：解决 plan authoring 的体量和错误语义问题。

要做：

1. drafting prompt 加单次 `plan_write` 体量预算和精简规则；预算按模型 max output tokens 的比例表达，行数/字数只作为待校准启发值。
2. A1 调研结论：目前仅发现 per-tool `prepareArguments`，未发现可由扩展统一接管的 schema-validation-failed hook；本轮不做 runtime error formatter。

这吸收修正后的 B2 + A1。B2 是近期可控修复；A1 若要覆盖 malformed JSON / 通用 schema error，仍需 pi/pi-ai runtime 层提供正式 hook，优先级低于 C2 的结构性 API 演进。

#### Iteration 4：plan_write API 演进

目标：让大 plan 不必一次性写完。

评估新增：

- `mode: "skeleton"`：只写 title + steps 骨架。
- `mode: "patch"`：对已有 draft 追加/修改局部字段。
- `mode: "full"`：保持现有全量覆盖行为。

这对应原来的 C2，属于接口形态变更，需要 schema 兼容、迁移和测试，不应与前两轮架构修复混在一起。

#### Iteration 5：命名迁移

目标：把用户概念从 plan-flow 迁移到 plan-mode。

策略：

1. 先区分两类名字：
   - **可 alias 的装饰性 / 进程内名字**：目录名、函数名、命令文案、`startPlanFlow` / `startPlanMode` wrapper。
   - **不可随意改的落盘协议**：`customType` 字符串、`phase` 枚举值、`phase === "executing"` 语义、`todoListId` / `planId` / step-to-todo 映射。
2. 新文档、新 prompt、新工具名优先使用 `plan-mode`。
3. 旧的 `plan-flow` 入口名短期保留 alias，便于跨仓库分阶段验证。
4. 无 dual-read/dual-write 过渡期时，绝不重命名序列化 `customType`，绝不改 `phase` / `"executing"` 等已落盘枚举。
5. 等 mode kernel 与跨仓库 status protocol 稳定后，再统一重命名目录、函数、文档与命令描述。

不建议第一步就全量机械 rename；应先把系统真正做成 mode system，并把持久化协议当作跨仓库契约保护起来，再迁移名字。

#### Cross-repo impact：`sw_project_trunk_02/.pi/extensions` 可随 plan-mode 一起迭代

`G:/Project/SkyWalker/sw_project_trunk_02/.pi/extensions` 中存在与当前 plan-flow 的耦合。由于该仓库代码也可修改，迁移策略不必只靠长期兼容 alias；可以把它作为 plan-mode 迁移的一部分同步演进。

已识别耦合点：

1. **入口耦合：`.pi/extensions/ta-dev/index.ts`**
   - 动态定位并 import `yuki-pi/extensions/plan-flow/index.ts`。
   - 调用 `startPlanFlow(pi, ctx, { request, planningContext })`。
   - fallback 使用 `/plan --context ...`。
   - 文案多处写 `yuki plan-flow`。
   - plan-mode 迁移时应同步改为 `extensions/plan-mode/index.ts` / `startPlanMode` / plan-mode 文案；必要时短期保留 `startPlanFlow` wrapper 作为过渡。

2. **状态协议耦合：`.pi/extensions/harness-execution-policy/index.ts`**
   - 读取 `PLAN_STATE_CUSTOM_TYPE = "yuki-plan-flow-state"` 与 `TODO_STATE_CUSTOM_TYPE = "yuki-todo-state"`。
   - 依赖 plan state shape：`active`、`phase`、`planId`、`todoListId`、`steps`。
   - 依赖 `phase === "executing"` 判断只在执行期拦截 plan-owned `todo_write`。
   - plan-mode 迁移时应把这部分抽象为 plan-mode state protocol，例如 `mode === "executing"` 或兼容读取旧 `phase`，并明确 step id 与 todo id 的映射仍是协议的一部分。

3. **执行唤醒耦合：`.pi/extensions/_shared/compile-guard.ts`**
   - 读取 `"yuki-plan-flow-state"` / `"yuki-todo-state"`。
   - 维护 `PLAN_TOOL_NAMES = new Set(["plan_ask", "grill_plan", "grill_done", "plan_write", "plan_exit"])`。
   - 判断 executing plan 中是否还有未完成 todo；clean compile pass 后会 steer agent 去读取 evidence 并完成 todo。
   - plan-mode 迁移时应同步改为读取 plan-mode status/state protocol，而不是继续散落硬编码 customType、phase、tool names。

4. **弱耦合：`.pi/extensions/harness-controller/index.ts`**
   - `sensor_evidence_read` 的 prompt 里提到 `todo_write` 和 yuki-pi todo state。
   - 主要是 evidence workflow 耦合，不是 plan-flow 核心耦合；迁移时只需更新 wording。

迁移建议：

- Iteration 1/2 完成 mode kernel 与 status protocol 后，优先让 `sw_project_trunk_02` 侧改为读取 plan-mode 的稳定协议，而不是继续扫描 plan-flow 的内部 custom messages / tool result 名称。
- `get_plan_mode_status` 是 LLM 自省入口；扩展代码侧需要同源的共享 helper / 稳定 custom snapshot / 明确读取协议，不能假设可以直接“调用 LLM tool”。
- 可短期保留旧 `extensions/plan-flow/index.ts`、`startPlanFlow` 等入口 alias，以便分阶段验证；但目标不是永久兼容旧命名，而是两边代码一起迁到 plan-mode。
- 对落盘协议要更保守：无 dual-read/dual-write 过渡期时，不改 `yuki-plan-flow-state` / `yuki-todo-state` customType，不改 `phase` / `"executing"` 枚举语义。
- 将跨仓库协议显式化：status customType、mode/phase 枚举、todoListId、planId、steps、step-to-todo 映射、available plan tools，避免 TA Harness 后续继续依赖内部实现细节。

### 当前结论

新的实施顺序是：

1. **Mode kernel：每轮按 mode 推导工具面；idle 是 `currentTools - PLAN_MUTATING_TOOLS`，executing 是 sanitized ambient tools + todo tools；纯推导放 `plan-helpers.ts` 并配单测。**
2. **idle/no-active-plan 的 `plan_write`：丢弃 guard-block，改成 `terminate:true` 的干净 result。**
3. **Status tool / protocol：`get_plan_mode_status` 给 LLM 用，同源稳定 status 协议给扩展代码用。**
4. **Mode prompt 注入：每轮说明当前 mode、可用/禁用 plan tools、下一步。**
5. **B2 steering 预算：先预防过大 `plan_write`，预算数字按模型输出上限比例表达并标注待校准。**
6. **plan_write skeleton/patch/full：作为 Incident 1 的结构性解药。**
7. **A1 截断诊断：本轮调研记录 per-tool `prepareArguments` 可用，但无全局 validation-failed hook；暂不做 runtime formatter。**
8. **跨仓库迁移：区分可 alias 的名字与不可破坏的落盘协议；无 dual-read/dual-write 不改 customType 与 `phase` 枚举。**

---

## 与既有 plan-flow incident 的关系

- `plan-flow-drafting-wrong-tool-loop-2026-06-19.md`：drafting 阶段错误调用工具的 incident，已有解。Incident 1 是同一阶段的**不同失败模式**——不是调错工具，是同一工具调用 payload 过大。
- `plan-flow-design-rethink-2026-06-19.md`：drafting 阶段的总体设计反思。两个 incident 都应作为该 rethink 的输入：plan_write 接口形态需要支持渐进构建（C2），工具面模型需要从"条件收窄"转向"mode 驱动的每轮推导"（B1）。
- `plan-flow-ux-overhaul-2026-06-19.md`：UX overhaul。两个 incident 各给出一个具体 UX bug 与增强：Incident 1 的"错误消息把传输层截断误报为 schema 不符"（A1），Incident 2 的"工具在错误 mode 可见 + 缺自省能力"（B1/C1），都应纳入 overhaul 清单。

## 参考实现

- `Luan-Vn4/pi-mode`：https://github.com/Luan-Vn4/pi-mode
  - `src/extension.ts`：mode 驱动的 tool guard + `before_agent_start` 每轮注入。
  - `get_pi_mode` 工具：LLM 自省当前 mode 与可用工具（C1 的直接灵感来源）。
  - `src/mode-info.ts`：每个 mode 的 capability / prompt block / completions 集中定义。

---

## Changelog

- **2026-06-22 深度 review（已并入正文）**：A1 降级为 runtime validation hook 调研项；A2 从"idle guard-block"改为"no-active-plan 返回 terminating result"；idle 工具面定为减法式硬不变量，并扩展覆盖 `executing` 还原 / `abortPlan` / `closePlan`（根因 R5）；补充 `currentTools` vs sanitized `ambientTools` 的推导边界，避免 idle 覆盖其他扩展工具、executing 丢失正常执行工具；标注 runtime 对 inactive-but-registered 工具仍派发到 `execute()` 的待验证假设；点名 `enable-grep.ts` 共享工具面所有权；跨仓库迁移区分"可 alias 的名字" vs "不可破坏的落盘协议（customType + `phase` 枚举，dual-read 窗口）"；记录 `compile-guard.ts:78` 死工具名 drift；要求 `derivePlanModeSurface` 放 `plan-helpers.ts` 并配单测。单一真源以上文正文为准。
- **2026-06-22 runtime hook 调研**：pi extension types 暴露 `ToolDefinition.prepareArguments(args)`（schema validation 前的 per-tool shim），但未发现全局 validation-failed hook 或统一 error formatter；本轮通过 plan_write skeleton/patch/full schema 和 execute 内 runtime 校验缩小误报面。

---

## 实施验收 review（2026-06-22，代码核对后）

对实施后的代码逐条核对（yuki-pi `extensions/plan-mode/index.ts`、`extensions/shared/plan-helpers.ts`、`extensions/shared/constants.ts`、`test/plan-helpers.test.ts`、`test/plan-mode-v2-regression.test.ts`、`package.json`；sw_project_trunk_02 `.pi/extensions/ta-dev/index.ts`、`_shared/compile-guard.ts`、`harness-execution-policy/index.ts`）。`npm test` 全绿（59 pass / 0 fail）。

总评：**核心架构全部落地、测试背书充分。唯一阻断项是目录改名引发的跨仓库回归（ta-dev 解析器找不到 plan-mode）。**

### 已正确落地（逐条）

- **Mode kernel**：`derivePlanModeSurface(state, currentActiveTools)`（`plan-helpers.ts:193`）为纯函数并配单测；`getAllowedToolsForState` 新增 `currentActiveTools` 参数（`:171`）。
- **减法不变量全覆盖（R5）**：`stripPlanMutatingTools`（`plan-helpers.ts:149`）正确用于 idle 分支（`:188`）、executing 还原（`:184`）、`abortPlan`（`index.ts:900`）、`closePlan`（`index.ts:915`）。
- **每轮无条件推导**：所有非活跃分支不再 early-return，改用 `applyIdleTools(pi)`（`session_start:251`、`before_agent_start:283`、`input:311`、`turn_end:360/365`、`session_tree:274`）。
- **自省工具不自删**：`PLAN_STATUS_TOOL` 始终入 base set（`:177`），不在 `PLAN_MUTATING_TOOLS` 内。
- **terminating result（A2）**：`:473` 的 `throw` 已改为 `buildNoActivePlanResult`（`index.ts:521-524`，`terminate:true`）；`tool_call` 保留 "NEVER block plan_write"（`:335-342`）；新建独立 helper 而非复用 `buildWrongPhaseResult`。
- **status + prompt 注入**：`get_plan_mode_status`（`:478`）、`buildPlanModeStatus` 同源协议（`plan-helpers.ts:207`）、`buildPlanModePrompt` 经 `context` 每轮注入且 idle 也注入（`:297-304`）。
- **B2 预算**：`PLAN_WRITE_BUDGET_GUIDANCE`（`:20`）按 max output tokens 的 40%-60% 比例表达。
- **C2 skeleton/patch/full**：`applyPlanWrite`（`:763`）全实现；skeleton/patch 不 terminate，仅 full 提交 review 才 `terminate`（`:549`）。
- **落盘协议保护**：`customType` 两边均未改（仍 `yuki-plan-flow-state`）；`compile-guard.ts:74` 注释显式记录 "keep ... until dual-read/dual-write migration"；顺带把 `PLAN_TOOL_NAMES` 从五个死名收敛为 `{plan_write}`（`compile-guard.ts:80`），修掉了之前发现的 drift。

### 阻断项：ta-dev 跨仓库解析器未跟随目录改名（必须修）

`2de6138 refactor(plan-mode): rename extension directory` 把 yuki-pi 目录从 `plan-flow` 改成 `plan-mode`，但：

- yuki-pi 侧已**不存在** `extensions/plan-flow/` 目录。
- sw 侧 `ta-dev/index.ts:217` 仍按 `join(pkgDir, "extensions", "plan-flow", "index.ts")` + `existsSync` 定位，找不到即 `continue` → `loadStartPlanFlow()` 永远返回 `undefined`。

后果：`/ta-dev` 永久退回 fallback editor-prefill 路径（即 incident #1 抱怨的"要按两次回车"旧路径）。这正是正文 Cross-repo 小节要求"plan-mode 迁移同步改 ta-dev 入口"的那一条，但只改了 yuki-pi 单边。注意：yuki-pi 保留了 `startPlanFlow` **导出名** alias（`index.ts:1301`），但 sw 侧按**目录路径**定位，导出名兼容救不了路径失配。

修复（小）：ta-dev `loadStartPlanFlow` 应同时探测 `extensions/plan-mode/index.ts` 与 `extensions/plan-flow/index.ts`，任一存在即用。

### 小问题（非阻断）

1. `getConvergenceKick` 文案残留 `yuki plan-flow`（`plan-helpers.ts:283`），其余文案已迁 `plan-mode`；纯 wording。
2. `PLAN_KICK_CUSTOM_TYPE` 等仍为 `yuki-plan-flow-*`（`index.ts:17-19`）——属落盘协议，**故意保留正确**，但建议加注释说明"故意保留旧名，待 dual-read 迁移"，免后人误判为漏改。
3. README / docs 抽查：确认面向用户的命令/路径不再引用 `plan-flow` 目录。

### 收尾建议

1. 修 ta-dev 解析器（阻断项）。
2. 清理两处 `plan-flow` wording（小问题 1、2）。
3. 给保留的旧 customType 加"故意保留"注释。
