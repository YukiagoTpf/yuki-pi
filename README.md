# yuki-pi

Personal [Pi](https://pi.dev/) package for custom extensions and local tweaks.

## Install

```bash
pi install git:github.com/YukiagoTpf/yuki-pi
```

For one-off testing without installing:

```bash
pi -e git:github.com/YukiagoTpf/yuki-pi
```

## Contents

- `extensions/ask-user-question.ts` — `ask_user_question` tool for structured user Q&A.
- `extensions/btw.ts` — `/btw` one-shot side-question command.
- `extensions/recap.ts` — `/recap` one-sentence session progress recap.
- `extensions/yuki-compaction.ts` — structured long-session compaction with pruning, archives, pinned state, and proactive triggers.
- `extensions/codex-usage-status.ts` — footer status for Codex/Codex Spark usage windows, adapted from `@calesennett/pi-codex-usage`.
- `extensions/yuki-statusline.ts` — concise Claude Code-style footer: path, git branch, model, and context progress bar.
- `extensions/enable-grep.ts` — enables Pi's built-in `grep` tool.
- `extensions/todo/index.ts` — standalone branch-safe `todo_write` / `todo_clear` / `todo_read` tools and `/todos` command.
- `extensions/plan-flow/index.ts` — `/plan` / plan-mode workflow: read-only research, `plan_write` draft authoring (full/skeleton/patch), `get_plan_mode_status` self-check, automatic review, approval, final plan file, and plan-owned todo seeding.

## Ask User Question

The `ask_user_question` tool lets the model pause to ask one user-facing question, optionally with choices and an “Other” custom answer. When choices are shown, the custom answer is an inline input box (Claude Code-style), so typing a custom response no longer requires selecting “Other” first. Long question text is wrapped and capped, and only the selected option's description is shown to keep the dialog height stable during navigation. The selected answer is returned as the tool result so the model can continue with the user's decision in context.

## Plan Mode

The plan-mode module provides:

- `/plan [--context <token>] <request>` — enter read-only planning mode for a requested change. `--context <token>` loads structured planning constraints (profiles, mandatory validation, declared files) from a one-shot `.pi/plan-context/<token>.json` handoff file written by callers like `/ta-dev`, so constraints do not have to be serialized into the visible prompt.
- `get_plan_mode_status` — read-only self-check for the current plan mode and available plan tools.
- `plan_write` — write a structured plan draft and render `.pi/plan-draft-<planId>.md`. Use `mode:"skeleton"` for title+steps, `mode:"patch"` for incremental updates, and `mode:"full"` to submit the accumulated draft for review. When a planning context declares mandatory validation, full submission enforces that the union of all steps' `validation` covers every mandatory sensor.
- Automatic review — after full `plan_write`, the current model reviews the plan once; blocking issues return the flow to revision, otherwise an approval dialog opens automatically in UI mode.
- Approval promotes the plan to `docs/plan-<slug>-<planId>.md` and seeds a plan-owned todo list, then automatically starts the execution turn.
- A plan auto-closes once all its plan-owned todos are completed, freeing `/plan` for a new run.
- `/plan-status`, `/plan-debug` (phase / allowed tools / next action), and `/plan-abort`.

Phase transitions that need a clean, tool-narrowed turn fire a `display:false` kick from `turn_end` (A-class); transitions inside a tool `execute()` (B-class) cannot start a new turn mid-stream, so they rely on decisive tool-result text plus the `tool_call` block as the mid-turn defense. Phase prompts are positive-only (they say what to call, never naming disallowed tools).

## Todo

The standalone todo module provides:

- `todo_write` — create or update a branch-safe todo list without implicit deletion.
- `todo_clear` — explicitly clear completed or all todos from a standalone list.
- `todo_read` — inspect the current/default todo list.
- `/todos [listId]` — show todos on the current branch.
- `/todos clear [completed|all] [listId]` — clear standalone todos from the current/default or named list.

It works without `/plan`. Plan-flow seeds a plan-owned todo list via the exported todo state helpers; plan-owned lists apply stricter policy such as a single `in_progress` item and required evidence for completed items. Plan-owned and workflow todo lists cannot be cleared with `todo_clear` because they are execution records.

## Codex Usage Status

Adapted from [`@calesennett/pi-codex-usage`](https://github.com/calesennett/pi-codex-usage), this extension shows Codex usage in the footer when `openai-codex` OAuth credentials are present in Pi's `auth.json`.

Commands:

- `/codex-usage-mode` — toggle display mode between percent `left` and percent `used`.
- `/codex-usage-mode left|used` — set display mode explicitly.
- `/codex-usage-reset-window` — toggle reset countdown between `7d` and `5h`.
- `/codex-usage-reset-window 7d|5h` — set reset countdown window explicitly.

Preferences are stored in Pi's `settings.json` under `pi-codex-usage`.

## Yuki Compaction

The compaction extension customizes Pi's `session_before_compact` flow for long-running coding sessions:

- pre-store pruning for very large tool outputs, with full text archived under `.pi/yuki/tool-output/`;
- runtime tool-output pruning before LLM calls;
- structured compaction summaries with pinned goal, constraints, plan/todo progress, decisions, and working memory;
- branch-aware state snapshots in `CompactionResult.details` plus non-compaction delta entries;
- proactive `ctx.compact()` hysteresis on `turn_end` / `agent_end`.

Commands:

- `/yuki-compact` — open the interactive TUI settings menu.
- `/compact` — when Yuki is enabled, Pi's built-in compact command is intercepted and produces the Yuki structured compaction.
- `/yuki-compact status` — show current branch config and compaction state.
- `/yuki-compact now` — compatibility manual trigger; in normal TUI use `/compact` instead.
- `/yuki-compact on|off` — enable or disable the Yuki override for Pi's built-in `/compact` on the branch.
- `/yuki-compact proactive on|off` — enable or disable proactive `ctx.compact()` triggers.
- `/yuki-compact model auto|<provider/model>` — choose summarizer model preference, like `/model` but only for compaction.
- `/yuki-compact set trigger <ratio>` / `target-free <ratio>` / `archive-chars <n>` / `runtime-chars <n>` / `min-interval-ms <n>` — tune thresholds without opening the menu.
- `/yuki-compact reset` — restore defaults.
- `/yuki-compact-now` and `/yuki-compact-status` remain as compatibility aliases.

## Recap

Use `/recap` to generate a one-sentence summary of what the current coding session is working on and where it stands.
It uses the currently selected Pi model with low reasoning and shows the result in a widget above the editor.
Manual `/recap` widgets can be dismissed with Space, Enter, or Esc.
After 10 minutes without a new completed turn, it also generates the same one-sentence recap automatically; that automatic widget clears when the next prompt starts.

## Development

Pure, dependency-free helpers live in `extensions/shared/` so they can be unit tested without loading the Pi runtime. Tests use Node's built-in runner and need no install:

```bash
npm test          # node --test over test/*.test.ts
npm run typecheck # tsc --noEmit (requires `npm install` first)
```
