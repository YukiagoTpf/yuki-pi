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

**R4：tool_call guard 对 idle 没有覆盖**

`extensions/plan-flow/index.ts` L321-324 注释明确写了 "NEVER block plan_write"，理由是中途 stale call 被 block 后会在冻结工具面上反复重试。这个理由对 **plan 活跃但 wrong-phase** 成立，但被无差别套到了所有情况上。idle 时没有"冻结的 mid-turn tool surface"问题——此时本该 block 并给清晰语义，代码却没有这个分支。

### 与 pi-mode 的对照（`Luan-Vn4/pi-mode`）

pi-mode 的核心机制，恰好是本 incident 缺的三件事：

1. **mode 是工具面的唯一真源，每轮在 `before_agent_start` 重新推导。** 不是"进入特殊模式才收窄"，而是 ask/plan/agent **每个** mode 都有显式工具策略。不存在"没有 mode"的状态——idle 就是 ask 或 agent。
2. **`tool_call` guard 作为兜底 + 清晰 `reason`。** 模型若在冻结工具面上偷调被禁工具，guard 返回 `block: true` + 可读 `reason`，而不是让工具执行后 throw。模型拿到的是"这个工具在当前 mode 不可用"，不是"运行时错误"。
3. **`get_pi_mode` 自省工具。** 让 LLM 在不确定时先问"我现在在哪个 mode"，而不是盲调试错。

pi-mode 的方向是 **"默认全禁 + 按 mode 放开"**；yuki plan-flow 是 **"默认全放 + 有 plan 才收窄"**。后者正是泄漏来源。

---

## 统一修复方案

两个 incident 共享同一修复哲学：**让 plan_write 的错误语义指向真因，并从源头/接口形态上不让问题发生。** 按三条线组织。

### 线 A：让错误消息指向真因（立即做，小工程，阻断体感）

**A1：plan_write 错误消息加上"截断检测"**（来自 Incident 1）

在 plan_write tool handler 进 schema 校验之前，先检查输入字符串/对象有没有截断迹象：

- 字符串字段以中文标点、半个字符、未闭合括号、未闭合引号收尾
- 数组最后一项是字符串且明显语义未完
- top-level object 同时缺多个 required field（不是单个）

任一命中 → 错误消息明确指："你的 plan_write 调用看起来在传输层被截断（received 缺失 N 个 required 字段，最后字段在 `decisions[5]` 半句中断）。请把 plan 拆成更短的 background / decisions / risks 后再试，或减少 steps 数量。"

agent 看到这条消息会立刻调整策略，而不是补字段重发。半天工程，阻断 75% 同类 incident 的体感。

**A2：tool_call guard 区分 stale-call 与 idle-call**（来自 Incident 2）

保留 L321-324 对 **plan 活跃但 wrong-phase** 的放行逻辑（理由成立），新增 **无活跃 plan** 分支：

```
if (PLAN_TOOLS.has(event.toolName)) {
    const state = reconstructPlanState(ctx);
    if (!state?.active || state.phase === "aborted" || state.phase === "completed") {
        return {
            block: true,
            reason: "plan_write only available inside an active yuki plan-flow (start with /plan <request>). You are in normal mode — use read/grep/edit/write/bash and the todo tools instead.",
        };
    }
    consecutiveBlockedToolCalls = 0;
    return;
}
```

这是 pi-mode 的 ask/agent guard 模式：给模型清晰语义，让它停下来改用普通工具，而不是 throw 后空耗一个 turn。与 A1 同理——错误消息指向"mode 不符"而非"运行时异常"。

### 线 B：从源头不让问题发生（立即/一周内做）

**B1：idle 也是一种工具面策略**（来自 Incident 2，根因修复）

让"无活跃 plan"成为显式状态，而不是 early-return 的盲区。

- 在 `session_start` / `before_agent_start` / `input` 的非活跃分支里，**不要直接 return**，而是 `pi.setActiveTools(currentActiveTools.filter(t => !PLAN_TOOLS.has(t)))`。
- 或更彻底：`getAllowedToolsForState` 的 idle 分支改为"返回 previousActiveTools **减去** PLAN_TOOLS"，并在所有事件里**无条件**调用 `applyActiveTools`（含 idle）。这样 idle 的工具面也由 plan-flow 显式推导，和 pi-mode 的"每轮重新推导"对齐。

实施注意：`previousActiveTools` 快照在首次会话时可能本就不含 plan_write（因为快照在 `/plan` 命令里取，那时扩展已注册），需确认快照语义。稳妥做法是直接对"当前 active tools"做减法，而非依赖快照。

**B2：drafting phase 文档明确单次 plan_write 预算上限**（来自 Incident 1，一周内做）

在 plan-flow drafting steering prompt 里加：

> 单次 plan_write 调用建议 JSON body < 6k tokens。如果你预计 plan 超出该体量，请：(1) 精简 background 为 5-8 行核心事实；(2) decisions 每条 ≤ 80 字；(3) steps 拆为 stage（每 stage 一步），不要拆 stage.A/stage.B 多步；(4) validation 数组每步 ≤ 2 条。

把"输出预算"这件事从隐性变显性。配合 A1 的错误消息，agent 能从两端学到。

### 线 C：接口形态演进（本迭代/下迭代）

**C1：`get_plan_flow_status` 自省工具**（来自 Incident 2，本迭代做，高价值）

仿 pi-mode 的 `get_pi_mode`，注册一个让 LLM 自问"我现在在 plan mode 吗"的只读工具。它把"是否在 plan mode"从隐性的工具面推导，变成模型可主动查询的显式信号，阻断"盲调 plan_write 试错"这条路径——与 Incident 1 的"盲补字段试错"是同一类循环，用同一类自省能力解。

工具形态建议：

- `name: "get_plan_flow_status"`
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
2. **它不替代 B1/A2**。B1 收窄 plan_write 的可见性，A2 兜底 block，C1 给模型主动查询能力。三者叠加：模型"看不见 plan_write（B1）→ 若仍想调被 block（A2）→ 或先自省拿到 guidance（C1）"。
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

### 修复优先级

1. **A1 + B1 + A2** 立即做（同批，封死两类体感的主路径与兜底）。
2. **B2** 一周内做（drafting steering prompt 加一段）。
3. **C1** 本迭代做（高价值，阻断盲调试错循环，与 pi-mode 对齐的自省能力）。
4. **C2** 下个迭代评估（接口形态变更，需要 schema 兼容）。
5. **D1** 暂不做。

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
