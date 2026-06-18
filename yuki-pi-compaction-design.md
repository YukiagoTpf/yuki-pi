# Yuki-Pi Compaction 设计方案（v3）

## 设计目标

Pi 要用于 goal 级别的长线工作（跨几十轮甚至上百轮对话），压缩系统的核心需求是：
1. **目标不丢** — 无论压缩多少次，用户的原始 goal、约束、偏好必须完整保留
2. **进展可追** — 已完成/进行中/阻塞的任务状态在压缩后清晰可见
3. **决策不忘** — 关键架构决策和"为什么这么做"的原因不能被摘要蒸发掉
4. **成本可控** — 不能每次压缩都消耗大量 token（goal 任务压缩频率高）
5. **可恢复** — 被压缩掉的历史信息不应永久丢失，需要时可追溯

---

## 架构：三层压缩体系

```
Layer 0: Prune（无 LLM 调用，纯规则修剪，含 intra-turn 修剪）
    ↓ 释放空间不足 targetFreeRatio
Layer 1: Structured Compact（轻量 LLM 调用，增量锚定摘要）
    ↓ 摘要超出预算 OR 世代计数器 > 5
Layer 2: Deep Compact（延迟执行的受控重摘要，重置累积误差）
```

---

## 全局 Token Budget Allocator

所有压缩组件共享统一预算，**按优先级分配**，总占用目标不超过 `usableWindow * budgetRatio`：

```typescript
interface BudgetAllocation {
  // 按优先级从高到低排列（紧张时低优先级先让步）
  pinnedGoal: number;          // P0: Goal 原文（~500）
  pinnedConstraints: number;   // P0: Constraints（~500）
  planStatus: number;          // P1: Plan/Todo 状态（~1K）
  decisions: number;           // P1: Decision Log（~1.5K，独立预算）
  projectContext: number;      // P2: AGENTS.md 等（~2.5K）
  summary: number;             // P2: LLM 摘要（弹性，上限 summaryMax）
  workingMemory: number;       // P3: 当前 step 活跃中间状态（~800）
  fileIndex: number;           // P3: 文件路径索引（~500）
  recentTail: number;          // P4: 尾部保留（剩余全部）
}

function allocateBudget(usableWindow: number): BudgetAllocation {
  // budgetRatio 语义：压缩后所有固定开销（pinned + summary + tail）占 usableWindow 的最大比例
  // 即 overhead / usableWindow 的上限。剩余的 (1 - budgetRatio) 留给新对话和模型输出安全余量。
  // usableWindow = contextWindow - systemPromptTokens - maxOutputTokens
  // 128K 级窗口用更大的比例（0.30）以保证 tail 够用，200K+ 用 0.25
  const budgetRatio = usableWindow <= 150_000 ? 0.30 : 0.25;
  const totalBudget = Math.floor(usableWindow * budgetRatio);
  
  // 固定开销（按优先级分配；P0/P1 不可压缩，P2/P3 可降级）
  // 注意：projectContext 是 compaction 后由本扩展「重新注入」的项目上下文索引（AGENTS.md 摘要等），
  // 与 Pi 原生 systemPrompt 中的 AGENTS.md 是同一信息的两条路径——为避免双重计入，
  // 见「压缩后 Context 组成示意」的口径说明：systemPrompt 内的 AGENTS.md 在 usableWindow 之外，
  // 本项仅计 compaction summary 内重注入的精简索引。
  const fixed = {
    pinnedGoal: 500,
    pinnedConstraints: 500,
    planStatus: 1000,
    decisions: 1500,
    projectContext: 2500,
    workingMemory: 800,
    fileIndex: 500,
  };
  const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0); // 7300
  
  // 弹性开销：先保留至少 20% totalBudget 给 tail，小窗口下 summary 自动让步
  const minTail = Math.floor(totalBudget * 0.20);
  const maxSummaryByWindow = Math.min(8000, Math.floor(usableWindow * 0.05));
  const availableForSummary = Math.max(0, totalBudget - fixedTotal - minTail);
  const summary = Math.min(maxSummaryByWindow, availableForSummary);
  const recentTail = Math.max(0, totalBudget - fixedTotal - summary);
  
  return { ...fixed, summary, recentTail };
}

// 200K context / ~184K usable → total 46K: fixed 7.3K + summary 8K + tail 30.7K
// 128K context / ~112K usable → total 33.6K: fixed 7.3K + summary 5.6K + tail 20.7K
// 上述 total（overhead）不含 Pi 原生 systemPrompt + AGENTS.md（在 usableWindow 之外）。
// recentTail 是否能精确落地取决于 Phase 0：若 CompactionResult.firstKeptEntryId
// 不能使用扩展自选 cut point，则 recentTail 必须与 Pi settings.compaction.keepRecentTokens 对齐。
```

**优先级降级规则**：当实际 token 超出某项预算时，从最低优先级开始压缩：
1. 先缩减 fileIndex → 2. 缩减 workingMemory → 3. 缩减 summary → 4. 缩减 projectContext
5. pinnedGoal / pinnedConstraints / planStatus / decisions 永不缩减

**硬约束冲突处理**：如果 P0/P1 本身已经超过 `totalBudget`，优先保证不丢目标/约束/计划/决策，允许压缩后 overhead 临时超过 `budgetRatio`，并记录 debug warning；下一轮通过裁剪 projectContext/summary/tail 恢复。

---

## 迟滞机制（防震荡）

```typescript
interface HysteresisConfig {
  // 触发压缩的阈值（上水位）— 基于 usableWindow 而非 raw contextWindow
  triggerRatio: number;         // default: 0.85
  // 压缩后的目标（下水位）
  targetFreeRatio: number;      // default: 0.40
  // 两次完整压缩（Layer 1+）之间的最小间隔
  minTurnsBetweenCompacts: number;  // default: 5
  // 紧急 Prune 阈值（即使未满最小间隔也允许 Layer 0）
  emergencyPruneRatio: number;  // default: 0.92
}

// usableWindow = contextWindow - systemPromptTokens - maxOutputTokens
function getUsableWindow(contextWindow: number, systemTokens: number, maxOutput: number): number {
  return contextWindow - systemTokens - maxOutput;
}
```

**触发落地注意**：Pi 原生 auto-compaction 的触发条件是 `contextTokens > contextWindow - reserveTokens`，`session_before_compact` 只会在 Pi 已经决定 compact 时触发。因此本扩展需要在 `turn_end` / `agent_end`（或低成本 `context` hook）中主动读取上下文用量，达到 `triggerRatio` 时调用 `ctx.compact()`，才能实现本节的上下水位策略。用量读取统一走**入库口径**（见「Prune 与触发口径统一」）：优先用 `ctx.getContextUsage()`，若 Phase 0 确认其返回的是经 `context` hook 变换后的发送量，则改用 `estimateContextTokens` 对入库 entry 自算，避免被 runtime prune 干扰。

**最小间隔语义**：`minTurnsBetweenCompacts` 只限制扩展主动触发的 Layer 1+ compact；如果 Pi 原生 auto-compaction 已经触发，说明上下文接近硬上限，不能因为间隔未满而取消释放空间，必须至少执行 aggressive prune 或 structured compact 兜底。

**紧急逃逸阀**：当间隔未满 5 turns 但已达 `emergencyPruneRatio`（0.92）时，允许执行 Layer 0 runtime prune / pre-store prune（不计入间隔计数）。如果 Pi 已经进入 `session_before_compact`，Layer 1+ 不再受最小间隔阻塞。

---

## Prune 与触发口径统一（防会计错位）

