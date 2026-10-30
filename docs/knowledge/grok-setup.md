---
type: knowledge
summary: "Installing razor for the Grok Build CLI, which hooks actually gate a tool call, and the context Grok does not deliver to the model; read before changing the Grok adapter."
related_files:
  - hooks/hooks.json
  - hooks/select-host.js
  - hooks/lib/grok-harness.js
  - hooks/razor-lib.js
---

# Set up Razor in Grok Build

Grok Build (`grok`) runs razor's guards. It does not show razor's checklist.
The checks are the floor; the checklist is the part Grok does not deliver.

## Install

Requirements: Node.js 22 or later, Git, and the `grok` CLI. Node has to be on
the `PATH` the hook process inherits.

Install from this repository and trust the plugin. Without `--trust`, Grok
prints the source, warns that install activates hooks, and stops:

```text
grok plugin install V-Songbird/razor --trust
```

Start a new session after installing. `grok plugin list` should name `razor`.

Grok also discovers plugins already installed for Claude Code, from
`~/.claude/plugins/` and `~/.claude/plugins/installed_plugins.json`. A Claude
Code install of razor is therefore loaded without a separate Grok install, and
its hooks stay inactive until that plugin is trusted. Trust is per plugin:
plugins under `~/.grok/plugins/` are trusted automatically, and a project copy
under `.grok/plugins/` is not until you trust the folder.

A marketplace add works when you want the Foundry catalog first:

```text
grok plugin marketplace add V-Songbird/foundry
grok plugin install razor --trust
```

Foundry's catalog is the Claude Code one. Grok reads `.claude-plugin/` as well
as `.grok-plugin/`. Installing `V-Songbird/razor` directly avoids depending on
that catalog checkout having its submodules.

## What runs

Grok reads `hooks/hooks.json`, the same file Claude Code reads. Each command
is one shell string. Grok's handler has `type`, `command`, `url`, `timeout`
and `env`, and no `args`, so a command of `node` plus a separate args array
never starts the script. A hook that does not start fails open: the tool call
proceeds.

The `PreToolUse` matcher stays `^(Bash|PowerShell|Edit|Write)$`. Grok tests
that expression against the real tool name and against the Claude name it
aliases, so `Bash` also selects `run_terminal_command`, and `Edit` or `Write`
also selects `search_replace`, `write` and `hashline_edit`. PowerShell has no
separate tool; a shell command is `run_terminal_command`.

| Grok tool | What razor treats it as |
| --- | --- |
| `run_terminal_command`, and the internal id `run_terminal_cmd` | a shell command, checked for a new install |
| `search_replace` and `edit` | an edit; an empty `old_string` is a whole-file write |
| `write` | a whole-file write (`file_path` and `content`) |
| `hashline_edit` | a whole-file write when the only op is `write`; otherwise the new text is checked for imports, and an anchored edit of a manifest is not previewed |

The retry still goes through, on Grok as on the other hosts. razor never
grants a permission.

Grok's default hook timeout is 5 seconds, and 600 for `Stop`. A timeout fails
open. razor sets its own: 10 seconds on `SessionStart`, `PreToolUse` and
`Stop`, and 5 on `SubagentStart` and `UserPromptSubmit`.

Settings are the `RAZOR_*` variables in [settings](settings.md). Grok does not
read `userConfig` from a manifest. The root `plugin.json` is the Antigravity
manifest; putting `userConfig` there would not create a Grok settings panel.
State goes in `GROK_PLUGIN_DATA` when the plugin hook sets it, otherwise in a
`razor-grok` folder under the system temp directory.

`razor off` and `razor on`, sent as a message of their own, still switch the
guards for the session. Grok discards the confirmation line.

## What does not reach the model

Grok ignores stdout from `SessionStart` and `SubagentStart`. On
`UserPromptSubmit` it can block a prompt, and it discards stdout when it
allows one. The checklist, the copy handed to a subagent, and the scope-drift
note are those outputs. They still run, and `SessionStart` still records the
build-check baseline, but the model does not see the text.

`Stop` does read the build check. A session that grew a lot with almost
nothing deleted still gets the one question, on a stop whose `reason` is
`end_turn`. A stop fired because the session is closing does not ask and does
not use up that question.

To put the checklist where Grok will read it, add it to the project's
`AGENTS.md`. razor does not write that file. A short form that matches the
ladder:

```markdown
Before adding code, stop at the first fit: skip it, reuse what is already
here, use the language or the platform, use a dependency this project already
installed, or write the smallest change. Do not add a package or a new file
when one of those covers the task.
```

That paragraph is not injected by a hook, and it is not a measurement of the
ladder the other hosts inject. It is there because Grok reads `AGENTS.md` and
does not read razor's session-start output.
