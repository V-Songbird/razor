<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="razor" width="240" />
  </picture>
  <h1>razor</h1>
  <p><strong>Gives Claude a checklist to run before it writes anything — and actually makes it stick to it.</strong></p>
</div>

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](./LICENSE) [![Claude Code](https://img.shields.io/badge/Claude_Code-E5582B)](https://docs.anthropic.com/en/docs/claude-code)

---

## What is this?

AI assistants love to add things. Ask for one small feature and you might get a new library installed, five helper files, and an abstraction layer for a future that never comes — all of it stuff you now have to understand, maintain, and eventually delete.

razor teaches Claude to run down a short list before writing anything: needed at all? already in the codebase? does the platform already do it? Most of the time the answer to something on that list is yes — which means most of the time, nothing new gets written.

It's built for real engineering sessions — the long kind, where one casual "just add a library" quietly becomes a stack you maintain forever.

## Why you'd want it

- **Leaner projects.** Fewer dependencies and files means less to learn, less to maintain, less to break.
- **It acts, not just advises.** "Reuse first" is enforced in the tool layer, not just suggested in a prompt Claude can forget.
- **Never blocks you.** Every nudge fires once and the retry always goes through. You stay in control.
- **One switch.** `/razor off` turns it off for the session, `/razor on` back on. No dials to fiddle with.

## How it works

Here's the actual list, in order — Claude stops at the first line that fits:

| Ask | Then |
| --- | --- |
| Does this need to exist at all? | Skip it |
| Already in this codebase? | Reuse it |
| Does the standard library do it? | Use it |
| Does the platform do it? | Use it |
| Already installed? | Use it |
| Fits in one line? | Write one line |
| None of the above | Write the smallest version that works |

That's the list. Four checks make sure it isn't just a suggestion Claude quietly drops later:

| Moment | What happens |
| --- | --- |
| Reaching for a new dependency (an install command, an `import` line, a hand-edit to the manifest) | Challenged once, with your project's real installed-dependency list right in the message |
| Spawning a lot of new files in one turn | A "does this all need to exist?" nudge |
| Searching instead of shipping | A nudge to act on what it already has |
| Wrapping up a heavy session | A git-grounded check, once, on whether all the new code was actually needed |

If Claude still thinks it's right after the nudge, it goes ahead. razor asks the question once — it doesn't argue.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

It's active from your next session — nothing to configure.

## Benchmarks

We put that list up against plain Claude Code and a plugin that just tells the model to keep things lean, on real engineering work — full agent sessions that read, write, and run code, not a single generated reply. Same coding jobs, three setups; we measured the code and the bill.

<p align="center"><img src="assets/bench-hero.svg" alt="You said just use axios — did the needless dependency ship? With no plugin it shipped in every session; a keep-it-lean plugin let 92% through; razor 0%" width="700"></p>

**"Does the platform do it?" catches this one every time.** Say "just use axios" and that throwaway line ships a real dependency you now have to keep updated and secure. With no plugin it shipped every time; even a "keep it lean" plugin let almost all of them through. razor never did — on the small model and the big one alike.

<p align="center"><img src="assets/bench-supplychain.svg" alt="More than 1.2 million malicious open-source packages blocked to date, and climbing; 0% of razor's sessions added an unnecessary dependency" width="640"></p>

**That "never" matters more than it sounds.** Open-source registries have already blocked over 1.2 million malicious packages, and new ones arrive faster every year. Every dependency razor talks Claude out of is one fewer door into that pool.

<p align="center"><img src="assets/bench-lean.svg" alt="A parse-the-query-string task a built-in already covers: no plugin wrote 19 lines, a keep-it-lean plugin 4, razor 3 — 84% leaner" width="700"></p>

**Same question, different job.** Hand it a job a built-in already covers and no plugin will hand-roll a 19-line parser; razor stops at "does the platform do it?" and writes three. It writes less than doing nothing — and never more.

### The full picture

Every job, every setup — the big wins, the ties, and the one row where doing nothing wins, because a scoreboard that only shows wins isn't worth much. Fewest lines per row in **bold**.

| Coding task | no plugin | "keep it lean" | razor |
| --- | --- | --- | --- |
| Parse a query string | 19 | 4 | **3** |
| Read a `.env` file | 24 | 22 | **18** |
| Add a command to a CLI | 16 | 14 | **11** |
| "Just use axios" and fetch | 4 | 4 | **2** |
| Reuse-or-write a helper | 52 | **46** | **46** |
| A one-line HTTP GET | **2** | **2** | **2** |
| Generate a unique id | **1** | 3 | 3 |
| **Average across the suite** | 15 | 13 | **12** |

**Leaner, and never careless.** razor wrote the fewest lines on average — and still passed the most jobs correctly of any setup, at about the same cost as running no plugin at all. Being lean is only worth something if the code still works, and razor's did.

> [!NOTE]
> You'll see lean-code tools headline much bigger cuts — 50%, even 90%. Those come from jobs with a lot to trim: a hand-built interface widget that one native element replaces. razor's benchmark measures already-tight backend code, where an honest cut is smaller — there's simply less bloat to remove. That's why a few rows above tie, or even match doing nothing: there was nothing to cut. The discipline is the same — point it at a real over-build and it saves a lot, point it at already-lean code and it just holds the line. It never pads, and it never ships the needless dependency.

*How we tested: the same coding jobs, three setups, several runs each in fresh throwaway workspaces — full agent sessions, never a single generated reply — with the real cost read straight from the API. Numbers move a few percent between runs, and hold on the bigger model too. Reproduce it yourself — see [benchmarks/](benchmarks/).*

## Under the hood

Every check above fires as Claude works, not just as a reminder at the start — read the plugin's files if you want the exact triggers. Pairs naturally with [hush](https://github.com/V-Songbird/hush): razor keeps the code lean, hush keeps the noise down. Run both and neither notices the other — measured together, they add no overhead of their own.

## Skills

`/razor:unused` audits the other direction — dependencies already declared in your manifest that nothing imports. It reports what it finds and never edits a manifest or runs an uninstall; anything it can't confirm from imports alone (a name that only shows up in a script or a config file) is flagged separately as needing a manual check, not reported as a clean finding.

## Settings

Most people never touch these. razor asks for them when you enable it (and they can be changed anytime in the plugin's configuration) — the environment variables below do the same thing and take precedence when set:

| Variable | What it does |
| --- | --- |
| `RAZOR_DISABLE=1` | Turns everything off |
| `RAZOR_DEP_GUARD=off` | Stops the new-dependency nudge for install commands |
| `RAZOR_IMPORT_GUARD=off` | Stops the new-dependency nudge for `import`/`require` lines |
| `RAZOR_MANIFEST_GUARD=off` | Stops the new-dependency nudge for direct edits to `package.json`/`requirements.txt` |
| `RAZOR_FILE_BUDGET=4` | New files allowed in one turn before it speaks up |
| `RAZOR_SEARCH_BUDGET=1` | Extra searches allowed after the code is written before it speaks up |
| `RAZOR_LEDGER=off` | Turns off the end-of-session "is all this needed?" check |

## License

MIT — see [LICENSE](./LICENSE).
