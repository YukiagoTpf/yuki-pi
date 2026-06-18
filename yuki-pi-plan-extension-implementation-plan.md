# yuki-pi · plan + todo 工作流扩展实施计划

> 输入设计稿：`/Users/bytedance/Downloads/yuki-pi-plan-extension-design.md`  
> 参考 Pi 文档：`README.md`、`docs/extensions.md`、`docs/session-format.md`、`docs/packages.md`、`examples/extensions/plan-mode/`、`examples/extensions/todo.ts`、`examples/extensions/question*.ts`、`examples/extensions/summarize.ts`、`examples/extensions/structured-output.ts`。  
> 目标：把设计稿中的「调研 → 逼问澄清 → 产出 plan → 自动 review → 改稿 → 用户审批 → 存储 plan + 注册 todo → 执行」落成一个可热重载、可恢复、分支安全的 Pi Extension。

---

## 0. Pi 文档约束与实现修正

### 0.1 必须遵守的 Pi Extension 事实

1. **扩展是 TypeScript 模块**：放在 `~/.pi/agent/extensions/` 或项目 `.pi/extensions/` 可被自动发现，并可用 `/reload` 热重载；临时调试可用 `pi -e ./path.ts`。
2. **可注册能力**：`pi.registerTool()`、`pi.registerCommand()`、`pi.on(...)`、`pi.registerShortcut()`、`pi.registerFlag()`、`pi.setActiveTools()`。
3. **状态推荐存储**：
   - 分支安全状态优先存到工具结果 `details`，重启/切分支时用 `ctx.sessionManager.getBranch()` 重建。
   - 命令或事件产生的状态变化没有工具结果承载，需用 `pi.appendEntry(customType, data)` 追加 `custom` entry；重建时同样只扫描当前 branch。
4. **`getBranch()` 返回 root → leaf 的当前路径**，适合按顺序 apply snapshot/delta。
5. **工具调用可被拦截**：`tool_call` 事件可返回 `{ block: true, reason }`，适合做 phase 白名单门禁。
6. **自定义工具的文件写入需串行**：如果自定义工具会改文件，使用 `withFileMutationQueue()` 包住 read-modify-write 窗口，避免与内置 `edit/write` 并发覆盖。
7. **自动 review 必须用 Pi/AI SDK**：参考 `examples/extensions/summarize.ts`，`complete()` 调用需要：
   - `const model = ctx.getModel()`；
   - `const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model)`；
   - `await complete(model, { messages }, { apiKey, headers, signal, timeoutMs })`。
8. **不要裸 HTTP 打模型网关**：Pi 已提供模型、鉴权、transport、timeout、headers 抽象。
9. **UI 能力要按 mode 降级**：`ctx.hasUI` 才能弹 `confirm/select/input/editor`；`ctx.mode === "tui"` 才做复杂 TUI 组件。
10. **Pi 默认没有内置 plan/todo/subagent**：本扩展必须自带 plan/todo 工具和必要的提问工具，不能假设 Pi core 已经提供。

### 0.2 对原设计稿的关键落地修正

| 原设计点 | 落地修正 | 原因 |
|---|---|---|
| `askuserquestion` 被列为允许工具 | 本扩展实现 `plan_ask`，或在包内复用 `questionnaire` 思路；不依赖外部示例工具 | Pi core 默认工具没有 `askuserquestion`；示例工具不是自动存在 |
| `review` 用 `ctx.getModel()+complete()` | 增加 `ctx.modelRegistry.getApiKeyAndHeaders(model)`，并设置 `timeoutMs/signal` | `complete()` 需要鉴权参数；文档示例如此 |
| 状态“不存内存” | 实现上允许有内存 cache，但每次 `session_start/session_tree/tool_result` 后都从 branch 重建，内存只作派生缓存 | Extension 运行中需要局部变量；真相源仍是 session branch |
| `.pi/plan-draft-*.md` 是渲染产物 | `plan_write` 写文件时必须用 `withFileMutationQueue()`；重建后可按 state 重新渲染 | Pi 工具并发执行，文件写入要入队 |
| `research → grilling` 未定义触发工具 | 允许 `grill_plan` 在 `research` 阶段首次调用时进入 `grilling`；若 `restart_research=true` 则回到 `research` | 避免新增不必要的 `research_done` 工具 |
| `/plan` 命令只写状态还不够 | `/plan <需求>` handler 需初始化状态后 `pi.sendUserMessage()` 触发 agent | Extension command 会绕过普通 agent 输入，不主动发送则流程不会开始 |

---

## 1. 最终用户体验

