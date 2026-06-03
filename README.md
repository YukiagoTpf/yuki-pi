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

- `extensions/btw.ts` — `/btw` one-shot side-question command.
- `extensions/recap.ts` — `/recap` one-sentence session progress recap.
- `extensions/enable-grep.ts` — enables Pi's built-in `grep` tool.

## Recap

Use `/recap` to generate a one-sentence summary of what the current coding session is working on and where it stands.
It uses the currently selected Pi model with low reasoning and shows the result in a widget above the editor.
Manual `/recap` widgets can be dismissed with Space, Enter, or Esc.
After 10 minutes without a new completed turn, it also generates the same one-sentence recap automatically; that automatic widget clears when the next prompt starts.
