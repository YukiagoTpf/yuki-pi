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

## Ask User Question

The `ask_user_question` tool lets the model pause to ask one user-facing question, optionally with choices and an “Other” custom answer. When choices are shown, the custom answer is an inline input box (Claude Code-style), so typing a custom response no longer requires selecting “Other” first. Long question text is wrapped and capped, and only the selected option's description is shown to keep the dialog height stable during navigation. The selected answer is returned as the tool result so the model can continue with the user's decision in context.

## Recap

Use `/recap` to generate a one-sentence summary of what the current coding session is working on and where it stands.
It uses the currently selected Pi model with low reasoning and shows the result in a widget above the editor.
Manual `/recap` widgets can be dismissed with Space, Enter, or Esc.
After 10 minutes without a new completed turn, it also generates the same one-sentence recap automatically; that automatic widget clears when the next prompt starts.