### 1.1 启动

```text
/plan 给当前项目增加 GitHub OAuth 登录
```

扩展执行：

1. 生成 `planId`，例如 `20260606-143012-a8f3`。
2. 保存初始 state 到 session custom entry。
3. 限制 active tools 到只读/规划工具。
4. 注入规划系统提示。
5. 把用户需求作为 user message 发给 agent，让 agent 开始只读调研。

### 1.2 调研 + 逼问

Agent 先只读查看文件，然后用最多 5 次 `plan_ask` 询问关键决策。每次问题必须满足：

- 不问可以自行查代码得到的事实；
- 不问低影响纯偏好；
- 只问如果答错会导致返工或架构推翻的问题；
- 用户回答若是“都行/看情况/之后再说”之类不可执行答案，必须继续追问同 topic。

### 1.3 草稿 + 自动 review

Agent 调 `plan_write` 写结构化草稿。扩展在该 turn 结束后自动调用当前模型做一次 review：

- 成功：把 review 意见作为后续 user message 投回主 agent，要求按意见改稿，再次 `plan_write`。
- 失败或无模型/无 key/超时：跳过 review，进入用户审批，并标注“未经自动审查”。

### 1.4 用户审批

Agent 调 `plan_exit`，扩展展示 plan：

- `Approve`：promote 到 `docs/plan-<slug>-<planId>.md`，注册 todos，进入执行态。
- `Request revision`：要求用户输入驳回理由，回到 `revising`。
- `Cancel`：等价 `/plan-abort`。

### 1.5 执行

进入 `executing` 后恢复原 active tools，并启用 `todo_write` 纪律：

- 同时最多一个 `in_progress`。
- 有测试失败、报错、未完成时不能标 `completed`。
- 执行期进度真相源是 todo，不回写已批准 plan 文件。

---

## 2. 目录与包结构

建议按项目级 extension 开发，后续再打成 Pi package：

```text
yuki-pi/
  package.json
  tsconfig.json
  extensions/
    plan-flow/
      index.ts              # 入口：注册命令、工具、事件、快捷键、flag
      constants.ts          # customType、工具名、phase、默认文件名
      types.ts              # Phase、PlanFlowState、PlanStep、TodoItem 等
      state.ts              # reconstructState/applySnapshot/persist helpers
      gate.ts               # tool_call 白名单门禁 + active tools 切换
      prompts.ts            # 各 phase 注入 prompt + review prompt
      paths.ts              # planId、slug、draft/final 路径
      render.ts             # state.steps -> markdown；todo -> widget
      review.ts             # ctx.getModel + complete 自动 review
      tools/
        plan-ask.ts         # 提问工具，累计 askCount
        grill.ts            # grill_plan / grill_done
        plan-write.ts       # 写 steps 真相源 + 渲染 draft
        plan-exit.ts        # 审批、promote、注册 todos
        todo-write.ts       # 执行期 todo 状态更新
      ui.ts                 # status/widget/approval UI 轻封装
      validation.ts         # schema 校验、grilling 答案合格校验
      file-mutations.ts     # withFileMutationQueue 包装写 draft/final
      tests/
        state.test.ts
        validation.test.ts
        render.test.ts
        paths.test.ts
```

### 2.1 `package.json`

```json
{
  "name": "yuki-pi-plan-flow",
  "version": "0.1.0",
  "keywords": ["pi-package"],
  "type": "module",
  "peerDependencies": {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "typescript": "latest",
    "vitest": "latest"
  },
  "pi": {
    "extensions": ["./extensions/plan-flow/index.ts"]
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

> Pi package 文档要求：Pi 核心包用 `peerDependencies: "*"`，不要打包；运行时第三方依赖才放 `dependencies`。

---

## 3. 状态模型

### 3.1 Phase

```ts
export type Phase =
  | "idle"
  | "research"
  | "grilling"
  | "drafting"
  | "reviewing"
  | "revising"
  | "awaiting_approval"
  | "executing"
  | "aborted";
```

说明：

- `idle`：普通 Pi 状态，没有 plan flow。
- `reviewing`：扩展内部短暂态；主要用于防并发重复 review 和 UI 状态展示。
- `aborted`：终止态，用于 branch 重建时明确知道该 plan 已停止。

### 3.2 核心 state

```ts
export interface PlanFlowState {
  version: 1;
  active: boolean;

  phase: Phase;
  planId: string;
  request: string;
  title?: string;

  // 与 Pi active tool 恢复相关
  previousActiveTools: string[];
  currentActiveTools: string[];

  // grilling
  questions: OpenQuestion[];
  askCount: number;
  maxAskCount: 5;

