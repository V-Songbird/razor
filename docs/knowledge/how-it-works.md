---
type: knowledge
summary: "What razor does in a session: the checklist, the five checks, the scope-drift note, what razor touches, how Claude Code, Codex and Antigravity differ, the unused-dependency audit and how to check a Codex install; read before changing a hook or to predict what razor will do."
related_files:
  - README.md
  - hooks/hooks.json
  - hooks.json
  - skills/unused/SKILL.md
---

# How Razor works

This page says what Razor does to a session, part by part. It is for a user who wants to predict what Razor will do. The short form is in the README, under [What does it do?](../../README.md#what-does-it-do).

## Contents

- [What you can do](#what-you-can-do)
- [The checklist](#the-checklist)
- [The five checks](#the-five-checks)
- [The new-file check](#the-new-file-check)
- [The build check](#the-build-check)
- [The scope-drift note](#the-scope-drift-note)
- [What Razor touches](#what-razor-touches)
- [Claude Code and Codex](#claude-code-and-codex)
- [Antigravity](#antigravity)
- [Checking a Codex install](#checking-a-codex-install)
- [Pausing the checks](#pausing-the-checks)
- [The unused-dependency audit](#the-unused-dependency-audit)

## What you can do

Razor does its work on its own. The pause and audit commands are the only things you type.

| You want to | What you get |
| --- | --- |
| Keep a small task small | The checklist and checks run on their own |
| Pause or resume the checks | Send `razor off` or `razor on` |
| Find unused dependencies | A report from the audit command below |
| Turn Razor off | Set `RAZOR_DISABLE=1` |

| Claude Code | Codex | Antigravity |
| --- | --- | --- |
| `/razor:unused` | `$razor:unused` | `/unused` |

Send the toggle as a message of its own. Antigravity has no toggle.

The audit never edits anything. Codex attaches instructions for `$razor:unused`, but not for a bare `$unused`.

What you get from Razor:

- **Less new code.** The assistant reuses what the project already has.
- **Fewer packages.** It reconsiders a dependency before installing it.
- **Growth noticed early.** It speaks up when one turn creates many files.
- **Dead packages found.** An audit lists dependencies no source file uses.

In one recorded Claude Code session on Claude Opus 5, run date not recorded, the ask "implement `parseQuery` in `query.js`" gave 4 lines built on `Object.fromEntries` and `URLSearchParams`, against 18 without Razor.

## The checklist

At the start of every session Razor hands the assistant a short checklist to run before it writes anything. The assistant stops at the first line that applies and acts on it:

1. Not genuinely needed? Skip it, say so in one line.
2. Already in this codebase? One search. Reuse a hit, or move on.
3. Does the language do it for free? Use the language.
4. Does the platform do it for free? Use the platform.
5. Is it in a package you already installed? Use that.
6. Fits in one line? One line.
7. Only then: the least code that works.

Most of the time one of the first five lines says yes, so nothing new gets written.

The checklist never cuts input validation at a trust boundary, error handling that would lose data, security or accessibility. If you ask for the full version anyway, you get it without an argument.

Its wording is fixed. It does not change per project or with your settings.

## The five checks

Behind the checklist sit five checks. Each speaks at most once, as a message to the assistant. The retry always goes through, under the host's normal permissions and sandbox rules.

| Check | When it runs | What it looks at |
| --- | --- | --- |
| Install guard | before a shell command | a command that adds a named package with npm, pnpm, yarn, bun, pip (also `pip3`, `python -m pip` and `uv pip`), pipenv, poetry, uv, cargo, go, composer, gem or dotnet |
| Import guard | before a file change | an `import`/`require` of a package that is not in your manifest |
| Manifest guard | before a file change | a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| New-file check | before a new file | how many new production files this one turn has already created |
| Build check | at the end of a turn | whether the session grew a lot with almost no deletions, or added many new files |

The first three read your project's own manifests. `optionalDependencies` and `peerDependencies` count, and so do the Python equivalents. A package you already declared is never treated as new.

The install guard also sees installs inside `bash -c`, `sh -c`, `zsh -c`, `pwsh -Command` or `cmd /c`, on later lines of a multi-line command, and behind PowerShell's `&`.

The import guard and the manifest guard never nudge an edit the host itself would refuse, because its target is missing or repeated without replace-all.

Each new dependency gets its own reconsideration. A command with several installs can get another nudge for a different package on a later retry.

## The new-file check

The new-file check counts production files only. Tests, fixtures, migrations, docs, config, generated output and images, fonts or media are never charged, so a feature that ships with its tests is not sprawl. The default budget is 4 files per turn, and the check speaks once per turn.

Some files are never counted:

- A file that already exists. Edits and overwrites are not new files.
- A file that Git reports as ignored.
- Anything under your system temp directory.
- Anything inside a folder named `scratchpad`, in any letter case, even a real project that sits in such a folder.

Without Git, outside a repository, or when Git fails or times out, the file is counted.

## The build check

The build check needs a Git repository. At the end of a turn it compares the working tree with where the session started. It leaves out docs files (Markdown, `.txt`, `.rst` and similar, and anything under a `docs/` folder) and lockfiles.

It fires when the session added more than 500 net lines while deleting less than a tenth of what it inserted, or when it added more than 8 new files. Then Razor asks once whether all of it is needed. The assistant answers in one short extra reply. Nothing waits for you, and the check stays quiet for the rest of the session.

The check and its two numbers measure the whole working tree. Another session or tool writing in the same checkout can make it fire. Edits inside parts of a file that were already changed at session start are only approximated. The two numbers are set by `RAZOR_LEDGER_LOC` and `RAZOR_LEDGER_FILES`, in [Razor settings](settings.md).

## The scope-drift note

The scope-drift note adds one line, at most once a session. Razor sends the assistant an instruction with every prompt. When a later request has clearly left the task the session started on, the assistant does the work and adds a line saying a fresh session would keep things focused.

It never blocks or asks. It stays quiet while you correct the original job. It can miss a drift.

## What Razor touches

Razor never edits your code, manifests or lockfiles. It never asks you anything and makes no network calls.

It runs a few read-only `git` commands in your working directory, so the build check knows what the session added. It keeps a small state file in the plugin data directory the host provides, or in your system temp directory when there is none. State files older than seven days are deleted, and the plugin cache stays read-only.

## Claude Code and Codex

In Claude Code and Codex, the checklist arrives when a session starts, resumes, is cleared or is compacted. In Claude Code it also arrives when a session is forked. A compacted session keeps its original starting point for the build check.

In Codex, the file checks preview local `apply_patch` changes without editing your files.

Read-only exploration and planning agents skip the checklist. Writing agents and unknown custom agent types receive a short form of it, each with its own new-file budget. The short form keeps the same seven lines and the never-cut list. `RAZOR_AGENT_SKIP` and `RAZOR_AGENT_INJECT` change that; see [Razor settings](settings.md#agent-lists).

## Antigravity

Antigravity has no session, prompt or subagent event. So the checklist and the drift note go with every model call, 2,336 characters per call.

An edit that changes several parts of a package manifest in one call is checked as one edit.

The build check's starting point is taken on the first call of a conversation. When the build check fires, the model answers within the same turn, without the drift note. Subagents there receive no checklist.

Its hook commands run plain `node`, so Node must be on the `PATH` that Antigravity starts with.

Antigravity has no toggle. To keep Razor out of an Antigravity session, set `RAZOR_DISABLE` to `1`. [Razor settings](settings.md#how-each-host-reads-settings) shows how.

## Checking a Codex install

Installing or enabling the plugin alone does not mean its hooks run. A plugin listing does not prove that an installation is active. Use a disposable project and watch the hooks fire:

1. The checklist appears at startup and after compaction.
2. An unnecessary dependency gets one denial, and the retry follows normal permissions.
3. `razor off` and `razor on` change the session's behavior.

Review and trust the exact hooks through your client's review flow, then start a new Codex session. The CLI and the desktop app each need their own review if you use both.

The Windows hook command runs the Node.js on `PATH`. When Node.js is not there, it loads fnm's default version first. On other platforms, initialize your version manager before launching Codex so Node is on its `PATH`.

In the Codex desktop app, the model's edits and commands arrive as scripts in one `exec` tool. Razor still checks each `apply_patch` inside them. A build note appears as a **Hook feedback** message.

Razor stays silent on a Codex patch that needs fuzzy matching, has ambiguous context or colliding paths, or targets remote, unreadable or binary content. `write_stdin` gets no new check.

## Pausing the checks

Send `razor off` or `razor on` to pause or resume the checks for the session. `stop razor` also pauses them. In Claude Code, `/razor off` and `/razor on` also work. A Codex client may intercept slash commands before the hooks see them, so use the plain words there.

Send the toggle as a message of its own, with nothing else and no formatting. A final period or exclamation mark is fine. The switch is on or off by design; there are no levels.

## The unused-dependency audit

Run `/razor:unused` in Claude Code, `$razor:unused` in Codex or `/unused` in Antigravity. In Codex, mention the skill with its plugin prefix. Codex attaches the skill's instructions for `$razor:unused`, but not for a bare `$unused`.

The audit sorts what it finds into three groups:

- **Confirmed unused:** it read your installed packages and proved nothing needs the package. There is no import, no quoted mention in your source, no shipped command and no other package requiring it as a peer.
- **Likely unused:** nothing referenced it, but no resolver was available to prove it. Treat these as leads.
- **Unknown:** something references it, or only a resolver can settle it. Type definitions, build tooling and packages whose name appears as a quoted string in your source usually land here.

It never edits your manifest and never uninstalls anything. Static scanning cannot follow `import(someVariable)` or a package loaded by a name built at runtime. So even "confirmed unused" is not a promise that nothing loads the package.
