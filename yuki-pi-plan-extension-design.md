# yuki-pi · plan + todo 工作流扩展设计（v2，已合并 review 意见）

> 目标：在 Pi 上实现「调研 → 逼问澄清 → 产出 plan → 一轮 review → 改稿 → 用户审批 → 存储 plan + 注册 todo → 执行」的完整流水线。
> 底层取三家所长：Codex 极简字段、Claude Code 双形态与纪律、Pi 的 details/分支重建存储；review 用 Pi 原生 `complete()`，不引入 subagent，不写裸 HTTP。
> v2 变更：合并一轮架构 review 的 10 条意见（R1–R10），重点修复流程断点与真相源问题。

---

## 一、整体流程

```
/plan "需求描述"
  → ① research          只读调研代码库
  → ② grilling          决策树 + 最多 5 个关键问题逐层逼问（可打回 ①）
  → ③ drafting          plan_write 写结构化草稿（临时区，reviewed=false）
  → ④ review            plan_write 完成后自动触发；ctx.getModel()+complete() 一轮
  → ⑤ revising          按 review 意见改稿（reviewed=true）
  → ⑥ awaiting_approval  plan_exit 提交用户浏览
        ├ 驳回 → 回 ⑤
        └ 通过 → ⑦
  → ⑦ commit            promote 草稿到 docs/（带 id）+ 结构化注册 todo
  → ⑧ executing         解除只读门禁，按 todo 执行

  任意阶段：/plan-abort → 清状态、解门禁、回普通态（R10）
```

## 二、状态机（R1：补 revising 子态）

单一 `phase` 驱动，状态不存内存，靠 `reconstructState(ctx)` 扫 `ctx.sessionManager.getBranch()` 重建（Pi todo 例子做法，分支安全、可 resume）。

| phase | 含义 | 允许的工具 |
|-------|------|-----------|
| `research` | 只读调研 | read / grep / glob / list + askuserquestion |
| `grilling` | 逐层逼问（≤5 问） | askuserquestion、grill_plan、grill_done |
| `drafting` | 写初稿 | plan_write |
| `revising` | 按 review 意见改稿 | plan_write |
| `awaiting_approval` | 等用户拍板 | plan_exit、plan_write |
| `executing` | 执行 | 全部工具 + todo_write |

**state 结构（v2 增补字段）**：
```ts
interface PlanFlowState {
  phase: Phase;
  planId: string;          // R8：每次 /plan 生成，贯穿草稿/最终文件命名
  questions: OpenQuestion[];
  askCount: number;        // R4：累计 askuserquestion 次数，到 5 强制收尾
  steps: PlanStep[];       // R7：plan 唯一真相源（不是文件）
  reviewed: boolean;       // R1/R2：草稿是否已经过 review
  todos: TodoItem[];
}
```

门禁：监听 `tool_call`，按 phase 查白名单，非白名单直接 deny。**用白名单角色，不用正则黑名单**（Opencode 做法；Pi plan-mode 例子的 `isSafeCommand()` 正则可被 bash 套娃绕过）。

## 三、各阶段细节

### ① research（只读门禁）
- 进 `/plan` 即 phase=`research`，生成 `planId`（R8）。
- 只放行 read/grep/glob/list + askuserquestion，其余 deny。
- 注入引导："先调研清楚再进入澄清；此阶段不写任何文件。"

### ② grilling（关键 5 问 + 可打回，R4/R5/R6）
工具 `grill_plan`：
```ts
grill_plan({
  open_questions: [{ topic, why_matters, status, resolution? }],  // 当前未决/已决快照
  restart_research?: boolean,   // R5：推翻调研结论时打回
})
```
约束（解决 grill-me「太多太冗余」）：
- **硬上限 5 个**：`open_questions` 超 5 拒绝。
- **R4 名额用累计计数，不靠数组长度**：state 里 `askCount` 每调一次 askuserquestion +1，到 5 强制 `grill_done`。数组只反映当前未决项，名额统计独立。
- **只问决策级问题**：prompt 明确——只问「不定就没法动手、会导致推倒重来」的；禁问能自查的/无关细节/纯偏好。
- **R6 答案合格判定给硬反例**：prompt 列出不合格答案样本（"看情况""到时候再说""随便""都行"），要求 `resolution` 必须是可执行的具体决定，否则不准标 resolved，同 topic 继续追问。
- **可提前收尾**：调 `grill_done` 进 drafting。

**R5 打回 research 的语义（定死）**：`restart_research:true` → phase 回 research，**保留已 resolved 的 question**（只重做调研，不重问已澄清项）；`reconstructState` 对 question 做"按 topic 合并、保留 resolved" 而非整体覆盖。

所有 question resolved（或 grill_done / askCount≥5）→ 进 drafting。

### ③ drafting（写初稿，临时区）
工具 `plan_write`，**结构化参数**（不让 AI 吐自由文本再正则抠）：
```ts
plan_write({
  title, background,
  steps: [{ content /*祈使句*/, activeForm /*进行时*/, rationale? }],
  risks?: string[],
})
```
- **R7 真相源唯一**：steps 写进 state.details 作为唯一真相；`.pi/plan-draft-<planId>.md` 只是**渲染产物**。每次重建后由 steps 重新渲染文件，**绝不反向读文件改状态**。
- 初稿写完时 `reviewed=false`。