  // plan 真相源
  steps: PlanStep[];
  background?: string;
  risks: string[];

  // review
  reviewed: boolean;
  reviewPending: boolean;
  reviewSkipped?: boolean;
  reviewSkippedReason?: string;
  reviewFeedback?: ReviewFeedback;

  // approval / storage
  approved: boolean;
  draftPath: string;
  finalPath?: string;
  approvedAt?: string;

  // execution
  todos: TodoItem[];

  // audit
  createdAt: string;
  updatedAt: string;
  abortedAt?: string;
  abortReason?: string;
}
```

### 3.3 Question

```ts
export interface OpenQuestion {
  id: string;
  topic: string;
  question: string;
  whyMatters: string;
  status: "open" | "resolved";
  resolution?: string;
  askedAt?: string;
  answeredAt?: string;
  answer?: string;
}
```

约束：

- `topic` 是合并键；打回 research 后同 topic 的 resolved question 必须保留。
- `resolution` 必须是可执行决定，不接受“随便/都行/看情况/之后再说”。

### 3.4 PlanStep

```ts
export interface PlanStep {
  id: string;
  content: string;      // 祈使句："Update auth middleware to ..."
  activeForm: string;   // 进行时："Updating auth middleware to ..."
  rationale?: string;
  files?: string[];
  validation?: string[];
  dependsOn?: string[];
}
```

### 3.5 TodoItem

```ts
export interface TodoItem {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
  evidence?: string;
  updatedAt: string;
}
```

---

## 4. 状态持久化与重建

### 4.1 记录类型

```ts
export const STATE_CUSTOM_TYPE = "yuki-plan-flow-state";