`context` hook 的 runtime view prune 只变换**发往 LLM 的揮发视图**，不改入库 session。这会让「实际发送 token」小于「入库 token」。为避免触发判断与增量会计相互打架，统一约定：

- **触发与增量会计一律按「入库口径」（store-based）**：
  - 触发判断使用入库消息的 token 估算（或 `getContextUsage()` 的入库口径，取决于 Phase 0 结论），**不**用 runtime prune 后的发送量。这样 runtime prune 只负责省钱（减少实际发送），不会因为「发送量被压低」而让上水位永远够不着、或反过来抑制本应触发的 compact。
  - Layer 1 的「只发新增消息」增量会计，其「新增」边界以**入库 entry 的 turn/index** 为准（`lastCompactTurnIndex` ~ 当前 leaf），与 runtime prune 无关。runtime prune 只在最终发送前再压一次文本，不改变「哪些 entry 算新增」。

- **两次缩小不互相抵消**：
  - runtime prune（揮发）与 Layer 0 pre-store prune（持久）作用对象不同：pre-store 已经把入库内容压小，runtime 只在其基础上对仍然超阈值的 block 再做发送期压缩。对**同一个已 pre-store 压缩过的 block**，runtime prune 不再重复压缩（通过 block meta 标记 `prunedAtStore=true` 跳过）。
  - compaction discard（持久丢弃旧历史）发生后，被丢弃 entry 不再进入入库 token 统计，触发口径自然回落；runtime prune 不参与该统计。

- **Phase 0 依赖**：若 Phase 0 确认 `getContextUsage()` 返回的是「经 `context` hook 变换后的发送量」而非入库量，则触发判断改为**自行用入库 entry 估算**（`estimateContextTokens`），不直接用 `getContextUsage()` 的百分比，以保持本节口径一致。


## Layer 0: Prune（工具输出修剪）

Layer 0 分三条落地路径，避免误以为可以在 compaction hook 中就地修改历史 entry：

1. **Pre-store prune（持久）**：在 `tool_result` hook 中压缩超大工具输出，结果入库前就减小体积；对不可重现输出先落盘完整副本（见下）。
2. **Runtime view prune（非持久）**：在 `context` hook 中只变换发往 LLM 的 `messages`，不改 session 文件。
3. **Compaction discard（持久）**：在 `session_before_compact` 返回 `CompactionResult`，通过 `summary + firstKeptEntryId` 丢弃旧历史；不能就地改写旧 tool result。

### Pre-store Full Output Archive

Pre-store prune 会在内容入库前丢弃一部分工具输出，因此它必须自己承担可恢复性：

```typescript
interface ToolOutputArchiveRef {
  path: string;       // .pi/yuki/tool-output/{toolCallId}-{sha256}.txt
  sha256: string;
  bytes: number;
  toolName: string;
  createdAt: string;
}
```

规则：
- 对可重现输出（`read` 文件、可重新执行且无副作用的搜索）可只保留重读提示。
- 对不可重现或高价值输出（命令输出、远端/API 返回、临时生成内容、大 grep 结果）先把完整内容写入 `.pi/yuki/tool-output/`，tool result 中保留 `ToolOutputArchiveRef`。
- runtime prune 看到 archive ref 时保留 ref，不再二次丢弃恢复线索。
- tool-output archive 与 compaction-history 一样定位为灾难恢复；失败只降级为普通截断并记 debug warning。
- tool-output archive 与 compaction-history 共用同一个单线程 background archive queue，避免并发写文件/索引竞争。

### 触发条件

- 主动触发：`contextTokens > usableWindow * triggerRatio`
- 紧急 runtime prune：`contextTokens > usableWindow * emergencyPruneRatio`
- 单条工具输出：`content.length > intraTurnPruneThreshold` 或超过工具类型阈值

### Content-Type Aware 修剪策略

不同类型的 content 使用不同的修剪方式。Runtime view prune 必须保持 provider 消息合法性：不能删除仍被 assistant tool call 引用的 tool result，也不能打乱 tool call / tool result 配对，只能压缩 content block 文本。

```typescript
interface PruneStrategy {
  // 动态保护范围
  protectSince: 'current_plan_step' | 'fixed_turns';
  protectRecentTurns: number;       // fallback default: 5
  minPrunableChars: number;         // default: 2000
}

// 按 content type 分发修剪策略
function pruneContentBlock(block: ContentBlock, meta: BlockMeta): string {
  switch (classifyBlock(block)) {
    case 'file_read':
      // 文件读取：只保留路径 + 行数 + 前3行（可重新读取）
      return `[File: ${meta.filePath} (${meta.lineCount} lines)]\n${meta.firstLines}\n[...re-read file if needed]`;
    
    case 'command_output':
      // 命令输出：保留命令 + exit code + 关键行（error/warning）
      return `[Command: ${meta.command} → exit ${meta.exitCode}]\n${extractKeyLines(block, 5)}`;
    
    case 'code_edit':
      // 代码编辑：保留文件路径 + 变更行范围 + 变更意图
      return `[Edit: ${meta.filePath} lines ${meta.startLine}-${meta.endLine}] ${meta.editIntent}`;
    
    case 'search_result':
      // 搜索结果：保留查询 + 匹配文件数 + 前2个匹配
      return `[Search: "${meta.query}" → ${meta.matchCount} matches]\n${meta.topMatches.slice(0, 2).join('\n')}`;
    
    case 'conversation':
      // 对话消息：保留完整（由 Layer 1 处理）
      return block.content;
    
    default:
      // 默认：头尾保留
      return `${block.content.slice(0, 150)}\n[...pruned ${block.content.length} chars...]\n${block.content.slice(-100)}`;
  }
}
```

### Intra-Turn Pruning

即使 turn 在保护范围内，tool_result 中超过 `intraTurnPruneThreshold`（default: 8000 chars）的 content block 也可以被部分修剪：

```typescript
interface IntraTurnPruneConfig {
  enabled: boolean;                  // default: true
  threshold: number;                 // default: 8000 chars
  // 保护最近 1 个 turn 完全不做 intra-turn prune
  absoluteProtectLastN: number;      // default: 1
}
```

这解决了"一次并发读 5 个大文件"占 40K+ tokens 的问题。

---

## Layer 1: Structured Compact（增量锚定摘要）

### 触发条件

进入压缩流程（由 `turn_end` 上水位 `triggerRatio` 主动触发，或 Pi 原生/紧急路径触发）后，先跑 Layer 0 prune；若 Layer 0 后入库占用仍高于**下水位目标**，才升级到 Layer 1。统一用一条数轴描述三个口径（均按入库 token / usableWindow）：

```
0%                         (1−triggerRatio)        targetFreeRatio
 |                              空闲                    |
低空闲 ←———————————————————————————————————————————————→ 高空闲
 |                  |                    |
 ↑ emergencyPrune   ↑ trigger 上水位      ↑ 压缩后下水位目标
   freeRatio<0.08     freeRatio<0.15       freeRatio≥0.40
   (=usage>0.92)      (=usage>0.85)        (=usage≤0.60)
```

- **上水位（进入压缩）**：`storeTokens > usableWindow * triggerRatio`（0.85，≈156K@200K）。`turn_end` 据此主动 `ctx.compact()`。
- **下水位（压缩目标 / 是否升 Layer 1）**：压缩后要把入库占用降到 `usableWindow * (1 - targetFreeRatio)` 以下（targetFreeRatio=0.40 → 目标 usage ≤ 0.60，≈110K@200K）。**Layer 0 prune 后若 `storeTokens` 仍 > 该目标线（110K），才进入 Layer 1**；若 Layer 0 已把占用压到目标线以下，则本轮不调用 LLM，按触发来源返回（见下）。
- 即：156K 触发进入流程 → Layer 0 尽量往 110K 压 → 仍 >110K 则 Layer 1 接管把它压到 ≤110K。三个数互相咬合，无歧义。

