# Set up Razor in Codex

Install Razor from the Foundry marketplace, then review its hooks in the Codex
client you use. Check the CLI and desktop separately if you use both.

## Install

```text
codex plugin marketplace add V-Songbird/foundry
codex plugin add razor@foundry
```

Use the Codex package's `.codex-plugin/plugin.json`. Claude packages live on
the separate `Claude` branch.

Review and trust the exact hooks through your client's supported review flow.
Installing or enabling the plugin alone does not establish that its hooks run.

## Bring over your preferences

Transfer the desired `RAZOR_*` preferences using the [settings guide](SETTINGS.md).
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

## Coverage

Patch guards cover previewable local `apply_patch` changes. Ambiguous context,
colliding paths, unsupported remote formats and unreadable or binary input
abstain. Shell scripts and other editing tools bypass those patch guards;
`write_stdin` does not receive a new `PreToolUse` check. The Git build ledger
can still notice aggregate growth. Razor is advisory, not a security boundary.

For settings, see [Settings](SETTINGS.md). For reproducible source checks, see
[the Codex benchmark harness](https://github.com/V-Songbird/foundry/blob/main/benchmarks/razor/CODEX-HARNESS.md).
