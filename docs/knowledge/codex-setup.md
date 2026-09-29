---
type: knowledge
summary: "Installing razor in Codex, trusting its hooks, carrying settings over from Claude Code, checking that it is active and what the patch guards cover; read before touching Codex behavior."
related_files:
  - hooks/codex-hooks.json
  - hooks/codex-hook.js
  - hooks/lib/codex-tools.js
  - .codex-plugin/plugin.json
---

# Set up Razor in Codex

Install Razor from the Foundry marketplace, then review its hooks in the Codex
client you use. Check the CLI and desktop separately if you use both.

## Install

```text
codex plugin marketplace add V-Songbird/foundry
codex plugin add razor@foundry
```

The same package also works in Claude Code; the [README](../../README.md#claude-code)
has those steps.

Review and trust the exact hooks through your client's supported review flow.
Installing or enabling the plugin alone does not establish that its hooks run.

## Bring over your preferences

Transfer the desired `RAZOR_*` preferences using the [settings guide](settings.md).
Map Claude installation options to those environment controls. Keep toggles,
counters and ledgers local to each host; do not copy transient session state.

## Check that Razor is active

Use a disposable project to check the following behavior. A real package
installation is unnecessary when checking a hook decision.

- The checklist appears at startup and after compaction.
- A writing subagent receives the checklist.
- An unnecessary dependency receives one denial; its retry follows normal
  permissions. A declared dependency remains allowed.
- Import and manifest patches receive the applicable checks.
- Changes across multiple files receive the file-budget check.
- `razor off` and `razor on` change the session's behavior.
- With Git available, a build note can request one continuation.
- The `unused` skill reports findings without changing dependencies.

Observe actual hook delivery. Plugin listings and fixture tests do not establish
that a particular installation is active.

Last live check: Codex CLI 0.157.1 on Windows 11, `codex exec`, razor at
ec7e04e, with its five hooks trusted. The checklist appeared at startup, the
hooks for each prompt and for the end of a turn ran, and a patch that imported
an undeclared package was denied. That check did not cover the checklist after
compaction, the writing subagent, the retry after a denial, the
declared-dependency and manifest checks, the file budget, `razor off` and
`razor on`, or a build-note continuation. An earlier check at b4ca2db showed
`$unused` reporting without changing files.

Last desktop check: the Codex desktop app 26.924.51851 (package
26.924.6891.0, bundled CLI 0.158.0-alpha.2.1) on Windows 11, on 2026-09-29,
with razor 1.8.0 installed from the Foundry marketplace. The run used the
app's default permission mode. The app did not ask to trust the hooks. Trust
entries from an earlier install were already in `config.toml`. Every item in
the list above passed. The startup, prompt, tool and end-of-turn hooks were
seen firing. A subagent received the checklist, but the session record does
not name the event that delivered it. That check found no gap specific to the
desktop app. The CLI has not yet been checked for the items its last check did
not cover. Two things look different in the desktop app. The model's edits and
commands arrive as scripts in one `exec` tool, and razor still checks each
`apply_patch` inside them. A build note at the end of a turn appears as a
**Hook feedback** message. That check did not cover a first install from the
app's plugin list or a first hook review.

## Coverage

Patch guards cover previewable local `apply_patch` changes. Ambiguous context,
colliding paths, unsupported remote formats and unreadable or binary input
abstain. Shell scripts and other editing tools bypass those patch guards;
`write_stdin` does not receive a new `PreToolUse` check. The Git build ledger
can still notice aggregate growth. Razor is advisory, not a security boundary.

For settings, see [Settings](settings.md). The Codex benchmark harness is kept
outside this repository and is not distributed with the plugin.
