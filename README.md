# razor

**Before adding code, ask whether the project already has what it needs.**

Available on [Claude Code](#claude-code), the primary host, and on the compatibility hosts [Codex](#codex) and [Antigravity](#antigravity).

[Get started](#install) · [What is this?](#what-is-this) · [How it works](#how-it-works) · [What you can do](#what-you-can-do) · [Evidence](#the-numbers)

## What is this?

You ask for a small query parser. The assistant reaches for a package, adds helper files, and leaves you more code to maintain. Razor asks whether the language or your project already has what the task needs.

It puts a short checklist before new code and uses targeted checks to prompt reconsideration of unnecessary additions. The aim is to finish the requested work with less to maintain. This example illustrates the workflow; the measurements below describe specific recorded runs.

## Why you'd want it

- Reuse what the project already has.
- Reconsider unnecessary dependencies before installing them.
- Notice file growth before a small task becomes a larger project.
- Find declared dependencies that no source file appears to use.

## How it works

At the start of every session razor hands the assistant a short checklist to run before it writes anything. The assistant stops at the first line that applies and acts on it:

1. Not genuinely needed? Skip it, say so in one line.
2. Already in this codebase? One search. Reuse a hit, or move on.
3. Does the language do it for free? Use the language.
4. Does the platform do it for free? Use the platform.
5. Is it in a package you already installed? Use that.
6. Fits in one line? One line.
7. Only then: the least code that works.

Most of the time one of the first five lines says yes, so nothing new gets written. In the recorded Claude Code runs, that is where nearly all of razor's measured effect came from. The checklist never cuts input validation at a trust boundary, error handling that would lose data, security or accessibility, and if you ask for the full version anyway, you get it without an argument. Its wording is fixed; it does not change per project or with your settings.

Behind the checklist sit five checks. Each speaks at most once, as a message to the assistant, and the retry always goes through, under the host's normal permissions and sandbox rules.

| Check | When it runs | What it looks at |
| --- | --- | --- |
| Install guard | before a shell command | a command that adds a named package with npm, pnpm, yarn, bun, pip (also `pip3`, `python -m pip` and `uv pip`), pipenv, poetry, uv, cargo, go, composer, gem or dotnet |
| Import guard | before a file change | an `import`/`require` of a package that is not in your manifest |
| Manifest guard | before a file change | a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| New-file check | before a new file | how many new production files this one turn has already created |
| Build check | at the end of a turn | whether the session grew a lot with almost no deletions |

The first three read your project's own manifests, `optionalDependencies` and `peerDependencies` and the Python equivalent included, so a package you already declared is never treated as new. Each new dependency gets its own reconsideration, so a command with several installs can get another nudge for a different package on a later retry.

The new-file check counts production files only: tests, fixtures, migrations, docs, config and generated output are never charged, so a feature that ships with its tests is not sprawl. A file Git reports as ignored is not counted; without Git, outside a repository, or when Git fails or times out, the file is counted. Anything under your system temp directory, or inside a folder named `scratchpad` in any letter case, is scratch and skipped, even a real project that sits in such a folder.

The build check needs a Git repository. At the end of a turn it compares the working tree with where the session started, leaving out Markdown, anything under a `docs/` folder and lockfiles, and if the session grew a lot with almost nothing deleted it asks once whether all of it is needed. The assistant answers in one short extra reply; nothing waits for you, and the check stays quiet for the rest of the session.

A scope-drift note adds one line, at most once a session, when a later request has clearly left the task the session started on, to say a fresh session would keep things focused. It never blocks or asks, stays quiet while you correct the original job, and can miss a drift.

Razor never edits your code, manifests or lockfiles, never asks you anything and makes no network calls. It runs a few read-only `git` commands in your working directory so the build check knows what the session added, and keeps a small state file in the plugin data directory the host provides, or in your system temp directory when there is none. Old files clean themselves up, and the plugin cache stays read-only.

**In Claude Code and Codex**, the checklist arrives when a session starts, resumes, is cleared or is compacted, or, in Claude Code, forked, and a compacted session keeps its original starting point for the build check. In Codex, the file checks preview local `apply_patch` changes without editing your files. Read-only exploration and planning agents skip the checklist; writing agents and unknown custom agent types receive it, each with its own new-file budget.

**In Antigravity**, which has no session, prompt or subagent event, the checklist and the drift note go with every model call, about 2,500 characters per call, and the build check's starting point is taken on the first call of a conversation. When the build check fires, the model answers within the same turn, without the drift note. Subagents there receive no checklist.

## What you can do

| You want to | Outcome |
| --- | --- |
| Keep a small task small | Check reuse, dependencies and file growth |
| Pause or resume the checks | Change the session toggle |
| Find unused dependencies | Receive a report with confirmed, likely and unknown findings |

### Pause or resume the checks

Send `razor off` or `razor on` to pause or resume the checks for the session; `/razor off` and `/razor on` also work in Claude Code. A Codex client may intercept slash commands before the hooks see them, so use the plain words there. Send the toggle as a message of its own, with nothing else and no formatting; a final period or exclamation mark is fine. The switch is on or off by design; there are no levels.

Antigravity has no prompt event, so the toggle does not exist there. To keep razor out of an Antigravity session, set `RAZOR_DISABLE` to `1` as [Settings](#settings) describes.

### Find unused dependencies

Use `/razor:unused` in Claude Code, `$razor:unused` in Codex, or `/unused` in Antigravity. In Codex, mention the skill with its plugin prefix: Codex attaches the skill's instructions for `$razor:unused`, but not for a bare `$unused`.

The audit sorts what it finds into three piles:

- **Confirmed unused**: it read your installed packages and proved nothing needs the package: no import, no quoted mention in your source, no shipped command, no other package requiring it as a peer.
- **Likely unused**: nothing referenced it, but no resolver was available to prove it. Treat these as leads.
- **Unknown**: something references it, or only a resolver can settle it. Type definitions, build tooling and packages whose name appears as a quoted string in your source usually land here.

It never edits your manifest and never uninstalls anything. Static scanning cannot follow `import(someVariable)` or a package loaded by a name built at runtime, so even *confirmed unused* is not a promise that nothing loads the package.

### Settings

Most people never touch these. In Claude Code, the plugin's settings panel asks about the per-check switches and the new-file budget when you enable razor; the environment variables do the same thing and win when both are set. Each host keeps its own settings and state; to bring Claude Code preferences to Codex, set the matching variables.

Codex has no settings panel: set the variables before starting the Codex host, whose hooks inherit its environment (`$env:RAZOR_FILE_BUDGET = '6'; codex` in PowerShell, `RAZOR_FILE_BUDGET=6 codex` in a POSIX shell). In Antigravity, set them in the shell that launches the CLI or the editor (`export RAZOR_DISABLE=1` in bash, `$env:RAZOR_DISABLE = '1'` in PowerShell). A host that is already running, a desktop app included, does not pick up changes made in a new shell; restart it.

| Setting | Values | Effect |
| --- | --- | --- |
| `RAZOR_DISABLE` | `1` | Turns everything off, on every host |
| `RAZOR_DEP_GUARD`, panel: Dependency guard (installs) | `off` / on (default) | The nudge before a command installs a package |
| `RAZOR_IMPORT_GUARD`, panel: Dependency guard (imports) | `off` / on (default) | The nudge before code imports a package that is not in your manifest |
| `RAZOR_MANIFEST_GUARD`, panel: Dependency guard (manifest edits) | `off` / on (default) | The nudge before a direct edit to `package.json`, `requirements.txt` or `pyproject.toml` |
| `RAZOR_LEDGER`, panel: Once-per-session build check | `off` / on (default) | The once-a-session "is all of this needed?" question |
| `RAZOR_DRIFT_NOTE`, panel: Scope-drift note | `off` / on (default) | The line that says the session has wandered off its original task |
| `RAZOR_FILE_BUDGET`, panel: New-file budget per turn | a number, default 4; `0` | New code files allowed in one turn before razor speaks up; `0` switches the new-file check off |
| `RAZOR_LEDGER_LOC` | a number, default 500 | Net lines a session can add before the build check asks |
| `RAZOR_LEDGER_FILES` | a number, default 8 | New files a session can add before the build check asks |
| `RAZOR_GIT_TIMEOUT_MS` | milliseconds, default 2000 | How long each read-only `git` call may take; a lower value is ignored |
| `RAZOR_AGENT_SKIP` | comma-separated agent types | Agent types that skip the checklist |
| `RAZOR_AGENT_INJECT` | comma-separated agent types | Agent types that receive it, overriding the skip list |

By default the new-file budget counts production files only. Once you choose a number, it becomes a plain ceiling on every new file. `RAZOR_FILE_BUDGET` always counts as a choice; in Claude Code the panel's value counts only when it differs from 4, because a stored 4 looks like the default, so for a plain ceiling of 4 set `RAZOR_FILE_BUDGET=4`. The scratch and Git-ignored skips still apply.

`RAZOR_GIT_TIMEOUT_MS` helps on a slow machine or a very large repository, where a `git` call that runs out of time at session start leaves the build check without its starting point. The whole hook must still finish inside its host's timeout of 5 to 10 seconds, so a much larger value does not help.

Agent names in the two agent lists match without regard to case, with or without a plugin namespace. In Codex, the skip list matches the role Codex reports: children reported as `default` receive the checklist even when their prompt only asks them to read, and named roles must exist in Codex's own agent configuration, which razor does not change. In Antigravity these two variables do nothing.

## Install

Razor is one package for Claude Code, Codex and Antigravity. Install it in the one you use.

### Claude Code

Requirements: Node.js 22 or later, Git and Claude Code 2.1.323 or later.

Inside Claude Code:

```text
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

Start a new session to load the plugin.

### Codex

Requirements: Node.js 22 or later, Git and a Codex host with plugin support.

```text
codex plugin marketplace add V-Songbird/foundry
codex plugin add razor@foundry
```

Review and trust the exact hooks through your client's review flow, then start a new Codex session. Installing or enabling the plugin alone does not mean its hooks run, and the CLI and the desktop app each need their own review if you use both. The Windows hook command runs the Node.js on `PATH` and, when Node.js is not there, loads fnm's default version first; on other platforms, initialize your version manager before launching Codex so Node is on its `PATH`.

To see that razor is active, use a disposable project: the checklist should appear at startup and after compaction, an unnecessary dependency should get one denial whose retry follows normal permissions, and `razor off` and `razor on` should change the session's behavior. Watch the hooks fire; a plugin listing does not prove that an installation is active. In the Codex desktop app, the model's edits and commands arrive as scripts in one `exec` tool, and razor still checks each `apply_patch` inside them; a build note appears as a **Hook feedback** message.

### Antigravity

Requirements: Node.js 22 or later, Git and the Antigravity CLI. Antigravity has no marketplace for third-party plugins, so install razor from a clone of Foundry, which checks razor out at the commit the Claude Code and Codex catalogs pin. Replace `<path-to-clone>` with the directory to clone into:

```shell
git clone --recurse-submodules https://github.com/V-Songbird/foundry.git <path-to-clone>
agy plugin install <path-to-clone>/razor
agy plugin list
```

The list should name `razor`. Start a new conversation to load it. Its hook commands run plain `node`, so Node must be on the `PATH` Antigravity starts with.

### Update

In Claude Code, refresh the marketplace, update the plugin and start a new session:

```text
/plugin marketplace update foundry
/plugin update razor@foundry
```

In Codex, refresh the marketplace, add the plugin again and start a new session:

```text
codex plugin marketplace upgrade
codex plugin add razor@foundry
```

An Antigravity install is a copy, so it stays at the commit it was installed from. Update the clone, install again and start a new conversation:

```shell
git -C <path-to-clone> pull
git -C <path-to-clone> submodule update --init
agy plugin install <path-to-clone>/razor
```

## Good to know

Input validation, security and error handling that protects your work remain necessary. Explicitly requested scope stays yours to choose. These checks are advisory, not a security boundary.

File checks see only the edits made through the assistant's own editing tool: `Write` and `Edit` in Claude Code, `apply_patch` in Codex, and `write_to_file` and `replace_file_content` in Antigravity. Files written by a shell command skip them on every host; shell commands are still checked for dependency installs, and the build check can still notice the growth. In Codex, razor stays silent on a patch that needs fuzzy matching, has ambiguous context or colliding paths, or targets remote, unreadable or binary content, and `write_stdin` gets no new check.

The build check and its two numbers measure the whole working tree, so another session or tool writing in the same checkout can make it fire, and edits inside parts of a file that were already changed at session start are only approximated.

## The numbers

Each result belongs to the named model and recorded run. Missing measurements remain marked as unmeasured. These are a few hundred sessions against a live model, not a powered experiment, and numbers move between runs: read the direction, not the decimals. The Codex run and the Claude Opus 5.5 runs below measured the checklist's current one-lookup-per-rung sentence; the Claude Opus 5 run and the earlier Claude Code runs used its earlier "One check is enough, anywhere in this task" wording. [Foundry](https://github.com/V-Songbird/foundry) lists this plugin; the benchmark harnesses live in Foundry's `benchmarks/` folder and are not distributed with the plugin.

### Claude Code results

<!-- foundry:evidence {"platform":"Claude","status":"measured","models":["Claude Opus 5.5"],"date":"2026-10-13","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Claude Opus 5.5 | No plugin | 24/26 | 16.2 |
| Claude Opus 5.5 | razor | 26/26 | 8.7 |

Claude Code 2.1.296 on Windows, `claude-opus-5-5` at the CLI's default effort, on 2026-10-13 against razor checked out at `a6ecf5f`, whose plugin code is identical to release 1.8.1 (`6174db6`): the 13 jobs of the full suite, twice each per setup, 26 sessions per setup, none failed to run. Both no-plugin failures were the same job: told to use axios, it imported axios into a project that does not have it. Lines are averaged over the eleven coding jobs, 22 sessions per setup; razor wrote fewer lines on ten of them and tied on the eleventh.

Mean session cost was $0.086 with razor and $0.100 without a plugin, a difference of $0.014 ± $0.013 per job. Razor cost more on four of the 13 jobs: the two with no code, by 17% on the question and 14% on the typo fix, and two coding jobs. Its time saving, 3.2 ± 5.9 seconds per job, is inside the noise. Two repetitions are exploratory, not a stable estimate. These workspaces sat outside the temp folder, so razor's new-file check was active; it did not speak.

The drift note was tested on the same host, model, effort, date and revision, in 6 two-request conversations per setup: razor noted unrelated second requests in 3 of 3 conversations, against 0 of 3 without a plugin, and stayed quiet on 3 of 3 same-job corrections. The suite scores the message, not the code the second request asked for. A razor conversation cost $0.197 against $0.169 without a plugin, 17% more.

A run on release 1.8.2 (`9eb5215`), same host, model, effort and date, 9 conversations per setup, added a third unrelated request: razor noted the first unrelated request in 3 of 3 conversations and did not repeat the note on the third request in any. A razor conversation with three requests cost $0.323 against $0.288 without a plugin, 12% more. Three conversations of each kind are exploratory, not a stable estimate.

A larger run on release 1.8.3 (`527e900`), same host, model, effort and date, compared razor with a copy that delivers the note once at session start, with no no-plugin setup: four kinds of conversation, ten of each, 40 conversations per setup. The note, delivered beside every request as razor ships it, followed unrelated work in 29 of 30 conversations on the three kinds that drift, against 24 of 30 for the copy delivered once at session start; in the three-request conversations it came after the second request in 9 of 10 and was repeated after the third in 0 of 9. It never fired on a correction. Ten conversations of each kind are also exploratory.

<!-- foundry:evidence {"platform":"Claude","status":"measured","models":["Claude Opus 5"],"date":"unknown","revision":"not recorded","revisionReason":"The run was published on 2026-09-01 in cbc92f3; the razor revision it measured is not recorded.","dateReason":"The retained source excerpt does not state a run date.","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Claude Opus 5 | No plugin | 35/39 | 18.3 |
| Claude Opus 5 | ponytail | 39/39 | 12.2 |
| Claude Opus 5 | razor | 39/39 | 9.6 |

Claude Code with its CLI version and effort not recorded, Claude Opus 5, 39 sessions per setup in one run; the run date and the razor revision are not recorded, and the result was published on 2026-09-01 in `cbc92f3`. A clean session completed the job without adding a package. Lines are averaged over the eleven coding jobs; razor wrote fewer lines than [ponytail](https://github.com/DietrichGebert/ponytail), another plugin that tells Claude to write less, on nine of them and tied on the other two, and ponytail also blocked every unnecessary package. Mean session cost was $0.121 with razor, $0.155 without a plugin and $0.151 with ponytail. The runner put this run in a temp folder by default, where razor's new-file check stays silent, so treat it as measuring razor's other checks only.

A recorded Claude Code demo on Claude Opus 5, published September 4, 2026 (run date not recorded), gave one session each the same ask, implement `parseQuery` in `query.js`: without razor, Claude wrote it in 18 lines; with razor, in 4 lines built on `Object.fromEntries` and `URLSearchParams`. The averages over 3 sessions each way were the same.

**Where razor does not win.** These results come from earlier Claude Code runs on Claude Sonnet and Claude Opus, with model versions, effort and razor revisions not recorded. In a batch on Claude Code 2.1.251 on 2026-08-29, a blind reviewer judged 66 pairs of answers to the same job in both orders, 132 judge calls; 27 pairs got the same verdict both ways, and razor's answer was preferred in 11 of those 27 (41%), against a 60% bar set beforehand. In the same batch, 24 sessions where Claude split the work across five helper agents, each of which receives the checklist, razor cost about 2% more: $0.221 against $0.216 on Sonnet and $0.474 against $0.464 on Opus, for 13–31% less code. Its code is not measurably flatter or less branchy per line either.

The cost saving on Sonnet is not settled: two runs of the same jobs, on Claude Code 2.1.235 and 2.1.238 on 2026-08-19 and 2026-08-20, 78 sessions per setup per model when pooled, disagree, one finding razor 9% cheaper and the other level. Only the Opus saving reproduced. Across the earlier Claude Code runs, the gains were smaller on Sonnet across the board: the same direction, less far and less reliably. The Claude tables above are Opus results only. These earlier runs are read as having put their workspaces in the temp folder, where razor's new-file check stays silent, so they measure its other checks only.

### Codex results

<!-- foundry:evidence {"platform":"Codex","status":"measured","models":["GPT-5.6 Sol"],"date":"2026-10-09","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| GPT-5.6 Sol | No plugin | 19/26 | 18.7 |
| GPT-5.6 Sol | razor | 26/26 | 10.4 |

Controlled run on Codex CLI 0.161.0 at high reasoning on Windows, on 2026-10-09 against razor `18d1d0a`: 19 tasks, twice each per setup, 38 cases, of which the table covers the 26 in the full task group. Across all groups, razor passed 38/38 cases versus 29/38 without it. On the pairs both setups passed, razor's median ratio to no plugin was 0.500 for coding lines (23 pairs). Over 29 pairs, elapsed time was 15.1% higher, input tokens 5.1% higher and output tokens 6.2% lower; timings include the overhead of observing razor's hooks. Two repetitions are exploratory, not a stable estimate. This result does not compare Sol against Claude.

### Antigravity results

<!-- foundry:evidence {"platform":"Antigravity","status":"pending","reason":"No Antigravity performance measurements are available."} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Not measured | Not measured | Not measured | Not measured |

No Antigravity session has been measured yet.

*Results can vary between runs.*

## What changed

Release notes for every version are on the [releases page](https://github.com/V-Songbird/razor/releases).

## License

MIT — see [LICENSE](LICENSE).