### ④ review（自动触发，一轮，R2/R3）
- **R2 触发点定死**：`plan_write` handler 返回后，若 `phase==drafting && reviewed==false`，扩展在 `turn_end` 事件里自动调 `reviewPlan(ctx, render(steps))`。不靠 AI 自觉。
- 调用：`ctx.getModel()` + `complete(model, reviewCtx)`，REVIEW_SYSTEM_PROMPT 让审查模型只输出"遗漏/风险/不可执行项"的结构化意见，不重写全文。
- **红线**：必须走 `complete()`，绝不自拼 HTTP 打 gateway。
- **R3 降级路径**：`getModel()` 返回空、complete 超时或报错 → **跳过 review**，phase 直接进 awaiting_approval，并在提交给用户时标注「本次未经自动审查」。绝不 throw 阻断主流程。
- 正常完成 → 意见投回主 agent，phase 进 revising。

### ⑤ revising（改稿，R1）
- review 意见用 `sendMessage`/`sendUserMessage` 投回，触发 AI 再调 `plan_write`。
- `plan_write` 在 revising 态执行后置 `reviewed=true`，避免再次触发 ④（防 review 死循环）。
- 改完进 awaiting_approval。

### ⑥ awaiting_approval（用户审批）
- `plan_exit` 从 state.steps 渲染 plan 展示（R7：读真相源不读文件），请求用户确认。
- 驳回 → 回 `revising`（带驳回理由）；通过 → ⑦。

### ⑦ commit（存储 + 注册 todo，R8/R9）
- **R8 命名带 id**：promote `.pi/plan-draft-<planId>.md` → `docs/plan-<slug>-<planId>.md`，不覆盖历史 plan，并发 plan 互不踩。
- steps 转 todo（content+activeForm 已齐），一次性结构化注册到 state.todos。
- **R9 真相源边界定死**：docs 里的 plan 是「批准时的快照」，**执行期不回写**；todo 是执行期唯一进度真相。文档里注明此约定，避免脱节误解。

### ⑧ executing（执行，纪律）
- phase=`executing`，解除只读门禁。
- todo 纪律：
  - **同时只 1 个 in_progress**（Codex 硬约束）；`todo_write` 校验，违反则拒绝。
  - **测试没过/有报错/只做一半，绝不标 completed**（CC 纪律），prompt + 工具双重约束。

### 退出路径（R10，新增）
- `/plan-abort` 命令：任意阶段可调，清空 plan 状态、解除门禁、回普通 executing 态，删除 `.pi/plan-draft-<planId>.md` 临时文件。
- `plan_exit` 增 cancel 分支，等价于在 awaiting_approval 触发 abort。

## 四、TODO 字段定型（三家融合）
```ts
{
  content: string,      // CC：祈使句
  activeForm: string,   // CC：进行时
  status: "pending" | "in_progress" | "completed",  // Codex 三态
}
```
字段取 Codex 极简（不要 priority）；双形态抄 CC；存储抄 Pi（details + 分支重建）。

## 五、已定决策点
1. grilling 上限：最多 5 个关键问题，**名额按 askCount 累计**（R4）。✓
2. 草稿存储：临时区 `.pi/plan-draft-<planId>.md`，批准后 promote 到 `docs/plan-<slug>-<planId>.md`（R8）。✓
3. grilling 可打回 research：允许，**保留已 resolved**（R5）。✓
4. `/todos` 冲突：本扩展统一接管 todo，不并行启用 Pi 自带例子。✓

## 六、review 意见落实清单（R1–R10）
| # | 意见 | 落实位置 | 优先级 |
|---|------|---------|--------|
| R1 | revise 无独立 phase | 加 `revising` 态 + `reviewed` 字段（§二、⑤） | 必修 |
| R2 | review 触发时机未定义 | `turn_end` 自动触发（④） | 必修 |
| R3 | review 失败无降级 | model 不可用即跳过、不 throw（④） | 必修 |
| R7 | 文件/details 双真相源 | steps 为唯一真相，文件仅渲染产物（③⑥） | 必修 |
| R4 | 5 问名额统计矛盾 | `askCount` 累计计数（②） | 应修 |
| R5 | 打回丢失已澄清成果 | 保留 resolved，仅重调研（②） | 应修 |
| R9 | todo/plan 同步未定义 | docs=批准快照不回写，todo=执行真相（⑦） | 应修 |
| R6 | 答案合格判定模糊 | prompt 给不合格反例 + resolution 必须可执行（②） | 选修 |
| R8 | promote 命名/覆盖缺失 | 文件名带 planId（③⑦） | 选修 |
| R10 | 无中途放弃路径 | `/plan-abort` + plan_exit cancel 分支（退出路径） | 选修 |

## 七、目录骨架
```
yuki-pi/extensions/plan-flow/
  index.ts            # 入口：注册命令(/plan、/plan-abort)、工具、生命周期(tool_call 门禁、turn_end 触发 review)
  state.ts            # Phase + PlanFlowState(含 planId/askCount/steps/reviewed) + reconstructState
  gate.ts             # tool_call 门禁：按 phase 查白名单
  tools/
    grill.ts          # grill_plan / grill_done（askCount、restart_research、合格判定）
    plan-write.ts     # plan_write（写 steps→渲染临时文件；按 phase 切 reviewed）
    plan-exit.ts      # plan_exit（渲染 steps 请求审批；cancel 分支）
    todo-write.ts     # todo_write（in_progress 唯一 + completed 纪律校验）
  review.ts           # turn_end 自动触发；getModel()+complete()；失败降级
  prompts.ts          # 各阶段注入 + REVIEW_SYSTEM_PROMPT + grilling 反例约束
  paths.ts            # planId 命名、.pi 临时区、docs/ promote
```