**Layer 0-only 返回行为**：
- 若本轮是 Yuki 主动 `ctx.compact()` 触发，且 Layer 0 后已低于下水位：返回 `{ cancel: true }`，不写 compaction entry，避免制造空摘要。
- 若本轮是 Pi 原生 auto-compaction 或紧急路径触发：不能简单 cancel；返回 no-LLM `aggressivePruneToCompactionResult`，用 pinned sections + previous summary 生成合法 `CompactionResult`，确保硬上限压力被释放。

### 核心设计：State-Driven + LLM-Generated + Working Memory

摘要分三部分：
- **State-Driven（从 extension state 直接注入，LLM 不碰）**：Goal、Constraints、Plan Progress、Decision Log
- **LLM-Generated（由 LLM 生成 volatile context）**：Critical Context、Work Progress、User Directives
- **Working Memory（当前 plan step 的活跃中间状态）**：随 step 推进清空重写

```typescript
function buildCompactedContext(state: ExtensionState, llmSummary: string): string {
  const pinned = buildPinnedSections(state);        // State-Driven
  const memory = buildWorkingMemory(state);         // Working Memory
  return `${pinned}\n\n${memory}\n\n---\n\n${llmSummary}`;
}
```

#### State-Driven Sections（从 state 注入，LLM 不碰）

```markdown
## Goal
{直接从 GoalPin 读取 — 见 Goal Pinning 章节}

## Constraints & Preferences
{从 state.constraints[] 逐条列出}
- session-level: "不要用 class，用函数式"（用户风格偏好）
- task-level: "必须兼容 Node 18"（任务约束）

## Plan Progress
{从 plan-flow 读取 plan 元信息；从 plan-owned todo state 读取 completed / in_progress / remaining}
### Completed
- [x] Phase 1: Research — turn 12
### In Progress
- [-] Phase 2: Implementation — started turn 15
### Remaining
- [ ] Phase 3: Testing

## Key Decisions
{从 DecisionLog 注入，有 token 预算限制}
- [Turn 20] **选择 PostgreSQL**: 需要 JSONB + 团队熟悉 (architecture)
- [Turn 15] **使用 monorepo**: 模块间强耦合 (architecture)
- ...and 5 earlier decisions (see .pi/yuki/decisions.log mirror)
```

#### Working Memory（当前 step 活跃状态）

专门解决"两不管地带"问题——存放 State-Driven 和 LLM Summary 都不合适管理的中间状态：

```markdown
## Working Memory (current step)
- Active error: TypeError at src/auth.ts:42 — `session.user` is undefined
- Hypothesis: middleware order issue, testing by moving authMiddleware before bodyParser
- Pending sync: changed interface in types.ts, need to update handler.ts and tests/
```

Working Memory 的特点：
- **随 plan step 推进自动清空**：进入新 step 时，上一个 step 的 working memory 被归档到 compaction history
- **由 LLM 在 Layer 1 compact 时顺便更新**（不额外调用）
- **预算小（~800 tokens）**：只记录"当前正在追踪的问题"，不是完整历史

#### LLM-Generated Sections（LLM 生成，职责收窄）

```typescript
const STRUCTURED_COMPACT_PROMPT = `
You are summarizing the VOLATILE parts of a coding session.
Goal, Constraints, Plan, and Decisions are tracked separately — do NOT include them.
Working Memory is tracked separately too, but you must output a dedicated update section for the host to parse into state.

Your job is ONLY to capture:
1. **Critical Context** — unresolved technical facts, API behaviors, env issues that persist across steps
2. **Work Progress** — implementation details not in the plan (specific functions, approaches tried/failed)
3. **User Directives** — user's task-level instructions (brief imperative form, max 100 chars each, most recent 8)

Format:
## Critical Context
- [item]

## Work Progress
- [item]

## User Directives
- [directive]

## Working Memory Update
- [current active issues for the in-progress plan step, max 3 items]

Rules:
- Bullet points only. No prose. Preserve exact file paths/function names/error messages.
- Do NOT include goal, constraints, plan status, or decisions.
- Working Memory Update is parsed into state and must NOT be copied into the persisted LLM summary.
- "(none)" if a section is empty.
`;
```

#### 增量更新

```typescript
const UPDATE_COMPACT_PROMPT = `
<previous-volatile-summary>
{previousLLMSummary}
</previous-volatile-summary>

The messages above are NEW since the last summary. Update:
1. Critical Context: Remove resolved. Add new unresolved.
2. Work Progress: Update to current state. Remove completed work.
3. User Directives: Add new. Keep most recent 8. Drop stale.
4. Working Memory Update: What are the top 3 active issues RIGHT NOW for the current step?

Output using the same Markdown structure.
`;
```

#### 世代计数器（防累积漂移）

```typescript
interface CompactState {
  generation: number;                // 增量更新次数
  maxGenerationBeforeReset: number;  // default: 5
  deepCompactPending: boolean;       // Deep Compact 延迟标记
}
```

当 `generation > 5` 时：**不立即执行 Deep Compact**，而是设置 `deepCompactPending = true`。下次自然触发压缩时（因 0.85 阈值），才执行 Deep Compact。避免在用户交互中产生延迟突刺。

**`deepCompactPending` 与最小间隔的优先级**（消除潜在僵持）：
- `deepCompactPending` **不会**绕过 `minTurnsBetweenCompacts`——它只决定「下次发生压缩时走 Layer 2 而非 Layer 1」，不主动提前触发。
- 但一旦因 0.85 上水位**或**紧急逃逸阀（0.92）**或** Pi 原生 auto-compaction 而发生压缩，且 `deepCompactPending == true`，则该次压缩**必须**走 Deep Compact（即使因紧急路径而 min 间隔未满）。即：min 间隔只拦截「主动 ctx.compact()」，不改变「一旦压缩就用 Deep」这一选择。
- 极端情况：若 `deepCompactPending` 长期挂起（一直没到上水位），说明上下文增长缓慢、累积漂移风险低，挂起本身无害；无需为它单独提前触发。

#### 成本优化

- **增量发送的真实量级**：触发在 `triggerRatio`（0.85）。以 200K 窗口为例，上次 compact 后 tail 落到 ~30K，叠加 `minTurnsBetweenCompacts`（5）的间隔，到下次 compact 时累积的「上次摘要之后的新增入库消息」并非 20-40K，**实测可达 80-120K**。因此 UPDATE input 不能假设固定 30K，必须按累积量分档处理（见下）。
- **新增量分档（按 summaryModel 上下文窗口的安全比例）**：设 `incrementBudget = summaryModel.usableWindow * 0.5`（给摘要模型留一半窗口做输出与安全余量）。
  - **新增量 ≤ incrementBudget**：常规 UPDATE。input = 前次 LLM 摘要（~5K）+ 新增消息 + prompt（~1K）。
  - **新增量 > incrementBudget**：触发 **Layer 1 内部 map-reduce**——按 epoch/chunk 把新增消息切成多段，各段先生成临时 volatile candidate，再 reduce 进前次摘要。reduce 阶段把临时 candidate 当作「新增」喂给 UPDATE prompt。
  - **新增量 > 2 × incrementBudget 或 generation 已临近 reset**：直接置 `deepCompactPending = true`，交给 Layer 2 的延迟重摘要（Layer 2 本就支持 map-reduce），避免在 Layer 1 反复多段拼接放大累积漂移。
