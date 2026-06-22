# PLAN MODE 问题调研报告

> 调研日期：2026-06-22
> 范围：`extensions/plan-mode/index.ts` 及相关 UI / subagent 机制
> 性质：事实调研，不含代码改动

---

## 摘要

用户提出 plan-mode 的三个体验问题，本报告通过阅读源码逐一核实，并补充了 pi 社区与 Claude Code 社区的 review subagent prompt 模板调研。核心结论：

1. **review 的 warning/error 像出问题** — 属实。根因是通知级别语义被混用，且 review 实际意见几乎不展示给用户。
2. **用 subagent review plan** — 现在完全没用 subagent，review 走 LLM 直连。subagent 能补短板，限定 1 次合理，但落地涉及架构选择。
3. **plan 触发后 UI 不好** — 三个子问题分别属实 / 部分属实 / 属实，根因各不相同。

所有结论均带 `extensions/plan-mode/index.ts` 行号作为证据。

---

## 问题 1：review 阶段的 warning/error 像是"出问题了"

### 1.1 review 机制总览

review 机制在 `extensions/plan-mode/index.ts`，核心是 `runAutomaticReview`（**index.ts:572**）。

触发时机：`plan_write` 提交 `mode: "full"` 草稿后，在 `turn_end` 事件里触发（**index.ts:417-434**）。

关键实现方式：**review 是主模型自己直连 LLM `complete()`，不走 agent 循环**（index.ts:572-616）：

```ts
const response = await complete(
  model,
  { messages: [{ role: "user", content: [{ type: "text", text: buildReviewPrompt(state) }] }] },
  { apiKey: auth.apiKey, headers: auth.headers, signal: controller.signal, timeoutMs: 60_000 },
);
```

review prompt 由 `buildReviewPrompt`（**index.ts:637**）构建，要求返回严格 JSON：

```
{"summary":"...","blockingIssues":[{"stepId":"step-1","issue":"...","suggestion":"..."}],"risks":["..."],"missingValidation":["step-2"]}
```

返回结果由 `parseReviewFeedback`（**index.ts:651**）解析为 `ReviewFeedback` 结构。

### 1.2 warning 通知的来源

review 结果通过 `drivePostReview`（**index.ts:990**）转成 UI 通知，一律用 `"warning"` 级别：

```ts
// index.ts:1003-1004 — blocking 但还在自动修订循环里
ctx.ui.notify(
  `Automatic review found ${issueCount} blocking issue(s); revising automatically (${state.reviewRevisionAttempts}/${MAX_REVIEW_REVISION_ATTEMPTS}).`,
  "warning",
);

// index.ts:996-997 — 超过 MAX_REVIEW_REVISION_ATTEMPTS(=3)
ctx.ui.notify(
  `Automatic review still has ${issueCount} blocking issue(s) after ${state.reviewRevisionAttempts} attempt(s); waiting for intervention.`,
  "warning",
);
```

另外的 `"warning"` 通知（index.ts:171/175/401/1031 等）是真正的"出问题"信号：review 被 skip 的原因、stalled 提示、参数错误等。

### 1.3 关键边界情况：非 JSON 返回

**index.ts:655-657**，当 review 返回的不是合法 JSON 时：

```ts
catch {
  return {
    summary: "Review returned non-JSON feedback; treat as blocking revision feedback.",
    blockingIssues: [{ issue: raw }],
    raw,
  };
}
```

这种会被当 blocking 处理，但用户只看到 "found N blocking issue(s)" 的 warning，**完全看不到模型实际返回了什么 review 意见**。

### 1.4 review 意见几乎不展示给用户

`ReviewFeedback` 结构（index.ts:93-99）含 `summary`、`risks`、`missingValidation`，但这些几乎不展示：

- `renderPlanMarkdown`（**index.ts:1126**）里只一句 `Automatic review: completed/skipped` 一笔带过，不显示 summary 内容。
- blockingIssues 内容只通过 `formatReviewIssues`（**index.ts:665**）喂回模型做修订，**不显示给用户**。

### 1.5 判断

**用户直觉基本正确**，更精确的说法是：

