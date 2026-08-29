# Settings

Most people never touch these. razor works out of the box.

When you enable the plugin, Claude Code asks you about most of these in its own
settings panel. The environment variables below do the same thing, and they win
when both are set.

## The switch

| Variable | What it does |
| --- | --- |
| `RAZOR_DISABLE=1` | Turns everything off |

In a session you can also type `/razor off` and `/razor on`. The switch is on or
off by design. There are no levels.

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

## Where razor keeps its state

A small file in the plugin data directory your host provides. If there isn't
one, it falls back to your system temp directory. Old files clean themselves
up. Nothing leaves your machine.

## More

- [How razor works](HOW-IT-WORKS.md) — what runs, and when
- [The numbers](BENCHMARKS.md) — what we measured, and where razor loses