- **可选小模型**：摘要不需要强推理，可用 Haiku/GPT-4o-mini。注意 `incrementBudget` 要按所选 summaryModel 的窗口算，而非主模型。

```typescript
interface CompactModelConfig {
  summaryModel?: string;  // default: 继承主模型；推荐: 'haiku' / 'gpt-4o-mini'
}
```

> 200K 通算示例（量级估算，非精算；与「全局 Token Budget Allocator」「压缩后 Context 组成示意」保持同一组数）：usable ~184K，trigger 0.85 ≈ 156K 入库时触发；Prune 后若仍 > 下水位目标（~110K）则进 Layer 1。若上次 compact 把入库压回 ~46K overhead（其中含 ~30.7K recent tail，tail 属于「已保留的旧尾巴」而非新增），则两次 compact 之间真正的「新增消息」≈ 156K − (46K − 30.7K) ≈ 140K 量级，落入「> incrementBudget」档，走 Layer 1 map-reduce 或转 Layer 2。具体数随 tail 复用比例浮动，实现时以实测为准。

---

## Layer 2: Deep Compact（延迟执行的受控重置）

### 触发条件（满足任一）

- `deepCompactPending == true` 且自然触发了压缩（0.85 阈值到了）
- Layer 1 的 LLM 摘要超出 `summary` 预算
- 手动 `/compact --deep` 命令

### 策略

Deep Compact 的“全量”不是把完整 raw session 再塞给模型（长线 goal 可能已经累计数十万/百万 token，不可行），而是从可控输入重建当前 volatile summary，重置 generation 计数器。State-Driven sections 不受影响。

Deep Compact 输入优先级：
1. current branch 上最近 raw tail（原始消息，预算内）
2. previous compaction summaries / branch summaries（而不是全部旧 raw messages）
3. compaction history index（只注入索引，必要时按 index 精读 epoch）
4. State-driven pinned sections（只作为避免重复/冲突的参考，不要求模型重写）

如果上述输入仍超预算，采用 map-reduce：先按 epoch/chunk 生成临时 volatile candidates，再 reduce 成最终 summary。

```typescript
const DEEP_COMPACT_PROMPT = `
You are creating a fresh volatile summary for a long-running coding session.
This replaces a stale incremental summary (updated ${generation} times).

Goal, Constraints, Plan, Decisions, and Working Memory are tracked separately — do NOT include them in the summary.
You may output Working Memory Update separately for the host to parse into state.

Summarize ONLY what is STILL RELEVANT right now:
1. **Critical Context** — active unresolved issues only
2. **Work Progress** — what is being worked on RIGHT NOW
3. **User Directives** — user's most recent 5 instructions
4. **Working Memory Update** — top 3 active issues for current step

Rules:
- Budget: stay under ${summaryBudget} tokens.
- Ruthlessly concise. Only CURRENTLY ACTIVE items.
- Preserve exact paths, names, errors.
- Working Memory Update is parsed into state and excluded from persisted LLM summary.
`;
```

### Decision Log 注入

```typescript
function injectDecisions(decisions: Decision[], budget: number): string {
  // 过滤掉 superseded 的决策
  const active = decisions.filter(d => !d.superseded);
  // 按时间倒序，在 budget 内尽可能多注入
  let output = '## Key Decisions\n';
  let tokens = 0;
  for (const d of active.sort((a, b) => b.turnId - a.turnId)) {
    const line = `- [Turn ${d.turnId}] **${d.description}**: ${d.rationale} (${d.category})\n`;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > budget) {
      const remaining = active.length - countLines(output);
      output += `- ...and ${remaining} earlier decisions (see .pi/yuki/decisions.log mirror)\n`;
      break;
    }
    output += line;
    tokens += lineTokens;
  }
  return output;
}
```

---

## Compaction History 持久化

```typescript
interface CompactionArchive {
  archiveDir: string;  // default: '.pi/yuki/compaction-history/'（避免污染业务源码目录）
  // 每次压缩生成 epoch 文件 + 写入 index
  indexFile: string;   // '.pi/yuki/compaction-history/index.md'
  // 保留策略：超过 20 个 epoch 时归档旧文件
  maxEpochs: number;   // default: 20
}

async function archiveBeforeCompact(
  discardedMessages: AgentMessage[], 
  epoch: number,
  workingMemory: string[]
): Promise<void> {
  // 调用方以 fire-and-forget 入队（不 await）；真正 I/O 由单线程后台队列串行执行。
  // 返回的 promise 仅供 session_shutdown 的 best-effort flush 等待，正常路径不消费它。
  // 这样 CompactionResult 能立即返回，且连续 compact 不会并发写同一个 index.md。
  // 唯一必须在返回 CompactionResult 之前同步算好的，是 epoch 编号与索引所需的 turn 范围（轻量）。
  return archiveQueue.enqueue(async () => {
    try {
      // 1. 写入被 compaction 替代的消息文本（来自 preparation.messagesToSummarize/turnPrefixMessages）
      const content = serializeConversation(convertToLlm(discardedMessages));
      const path = `.pi/yuki/compaction-history/epoch-${String(epoch).padStart(3, '0')}.md`;
      await writeFile(path, content);

      // 2. 追加 index entry（3-5 行摘要，方便快速查找）
      const indexEntry = `### Epoch ${epoch} (turns ${startTurn}-${endTurn})\n` +
        `- Topics: ${extractTopics(discardedMessages).join(', ')}\n` +
        `- Key files: ${extractFiles(discardedMessages).slice(0, 5).join(', ')}\n\n`;
      await appendFile('.pi/yuki/compaction-history/index.md', indexEntry);
    } catch (err) {
      // 归档失败只记 debug warning，绝不影响已经返回的 compaction 主流程（归档仅为灾难恢复）。
      debugWarn('archiveBeforeCompact failed', err);
    }
  });
}
```

归档逻辑发生在 `session_before_compact`（此时还能拿到 `preparation.messagesToSummarize` / `turnPrefixMessages` 等即将被摘要替代的内容），但必须在 `yukiCompact()` 成功产出 `CompactionResult` 并写好 `details` 后，才**以 fire-and-forget 方式入队**：epoch 计数与 `discardedMessages` 引用在返回前同步取好，实际序列化与写盘进入单线程 background queue，`CompactionResult` 不等待归档完成即返回。若 `yukiCompact()` 失败，不入队归档，避免 orphan epoch 文件。`session_compact` 只适合做通知、指标或状态清理。

> 注意 epoch 自增的并发安全：epoch 编号必须在「返回 CompactionResult 之前」就同步占用并写入 compaction details / state snapshot，不能依赖异步归档完成后再自增，否则连续两次快速 compact 会拿到同一 epoch。后台队列在 `session_shutdown` 中 best-effort flush；未 flush 完成只影响灾难恢复，不影响主 session。

定位为**灾难恢复**，不是常规检索。Agent 先查 index.md，再决定是否读具体 epoch。

`.pi/yuki/decisions.log` 同样只是给人/Agent 快速定位的导出镜像；DecisionLog 的真源仍是 `CompactionResult.details.state.decisions` + 后续 delta entries。

---

## 后处理恢复（Post-Compact Recovery）

恢复信息注入发生在两处：
- 压缩产物本身：`CompactionResult.summary` 中包含 pinned sections / working memory / file index。
- 后续 LLM 请求：`context` hook 可按预算追加轻量索引。

`session_compact` 只做通知、指标和状态清理，不负责修改已经保存的 compaction entry。

注入**索引而非内容**：

```typescript
interface PostCompactRecovery {
  // 1. AGENTS.md / 项目配置（~2.5K tokens）
  reinjectProjectContext: boolean;  // default: true
  
