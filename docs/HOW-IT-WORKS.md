# How razor works

The short version lives in the [README](../README.md). This page is the long
one, for people who want to know exactly what runs and when. razor behaves the
same in Claude Code and Codex; where the two hosts differ, this page says so.

## The idea in one line

Coding assistants are good at writing code and bad at not writing code. razor
puts a checklist in front of them, and a few checks behind that, so "do we even
need this?" gets asked before the code exists rather than in review afterwards.

## The checklist

At the start of every session razor hands the assistant a short list to run
before it writes anything. The assistant stops at the first line that applies
and acts on it.

1. Not genuinely needed? Skip it, say so in one line.
2. Already in this codebase? One search. Reuse a hit, or move on.
3. Does the language do it for free? Use the language.
4. Does the platform do it for free? Use the platform.
5. Is it in a package you already installed? Use that.
6. Fits in one line? One line.
7. Only then: the least code that works.

Most of the time one of the first five lines says yes, so nothing new gets
written. That is the whole trick. In the recorded Claude Code runs, it is where
nearly all of razor's measured effect came from.

The list also carries rules that never bend. **razor never cuts input
validation at a trust boundary, error handling that would lose data, security,
or accessibility.** If you ask for the full version anyway, you get it without
an argument.

The exact wording is fixed. It is not tuned per project, and it does not change
with your settings.

## The checks behind it

The checklist is advice. These checks are the floor under it. Each one speaks at
most once, then gets out of the way — **the retry always goes through.**

| Check | When it runs | What it looks at |
| --- | --- | --- |
| Install guard | before a shell command | `npm install`, `pip install`, `cargo add` and 12 other package managers |
| Import guard | before a file change | an `import`/`require` of a package that is not in your manifest |
| Manifest guard | before a file change | a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| New-file check | before a new file | how many new production files this one turn has already created |
| Build check | at the end of a turn | whether the session grew a lot with almost no deletions |

A file change is a `Write` or `Edit` call in Claude Code and an `apply_patch`
change in Codex.

The first three read your project's own manifests, so a package you already
declared is never treated as new. That includes `optionalDependencies` and
`peerDependencies`, and the Python equivalent.

The new-file check counts **production files only**. Tests, fixtures,
migrations, docs, config and generated output are recognised and never charged
against the budget, so a feature that ships with its tests is not sprawl. Set a
number yourself and it becomes a plain ceiling on every new file instead.

Anything under your system temp directory is treated as scratch and skipped.

Files written inside a shell command do not pass through the file checks in
either host. Shell commands are checked for dependency installs, and the build
check can still notice the resulting growth. In Codex, the file checks preview
local `apply_patch` changes without editing your files. If a patch needs fuzzy
matching, has ambiguous context or colliding paths, or targets remote or
unreadable content, razor stays silent.

Each new dependency gets its own reconsideration. A shell command containing
several separate installs can therefore receive another nudge for a different
dependency on a later retry. razor never grants permissions: an allowed retry
still follows the host's normal approval and sandbox rules.

The build check is the only one that speaks after the work instead of before
it. At the end of a turn it compares the tree against where the session
started, and if the session grew a lot with almost nothing deleted it asks once
whether all of it is needed. Prose does not count towards that: Markdown and
anything under a `docs/` folder is left out of the comparison, along with
lockfiles, so a session that writes the design notes your project asks for is
not read as sprawl. When it fires, the assistant answers the question in one
short extra reply. It never stops to wait for you, and it then stays quiet for
the rest of the session. It needs a git repository to compare against, so in a
folder that is not one it never runs.

## Where it hooks in

razor uses the same five hook events in both hosts. Claude Code reads
`hooks/hooks.json`, which runs each check's Node script directly. Codex reads
`hooks/codex-hooks.json`, which starts `hooks/codex-hook.js` to translate
Codex's event format before the same checks run.

| Event | What razor does |
| --- | --- |
| `SessionStart` | writes the checklist, takes a snapshot of your working tree |
| `SubagentStart` | writes the checklist into agents that may write code |
| `PreToolUse` | runs the install check on shell commands, and the import, manifest and new-file checks on file changes |
| `Stop` | runs the build check, once per session |
| `UserPromptSubmit` | handles `razor on` and `razor off`, and the scope-drift note |

`SessionStart` runs on `startup`, `resume`, `clear` and `compact`, plus `fork`
in Claude Code, so a resumed session gets the checklist too. Compaction keeps
the original build baseline.

Read-only exploration and planning agents skip the checklist. Writing agents
and unknown custom agent types receive it. Each agent gets its own counters
under the parent session, so one agent's new-file budget is not another's.

## The scope-drift note

One line, at most once per session, when a later request has clearly left the
task the session started on. It tells you a fresh session would keep things
focused. It never blocks, never asks you anything, and it stays quiet when you
are simply correcting the original job.

Turn it off with `RAZOR_DRIFT_NOTE=off`.

## Finding dead packages

The `unused` skill is the reverse question: `/razor:unused` in Claude Code,
`$unused` in Codex. The checks above stop **new** dependencies; this finds ones
already in your manifest that no file imports.

It sorts what it finds into three piles:

- **confirmed unused** — it read your installed packages and proved nothing
  needs the package: no import, no shipped command, no other package requiring
  it as a peer.
- **likely unused** — nothing referenced it, but no resolver was available, so
  nothing proved it. Treat these as leads.
- **unknown** — something references it, or only a resolver can settle it.
  Type definitions and build tooling usually land here.

It never edits your manifest and never uninstalls anything. Static scanning
cannot see `import(someVariable)` or a package loaded by a runtime string, so a
package used only that way can show up as *likely unused*. That is why the
high-confidence pile is separate.

## What razor touches

- **It never edits your code, your package list, or your lockfile.** Every
  check is a message to the assistant, not a change to your files.
- **It never asks you anything.** Every question goes to the assistant. The one
  line it writes for you is a note, not a prompt, so nothing interrupts you.
- **It makes no network calls.** Nothing leaves your machine.
- **It runs `git` in your working directory**, read-only, a few times a
  session: `rev-parse`, `diff --numstat`, `diff --diff-filter=A` and
  `ls-files --others`. That is how the build check knows what the session
  added. It never writes to git.
- **It keeps a small state file** in the plugin data directory the host
  provides: `CLAUDE_PLUGIN_DATA` in Claude Code, `PLUGIN_DATA` in Codex.
  Without one it falls back to your system temp directory, inside a
  `razor-codex` folder in Codex. Old files are cleaned up on their own. The
  plugin cache stays read-only.

## Turning it off

Send `razor off` for the session and `razor on` to bring it back. `/razor off`
and `/razor on` also work in Claude Code; a Codex client may intercept slash
commands before hooks receive them, so use the plain words there. The switch is
on or off by design — there are no levels. `RAZOR_DISABLE=1` turns everything
off before the session starts.

Per-check switches are in [SETTINGS.md](SETTINGS.md).
