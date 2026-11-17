---
type: knowledge
summary: "Every razor setting: the environment variables, their Claude Code settings-panel names, values and effects, how each host reads them, the new-file budget rule, the Git timeout and the agent lists; read before changing a setting."
related_files:
  - README.md
  - .claude-plugin/plugin.json
  - hooks/hooks.json
---

# Razor settings

This page lists every setting a user can change in razor. The three that most people reach for are in the README, under [Settings](../../README.md#settings).

Most people never touch these.

## Contents

- [How each host reads settings](#how-each-host-reads-settings)
- [The settings](#the-settings)
- [The new-file budget](#the-new-file-budget)
- [The Git timeout](#the-git-timeout)
- [Agent lists](#agent-lists)

## How each host reads settings

In Claude Code, the plugin's settings panel asks about the per-check switches and the new-file budget when you enable razor. The environment variables do the same thing and win when both are set. Each host keeps its own settings and state. To bring Claude Code preferences to Codex, set the matching variables.

Codex has no settings panel. Set the variables before starting the Codex host, whose hooks inherit its environment:

```powershell
$env:RAZOR_FILE_BUDGET = '6'; codex
```

```shell
RAZOR_FILE_BUDGET=6 codex
```

In Antigravity, set the variables in the shell that launches the CLI or the editor:

```shell
export RAZOR_DISABLE=1
```

```powershell
$env:RAZOR_DISABLE = '1'
```

A host that is already running, a desktop app included, does not pick up changes made in a new shell. Restart it.

## The settings

| Setting | Values | Effect |
| --- | --- | --- |
| `RAZOR_DISABLE` | `1` | Turns everything off, on every host |
| `RAZOR_DEP_GUARD`, panel: Dependency guard (installs) | `off` / on (default) | The nudge before a command installs a package |
| `RAZOR_IMPORT_GUARD`, panel: Dependency guard (imports) | `off` / on (default) | The nudge before code imports a package that is not in your manifest |
| `RAZOR_MANIFEST_GUARD`, panel: Dependency guard (manifest edits) | `off` / on (default) | The nudge before a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| `RAZOR_LEDGER`, panel: Once-per-session build check | `off` / on (default) | The once-a-session "is all of this needed?" question |
| `RAZOR_DRIFT_NOTE`, panel: Scope-drift note | `off` / on (default) | The line that says the session has wandered off its original task |
| `RAZOR_FILE_BUDGET`, panel: New-file budget per turn | a number, default 4; `0` | New code files allowed in one turn before Razor speaks up; `0` switches the new-file check off |
| `RAZOR_LEDGER_LOC` | a number, default 500 | Net lines a session can add, with almost no deletions, before the build check asks; zero or less keeps 500 |
| `RAZOR_LEDGER_FILES` | a number, default 8 | New files a session can add before the build check asks; zero or less keeps 8 |
| `RAZOR_GIT_TIMEOUT_MS` | milliseconds, default 2000 | How long each read-only `git` call may take; a lower value is ignored |
| `RAZOR_AGENT_SKIP` | comma-separated agent types | Agent types that skip the checklist |
| `RAZOR_AGENT_INJECT` | comma-separated agent types | Agent types that receive it, overriding the skip list |

## The new-file budget

By default the new-file budget counts production files only. Once you choose a number, it becomes a plain ceiling on every new file. The scratch and Git-ignored skips still apply.

`RAZOR_FILE_BUDGET` always counts as a choice. In Claude Code, the panel's value counts only when it differs from 4, because a stored 4 looks like the default. For a plain ceiling of 4, set `RAZOR_FILE_BUDGET=4`.

## The Git timeout

`RAZOR_GIT_TIMEOUT_MS` helps on a slow machine or a very large repository. There, a `git` call that runs out of time at session start leaves the build check without its starting point. The default is 2000, which is also the lowest value Razor uses.

The whole hook must still finish inside its host's timeout of 5 to 10 seconds. So a much larger value does not help.

## Agent lists

Agent names in the two agent lists match without regard to case, with or without a plugin namespace.

In Codex, the skip list matches the role Codex reports. Children reported as `default` receive the checklist even when their prompt only asks them to read. Named roles must exist in Codex's own agent configuration, which Razor does not change.

In Antigravity these two variables do nothing.