  // 2. 文件索引（路径 + 一行描述，~500 tokens）
  fileIndex: {
    maxEntries: number;  // default: 10
    format: '- {path}: {role/status}, last modified turn {N}';
  };
  
  // 3. Plan + Todo（从 state 注入，~1K）
  reinjectPlan: boolean;  // default: true
  reinjectTodos: boolean; // default: true
  
  // 4. Half-done edits（正在编辑但未完成的文件的变更摘要）
  halfDoneEdits: {
    enabled: boolean;     // default: true
    maxTokens: number;    // default: 1000
    // 格式: "- src/auth.ts: partially refactored (lines 20-45 done, 46-80 pending)"
  };
}
```

---

## Goal Pinning（多层 Fallback）

### 优先级

```typescript
function getGoalForCompaction(state: ExtensionState, planState?: PlanState, messages?: Message[]): string {
  // 1. 显式 Pin（grilling 阶段确定）
  if (state.goalPin && !state.goalPin.superseded) {
    return state.goalPin.originalText;
  }
  
  // 2. Plan root task（只在 plan 已批准执行后使用；规划期 request 不提前 pin 成 goal）
  if (planState?.phase === 'executing' && planState.request) {
    return `[From plan]: ${planState.title ?? planState.request}`;
  }
  
  // 3. Soft Pin（前 N 轮对话由 LLM 推断，可被覆盖）
  if (state.softGoalPin) {
    return `[Inferred]: ${state.softGoalPin.text}`;
  }
  
  // 4. 最终 fallback：第一条用户消息
  //    注意：此 fallback 只在「首次 compaction 之前」有效——一旦旧历史被丢弃，
  //    messages 头部的第一条 user 消息会消失。首次 compaction 时应同步触发 Soft Pin
  //    自动推断（见下），由 soft pin 兜住后续轮次。
  const firstUserMsg = messages?.find(m => m.role === 'user');
  return `[From first message]: ${truncate(firstUserMsg?.content || '', 300)}`;
}
```

### Soft Pin 自动推断

如果前 5 轮没有 explicit pin，在第一次 Layer 1 compact 时，LLM 摘要的 prompt 中额外要求：

```
Additionally, infer the user's primary goal in one sentence and output it as:
## Inferred Goal
- [one sentence goal statement]
```

这个 inferred goal 存为 soft pin，后续 explicit pin 可以覆盖它。

### Goal Lifecycle

```typescript
interface GoalPin {
  originalText: string;
  constraints: string[];
  pinnedAt: number;          // turn ID
  version: number;
  status: 'active' | 'suspended' | 'abandoned';
}

// Goal 切换时：
// 1. 旧 goal 标记为 suspended（不删除）
// 2. 旧 goal 的 working memory 归档
// 3. 记录到 Decision Log: "Pivoted from X to Y because ..."
// 4. 新 goal pin 创建，version++
```

---

## Decision Log

### 写入触发：两阶段过滤

```typescript
// 阶段 1: 正则初筛（宽松，宁多勿漏）
const DECISION_SIGNAL_PATTERNS = [
  /I'll go with|choosing|decided to|let's use|instead of|trade-?off|approach/i,
  /用|不要|必须|偏好|选择|方案[AB12]|versus/,
];

// 阶段 2: 在 Layer 1 LLM 调用中附带确认
// 在 STRUCTURED_COMPACT_PROMPT 的输出中增加一个可选 section:
const DECISION_EXTRACTION_ADDENDUM = `
If any ARCHITECTURAL decisions or user choices were made in the new messages,
list them (max 3 per compact round):
## New Decisions
- **[what was decided]**: [why] (architecture|tradeoff|constraint|preference)

If no decisions were made, omit this section entirely.
`;
```

这样 decision 的确认搭载在 Layer 1 LLM 调用中完成，不增加额外调用。正则只作为"是否需要在 LLM prompt 中启用 decision extraction"的门控。

### 非压缩轮次的 Decision Candidate

为避免长时间不 compact 时漏掉关键决策，`turn_end` 增加零成本候选记录：

```typescript
interface DecisionCandidate {
  turnId: number;
  text: string;
  source: 'user_explicit' | 'assistant_inferred';
  status: 'candidate' | 'confirmed' | 'rejected';
}
```

规则：
- 用户显式说“决定/选择/以后都/必须/不要/偏好”时，先写入 candidate。
- 明显 session-level preference 可直接写入 constraints；architecture/tradeoff 类等 Layer 1 LLM confirm。
- Layer 1 输出 `## New Decisions` 后，将对应 candidate 标记为 confirmed/rejected。
- DecisionLog 注入只展示 confirmed decisions；candidate 只用于防漏。

### Constraints 分级

```typescript
interface Constraint {
  text: string;
  level: 'session' | 'task';  
  // session: 跨越整个会话的风格/偏好（"不用 class"）
  // task: 特定任务的约束（"必须兼容 Node 18"）
  source: 'user_explicit' | 'inferred';
  addedAt: number;
}
```

Session-level constraints 存入 state（不会被 LLM 遗忘），task-level 可随 goal 切换而清理。

---

## 错误处理与 Fallback

```typescript
async function runCompaction(context: CompactContext): Promise<CompactResult> {
  try {
    return await normalCompactionPipeline(context);
  } catch (error) {
    if (isLLMCallFailure(error)) {
      // Fallback: aggressive prune（扩大范围，不调 LLM）
      // 产出合法 CompactionResult：summary 使用上一轮 pinned sections + previousLLMSummary
      // + "LLM compaction failed; older raw entries aggressively pruned" 标记；
      // firstKeptEntryId 仍取 preparation.firstKeptEntryId 或更靠后的安全 cut point。
      return await aggressivePruneToCompactionResult(context, {
        protectRecentTurns: 2,
        minPrunableChars: 500,
        pruneAssistantMessages: true,
        intraTurnPruneThreshold: 3000,
      });
    }
    throw error;
  }
}

interface CircuitBreaker {
  consecutiveFailures: number;
  maxFailures: number;              // default: 3
  cooldownMs: number;               // default: 60000
  lastFailureTime: number;
  isOpen(): boolean;
  recordFailure(): void;
  recordSuccess(): void;
}
```

---

## Runtime State 持久化

所有 runtime state 必须持久化（Pi 重启不丢失），并且恢复必须 **branch-aware**：优先从 `ctx.sessionManager.getBranch()` 或 `event.branchEntries` 重放状态，不能全量扫描 `getEntries()` 后把废弃分支的 Goal/Decision/Constraint 混入当前分支。

持久化分两层，避免 `appendEntry` 与 compaction entry 非原子导致状态不一致：
- **Compaction 原子快照**：每次 `session_before_compact` 返回的 `CompactionResult.details` 内携带 `PersistedCompactState` 快照。这与 compaction entry 同写入，是压缩后的主要恢复点。
- **非压缩增量**：非 compaction turn（decision candidate、soft pin、working memory 小变化）继续用 `appendEntry` 记录 delta。恢复时先读 branch 上最新 compaction details，再重放其后的 custom delta。