现在的 warning 通知不区分两类语义完全不同的情况：
- **review 正常提了 blocking 意见**（这是预期工作流，不是 fail）
- **review 流程真的出错了**（skip / 非 JSON / 超时）

两者都打 warning，语义被混在一起。

而 review 的实际意见（summary、blockingIssues、suggestion）几乎不展示给用户。用户问"review 机制是什么"时看不到 review 意见，确实是设计缺口 —— review 的 summary/findings 应该作为可见消息 publish 出来（类似 `PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE` 那条 markdown 预览），而不是只塞进 state 里给模型看。

---

## 问题 2：用 subagent 来 review plan

### 2.1 现状：完全没有用 subagent

review 走的是 `complete()` 直连（index.ts:589），**没有调用 `subagent` 工具，也没有任何 review 专用 subagent**。

本仓库已集成 `@mjakl/pi-subagent`（`pi-subagent/` 目录），目前只有两个 agent：
- `explore` — `~/.pi/agent/agents/explore.md`（read-only 代码探索）
- `oracle` — `pi-subagent/agents/oracle.md`

### 2.2 为什么 subagent review plan 会更好

现在的 review 有几个硬伤，subagent 正好能补：

1. **工具受限**：`complete()` 是纯文本 LLM 调用，reviewer 看不到实际代码，只能 review plan 文本的内部一致性。plan review 真正该做的是去读目标文件、grep 现有实现、核对 plan 声称的 API 是否存在 —— 这些都需要 `read`/`grep`/`find` 工具。subagent 可以带工具集。
2. **没有独立 context**：review 在主 session 的 turn_end 里同步跑（index.ts:417-434），60s 超时（index.ts:582），context 和主 agent 共享。subagent 跑在独立进程，context 隔离。
3. **prompt 太弱**：`buildReviewPrompt`（index.ts:637）只有 6 行指令 + plan markdown，没有领域知识。subagent 可以有专门的 system prompt。

### 2.3 关于"限定 1 次"

用户判断正确。现在的修订循环是 `MAX_REVIEW_REVISION_ATTEMPTS = 3`（index.ts:13），主模型自动改 3 次。如果换成 subagent review，它更重（带工具、独立进程），**限定 1 次合理**：subagent review 一次 → 有 blocking 就直接进 `awaiting_approval` 让用户决定，或者把 blocking 喂回主模型修订 1 次再 review。不要让 subagent review 进自动循环，否则会很慢很贵。

### 2.4 落地可行性

本仓库的 subagent 定义格式（以 `explore.md` 为准）是 Markdown + YAML frontmatter：

```yaml
---
name: plan-reviewer
description: Review yuki plan drafts against the actual codebase. ...
tools: read, grep, find, ls
---
system prompt body...
```

放置位置：
- user 级：`~/.pi/agent/agents/plan-reviewer.md`
- project 级：`.pi/agents/plan-reviewer.md`（project 优先，repo 受控）

frontmatter 字段解析见 `pi-subagent/agents.ts:157-191`，支持 `name` / `description` / `tools` / `model` / `thinking` / `sessionPreference` / `sessionHint`，system prompt 是 body 部分。

**集成点注意**：plan-mode 现在是扩展自己调 `complete()`，不是调主模型的 `subagent` 工具。要让 plan-mode 用 subagent review，需要改 `runAutomaticReview`：从直接 `complete()` 改成通过某种方式触发 subagent。这里有个架构选择：
- **方案 A**：plan-mode 扩展直接 spawn subagent 进程（用 `pi-subagent/runner-cli.js` 那套）。改动大但可控。
- **方案 B**：让主模型在 turn 里调 `subagent` 工具。更轻但 review 时机不好控制。

---

## 问题 3：plan 触发后的 UI 三个子问题

### 3.1 plan ID 是人无法理解的数字代码 — 属实

`createPlanId`（**index.ts:1561**）：

```ts
function createPlanId(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const random = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `${stamp}-${random}`;
}
// 例如: 20260622-135701-a3f2b1c8
```

