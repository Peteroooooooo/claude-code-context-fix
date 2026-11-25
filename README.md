# Claude Code Context Window Fix

Fixes the context usage ring in the official **Claude Code** VS Code extension (`anthropic.claude-code`) so it matches your actual auto-compact threshold, optionally appears immediately on new empty sessions, and displays exact token counts on hover.

## What Determines the 100% Progress Limit?

Even if you set `CLAUDE_CODE_AUTO_COMPACT_WINDOW=350000` (or `/autocompact 350k`), the native VS Code webview ring divides by your model's full window (e.g. `1M - 33k = 967k`), so auto-compact fires when the ring is only ~33% full.

This extension aligns the ring's `100%` mark with Claude Code's real auto-compact threshold, resolved in the exact same priority order as the CLI:

1. **Manual override (`claudeCodeContextFix.overrideWindow`)**: if `> 0`, overrides the raw window before buffer deduction.
2. **Environment variable `CLAUDE_CODE_AUTO_COMPACT_WINDOW`** (from `~/.claude/settings.json` `env` or process environment).
3. **Per-model setting `modelSettings.<model>.autoCompactWindow`** in `~/.claude/settings.json`.
4. **Top-level `autoCompactWindow`** in `~/.claude/settings.json` (set by `/autocompact`). Values `< 100000` or `"auto"` are ignored.
5. **Model window cap**: the resolved window is always capped by the active model's own context window (`min(modelWindow, configuredWindow)`). For example, `350000` on a `200k` model stays `200000`.
6. **Reserved 33k buffer deduction**: Claude Code deducts `min(maxOutputTokens, 20000)` (up to `20,000` for output, e.g. `CLAUDE_CODE_MAX_OUTPUT_TOKENS=64000` deducts `20k`) plus `13,000` for the compaction summary — **`33,000` tokens total**. So `350,000` becomes **`317k`**, and `1,000,000` becomes **`967k`**.
7. **Percentage override (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)**: if set (`1`–`100`), lowers the threshold further to `min(floor((window - outputBuffer) * pct / 100), window - 33k)`.

### Why didn't the ring show up on a brand-new empty chat?

Official Claude Code hides the ring until the first reply completes (`contextWindow === 0` and `0% <= threshold`). With `claudeCode.contextUsageThreshold` set to `0` and `claudeCodeContextFix.showBeforeFirstReply` enabled (default `true`), this extension infers the initial model window so the ring appears right away at **`0 / 317k` (`100% remaining`)** and updates to actual API token counts after your first turn.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `claudeCodeContextFix.enabled` | `true` | Enable or disable patching `anthropic.claude-code`'s `webview/index.js`. |
| `claudeCodeContextFix.overrideWindow` | `0` | Raw context window cap in tokens **before** the 33k deduction (`0` = auto-read from Claude settings). |
| `claudeCodeContextFix.showTokenCounts` | `true` | Show `(used / limit)` and `Model max` in the hover tooltip. |
| `claudeCodeContextFix.showBeforeFirstReply` | `true` | Show the `0 / limit` ring immediately on a new empty session when `claudeCode.contextUsageThreshold` is `0`. |

## Safety & Coexistence

- Uses inline Base64-preserved snippet replacement rather than overwriting whole-file backups, so it coexists cleanly with other webview patches such as `nuriyev.claude-code-katex`.
- Validates the resulting bundle with `acorn` (ESM parser) and writes atomically.
- Automatically reapplies when `anthropic.claude-code` updates or `~/.claude/settings.json` changes, and cleanly restores the original snippets on disable or uninstall.

## Commands

- **Claude Code Context Fix: Enable**
- **Claude Code Context Fix: Disable**
- **Claude Code Context Fix: Reapply Patch**
- **Claude Code Context Fix: Status**
