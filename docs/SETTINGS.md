# Settings

Most people never touch these. razor works out of the box.

## Where to set them

In **Claude Code**, the plugin's settings panel asks about the per-check
switches and the new-file budget when you enable razor. The environment
variables below do the same thing, and they win when both are set.

In **Codex**, there is no settings panel. Set the environment variables before
starting the Codex host that runs razor; its hooks inherit that host's
environment.

For example, in PowerShell:

```powershell
$env:RAZOR_FILE_BUDGET = '6'
codex
```

For Bash or another POSIX shell:

```sh
RAZOR_FILE_BUDGET=6 codex
```

A desktop app already running will not inherit changes made in a new shell.
Restart it with the intended environment. The Windows hook command initializes
fnm when it is available, then runs Node. On other platforms, initialize your
version manager before launching Codex so Node is available in its `PATH`.

## The switch

| Variable | What it does |
| --- | --- |
| `RAZOR_DISABLE=1` | Turns everything off |

In a session you can also send `razor off` and `razor on` as ordinary messages;
`/razor off` and `/razor on` also work in Claude Code. The switch is on or off
by design. There are no levels.

## Turning off one check

| Variable | What it stops |
| --- | --- |
| `RAZOR_DEP_GUARD=off` | the nudge before a command installs a package |
| `RAZOR_IMPORT_GUARD=off` | the nudge before code imports a package that is not in your manifest |
| `RAZOR_MANIFEST_GUARD=off` | the nudge before a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| `RAZOR_LEDGER=off` | the once-a-session "is all of this needed?" question |
| `RAZOR_DRIFT_NOTE=off` | the line that says the session has wandered off its original task |

## Tuning the numbers

| Variable | Default | What it means |
| --- | --- | --- |
| `RAZOR_FILE_BUDGET` | 4 | New code files allowed in one turn before razor speaks up |
| `RAZOR_LEDGER_LOC` | 500 | Net lines a session can add before the build check asks |
| `RAZOR_LEDGER_FILES` | 8 | New files a session can add before the build check asks |

> [!NOTE]
> By default the new-file budget counts **production files only**. Tests,
> fixtures, migrations, docs, config and generated output are recognised and
> never charged, so a feature that ships with its tests is not sprawl. The
> moment you set `RAZOR_FILE_BUDGET` yourself, it becomes a plain ceiling on
> every new file — you asked for a number, you get that number.

Set `RAZOR_FILE_BUDGET=0` to switch the new-file check off entirely.

## Subagents

| Variable | What it does |
| --- | --- |
| `RAZOR_AGENT_SKIP` | Comma-separated agent types that should skip the checklist |
| `RAZOR_AGENT_INJECT` | Comma-separated agent types that should receive it, overriding the skip list |

Read-only exploration and planning agents skip the checklist by default.
Writing agents and unknown custom types receive it. Names match without
regard to case, with or without a plugin namespace.

In Codex, the skip list matches the role Codex actually reports. Children
reported as `default` receive the checklist even when their prompt only asks
them to read. Named roles must be available in Codex's own agent configuration;
razor does not change that configuration.

## Where razor keeps its state

A small file in the plugin data directory the host provides:
`CLAUDE_PLUGIN_DATA` in Claude Code, `PLUGIN_DATA` in Codex. The host sets it;
you do not need to. Without one, razor uses your system temp directory, inside
a `razor-codex` folder in Codex. Old files clean themselves up. State stays
outside the plugin cache. Nothing leaves your machine.

Each host keeps its own settings and state. The [setup guide](SETUP.md) covers
bringing Claude Code preferences to Codex.

## More

- [How razor works](HOW-IT-WORKS.md) — what runs, and when
- [The numbers](BENCHMARKS.md) — what we measured in Claude Code, and where razor loses