```typescript
interface PersistedCompactState {
  // 必须持久化
  generation: number;              // 当前世代
  deepCompactPending: boolean;     // 是否待执行 Deep Compact
  lastCompactTurnIndex: number;    // 上次压缩的 turn
  epoch: number;                   // 当前 epoch 计数
  
  // 推荐持久化
  circuitBreaker: { failures: number; lastFailure: number };
  goalPin: GoalPin | null;
  softGoalPin: { text: string; turnId: number } | null;
  decisions: Decision[];
  decisionCandidates: DecisionCandidate[];
  constraints: Constraint[];
  workingMemory: string[];
}

interface YukiCompactionDetails {
  version: 1;
  state: PersistedCompactState;
  archiveEpoch: number;
  readFiles?: string[];
  modifiedFiles?: string[];
}

// 恢复策略：只重放当前 branch 上最新 compaction details + 其后的 state delta entries。
// appendEntry 不再是 compaction state 的唯一真源；它只承担非压缩轮次的 delta。
interface PersistedStateEntry<T> {
  kind: 'yuki-compact-delta';
  baseEpoch?: number;
  branchLeafId: string;
  turnId: number;
  data: Partial<T>;
}
```

---

## 与 plan-flow / todo 扩展的集成契约（单向只读订阅）

本方案的 Goal fallback（`planState.request`）依赖 plan-flow；Working Memory「随 plan step 推进清空」依赖 plan-owned todo 的执行状态。三个扩展不共享内存，必须通过 Pi 的 custom entry 解耦：

- **真相源**：
  - plan-flow 状态写入 custom type `yuki-plan-flow-state`（`PLAN_STATE_CUSTOM_TYPE`，见 `extensions/shared/constants.ts`）。
  - todo 状态写入 custom type `yuki-todo-state`（`TODO_STATE_CUSTOM_TYPE`），其中 plan-owned list 的 `source === 'plan'`，`owner.planId` 指向 plan-flow 的 `planId`。
  - compaction 扩展**只从当前 branch 读取这些 entry，绝不写入**，保持单向依赖。
- **plan-flow 读取方式**：在 `session_before_compact` / `turn_end` 中用与 plan-flow 一致的 branch 重建逻辑（扫 `getBranch()` 取最新一条 `customType === PLAN_STATE_CUSTOM_TYPE` 的 snapshot），取出 `phase`、`request`/`title`、`steps`、`approved`、`todoListId` 等字段。**只复用稳定字段**（`request` / `title` / `steps` / `phase` / `todoListId`），不耦合 plan-flow 的内部易变字段（如 `reviewPending`）。
- **todo 读取方式**：扫当前 branch 上 `customType === TODO_STATE_CUSTOM_TYPE` 的最新 snapshot，选择 `listId === planState.todoListId` 或 `source === 'plan' && owner.planId === planState.planId` 的 todo list，读取 `todos[].status`。
- **step 推进检测**：plan-flow 的 `PlanStep` 本身没有 `status` / `in_progress` 字段，因此 Working Memory 的清空时机以 plan-owned todo list 中 `status === 'in_progress'` 的 todo id 变化为准；compaction 扩展自己缓存上次观察到的 active todo id，变化即归档旧 Working Memory。
- **未安装 / 无 plan 时的降级**：
  - 若 branch 中**没有** `yuki-plan-flow-state` entry（用户没启用 plan-flow，或没跑 `/plan`）：Goal fallback 跳过第 2 级（plan root task），直接走 Soft Pin → 第一条用户消息。
  - 若有 plan-flow 但 `phase !== 'executing'`（仍在规划阶段）：不把规划期的中间态当成 Goal；Working Memory 不绑定 plan step，退化为「按固定 turn 窗口」管理。
  - 若 plan-flow 已 executing 但没有对应 todo state：Goal 仍可从 plan-flow 读取，Working Memory step 边界退化为固定 turn 窗口，并记 debug warning。
- **版本兼容**：读取时校验 `PlanFlowState.version` / `TodoState.version`，未知版本只读已知字段并记 debug warning，不因 plan-flow/todo 升级而崩。

---

## 与 Pi Extension API 的集成

> 本节的 API 能力依据 Pi 源码、官方文档与 Phase 0 spike（`.pi/spikes/phase0-compaction-spike.ts`，日志在 `.pi/yuki-phase0*/`）整理。Phase 0 已验证核心接管路径；仍需在真实长会话中补充质量/性能评估。

### API 能力核实结果

| 能力 | 核实结论 | 落地方式 |
|------|----------|----------|
| 扩展加载与事件订阅 | ✅ 支持。扩展为 `export default function(pi: ExtensionAPI)` 工厂，通过 `pi.on(event, handler)` 订阅，共约 30 个生命周期事件 | 单一扩展挂载多个 hook |
| 压缩前接管 | ✅ Phase 0 确认。`session_before_compact` 在默认摘要生成前触发；返回 `{compaction}` 会完整替换摘要并写入 compaction entry；返回 `{cancel:true}` 会让 `ctx.compact()` 以 `Compaction cancelled` 结束且不写 entry | 走完全接管路径 |
| 压缩后通知 | ✅ Phase 0 确认。自定义 compaction 成功后触发 `session_compact`，`fromExtension:true`，entry 中带 `fromHook:true` | 后处理恢复 |
| 修改发往 LLM 的消息 | ✅ 已在本仓库使用（recap.ts / btw.ts 的 `context` hook）。不能直接改 session entries（`ReadonlySessionManager` 只读），但 `context` hook 返回 `{messages}` 可在运行时变换发给 LLM 的内容（不落盘） | Prune/索引注入走此路径 |
| 工具结果入库前改写 | ✅ Phase 0 确认。`tool_result` hook 返回 `{content, details}` 后，session 中保存的是改写后的 tool result；原始大输出不会再进入 session | Pre-store prune + archive 可落地 |
| Token 计数 | 🟡 Phase 0 部分确认。`ctx.getContextUsage()` 在普通轮次返回最近 assistant usage 口径（包含系统/输入/输出，未证明等于入库 token）；刚 compact / reload 后可能为 `{tokens:null}`。需避免把 null 当 0 | 触发判断暂用 `ctx.getContextUsage()`，但必须容忍 null；严格 store-based 会计后续用 branch 自算补强 |
| 跨 session 状态持久化 | ✅ Phase 0 确认 compaction `details` 会持久化并在 reload 后通过 branch 最新 compaction entry 可见；plan-flow / todo 的 `appendEntry` + `getBranch()` 已在本仓库使用。fork/tree 细节仍建议补测 | Runtime State 由 compaction details + delta 共同持久化 |
| 覆盖默认压缩 prompt | 🟡 部分。无法直接改写 Pi 内置 prompt 常量；自定义 prompt 须经 `session_before_compact` 自行生成摘要后接管（官方 `custom-compaction.ts` 示例即此模式） | 完全接管模式自带自定义 prompt，无影响 |
| 自定义 tail cut point | ✅ Phase 0 确认。`CompactionResult.firstKeptEntryId` 可使用扩展自选的有效 entry id，实际写入 entry 并影响后续 branch context | 可按 Allocator 的 `recentTail` 选择 cut；但若 cut 比 `preparation.firstKeptEntryId` 更靠后，必须把额外丢弃区间也纳入摘要，否则会漏信息 |

### 集成模式：完全接管

Pi 原生支持 `session_before_compact` 返回自定义 `CompactionResult` 来替换默认压缩摘要生成，因此本方案在压缩阶段走完全接管；Layer 0 的 pre-store/runtime prune 则分别落在 `tool_result` 和 `context` hook：

