<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="razor" width="240" />
  </picture>
  <h1>razor</h1>
  <p><strong>Claude loves to add code. razor makes it stop and ask "do we even need this?" first — and actually makes the question stick.</strong></p>

  <img src="assets/hero.svg" alt="A poster of all 27 no-plugin sessions on the benchmark's nine dependency jobs, Claude Opus, as thin columns whose height is the lines of code each one added. A stepped green razor's edge runs across at the level the middle razor run lands on that same job, and the pale column tops above it are the offcut — 193 lines across 27 sessions. It reads: 193 lines never shipped." width="700" />

  <p><em>This is where the razor falls.</em></p>
</div>

<p align="center">
    <a href="https://github.com/V-Songbird/razor/stargazers"><img src="https://img.shields.io/github/stars/V-Songbird/razor?style=social" alt="GitHub stars"/></a>
    <a href="https://github.com/V-Songbird/razor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/V-Songbird/razor" alt="License"/></a>
    <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-E5582B" alt="Claude Code"/></a>
</p>

<p align="center">
    <a href="#install"><strong>Install</strong></a> &nbsp;·&nbsp;
    <a href="#what-is-this">What is this?</a> &nbsp;·&nbsp;
    <a href="#why-youd-want-it">Why you'd want it</a> &nbsp;·&nbsp;
    <a href="#the-numbers">The numbers</a> &nbsp;·&nbsp;
    <a href="#going-deeper">Going deeper</a>
</p>

> **TL;DR** — Ask for one small feature and Claude might install a library and five extra files to build it. razor makes it check "do we already have this?" before writing anything. Across 39 test sessions it never once added a package that wasn't needed, and it got every job right.

---

<p align="center"><img src="assets/demo.svg" alt="The same ask played twice, side by side. The prompt: In query.js, implement and export parseQuery(qs): parse a URL query string (like &#x27;host=localhost&amp;port=8080&#x27;) into a plain object of key -&gt; value. Handle a leading &#x27;?&#x27;, and percent-decode values. Keep the existing module.exports = { parseQuery } shape. Without razor, Claude wrote query.js in 18 lines. With razor, 4 lines, with what the platform already has. Across the run, 3 sessions each way: 18 lines on average without razor, 4 with it. One real session each on Claude Opus 5, replayed on the recorded wall clock." width="700"></p>

## What is this?

AI assistants love to add things.

You ask for one small feature. You get a new library, five helper files, and
some extra structure for a future that never arrives. It all works. It is also
now yours — yours to read, yours to keep running, yours to eventually delete.

Nobody decided that. It just accumulated, one reasonable-looking step at a time.

razor hands Claude a short checklist to run before it writes anything. Do we
need this at all? Is it already in the codebase? Does the language do it for
free? Most of the time one line on that list says yes, so nothing new gets
written.

That's it. That's the whole plugin.

## Why you'd want it

Here's a real one. The ask: write `parseQuery(qs)`, which turns a query string
like `host=localhost&port=8080` into a plain object. Handle a leading `?`,
decode the values. That's it.

**Without razor** — it built a parser by hand. Eighteen lines, all of them
now yours to maintain:

```diff
 function parseQuery(qs) {
   // Parse a URL query string into an object of key -> value.
-  throw new Error('not implemented');
+  const out = {};
+  if (typeof qs !== 'string' || qs === '') return out;
+
+  const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
+  for (const [key, value] of params) {
+    // defineProperty so keys like '__proto__' become own properties
+    // instead of mutating the prototype.
+    Object.defineProperty(out, key, {
+      value,
+      writable: true,
+      enumerable: true,
+      configurable: true,
+    });
+  }
+  return out;
 }
```

**With razor** — it asked what Node already has, and used it. Four lines:

```diff
 function parseQuery(qs) {
-  // Parse a URL query string into an object of key -> value.
-  throw new Error('not implemented');
+  return Object.fromEntries(new URLSearchParams(qs.replace(/^\?/, '')));
 }
```

Same ask, same tests, both green. Across that run, three sessions each way on
Claude Opus 5: 18 lines on average without razor, 4 with it.

**The reflex is to build. razor's first question is whether you have to.**
Here you didn't, and the answer was already in the language.

<p align="center"><img src="assets/bench-supplychain.svg" alt="More than 1.2 million malicious open-source packages blocked to date, and climbing; across 258 sessions razor opened zero doors into that pool" width="700"></p>

Every package you add is a door you now maintain. Package registries have
already blocked over 1.2 million harmful ones. Across 258 test sessions, razor
opened that door exactly zero times.

## How it works

At the start of every session, Claude gets a short list to run before it writes
anything — need it at all, already have it, does the language cover it. It
stops at the first line that applies.

