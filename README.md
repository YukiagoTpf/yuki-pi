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
- `extensions/enable-grep.ts` — enables Pi's built-in `grep` tool.
- `extensions/todo/index.ts` — standalone branch-safe `todo_write` / `todo_clear` / `todo_read` tools and `/todos` command.
- `extensions/plan-flow/index.ts` — `/plan` workflow: read-only research, grilling, automatic review, approval via `plan_exit`, final plan file, and plan-owned todo seeding.

## Ask User Question

The `ask_user_question` tool lets the model pause to ask one user-facing question, optionally with choices and an “Other” custom answer. When choices are shown, the custom answer is an inline input box (Claude Code-style), so typing a custom response no longer requires selecting “Other” first. Long question text is wrapped and capped, and only the selected option's description is shown to keep the dialog height stable during navigation. The selected answer is returned as the tool result so the model can continue with the user's decision in context.

## Plan Flow

The plan-flow module provides:

- `/plan <request>` — enter read-only planning mode for a requested change.
- `grill_plan`, `plan_ask`, `grill_done` — record and resolve at most five critical planning questions before drafting.
- `plan_write` — write a structured plan draft and render `.pi/plan-draft-<planId>.md`.
- Automatic review — after draft `plan_write`, the current model reviews the plan once; blocking issues return the flow to revision, otherwise it proceeds to approval.
- `plan_exit` — request user approval; approval promotes the plan to `docs/plan-<slug>-<planId>.md` and seeds a plan-owned todo list.
- `/plan-status` and `/plan-abort`.

## Todo

The standalone todo module provides:

- `todo_write` — create or update a branch-safe todo list without implicit deletion.
- `todo_clear` — explicitly clear completed or all todos from a standalone list.
- `todo_read` — inspect the current/default todo list.
- `/todos [listId]` — show todos on the current branch.
- `/todos clear [completed|all] [listId]` — clear standalone todos from the current/default or named list.

It works without `/plan`. Plan-flow seeds a plan-owned todo list via the exported todo state helpers; plan-owned lists apply stricter policy such as a single `in_progress` item and required evidence for completed items. Plan-owned and workflow todo lists cannot be cleared with `todo_clear` because they are execution records.

## Recap

Use `/recap` to generate a one-sentence summary of what the current coding session is working on and where it stands.
It uses the currently selected Pi model with low reasoning and shows the result in a widget above the editor.
Manual `/recap` widgets can be dismissed with Space, Enter, or Esc.
After 10 minutes without a new completed turn, it also generates the same one-sentence recap automatically; that automatic widget clears when the next prompt starts.