```typescript
export default function (pi: ExtensionAPI) {
  let compactInFlight = false;

  // getStoreBasedUsage：入库口径用量读取的统一入口（占位，Phase 0 后定型）。
  // - 若 Phase 0 确认 ctx.getContextUsage() 返回的是入库 token → 直接包装它；
  // - 若确认它返回的是经 context hook 变换后的发送量 → 改用 estimateContextTokens 对入库 entry 自算。
  // 这样下游触发逻辑不受 runtime prune 干扰（见「Prune 与触发口径统一」）。
  const getStoreBasedUsage = (ctx: ExtensionContext) => resolveStoreBasedUsage(ctx);

  // 启动时按当前 branch 回读持久化的 runtime state：最新 compaction details + 其后的 delta entries
  pi.on('session_start', async (_event, ctx) => {
    restoreState(ctx.sessionManager.getBranch());
  });

  // 主动触发：Pi 默认只在 contextWindow - reserveTokens 时 compact，扩展自己的 0.85 阈值要主动调用 ctx.compact()
  pi.on('turn_end', async (_event, ctx) => {
    // Phase 0: print/json one-shot runs may abort ctx.compact() during teardown;
    // proactive trigger is only enabled for long-lived TUI/RPC sessions.
    if (ctx.mode === 'print' || ctx.mode === 'json') return;
    const usage = getStoreBasedUsage(ctx);
    if (!compactInFlight && shouldTriggerYukiCompact(usage) && canActiveCompactNow()) {
      compactInFlight = true;
      ctx.compact({
        customInstructions: 'yuki-compact:auto',
        onComplete: () => { compactInFlight = false; },
        onError: () => { compactInFlight = false; },
      });
    }
  });

  // 工具结果入库前压缩超大输出（持久 pre-store prune）
  pi.on('tool_result', async (event, _ctx) => {
    return pruneToolResultBeforeStore(event);
  });

  // 完全接管压缩：Structured/Deep Compact → 产出 CompactionResult
  pi.on('session_before_compact', async (event, ctx) => {
    restoreState(event.branchEntries);              // branch-aware，避免串分支
    const epoch = reserveEpoch(state);              // 同步占用 epoch（并发安全），写入 result.details
    const discardedMessages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
    const result = await yukiCompact(event, ctx);   // 三层压缩管线（触发判断已在 turn_end 完成）
    result.details = buildCompactionDetails(state, epoch, result.details); // 与 compaction entry 原子保存
    // yukiCompact 成功后再 fire-and-forget 入队归档；避免 compact 失败时留下 orphan epoch 文件。
    void archiveBeforeCompact(discardedMessages, epoch, state.workingMemory);
    return { compaction: result };                  // 完整替换默认压缩
  });

  // 压缩完成后做通知/指标/状态清理；归档 discarded entries 不放这里做
  pi.on('session_compact', async (event, ctx) => {
    compactInFlight = false;
    await postCompactCleanupAndMetrics(event, ctx);
  });

  // 运行时变换发往 LLM 的消息（Prune 不落盘）
  pi.on('context', async (event, _ctx) => {
    return { messages: applyRuntimePrune(event.messages) };
  });
}
```

要点：
- **Prune 的三条落地路径**：`tool_result` 做持久 pre-store prune；`context` 做非持久 runtime view prune；`session_before_compact` 通过 `summary + firstKeptEntryId` 丢弃旧历史，不能就地改写旧 entry。
- **状态持久化分层**：compaction 时以 `CompactionResult.details` 为原子快照；非压缩轮次用 `appendEntry` 记录 delta；恢复必须 branch-aware。`.pi/yuki/compaction-history/` 仅用于压缩历史归档（灾难恢复），不承担 runtime state。
- **自定义 prompt 不依赖任何 prompt 覆盖钩子**，全部在接管路径内由本扩展自行构造。
- **自动触发分两层**：Pi 原生 auto compact 是硬上限保护；Yuki hysteresis 需要扩展在长驻 `tui/rpc` 的 `turn_end` 主动 `ctx.compact()`，并用 `compactInFlight` 防重复触发；`print/json` 禁用主动触发以避免进程 teardown abort。

---

## 触发策略总览

```typescript
interface CompactionTrigger {
  hysteresis: HysteresisConfig;
  pruneFirst: boolean;                // default: true
  overflowRecovery: boolean;          // default: true
  overflowMaxRetries: number;         // default: 2
  circuitBreaker: CircuitBreaker;
  minTurnsBetweenCompacts: number;    // default: 5，仅限制扩展主动 ctx.compact()
  emergencyPruneRatio: number;        // default: 0.92（紧急逃逸阀）
  activeTriggerHook: 'turn_end' | 'agent_end'; // default: 'turn_end'
  nativeAutoCompactBypassMinInterval: boolean; // default: true，Pi 已触发时必须释放空间
  compactInFlightGuard: boolean;       // default: true，防止 turn_end 重复 ctx.compact()
}
```

---

## 压缩后 Context 组成示意

200K context window（与 Allocator 同一组数：usableWindow ~184K，totalBudget 46K）：

```
┌─────────────────────────────────────────────────┐
│ System Prompt + AGENTS.md (Pi 原生)    (~3K)    │ ← 在 usableWindow 之外，不计入 46K overhead
╞═════════════════════════════════════════════════╡
│ Pinned Goal + Constraints              (~1K)    │ ← State P0
├─────────────────────────────────────────────────┤
│ Plan Progress + Decisions              (~2.5K)  │ ← State P1
├─────────────────────────────────────────────────┤
│ Project Context (重注入精简索引)       (~2.5K)  │ ← State P2 projectContext
├─────────────────────────────────────────────────┤
│ Working Memory (current step)          (~0.8K)  │ ← 活跃中间状态
├─────────────────────────────────────────────────┤
│ LLM Summary (Context + Progress +              │
│ Directives)                            (~8K)    │ ← LLM 生成（summary 上限）
├─────────────────────────────────────────────────┤
│ File Index + Half-done Edits           (~1K)    │ ← 轻量索引 (fileIndex 0.5K + 半成品)
├─────────────────────────────────────────────────┤
│ Recent Tail (原始对话尾部)             (~30.7K) │ ← 原样保留
├─────────────────────────────────────────────────┤
│                                                 │
│ Free Space for new conversation        (~138K)  │ ← usableWindow − overhead ≈ 184−46
│                                                 │
└─────────────────────────────────────────────────┘
Overhead（usableWindow 内）: 46K (25%), Free: ~138K (75%)
另：Pi 原生 systemPrompt+AGENTS (~3K) 与 maxOutput 预留在 usableWindow 之外单独占用。
```

128K context window（usableWindow ~112K，totalBudget 33.6K）：

```
┌─────────────────────────────────────────────────┐
│ System Prompt + AGENTS.md (Pi 原生)    (~3K)    │ ← usableWindow 之外
╞═════════════════════════════════════════════════╡
│ Pinned State (Goal+Constraints+Plan+Dec) (~3.5K)│ ← P0+P1 (0.5+0.5+1+1.5)
│ Project Context                        (~2.5K)  │ ← P2
│ Working Memory                         (~0.8K)  │
│ LLM Summary                            (~5.6K)  │ ← min(8K, 112K*0.05)
│ File Index + Half-done Edits           (~1K)    │
│ Recent Tail                            (~20.7K) │ ← ~7-9 轮
├─────────────────────────────────────────────────┤
│ Free Space                             (~78K)   │ ← usableWindow − overhead ≈ 112−33.6
└─────────────────────────────────────────────────┘
Overhead（usableWindow 内）: 33.6K (30%), Free: ~78K (70%)
```

---

## 实现路线图

### Phase 0: API 验证 Spike（定稿前必做）