A few checks sit behind the list, in case Claude gets partway into adding
something anyway. Each one speaks **once**, and the retry always goes through.
razor asks; it doesn't argue.

Three things it never trims: input checks on untrusted data, error handling
that would lose your work, and security. Ask for the full version and you get
it, no debate.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

It kicks in at your next session — nothing to configure.

Running [hush](https://github.com/V-Songbird/hush) too? Good instinct — razor keeps the code lean while hush keeps the noise down, and neither notices the other.

## What you can do

razor runs itself. These are the only controls:

| You want to… | Command |
| --- | --- |
| Turn razor off or back on for the session | `/razor off` · `/razor on` |
| Find packages in your project that no file uses | `/razor:unused` |

Everything else has a sensible default. If you want to change one, see
[Settings](docs/SETTINGS.md).

## Finding packages nobody uses

`/razor:unused` is the other half of the job. The checks above stop **new**
packages getting in; this one finds the ones already sitting in your project
that no file actually imports.

It sorts what it finds into three piles, and it is careful about the
difference:

- **confirmed unused** — it checked properly and found nothing needs this.
- **likely unused** — nothing mentions it, but nothing could prove it either.
  A lead, not a verdict.
- **unknown** — something still points at it. Usually build tooling.

It only tells you. It never edits your package list and never uninstalls
anything. What to remove stays your call.

## The numbers

Real Claude Code sessions, start to finish, on Claude Opus 5. Same job, same starter files, same
test at the end. The code gets **run** — a short answer that breaks the task counts as a failure,
not a win. 39 sessions per setup, in one run.

Beside razor: [ponytail](https://github.com/DietrichGebert/ponytail), a plugin that also tells
Claude to write less and say less.

**Does it still work?** A session counts as clean only if the code is correct *and* no package was
added.

| setup | clean sessions |
| --- | --- |
| no plugin | 35 / 39 |
| ponytail | 39 / 39 |
| **razor** | **39 / 39** |

**How much code?** Lines written for the same job, averaged over the eleven coding jobs:

| setup | lines |
| --- | --- |
| no plugin | 18.3 |
| ponytail | 12.2 |
| **razor** | **9.6** |

razor wrote fewer lines than ponytail on nine of the eleven jobs and tied on the other two.

**And what does it cost?** Per session, same run:

| setup | cost |
| --- | --- |
| no plugin | $0.155 |
| ponytail | $0.151 |
| **razor** | **$0.121** |

**And over a whole session?** This is the one that surprised us. Five requests in a row on the same
project — build a feature, build another, fix a bug in the second one, build two more. Total lines
in the project after each turn, on Claude Opus. This is a separate multi-turn run, with no third
setup in it:

| after turn | no plugin | razor |
| --- | --- | --- |
| 1 | 57 | **29** |
| 3 | 100 | **43** |
| 5 | 136 | **58** |

The gap **grows** as the session goes on. And nothing broke: every feature passed in both setups,
every time.

> [!IMPORTANT]
> **Where razor doesn't win.** It does not make code easier to *read* — we tested that with blind
> side-by-side comparisons and razor lost. ponytail is genuine competition, not a straw man: it
> also blocked every unnecessary package, and it beat plain Claude on both size and cost. The
> savings are also clearly smaller on Sonnet than on Opus, and the cost saving on Sonnet doesn't
> reproduce reliably between runs. The full picture, wins and losses, is in
> [the numbers](docs/BENCHMARKS.md).

*Numbers move between runs, sometimes by a lot. Run it yourself — see [benchmarks/](benchmarks/).*

## Going deeper

Everything technical lives here, so this page can stay short:

| | |
| --- | --- |
| [How razor works](docs/HOW-IT-WORKS.md) | The checklist, the checks behind it, what runs and when |
| [Settings](docs/SETTINGS.md) | Every switch and number, and what each one does |
| [The numbers](docs/BENCHMARKS.md) | Full results, including where razor loses |
| [Run the benchmarks](benchmarks/) | The harness, so you can check any of it yourself |

## Good to know

> [!NOTE]
> **What razor will never do.** It never edits your code, your package list, or
> your lockfile — every check is a message to Claude, and the retry always goes
> through. It never asks *you* anything either; every question goes to Claude,
> and the one line it writes for you is a note, not a prompt. It never installs
> anything. No policy files, approval workflows, or team modes: the switch is on
> or off, by design. No linting, formatting, or code review — other tools do
> that better. And nothing leaves your machine: razor makes no network calls. It
> reads your git history a few times a session to notice when a session has
> grown a lot, and it never writes to it.

razor is built for Claude Code, and only Claude Code.

## License

MIT — see [LICENSE](./LICENSE).
