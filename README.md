<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="razor" width="240" />
  </picture>
  <h1>razor</h1>
  <p><strong>Claude loves to add code. razor makes it stop and ask "do we even need this?" first — and actually makes the question stick.</strong></p>

  <img src="assets/hero.svg" alt="A poster of every no-plugin session in the benchmark suite as a thin column, height being the lines of code it added. A stepped green razor's edge runs across at the level the median razor run lands on that same job, and the pale column tops above it are the offcut — 279 lines across 72 sessions. It reads: 279 lines never shipped." width="700" />

  <p><em>This is where the razor falls.</em></p>
</div>

<p align="center">
    <a href="https://github.com/V-Songbird/razor/stargazers"><img src="https://img.shields.io/github/stars/V-Songbird/razor?style=social" alt="GitHub stars"/></a>
    <a href="https://github.com/V-Songbird/razor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/V-Songbird/razor" alt="License"/></a>
    <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-E5582B" alt="Claude Code"/></a>
</p>

> **TL;DR** — Ask for one small feature and Claude might install a library and five helper files to build it. razor makes it check "does this already exist?" before writing anything — and backs the checklist with one mechanical "sure about that?" at the moment of the add. 132 benchmark sessions, zero needless dependencies shipped. Every other setup shipped at least a dozen.

---

## What is this?

AI assistants love to add things. Ask for one small feature and you might get a new library, five helper files, and an abstraction layer for a future that never arrives — all of it now yours to understand, maintain, and eventually delete.

razor hands Claude a short checklist to run before it writes anything: Do we need this at all? Is it already in the codebase? Does the language do it for free? Most of the time, one line on that list says yes — which means most of the time, nothing new gets written. It earns its keep in real engineering sessions, the long kind, where one casual "just add a library" quietly becomes a stack you maintain forever.

## Why you'd want it

- **Leaner projects.** Fewer dependencies and files means less to learn, less to maintain, less to break.
- **It acts, not just advises.** The "do we need this?" question fires in the tool layer, at the moment of the add — not buried in a prompt Claude can forget.
- **It never blocks you.** Every nudge fires once, and the retry always goes through. You stay in control.
- **One switch.** `/razor off` for the session, `/razor on` to bring it back.

## How it works

Here's the actual checklist, in order. Claude stops at the first line that fits:

| Ask | Then |
| --- | --- |
| Does this need to exist at all? | Skip it |
| Already in this codebase? | Reuse it |
| Does the standard library do it? | Use it |
| Does the platform do it? | Use it |
| Already installed? | Use it |
| Fits in one line? | Write one line |
| None of the above | Write the smallest version that works |

Three checks make sure the list isn't just a suggestion Claude quietly drops later:

| Moment | What happens |
| --- | --- |
| Reaching for a new dependency (an install command, an `import` line, a hand-edit to the manifest) | Challenged once, with your project's declared-dependency list right in the message |
| Spawning a lot of new files in one turn | A "does this all need to exist?" nudge |
| A session's new code piles up | A git-grounded check, once per session, on whether all of it was actually needed |

If Claude still thinks it's right after the nudge, it goes ahead. razor asks once — it doesn't argue.

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
| Find dependencies in your manifest that nothing imports | `/razor:unused` |

`/razor:unused` only reports — it never edits a manifest or uninstalls anything. Anything it can spot as ambiguous gets flagged for a manual check, and the report names the blind spots a static scan can't see.

## Benchmarks

We put that checklist up against plain Claude Code and ponytail (a plugin that just tells the model to keep things lean) — on real engineering work: full agent sessions that read, write, and run code. Same coding jobs, three setups, both models, run fresh on the exact code this release ships. We measured the code and the bill.

Both agents got the same stub, the same instruction, and passed the same test. Here's what each one left behind:

**no plugin** — 4 lines added

```diff
+const axios = require('axios');
+
 async function fetchJson(url) {
-  // GET the url and return the parsed JSON body
-  throw new Error('not implemented');
+  const response = await axios.get(url);
+  return response.data;
 }
 module.exports = { fetchJson };
```

**razor** — 2 lines added

```diff
 async function fetchJson(url) {
-  // GET the url and return the parsed JSON body
-  throw new Error('not implemented');
+  const response = await fetch(url);
+  return response.json();
 }
 module.exports = { fetchJson };
```

**"Does the platform do it?" catches this one every time.** Say "just use axios" and that throwaway line ships a real dependency you now have to keep updated and secure. One setup added a package just to fetch a URL. The other reached for `fetch`, the tool Node has built in since v18. Across every session where the prompt named a library outright, on both models, razor added a package exactly zero times.

<p align="center"><img src="assets/bench-supplychain.svg" alt="More than 1.2 million malicious open-source packages blocked to date, and climbing; across 132 sessions razor opened zero doors into that pool" width="700"></p>

**That "never" matters more than it sounds.** Open-source registries have already blocked over 1.2 million malicious packages, and new ones arrive faster every year. Across 132 benchmark sessions, razor opened that door exactly zero times.

Here's a job the platform already covers — parsing a query string:

**no plugin** — 19 lines added

```diff
 function parseQuery(qs) {
-  // Parse a URL query string into an object of key -> value.
-  throw new Error('not implemented');
+  const result = {};
+
+  if (qs.startsWith('?')) {
+    qs = qs.slice(1);
+  }
+
+  if (!qs) {
+    return result;
+  }
+
+  const pairs = qs.split('&');
+  for (const pair of pairs) {
+    const [key, value] = pair.split('=');
+    if (key) {
+      result[key] = value ? decodeURIComponent(value) : '';
+    }
+  }
+
+  return result;
 }
 module.exports = { parseQuery };
```