这个 ID 在多处使用：
- widget 显示（index.ts:1146）
- notify（index.ts:1354）
- `/plan-debug`
- draft 文件名 `.pi/plan-draft-${planId}.md`（index.ts:1346）
- final 文件名 `docs/plan-${slug}-${planId}.md`（index.ts:1045）

对人类不友好，尤其是 `20260622-135701-a3f2b1c8` 这种串。

**改进方向**：用 `title` slug 做人类可读 ID。仓库已有 `slugify`（`extensions/shared/plan-helpers.ts:9`），比如 `refactor-auth-flow`，时间戳降级为内部字段或文件名后缀。

### 3.2 执行时为什么还要看 plan 执行情况，有 todo list 不够吗 — 部分属实

`updatePlanUi`（**index.ts:1164-1170**）执行阶段：

```ts
if (state.phase === "executing" || state.phase === "completed") {
  ctx.ui.setStatus("yuki-plan", state.phase === "executing" ? `plan executing · ${state.todoListId ?? ""}` : undefined);
  if (state.phase === "completed") {
    ctx.ui.setWidget("yuki-plan", undefined);
  } else {
    // Show a minimal executing widget; the turn_end handler enriches it with
    // the in_progress todo via updateExecutingWidget once todo state is read.
    ctx.ui.setWidget("yuki-plan", [`Plan executing · list ${state.todoListId ?? "?"}`, "Use /plan-debug for details."]);
  }
  return;
}
```

**执行期 widget 已压到 2 行**（"Plan executing · list xxx" + "Use /plan-debug"），不是完整 plan 执行情况。完整 plan 内容这时候确实不该再显示 —— 这一点代码已经做对了。

但问题在于：**status bar 仍然显示 `plan executing · <todoListId>`**，而 `todoListId` 又是另一个 ID（和 planId 一样可能不友好），和 todo list 的进度信息重复。执行期真正有价值的信息是 todo 进度，plan widget 这时候基本是冗余的。

**改进方向**：执行期直接 `setWidget(undefined)`，只留 status bar 一行，或者完全交给 todo list。

### 3.3 plan 文案一多撑得很长，可视窗变小 — 属实

**compact widget 不会撑长**。`buildCompactPlanWidget`（**index.ts:1145**）是固定 3 行：

```ts
function buildCompactPlanWidget(state: PlanFlowState): string[] {
  return [
    `Plan ${state.planId} · ${state.phase}`,
    state.title ? `Title: ${state.title}` : `Request: ${state.request}`,
    `${state.steps.length} step(s)${state.phase === "awaiting_approval" ? " · awaiting approval" : ""} · /plan-debug for details`,
  ];
}
```

**真正撑长的是 approval preview**。`publishApprovalPreview`（在 `runApprovalDialog` 里调，index.ts:949）用 `PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE`（index.ts:21）发一条 markdown 消息，渲染器是（index.ts:153）：

```ts
pi.registerMessageRenderer(PLAN_APPROVAL_PREVIEW_CUSTOM_TYPE, (message) =>
  new Markdown(String(message.content ?? ""), 0, 0, getMarkdownTheme()));
```

这条消息把**整个 plan markdown**（`renderPlanMarkdown` 输出，含 background/decisions/assumptions/steps/risks 全部）作为普通历史消息塞进消息流。plan 越长，这条消息越高，可视窗越小。

**根因**：完整 plan 内容没有折叠 / 分页 / 弹窗机制，直接走 `Markdown` 组件铺在消息流里。

**改进方向**：
- 改成可折叠（如果 `@earendil-works/pi-tui` 的 Markdown 支持折叠 / 限制高度）
- 或改成弹窗 / editor 形式（`ctx.ui.editor` 已用于 revision reason，index.ts:954）
- 或只显示摘要 + "按 /plan-debug 看全文"

---

## 社区 review subagent prompt 模板调研

### pi 社区

- **`@howaboua/pi-subagent-review`**（npm）：专门做 review 的 pi subagent 扩展，加 `/review` 和 `/review loop` 命令，跑隔离的 review subagent，产出 compact summary 喂回主 session。这是 pi 生态里最接近用户需求的现成方案。
  - 来源：https://www.npmjs.com/package/@howaboua/pi-subagent-review