export interface PlanFlowStateRecord {
  kind: "snapshot" | "abort";
  reason:
    | "plan_start"
    | "phase_change"
    | "review_complete"
    | "review_skipped"
    | "approval"
    | "abort"
    | "session_restore";
  planId: string;
  state: PlanFlowState;
}
```

### 4.2 何时写入哪里

| 触发源 | 写入方式 | 原因 |
|---|---|---|
| `/plan`、`/plan-abort` 命令 | `pi.appendEntry(STATE_CUSTOM_TYPE, record)` | 命令不产生 tool result |
| `turn_end` 自动 review 完成/跳过 | `pi.appendEntry(...)` | 事件不产生 tool result |
| `plan_ask`、`grill_plan`、`grill_done`、`plan_write`、`plan_exit`、`todo_write` | 工具返回 `details: { state, ... }` | Pi 文档推荐用 tool result details 做分支安全状态 |
| UI status/widget | 不持久化，重建后从 state 派生 | 避免 UI 成为真相源 |
| draft/final 文件 | 从 `state.steps` 渲染 | 文件不是状态源 |

### 4.3 `reconstructState(ctx)` 算法

```ts
export function reconstructState(ctx: ExtensionContext): PlanFlowState | undefined {
  let state: PlanFlowState | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    // 1. command/event custom entry
    if (entry.type === "custom" && entry.customType === STATE_CUSTOM_TYPE) {
      state = applyStateRecord(state, entry.data as PlanFlowStateRecord);
      continue;
    }

    // 2. tool result details
    if (entry.type === "message" && entry.message.role === "toolResult") {
      const toolName = entry.message.toolName;
      if (isPlanFlowTool(toolName)) {
        const details = entry.message.details as { state?: PlanFlowState } | undefined;
        if (details?.state) state = applySnapshot(state, details.state);
      }
    }
  }

  if (!state || !state.active || state.phase === "idle" || state.phase === "aborted") {
    return state;
  }

  return normalizeState(state);
}
```

关键点：

- 只扫描 `getBranch()`，不扫 `getEntries()`，保证 `/tree` 切分支后状态正确。
- 使用 full snapshot 简化恢复；必要时在 `applyStateRecord` 中兼容旧版本 delta。
- `normalizeState` 校验 `askCount <= 5`、最多一个 `in_progress`、路径存在/可重渲染。

### 4.4 `restart_research` 合并策略

当 `grill_plan({ restart_research: true })`：

1. `phase = "research"`。
2. 保留 `questions` 中 `status="resolved"` 的项目。
3. 清理或标记 open 项：
   - 同 topic 后续重新提出时覆盖旧 open；
   - resolved 同 topic 不允许被无理由降级为 open，除非 `grill_plan` 参数显式给出 `supersedesResolution: true`（第一版可不支持）。
4. `askCount` 不清零，仍累计到 5。

---

## 5. 命令设计

### 5.1 `/plan <需求>`

职责：启动流程。

伪代码：

```ts
pi.registerCommand("plan", {
  description: "Start yuki plan flow",
  handler: async (args, ctx) => {
    const request = args.trim();
    if (!request) {
      ctx.ui.notify("Usage: /plan <需求描述>", "warning");
      return;
    }

    const previousActiveTools = pi.getActiveTools();
    const planId = createPlanId();
    const state = createInitialState({
      planId,
      request,
      cwd: ctx.cwd,
      previousActiveTools,
    });

    persistCustom(pi, state, "plan_start");
    applyActiveTools(pi, state);
    updatePlanUi(ctx, state);

    pi.sendUserMessage(buildPlanKickoffMessage(state));
  },
});
```

### 5.2 `/plan-abort [reason]`

职责：任意阶段退出，删除临时 draft，恢复工具，清 UI。

步骤：

1. `const state = reconstructState(ctx)`。
2. 若无 active plan，提示“没有正在进行的 plan”。
3. 删除 `.pi/plan-draft-<planId>.md`（失败只 warning，不阻断）。
4. `phase="aborted"; active=false; abortedAt=now; abortReason=args || "user aborted"`。
5. 写 custom state entry。
6. `pi.setActiveTools(state.previousActiveTools)`。
7. 清 `ctx.ui.setStatus` 和 `ctx.ui.setWidget`。

### 5.3 `/plan-status`

第一版建议实现，便于调试和恢复：

- 展示 phase、planId、askCount、review 状态、draft/final path、todo 完成数。
- 非 TUI 下用 `ctx.ui.notify` 或直接 `pi.sendMessage`。

---

## 6. 工具设计

所有工具 schema 用 `typebox`；枚举用 `StringEnum`，避免 Google provider 不兼容 `Type.Union(Type.Literal(...))`。

### 6.1 `plan_ask`

> 自带提问工具，替代设计稿中未必存在的 `askuserquestion`。

参数：

```ts
const PlanAskParams = Type.Object({
  topic: Type.String(),
  question: Type.String(),
  why_matters: Type.String(),
  options: Type.Optional(Type.Array(Type.Object({
    label: Type.String(),
    description: Type.Optional(Type.String()),
    value: Type.Optional(Type.String()),
  }))),
  allow_other: Type.Optional(Type.Boolean()),
});
```

执行逻辑：

1. 只允许 phase=`grilling`。
2. 若 `askCount >= 5`，拒绝并提示必须 `grill_done`。
3. 若 `ctx.hasUI=false`，返回错误；非交互模式不能卡住等待。
4. 用 `ctx.ui.select/input/editor` 询问。
5. `askCount += 1`，把 answer 写到对应 topic 的 question。
6. 返回 `{ content: [{ text: answer }], details: { state } }`。

### 6.2 `grill_plan`

参数：

```ts
const GrillPlanParams = Type.Object({
  open_questions: Type.Array(Type.Object({
    topic: Type.String(),
    question: Type.String(),
    why_matters: Type.String(),
    status: StringEnum(["open", "resolved"] as const),
    resolution: Type.Optional(Type.String()),
  })),
  restart_research: Type.Optional(Type.Boolean()),
});
```

执行逻辑：

1. 允许 phase=`research|grilling`。
2. `open_questions.length > 5` 直接 throw，作为工具错误反馈给 LLM。
3. 校验 resolved 的 `resolution`：
   - 不能为空；
   - 不能匹配 `/^(随便|都行|看情况|之后再说|到时候再说|无所谓)$/i`；
   - 必须包含明确选择、范围、接口、文件、约束或验收标准之一。
4. `restart_research=true`：回 `research`，保留 resolved，返回提示“重新调研，不要重复询问已 resolved topics”。
5. 正常：进入或保持 `grilling`。
6. 若全部 resolved 或 `askCount>=5`，提示可调用 `grill_done`。

### 6.3 `grill_done`

参数：

```ts
const GrillDoneParams = Type.Object({
  summary: Type.String({ description: "Resolved decisions summary" }),
});
```

执行逻辑：

1. 允许 phase=`grilling`。
2. 若仍有 open questions 且 `askCount < 5`，允许但返回 warning：agent 必须说明为什么可继续。
3. 设置 `phase="drafting"`。
4. 启用 drafting 工具集。

### 6.4 `plan_write`

参数：

```ts
const PlanWriteParams = Type.Object({
  title: Type.String(),
  background: Type.String(),
  steps: Type.Array(Type.Object({
    content: Type.String(),
    activeForm: Type.String(),
    rationale: Type.Optional(Type.String()),
    files: Type.Optional(Type.Array(Type.String())),
    validation: Type.Optional(Type.Array(Type.String())),
    dependsOn: Type.Optional(Type.Array(Type.String())),
  })),
  risks: Type.Optional(Type.Array(Type.String())),
});
```

执行逻辑：

1. 允许 phase=`drafting|revising|awaiting_approval`。
2. 校验：
   - 至少 1 个 step；
   - `content` 是祈使句，不能是模糊描述；
   - `activeForm` 非空；
   - 每个 step 最好有 validation。
3. 更新 `state.steps/background/risks/title`。
4. 如果 phase=`drafting`：
   - `reviewed=false`；
   - `reviewPending=true`；
   - phase 暂保持 `drafting`，由 `turn_end` 触发 review。
5. 如果 phase=`revising`：
   - `reviewed=true`；
   - `reviewPending=false`；
   - `phase="awaiting_approval"`。
6. 如果 phase=`awaiting_approval`：
   - 允许用户审批前继续微调；
   - phase 仍为 `awaiting_approval`。
7. 用 `withFileMutationQueue(draftPath, ...)` 渲染 `.pi/plan-draft-<planId>.md`。
8. 返回 details full state。

### 6.5 `plan_exit`

参数：

```ts
const PlanExitParams = Type.Object({
  message: Type.Optional(Type.String({ description: "Short message to show before approval" })),
});
```

执行逻辑：

1. 允许 phase=`awaiting_approval`。
2. 从 `state.steps` 渲染 plan，不读 draft 文件。
3. 若 `ctx.hasUI=false`：返回错误，要求用户在交互模式审批；或降级为“未审批，不能执行”。
4. TUI 中展示：
   - 标题、背景、steps、risks、review 状态；
   - 选项：`Approve` / `Request revision` / `Cancel`。
5. `Request revision`：
   - 调 `ctx.ui.editor("Revision reason", "")`；
   - `phase="revising"`；
   - 返回内容要求 agent 按理由调用 `plan_write`。
6. `Cancel`：调用 abort helper。
7. `Approve`：
   - `approved=true; phase="executing"`；
   - promote draft/final：`docs/plan-<slug>-<planId>.md`；
   - 文件头写明：`docs plan 是批准时快照；执行进度以 todo 为准，不回写本文档`；
   - `todos = steps.map(...)`；
   - 恢复 `previousActiveTools + todo_write`（去重，且不越过用户原本禁用的工具）。

### 6.6 `todo_write`

参数：

```ts
const TodoWriteParams = Type.Object({
  todos: Type.Array(Type.Object({
    id: Type.String(),
    content: Type.String(),
    activeForm: Type.String(),
    status: StringEnum(["pending", "in_progress", "completed"] as const),
    evidence: Type.Optional(Type.String()),
  })),
  note: Type.Optional(Type.String()),
});
```

校验：

1. 只允许 phase=`executing`。
2. `in_progress` 数量必须 `<=1`。
3. 不允许删除 todo；只允许更新 status/evidence。
4. 标 completed 必须提供 `evidence`，例如：
   - 测试命令 + 通过结果；
   - 文件修改摘要；
   - 用户确认；
   - 若没有测试，必须写明“未运行测试及原因”。
5. 如果最近工具结果显示 error，agent 仍试图 completed：拒绝。第一版可基于 `state.lastToolError` 或在 prompt 中强约束；第二版再做严格工具结果扫描。

---

## 7. 工具门禁与 active tools

### 7.1 双层防护

1. **`pi.setActiveTools()`**：让模型 prompt 中只看到当前阶段可用工具，减少误调用。
2. **`tool_call` 白名单门禁**：即使模型或其他扩展绕过 active tools，也按 phase 阻断。

### 7.2 Phase 白名单

```ts
const PHASE_TOOL_ALLOWLIST: Record<Phase, string[]> = {
  idle: [],
  research: ["read", "grep", "find", "ls", "grill_plan"],
  grilling: ["plan_ask", "grill_plan", "grill_done", "read", "grep", "find", "ls"],
  drafting: ["plan_write"],
  reviewing: [],
  revising: ["plan_write"],
  awaiting_approval: ["plan_write", "plan_exit"],
  executing: ["todo_write", "read", "grep", "find", "ls", "bash", "edit", "write"],
  aborted: [],
};
```

> 注意：执行态不应硬编码“全部工具”，而应恢复 `previousActiveTools`，再追加 `todo_write`。上表用于门禁概念，具体实现要尊重用户启动 Pi 时的 `--tools/--exclude-tools` 限制。

### 7.3 门禁实现

```ts
pi.on("tool_call", async (event, ctx) => {
  const state = reconstructState(ctx);
  if (!state?.active) return;

  const allowed = getAllowedToolsForState(state);
  if (!allowed.includes(event.toolName)) {
    return {
      block: true,
      reason: `yuki plan-flow: tool ${event.toolName} is not allowed during phase ${state.phase}. Allowed: ${allowed.join(", ")}`,
    };
  }
});
```

---

## 8. Prompt 注入策略

在 `before_agent_start` 注入隐藏 custom message 或追加 system prompt。建议：

- 稳定规则放 `systemPrompt` 后追加；
- 当前 state 快照放 hidden custom message；
- 避免把完整历史 plan 大段重复塞入 system prompt，防止上下文膨胀。

### 8.1 research prompt 要点

```text
[YUKI PLAN FLOW: research]
You are in read-only research phase.
Allowed actions: inspect files with read/grep/find/ls, then call grill_plan.
Do not modify files. Do not draft implementation yet.
When you have enough context, call grill_plan with decision-level open questions.
```

### 8.2 grilling prompt 要点

```text
Ask at most 5 critical decision questions in total.
Only ask questions that can change the implementation architecture or cause rework.
Do not ask facts you can inspect from the repo.
Invalid resolutions include: "随便", "都行", "看情况", "之后再说".
A resolved question must produce an executable decision.
Use plan_ask for one question at a time.
Call grill_done when ready.
```

### 8.3 drafting/revising prompt 要点

```text
Use plan_write, not free-form markdown, as the source of truth.
Each step must have content and activeForm.
Prefer validation commands or concrete verification criteria per step.
```

### 8.4 executing prompt 要点

```text
Execute approved todos in order.
Maintain exactly one in_progress todo at a time.
Never mark completed if tests fail, errors remain, or work is partial.
Use todo_write to update progress.
The approved docs plan is a snapshot; do not edit it for execution progress.
```

---

## 9. 自动 review 实施

### 9.1 触发点

设计稿指定 `turn_end`。实现细节：

1. `plan_write` 在 drafting 阶段设置 `reviewPending=true`。
2. `turn_end` 重建 state。
3. 若满足：
   - `state.phase === "drafting"`
   - `state.reviewPending === true`
   - `state.reviewed === false`
   - 当前 turn toolResults 中包含 `plan_write`
4. 则调用 `reviewPlan(ctx, state)`。

### 9.2 review 调用伪代码

```ts
import { complete } from "@earendil-works/pi-ai";

