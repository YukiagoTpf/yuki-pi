#!/usr/bin/env python3
"""
Re-apply the provider-tabs patch to pi's model-selector.js after a pi update.

What it does
------------
`/model` shows every model from every provider in one long flat list. This patch
adds provider left/right tabbing:

- A `Provider: < name >  (i/N)  shift+←/→ switch` header above the search box.
- `shift+left` / `shift+right` cycle the active provider (all scope only).
- The model list only shows the current provider's models; up/down stays within it.
- Switching provider clears the search box and re-centers on the current model.

It patches the compiled file in the global pi install, so it affects every pi
project on this machine. Re-run this script after `pi update` (or a reinstall).

Idempotent: if the file already contains the patch marker, it exits early.

Usage:
    python3 patches/patch-model-selector-provider-tabs.py            # apply
    python3 patches/patch-model-selector-provider-tabs.py --revert   # restore backup
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

MARKER = "rev.2026-06-19 provider-tabs patch"
REL_TARGET = Path("@earendil-works/pi-coding-agent/dist/modes/interactive/components/model-selector.js")
BACKUP = Path(__file__).parent / "originals" / "model-selector.js.bak"


def _candidate_roots() -> list[Path]:
    roots: list[Path] = []

    try:
        npm_root = subprocess.check_output(["npm", "root", "-g"], text=True, stderr=subprocess.DEVNULL).strip()
        if npm_root:
            roots.append(Path(npm_root))
    except (OSError, subprocess.CalledProcessError):
        pass

    for env_name in ("APPDATA",):
        env_value = os.environ.get(env_name)
        if env_value:
            roots.append(Path(env_value) / "npm" / "node_modules")

    roots.extend([
        Path.home() / "AppData/Roaming/npm/node_modules",
        Path.home() / ".nvm/versions/node/v24.16.0/lib/node_modules",
    ])

    seen: set[str] = set()
    unique_roots: list[Path] = []
    for root in roots:
        key = str(root)
        if key not in seen:
            seen.add(key)
            unique_roots.append(root)
    return unique_roots


def find_target() -> Path | None:
    for root in _candidate_roots():
        target = root / REL_TARGET
        if target.exists():
            return target
    return None

EDITS: list[tuple[str, str]] = [
    # 0. import matchesKey from pi-tui
    (
        'import { modelsAreEqual } from "@earendil-works/pi-ai";\n'
        'import { Container, fuzzyFilter, getKeybindings, Input, Spacer, Text, } from "@earendil-works/pi-tui";',
        'import { modelsAreEqual } from "@earendil-works/pi-ai";\n'
        'import { Container, fuzzyFilter, getKeybindings, Input, matchesKey, Spacer, Text, } from "@earendil-works/pi-tui";',
    ),
    # 1. field declarations
    (
        '    scope = "all";\n    scopeText;\n    scopeHintText;',
        '    scope = "all";\n    scopeText;\n    scopeHintText;\n'
        '    // rev.2026-06-19 provider-tabs patch: left/right switch provider, '
        "list shows only current provider\n"
        "    providers = [];\n    providerIndex = 0;\n    providerText;",
    ),
    # 2. constructor: add providerText header above search input
    (
        '        else {\n'
        '            const hintText = "Only showing models from configured providers. Use /login to add providers.";\n'
        '            this.addChild(new Text(theme.fg("warning", hintText), 0, 0));\n'
        "        }\n"
        "        this.addChild(new Spacer(1));\n"
        "        // Create search input\n"
        "        this.searchInput = new Input();",
        '        else {\n'
        '            const hintText = "Only showing models from configured providers. Use /login to add providers.";\n'
        '            this.addChild(new Text(theme.fg("warning", hintText), 0, 0));\n'
        "        }\n"
        "        this.addChild(new Spacer(1));\n"
        "        // rev.2026-06-19 provider-tabs patch: current provider indicator + switch hint\n"
        "        this.providerText = new Text(this.getProviderText(), 0, 0);\n"
        "        this.addChild(this.providerText);\n"
        "        this.addChild(new Spacer(1));\n"
        "        // Create search input\n"
        "        this.searchInput = new Input();",
    ),
    # 3. loadModels tail: derive providers, restrict activeModels, add helpers
    (
        '        this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;\n'
        "        this.filteredModels = this.activeModels;\n"
        "        const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));\n"
        "        this.selectedIndex =\n"
        "            currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));\n"
        "    }\n"
        "    sortModels(models) {",
        '        // rev.2026-06-19 provider-tabs patch: derive provider list and restrict activeModels to current provider\n'
        "        this.providers = [...new Set(this.allModels.map((m) => m.provider))];\n"
        "        const currentProvider = this.currentModel?.provider;\n"
        "        this.providerIndex = this.providers.length ? Math.max(0, this.providers.indexOf(currentProvider)) : 0;\n"
        "        this.activeModels = this.scope === \"scoped\" ? this.scopedModelItems : this.currentProviderModels();\n"
        "        this.filteredModels = this.activeModels;\n"
        "        const currentIndex = this.filteredModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));\n"
        "        this.selectedIndex =\n"
        "            currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));\n"
        "        if (this.providerText)\n"
        "            this.providerText.setText(this.getProviderText());\n"
        "    }\n"
        "    /** rev.2026-06-19 provider-tabs patch: models belonging to the currently selected provider (all scope only). */\n"
        "    currentProviderModels() {\n"
        "        const provider = this.providers[this.providerIndex];\n"
        "        if (!provider)\n"
        "            return this.allModels;\n"
        "        return this.allModels.filter((m) => m.provider === provider);\n"
        "    }\n"
        "    /** rev.2026-06-19 provider-tabs patch: header line showing current provider + switch hint. */\n"
        "    getProviderText() {\n"
        '        if (this.scope === "scoped")\n'
        '            return theme.fg("muted", "Provider: (scoped models)");\n'
        "        if (this.providers.length === 0)\n"
        '            return theme.fg("muted", "Provider: —");\n'
        "        const name = this.providers[this.providerIndex];\n"
        "        if (this.providers.length <= 1)\n"
        '            return `${theme.fg("muted", "Provider: ")}${theme.fg("accent", name)}`;\n'
        "        const pos = `${this.providerIndex + 1}/${this.providers.length}`;\n"
        '        return `${theme.fg("muted", "Provider: ")}${theme.fg("accent", `< ${name} >`)} '
        '${theme.fg("muted", `(${pos})`)} ${theme.fg("dim", "shift+←/→")} '
        '${theme.fg("muted", "switch")}`;\n'
        "    }\n"
        "    /** rev.2026-06-19 provider-tabs patch: switch to a provider by index (wraps). */\n"
        "    setProvider(index) {\n"
        '        if (this.scope !== "all" || this.providers.length <= 1)\n'
        "            return;\n"
        "        this.providerIndex = ((index % this.providers.length) + this.providers.length) % this.providers.length;\n"
        "        this.activeModels = this.currentProviderModels();\n"
        '        this.searchInput.setValue("");\n'
        '        this.filterModels("");\n'
        "        const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));\n"
        "        this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;\n"
        "        if (this.providerText)\n"
        "            this.providerText.setText(this.getProviderText());\n"
        "    }\n"
        "    sortModels(models) {",
    ),
    # 4. setScope: use currentProviderModels + refresh providerText
    (
        "    setScope(scope) {\n"
        "        if (this.scope === scope)\n"
        "            return;\n"
        "        this.scope = scope;\n"
        '        this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.allModels;\n'
        "        const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));\n"
        "        this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;\n"
        "        this.filterModels(this.searchInput.getValue());\n"
        "        if (this.scopeText) {\n"
        "            this.scopeText.setText(this.getScopeText());\n"
        "        }\n"
        "    }",
        "    setScope(scope) {\n"
        "        if (this.scope === scope)\n"
        "            return;\n"
        "        this.scope = scope;\n"
        '        this.activeModels = this.scope === "scoped" ? this.scopedModelItems : this.currentProviderModels();\n'
        "        const currentIndex = this.activeModels.findIndex((item) => modelsAreEqual(this.currentModel, item.model));\n"
        "        this.selectedIndex = currentIndex >= 0 ? currentIndex : 0;\n"
        "        this.filterModels(this.searchInput.getValue());\n"
        "        if (this.scopeText) {\n"
        "            this.scopeText.setText(this.getScopeText());\n"
        "        }\n"
        "        if (this.providerText) {\n"
        "            this.providerText.setText(this.getProviderText());\n"
        "        }\n"
        "    }",
    ),
    # 5. handleInput: shift+left / shift+right switch provider
    (
        "    handleInput(keyData) {\n"
        "        const kb = getKeybindings();\n"
        '        if (kb.matches(keyData, "tui.input.tab")) {',
        "    handleInput(keyData) {\n"
        "        const kb = getKeybindings();\n"
        "        // rev.2026-06-19 provider-tabs patch: shift+left / shift+right switch provider (all scope only)\n"
        '        if (matchesKey(keyData, "shift+left") || matchesKey(keyData, "shift+right")) {\n'
        '            if (this.scope === "all" && this.providers.length > 1) {\n'
        '                this.setProvider(this.providerIndex + (matchesKey(keyData, "shift+left") ? -1 : 1));\n'
        "            }\n"
        "            return;\n"
        "        }\n"
        '        if (kb.matches(keyData, "tui.input.tab")) {',
    ),
]


def main() -> int:
    target = find_target()
    if target is None:
        print("Target not found. Checked:", file=sys.stderr)
        for root in _candidate_roots():
            print(f"  {root / REL_TARGET}", file=sys.stderr)
        return 1

    if "--revert" in sys.argv:
        if not BACKUP.exists():
            print(f"No backup at {BACKUP}; cannot revert.", file=sys.stderr)
            return 1
        shutil.copyfile(BACKUP, target)
        print(f"Reverted {target} from {BACKUP}")
        return 0

    src = target.read_text(encoding="utf-8")
    if MARKER in src:
        print(f"Already patched ({MARKER} found in {target}). Use --revert to restore.")
        return 0

    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if not BACKUP.exists():
        shutil.copyfile(TARGET, BACKUP)
        print(f"Backed up original to {BACKUP}")

    for i, (old, new) in enumerate(EDITS, 1):
        count = src.count(old)
        if count != 1:
            print(f"Edit {i} failed: expected exactly 1 match, found {count}.\n"
                  "The pi file likely changed in a new version; inspect and update this script.",
                  file=sys.stderr)
            return 2
        src = src.replace(old, new, 1)

    target.write_text(src, encoding="utf-8")
    print(f"Patched {target} ({len(EDITS)} edits). Re-run after every pi update.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