- **`pi-subagents` / `pi-sub-agent`**（GitHub: nicobailon/pi-subagents，pi.dev/packages/pi-sub-agent）：通用 subagent 框架，文档提到 review / scout / planner / security-auditor 等角色，但没有开箱即用的 review prompt 模板，需要自己写。
  - 来源：https://github.com/nicobailon/pi-subagents , https://pi.dev/packages/pi-sub-agent , https://registry.npmjs.org/pi-subagents

- **本仓库的 `@mjakl/pi-subagent`**：当前用的就是这个，自带 `explore` 和 `oracle`，没有 review agent。
  - 来源：https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent

### Claude Code 社区

Claude Code 的 subagent 定义格式（`.claude/agents/*.md`，YAML frontmatter）和 pi 的几乎一样（pi 的格式很可能借鉴了它）。文档明确推荐 review 类 subagent，但没有官方 review prompt 模板，社区实践是手写。

常见的 review subagent prompt 结构（综合多个来源）：
- 限定工具（read/grep，不带 write）
- 要求结构化输出（findings 分 critical / major / minor / nit）
- 要求引用文件:行号作为证据
- 明确"只 review 不改写"

来源：
- https://code.claude.com/docs/en/sub-agents
- https://claude-code-guide.org/sub-agents/
- https://claudelab.net/en/articles/claude-code/claude-code-custom-subagents-at-mention-guide
- https://github.com/ChuksForge/code-review-agent-public
- https://www.augmentcode.com/blog/how-we-built-high-quality-ai-code-review-agent

### 结论

**没有找到"开箱即用、可直接复制"的 review prompt 模板**。所有来源都是描述结构而非给全文。pi 生态里最值得参考的是 `@howaboua/pi-subagent-review` 的实现。如果要做，建议参考它的 prompt 设计 + Claude Code 的结构化输出约定，为本仓库写一个 `plan-reviewer.md`。

---

## 证据索引（关键代码位置）

| 主题 | 文件 | 行号 |
|------|------|------|
| `MAX_REVIEW_REVISION_ATTEMPTS = 3` | extensions/plan-mode/index.ts | 13 |
| `ReviewFeedback` 结构定义 | extensions/plan-mode/index.ts | 93-99 |
| review 消息渲染器注册（Markdown） | extensions/plan-mode/index.ts | 153 |
| review 触发（turn_end） | extensions/plan-mode/index.ts | 417-434 |
| `runAutomaticReview`（complete 直连） | extensions/plan-mode/index.ts | 572-616 |
| `buildReviewPrompt` | extensions/plan-mode/index.ts | 637 |
| `parseReviewFeedback`（含非 JSON 兜底） | extensions/plan-mode/index.ts | 651-657 |
| `formatReviewIssues`（喂回模型，不展示用户） | extensions/plan-mode/index.ts | 665 |
| approval preview publish | extensions/plan-mode/index.ts | 949 |
| `drivePostReview`（warning 通知来源） | extensions/plan-mode/index.ts | 990-1004 |
| `runApprovalDialog` | extensions/plan-mode/index.ts | 940-967 |
| `renderPlanMarkdown`（review 一笔带过） | extensions/plan-mode/index.ts | 1126 |
| `buildCompactPlanWidget`（固定 3 行） | extensions/plan-mode/index.ts | 1145-1150 |
| `updatePlanUi`（执行期 widget） | extensions/plan-mode/index.ts | 1164-1170 |
| plan 启动 notify | extensions/plan-mode/index.ts | 1354 |
| draft 文件名 | extensions/plan-mode/index.ts | 1346 |
| final 文件名 | extensions/plan-mode/index.ts | 1045 |
| `createPlanId`（不可读 ID） | extensions/plan-mode/index.ts | 1561-1567 |
| `slugify`（可复用做人类可读 ID） | extensions/shared/plan-helpers.ts | 9 |
| subagent frontmatter 解析 | pi-subagent/agents.ts | 157-191 |
| 现有 explore subagent | ~/.pi/agent/agents/explore.md | - |
| 现有 oracle subagent | pi-subagent/agents/oracle.md | - |