export async function reviewPlan(ctx: ExtensionContext, state: PlanFlowState) {
  const model = ctx.getModel();
  if (!model) return { skipped: true, reason: "No active model" };

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return { skipped: true, reason: auth.error };
  if (!auth.apiKey) return { skipped: true, reason: "No API key for active model" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  ctx.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const response = await complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{ type: "text", text: buildReviewPrompt(state) }],
          timestamp: Date.now(),
        }],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: controller.signal,
        timeoutMs: 60_000,
        temperature: 0,
      },
    );

    return parseReviewResponse(response);
  } catch (error) {
    return { skipped: true, reason: String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
```

### 9.3 review 输出格式

不要求模型重写 plan，只输出问题：

```json
{
  "summary": "...",
  "blockingIssues": [
    { "stepId": "...", "issue": "...", "suggestion": "..." }
  ],
  "risks": ["..."],
  "missingValidation": ["..."]
}
```

第一版可以用文本 JSON fenced block 解析；解析失败时保留 raw text，不阻断流程。

### 9.4 review 成功后的主 agent 驱动

```ts
persistCustom(pi, nextState, "review_complete");
applyActiveTools(pi, nextState); // revising tools only
pi.sendUserMessage(buildReviewFeedbackMessage(nextState), { deliverAs: "steer" });
```

`buildReviewFeedbackMessage` 明确要求：

- 不要重新调研，除非 review 指出信息缺失；
- 按 review 修改 plan；
- 调用 `plan_write`；
- 不要直接进入执行。

### 9.5 review 失败降级

```ts
state.reviewSkipped = true;
state.reviewSkippedReason = reason;
state.reviewPending = false;
state.phase = "awaiting_approval";
```

然后投递消息：

```text
Automatic review was skipped: <reason>.
Proceed to user approval by calling plan_exit. Clearly mention the plan was not automatically reviewed.
```

---

## 10. 文件路径与渲染

### 10.1 planId

```ts
YYYYMMDD-HHmmss-<4 bytes random hex>
```

示例：`20260606-143012-a8f3c091`。

### 10.2 draft path

```text
.pi/plan-draft-<planId>.md
```

创建 `.pi/` 目录时使用 `mkdir({ recursive: true })`。

### 10.3 final path

```text
docs/plan-<slug>-<planId>.md
```

`slug` 从 title 生成：

- 小写；
- 非字母数字转 `-`；
- 合并连续 `-`；
- 最长 60 字符；
- 为空则用 `plan`。

### 10.4 Markdown 模板

```md
# <title>

> Plan ID: <planId>  
> Status: Approved snapshot  
> Approved at: <approvedAt>  
> Execution progress source: Pi todo state (`todo_write`), not this document.

## Background

<background>

## Decisions

- <resolved question topic>: <resolution>

## Steps

1. **<content>**
   - Active form: <activeForm>
   - Rationale: <rationale>
   - Files: ...
   - Validation: ...

## Risks

- ...

## Review

- Automatic review: passed/skipped
- Feedback summary: ...
```

---

## 11. UI 与可观测性

### 11.1 Footer status

- research：`🧭 plan research`
- grilling：`❓ plan 2/5`
- drafting：`📝 drafting`
- reviewing：`🔎 reviewing`
- revising：`✍️ revising`
- awaiting approval：`⏳ approval`
- executing：`📋 1/5`

### 11.2 Widget

执行态展示 todo：

```text
☑ Step 1 ...
◉ Step 2 ...        # in_progress
☐ Step 3 ...
```

非执行态展示 phase 摘要，避免刷屏。

### 11.3 Custom message renderer（可选第二阶段）

第一版可用默认 custom message 渲染。第二阶段再为：

- `yuki-plan-review`
- `yuki-plan-approved`
- `yuki-plan-aborted`

注册 renderer 美化展示。

---

## 12. 实施里程碑

### Milestone 1：工程骨架 + 状态重建

交付：

- 目录结构、`package.json`、`tsconfig.json`。
- `types.ts/constants.ts/state.ts/paths.ts/render.ts`。
- 单测覆盖：
  - `createPlanId()` 唯一性与格式；
  - `slugify()`；
  - `reconstructState()` 对 custom entry + tool result snapshot 的顺序 apply；
  - branch 只读 `getBranch()` 输入模拟。

验收：

```bash
npm test
npm run typecheck
pi -e ./extensions/plan-flow/index.ts --no-session
```

### Milestone 2：命令 + phase 门禁

交付：

- `/plan`、`/plan-abort`、`/plan-status`。
- `before_agent_start` prompt 注入。
- `tool_call` 白名单门禁。
- `session_start/session_tree` 重建并恢复 UI/tools。

验收：

1. `/plan test` 后 `edit/write/bash` 在 research 被阻断。
2. `/plan-abort` 后 active tools 恢复。
3. `/reload` 后 status 能恢复。
4. `/tree` 切回 plan 前分支后状态随 branch 变化。

### Milestone 3：grilling 工具

交付：

- `plan_ask`。
- `grill_plan`。
- `grill_done`。
- `validation.ts` 中 resolution 合格判定。

验收：

1. 超过 5 问被拒绝。
2. `askCount` 是累计，不因 open questions 数组变化减少。
3. “都行/看情况”不能 resolved。
4. `restart_research=true` 保留 resolved questions。

### Milestone 4：plan_write + draft 渲染

交付：

- `plan_write` 工具。
- draft 文件渲染。
- `withFileMutationQueue()` 包装写文件。

验收：

1. `plan_write` 后 `.pi/plan-draft-<planId>.md` 存在。
2. 重建状态后重新 render 与 state 一致。
3. 手改 draft 不影响 state；下一次 render 会覆盖为 state 内容。

### Milestone 5：自动 review

交付：

- `review.ts`。
- `turn_end` 检测 `reviewPending`。
- 成功/跳过两条路径。

验收：

1. 初稿 `plan_write` 后自动调用 review。
2. review 失败不 throw、不阻断。
3. 成功后 phase=`revising`，再次 `plan_write` 后 phase=`awaiting_approval`。
4. 不发生 review 死循环。

### Milestone 6：approval + promote + todo 注册

交付：

- `plan_exit`。
- `docs/plan-<slug>-<planId>.md`。
- todos 初始化。

验收：

1. Approve 后 final 文件不覆盖历史。
2. Request revision 回到 revising。
3. Cancel 等价 abort。
4. final 文件声明“执行进度以 todo 为准”。

### Milestone 7：todo_write + 执行纪律

交付：

- `todo_write`。
- 执行态 prompt。
- UI widget。

验收：

1. 两个 `in_progress` 被拒绝。
2. 删除 todo 被拒绝。
3. completed 无 evidence 被拒绝。
4. 执行态恢复用户原 active tools，不越权启用原本禁用的工具。

### Milestone 8：打包与文档

交付：

- README：安装、使用、故障排查。
- Pi package manifest。
- 示例 GIF/截图可选。

验收：

```bash
pi install ./yuki-pi -l
pi config
pi
/reload
/plan <需求>
```

---

## 13. 测试矩阵

### 13.1 单元测试

| 模块 | 用例 |
|---|---|
| `paths.ts` | planId 格式、slug 截断、路径拼接跨平台 |
| `validation.ts` | resolved 判定、bad answer blacklist、todo 状态校验 |
| `state.ts` | snapshot apply、abort 覆盖、restart research 合并、branch 顺序 |
| `render.ts` | markdown escaping、空 risks、review skipped 文案 |
| `gate.ts` | 每个 phase 的 allow/deny、previousActiveTools 恢复 |

### 13.2 手动集成测试

1. **Happy path**：
   - `/plan 增加一个 README badge`；
   - research → grilling → drafting → review → revising → approval → executing。
2. **Review skipped**：
   - 切到无 key 模型或 mock `ctx.getModel=undefined`；
   - 确认可进入 approval。
3. **Abort path**：
   - research 中 `/plan-abort`；
   - draft 删除、tools 恢复。
4. **Branch safety**：
   - plan A 进入 drafting；
   - `/tree` 回到 `/plan` 前；
   - 启动 plan B；
   - 切回 plan A，状态和 draft/final 不互踩。
5. **Concurrent file mutation**：
   - 同 turn 同时触发 plan_write 和 edit（理论上门禁会阻断 edit）；
   - 确认 draft 写入稳定。
6. **No UI mode**：
   - `pi -p -e ./extensions/plan-flow/index.ts "/plan ..."`；
   - 需要明确报错或跳过需要 UI 的审批/提问，不挂死。

---

## 14. 风险与规避

| 风险 | 规避 |
|---|---|
| 其他扩展也注册 `/plan` 或 `/todos` | Pi 会 suffix 冲突命令；本扩展命名可用 `/yuki-plan` 作为别名，todo 工具用 `todo_write` 不抢 `/todos` |
| active tools 恢复错误导致越权 | 保存 `previousActiveTools`，执行态只恢复这些 + 本扩展必要工具 |
| review 模型调用卡住 | `timeoutMs=60000` + `AbortController` + catch 降级 |
| 文件与 state 双真相源 | 永远只从 state 渲染；永不从 draft/final 反读 state |
| 非 TUI 无法提问/审批 | `ctx.hasUI` 检查，返回明确错误；不等待不可用 UI |
| `/reload` 后内存丢失 | `session_start` 从 branch 重建所有状态 |
| `/tree` 后状态串分支 | 只用 `getBranch()`，不用 `getEntries()` 作为真相源 |
| LLM 不按纪律调用工具 | active tools + tool_call gate + schema 校验三层约束 |
| completed 误标 | `todo_write` 强制 evidence；后续增强扫描最近 error tool result |

---

## 15. 第一版完成定义（Definition of Done）

1. `/plan <需求>` 能自动进入 research，并阻止写文件。
2. grilling 最多 5 问，且 `askCount` 分支恢复正确。
3. `plan_write` 结构化写入 state，并渲染 draft。
4. drafting 后自动 review；review 失败不阻断。
5. revising 后进入 approval。
6. `plan_exit` approve 后生成 `docs/plan-...-<planId>.md`，并初始化 todo。
7. executing 中 `todo_write` 保证单 in_progress 和 completed evidence。
8. `/plan-abort` 任意阶段可恢复普通 Pi 状态。
9. `/reload`、`/tree`、resume 后状态正确。
10. 文档中明确 plan 文件是批准快照，todo 是执行期真相源。

---

## 16. 推荐实现顺序（最小可用到完整）

1. 先实现 `state.ts + /plan + /plan-abort + gate`，确保安全边界。
2. 再实现 `plan_write`，让 plan 真相源跑通。
3. 再补 `grill_* + plan_ask`，完善前置澄清。
4. 再做 `review.ts`，因为 review 失败可降级，不应阻塞主链路开发。
5. 再做 `plan_exit + promote + todo_write`，打通执行。
6. 最后做 UI 美化、README、package 发布。

这个顺序能保证每个阶段都有可手动验证的垂直切片，而不是一次性堆完整状态机。