本设计依赖一批 Pi compaction API。Phase 0 spike 已用最小 extension 实机验证核心前提，结论如下：

- ✅ **`session_before_compact` 触发顺序与接管**：在默认摘要前触发；返回 `{compaction}` 成功写入自定义 compaction entry；返回 `{cancel:true}` 不写 entry，并让 `ctx.compact()` 回调收到 `Compaction cancelled`。
- ✅ **`preparation` 字段**：字段真实存在：`firstKeptEntryId`、`messagesToSummarize`、`turnPrefixMessages`、`isSplitTurn`、`tokensBefore`、`previousSummary`、`fileOps`、`settings`。长输入 + 小 `keepRecentTokens` 下可拿到即将丢弃的 `messagesToSummarize`。
- 🟡 **`getContextUsage()` 口径**：普通轮次可读；刚 compact / reload 后可能为 null。口径更接近最近 assistant usage/当前 context 估计，未证明等于 raw store token。触发逻辑必须跳过 null，并保留后续 branch 自算入口。
- 🟡 **`ctx.compact()`**：支持 `customInstructions` / `onComplete` / `onError`，并会进入 `session_before_compact`。但 Phase 0 发现：在 `print/json` 这类一次性进程中，从 `turn_end` / `agent_end` 主动触发会进入 hook 后因 session teardown abort，最终 `Compaction cancelled`；长驻 TUI/RPC 才适合 proactive trigger。实现需在非长驻 mode 禁用主动触发。
- ✅ **`CompactionResult.firstKeptEntryId` 自定义 cut point**：可返回扩展自选有效 entry id，并写入 compaction entry。注意：若 cut 比 Pi preparation 更靠后，额外丢弃区间必须加入摘要输入。
- ✅ **`CompactionResult.details`**：自定义 details 完整持久化；reload 后最新 compaction entry 可在 branch 中读取。fork/tree 仍建议补测。
- ✅ **`event.branchEntries`**：在 `session_before_compact` 中可用，包含当前 branch entries，可用于状态重建。
- ✅ **`tool_result` pre-store 改写**：返回 `{content, details}` 后 session 只保存改写结果；大输出可在入库前被 archive ref 替代。

### Phase 1: Prune + Budget + Hysteresis（核心基础设施）

**Implementation note（2026-06-18）**：Phase 0 已完成核心 API spike，`extensions/yuki-compaction.ts` 基线实现按验证结果调整：非长驻 `print/json` mode 禁用主动 `ctx.compact()`；当前仍使用 `preparation.firstKeptEntryId` 作为安全 cut point，自定义 cut point 待补齐「额外丢弃区间摘要」后启用。运行参数通过 `/yuki-compact` 打开 TUI settings menu 持久配置（on/off、proactive、summarizer model、trigger/target/archive/runtime/min-interval 阈值）；同时保留子命令作为脚本/无 UI fallback。

- Content-type aware Prune（拆分为 `tool_result` pre-store + full-output archive、`context` runtime view、compaction discard）
- 全局 Budget Allocator（基于 usableWindow，含优先级降级）
- 迟滞机制 + 主动 `ctx.compact()` 触发 + 紧急逃逸阀
- 熔断器 + aggressive prune fallback
- Branch-aware runtime state 持久化（compaction details snapshot + appendEntry delta）
- **预期效果：减少 60% 的 LLM 压缩调用**
- **发布策略**：Phase 1 作为可独立发布的基线先行落地并实测「LLM 压缩 -60%」这一指标；指标验证通过后再进入 Phase 2+，避免在未验证收益前堆叠 Decision Log / Working Memory 等重机构。

### Phase 2: State-Driven Sections
- GoalPin（含 soft pin fallback + lifecycle）
- Constraints 分级（session/task）
- DecisionLog（per-turn candidate + 两阶段过滤：正则初筛 + LLM 确认）
- Working Memory slot

### Phase 3: LLM Summary（职责收窄版）
- 收窄的 CREATE/UPDATE prompt
- 世代计数器 + 延迟 Deep Compact（summary/index/tail 输入，必要时 map-reduce）
- 可选小模型

### Phase 4: Archive + Recovery + Observability
- Compaction history 持久化 + index
- Post-Compact Recovery（索引 + half-done edits）
- Debug log（每次压缩记录各层决策依据和 token 分配实际值）

---

## Known Gaps（明确标注，后续迭代解决）

| Gap | 影响 | 计划 |
|-----|------|------|
| `getContextUsage()` 不是稳定 raw-store token 口径，且 compact/reload 后可能为 null | 主动触发可能误判或跳过 | null 直接跳过；后续增加 branch-entry raw token 自算作为 store-based usage |
| `ctx.compact()` 在 `print/json` 的 `turn_end` / `agent_end` 主动触发会被 teardown abort | 一次性运行中主动压缩失败并产生 warning | 主动 hysteresis 仅在长驻 `tui/rpc` 启用；`print/json` 依赖原生 auto/manual 或下次长驻会话 |
| 自定义 `firstKeptEntryId` 虽可写入，但比 preparation 更靠后的 cut 会额外丢弃未摘要区间 | 可能漏掉 preparation tail 中的信息 | 启用自定义 cut 前，先实现「prep.firstKept → customCut」额外区间纳入摘要 |
| 内部 token 估算用 chars/4 启发式（Pi 导出的 `estimateTokens` 也是估算，非精确 tokenizer） | 预算分配存在误差，需留安全余量 | 预算计算保留 ~10% buffer；raw store 自算也只作为触发近似 |
| 无法覆盖 Pi 内置压缩 prompt，自定义 prompt 须经 `session_before_compact` 接管 | 必须走完全接管路径，不能只增强默认压缩 | 已采纳完全接管为唯一模式，无额外影响 |
| 依赖 plan-flow / todo 扩展的共享 custom entry（`yuki-plan-flow-state` / `yuki-todo-state`） | plan-flow/todo 未安装或字段变更时 Goal/Working Memory 降级 | 单向只读订阅 + 版本校验 + 无 plan/todo 降级（见集成契约章节） |
| Decision candidate 可能误报 | state 中会积累无效 candidate | Layer 1 确认后标记 rejected，并定期裁剪 rejected/过旧 candidate |
| Goal 多次切换后 suspended goals 累积 | 占 state 空间 | 加 retention policy |
| 非英文/中英混合的正则匹配覆盖率 | 漏检 decision/constraint candidate | 扩充正则 + LLM fallback |
| A/B 评估框架 | 无法量化压缩质量 | 后续用历史对话 replay 评估 |

---

## 关键设计原则总结

| 原则 | 实现方式 |
|------|----------|
| Goal 永不丢失 | GoalPin + multi-level fallback，LLM 不碰 |
| 分级响应 | Prune → Structured → Deep，按需升级 |
| 累积误差可控 | 世代计数器 + 延迟 Deep Compact 重置 |
| LLM 职责最小化 | 只做 volatile context，结构化数据从 state 读 |
| 两不管地带消除 | Working Memory slot + Constraint 分级 |
| 成本可控 | Prune 零成本 + 增量发送 + 小模型选项 |
| 信息不永久丢失 | 压缩历史 + index，定位为灾难恢复 |
| 防震荡 | 迟滞上下水位 + 最小间隔 + 紧急逃逸阀 |
| 预算透明可控 | 统一 Allocator + 优先级降级规则 |
| 优雅降级 | aggressive prune fallback + 熔断器 |
| 延迟不突刺 | Deep Compact 延迟到自然触发时执行 |
| 可观测 | Debug log 记录每次压缩决策 |