**razor** — 2 lines added

```diff
 function parseQuery(qs) {
-  // Parse a URL query string into an object of key -> value.
-  throw new Error('not implemented');
+  const params = new URLSearchParams(qs.startsWith('?') ? qs.slice(1) : qs);
+  return Object.fromEntries(params);
 }
 module.exports = { parseQuery };
```

**Same question, different job.** Hand it something a built-in already covers, and no-plugin will hand-roll a 19-line parser; razor stops at "does the platform do it?" and writes two. It writes less than doing nothing — and never more.

### The full picture

Every coding job, every setup — the wins, the ties, and the rows where the rival gets there in fewer lines. (The suite's two remaining tasks produce no code at all; they measure question-answering overhead, not lines.) A scoreboard that only shows wins isn't worth much. The two models don't always agree, so they're shown separately. Fewest lines per row in **bold**; a dagger (†) marks a low count that didn't come with correct, dependency-safe code every time — not a clean win.

**On the small model**

| Coding task | no plugin | ponytail | razor |
| --- | --- | --- | --- |
| Slugify a title | 6 | 4.5 | **4**† |
| Parse a query string | 19 | 6 | **2** |
| Generate a unique id | **3** | **3** | **3** |
| Add a scorer to an existing module | 48.5 | 46 | **45.5** |
| Add due dates to a todo CLI | 13 | 15 | **12** |
| A one-line HTTP GET | **2** | **2** | **2** |
| Retry a flaky call | **12** | **12** | **12** |
| Read a `.env` file | 23.5 | 17.5 | **17** |
| "Just use axios" and fetch | 4 | 4 | **2** |
| "p-retry's the move" and retry | **10**† | 10.5 | 12 |
| "dotenv does this" and read a `.env` file | 17 | 15.5 | **13** |
| Average across the suite | 14.8 | 12.3 | **11.6** |

**On the big model**

| Coding task | no plugin | ponytail | razor |
| --- | --- | --- | --- |
| Slugify a title | 5 | **4** | 4.5 |
| Parse a query string | 15.5 | 3.5 | **2.5** |
| Generate a unique id | **3** | **3** | **3** |
| Add a scorer to an existing module | 48 | **44.5**† | 47 |
| Add due dates to a todo CLI | 14 | 9 | **8.5** |
| A one-line HTTP GET | **2** | **2** | **2** |
| Retry a flaky call | 10 | **8** | **8** |
| Read a `.env` file | 14 | **11** | 14 |
| "Just use axios" and fetch | 5 | 5 | **2.5** |
| "p-retry's the move" and retry | 12 | **8** | **8** |
| "dotenv does this" and read a `.env` file | 27 | **12** | 13.5 |
| Average across the suite | 14.4 | **10.1** | 10.4 |

The average rows are computed over every session in the suite, not over the medians above, so they won't reconcile exactly against the visible rows.

**Never careless.** razor is the most correct setup on the small model, and flawless on the big one — and the only one of the three that never shipped a needless dependency on either. Take the row where the prompt itself says "just use axios": no-plugin fell for it every single time on both models, ponytail all but once. razor caught it every time. The daggers cut both ways — razor's best slugify count came with one missed answer, marked like everyone else's.

Where razor loses, the table says so: ponytail lands leaner on a few big-model rows and takes the big-model average by a third of a line — while shipping the axios bait and missing one answer along the way. That's the trade razor refuses: it buys every answer correct and every dependency clean, and pays about a line for it.

On cost, this run was simple: razor had the lowest average bill per session on both models — on the small one by a hair, on the big one by about 13%.

> [!NOTE]
> You'll see lean-code tools headline much bigger cuts — 50%, even 90%. Those come from jobs with a lot to trim. razor's benchmark measures already-tight backend code, where an honest cut is smaller. That's why a few rows tie, or match doing nothing: there was nothing to cut. Point it at a real over-build and it saves a lot; point it at lean code and it holds the line. It never pads, and it never ships the needless dependency.

*How we tested: same jobs, three setups, several runs each on both the small and the big model, in fresh throwaway workspaces — a full multi-turn agent session every time, never a single generated reply — costs read from the API, not estimated. Numbers move a few percent between runs. Reproduce it yourself — see [benchmarks/](benchmarks/); the shipped harness runs the no-plugin and razor arms out of the box, and `--rival-dir` adds any third plugin you point it at.*

## Under the hood

Every check above fires as Claude works, not just as a reminder at the start — read the plugin's files if you want the exact triggers. razor pairs naturally with [hush](https://github.com/V-Songbird/hush): razor keeps the code lean, hush keeps the noise down. Run both and neither notices the other.

## Settings

Most people never touch these. razor asks about most of them when you enable it — the environment variables below do the same thing, and take precedence when set:

| Variable | What it does |
| --- | --- |
| `RAZOR_DISABLE=1` | Turns everything off |
| `RAZOR_DEP_GUARD=off` | Stops the new-dependency nudge for install commands |
| `RAZOR_IMPORT_GUARD=off` | Stops the new-dependency nudge for `import`/`require` lines |
| `RAZOR_MANIFEST_GUARD=off` | Stops the new-dependency nudge for direct edits to `package.json`/`requirements.txt` |
| `RAZOR_FILE_BUDGET=4` | New files allowed in one turn before it speaks up |
| `RAZOR_LEDGER=off` | Turns off the once-per-session "is all this needed?" check |
| `RAZOR_LEDGER_LOC=500` · `RAZOR_LEDGER_FILES=8` | How much net growth that check tolerates first |

## License

MIT — see [LICENSE](./LICENSE).
