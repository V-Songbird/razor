# Changelog

All notable changes to razor are documented here. Razor is a monorepo-folder
plugin — its version is owned by `.claude-plugin/marketplace.json` at the
repo root, not by `razor/.claude-plugin/plugin.json` (which carries no
version field by convention).

## 0.4.0-alpha — 2026-07-14

Added a new skill, `/razor:unused` — audits a project's manifest for dependencies nothing imports, so cleanup isn't limited to catching new ones at write time.

Fixed an issue where TypeScript toolchain packages (`typescript`, `@types/*`, and similar) were reported as unused by that audit.

[forge](../forge)'s read-only research agents (expert, critic) no longer receive the ladder injection.

## 0.3.13-alpha — 2026-07-14

Doc-only: noted why the dependency gate needs no special handling for commands another installed plugin rewrites before they run. No behavior change.

## 0.3.12-alpha — 2026-07-13

Doc-only: rewrote the README in a more direct voice, and led it with razor's actual decision order — the short list it runs down before writing anything — instead of burying it in prose. Benchmarks now tie each result back to a specific line on that list. No behavior change.

## 0.3.11-alpha — 2026-07-13

Doc-only: added a How it works section summarizing the dependency, file, search, and end-of-session checks; trimmed the now-redundant mechanism detail out of the opening section. No behavior change.

## 0.3.10-alpha — 2026-07-13

Doc-only: the README logo now adapts to dark mode (white silhouette instead of black). No behavior change.

## 0.3.9-alpha — 2026-07-12

Doc-only: rebuilt the Benchmarks section — a new headline chart, a full per-task table showing every job across all three setups (the wins and the ties), current numbers, and a note on how to read them against bigger claims elsewhere. No behavior change.

## 0.3.8-alpha — 2026-07-12

Removed a redundant line from razor's guidance ladder; no change to how razor behaves.

## 0.3.7-alpha — 2026-07-12

razor's guidance now also steers away from defensive error handling for cases that can't happen — one more form of over-engineering it trims, alongside needless files, abstractions, and dependencies. Genuine safeguards (data loss, trust boundaries, anything you asked for) are untouched.

## 0.3.6-alpha — 2026-07-12

razor's checkpoint messages now say plainly that they're an automated reconsideration — not a denial from you — and that re-running the exact same command, write, or search is what clears them.

## 0.3.5-alpha — 2026-07-12

razor now also catches a new dependency added by editing `package.json` or `requirements.txt` directly — not just installs and `import` lines. Whichever way a package first tries to enter, razor prompts one reconsideration; once you've confirmed it through any path, the others stay silent. New setting: `RAZOR_MANIFEST_GUARD=off`.

## 0.3.4-alpha — 2026-07-11

Fixed an issue in multi-turn sessions where the post-edit search check treated every turn after the session's first edit as "already implementing" — exploration at the start of a new request could be interrupted. The check now starts fresh each turn and only arms after that turn's first edit.

## 0.3.3-alpha — 2026-07-11

razor's settings (budgets, guard toggles, the end-of-session check) can now be set when enabling the plugin instead of through environment variables — the variables still work and take precedence. Session state moved to the plugin's persistent data directory and is cleaned up when the session ends; leftovers from crashed sessions are swept automatically after a week.

## 0.3.2-alpha — 2026-07-11

razor's checks now run as one process per tool call, so overlapping checks can no longer lose each other's bookkeeping. Subagents get their own budgets — an exploration agent's searches no longer count against the main session's allowance, and vice versa. Turn boundaries come from the harness when available instead of being derived from the transcript. Fixed an issue where shell redirects such as `2>&1` were treated as package names by the dependency guard.

## 0.3.1-alpha — 2026-07-09

Doc-only: the dependency chart now shows all three setups and notes the result holds on both models, and a new diagram shows razor's five checks and the moment each one fires. No behavior change.

## 0.3.0-alpha — 2026-07-09

razor now catches a needless dependency at the moment it's written as an `import`/`require` line — not just when it's installed — and ships the lean version in the same response instead of pausing to ask. It also stops sooner when a search has already answered the question. Two new settings: `RAZOR_IMPORT_GUARD=off` and `RAZOR_SEARCH_BUDGET`.

## 0.2.10-alpha — 2026-07-08

Doc-only: Benchmarks charts now display larger (640px instead of 540px). No behavior change.

## 0.2.9-alpha — 2026-07-08

Doc-only: the cost chart now carries a "+35%" badge (what skipping razor costs on top), and the supply-chain stat gets its own chart instead of sitting only in prose. No new numbers, no behavior change.

## 0.2.8-alpha — 2026-07-08

Doc-only: the supply-chain stakes line now leads with the bigger, still-accurate cumulative figure (1.2 million malicious packages blocked to date) instead of the smaller annual one. No behavior change.

## 0.2.7-alpha — 2026-07-08

Doc-only: the README now cites real supply-chain risk data next to the dependency-avoidance chart, states plainly that every benchmark number comes from a real multi-turn agent session, and adds an honest note for tasks where razor and no plugin land in the same place. No behavior change.

## 0.2.6-alpha — 2026-07-08

Fixed the benchmarks harness's report generator so a custom `--rival-dir`/`--rival-name` arm is shown in the report table and chart instead of being silently dropped.

## 0.2.5-alpha — 2026-07-08

Doc-only: plugin.json's description now matches the marketplace listing text. No behavior change.

## 0.2.4-alpha — 2026-07-07

Doc-only: the pairing limitation noted in 0.2.3 is resolved by [hush](../hush) 0.3.6. Razor's behavior is unchanged.

## 0.2.3-alpha — 2026-07-07

Documented a known limitation when pairing razor with [hush](../hush) on hard debugging tasks. No behavior change; resolved by hush 0.3.6.

## 0.2.2-alpha — 2026-07-07

Fixed a gap in the dependency guidance: naming a new library in a request ("let's just use axios
for it") could add it via an `import`/`require` statement without ever tripping the guard, which
only watches for install commands. The guidance now covers that case too, so introducing an
undeclared dependency is flagged no matter how it's added into the code.

## 0.2.1-alpha — 2026-07-06

- Fixed unnecessary file-reading being triggered on greenfield tasks (writing into an empty
  directory) even when there was nothing to read yet.
- Fixed the guidance continuing to double-check lower-priority rules after a higher-priority one
  already applied — for example, still walking through every dependency-manifest format before
  writing a plain, dependency-free implementation. It now acts on the first applicable rule
  without further checking.

## 0.2.0-alpha — 2026-07-05

Evidence-carrying gates: deny reasons now present repo facts instead of general guidance.

- The dependency guard's deny message now lists the project's actual installed dependencies, so
  you can see at a glance what's already available before adding something new.
- Added a build ledger: razor now asks once per session if the working tree has grown unusually
  large (a lot of new files, or a lot of added code with little removed), as a nudge to check for
  unnecessary sprawl. Insertion-heavy refactors that also remove code won't trigger it. Tune with
  `RAZOR_LEDGER_LOC` / `RAZOR_LEDGER_FILES`, or disable with `RAZOR_LEDGER=off`.

## 0.1.0-alpha — 2026-07-05

Initial release. YAGNI enforcement at the harness level.

- Injects a compact "use the simplest solution that already works" checklist at the start of each
  session, and again for subagents (read-only built-ins are skipped). Tune with
  `RAZOR_AGENT_SKIP` / `RAZOR_AGENT_INJECT`.
- Dependency guard: denies the first install of a new package with a reuse-first reason; retrying
  the same install goes through. Lockfile restores and system package managers are ignored.
  Disable with `RAZOR_DEP_GUARD=off`.
- New-file meter: denies once when a single turn writes more new files than the budget (default
  4), then clears. Existing files and temp/scratchpad paths are exempt. Tune with
  `RAZOR_FILE_BUDGET`, or set to `0` to disable.
- Toggle razor on or off for the session with `/razor on|off` or "stop razor".
