<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="razor" width="240" />
  </picture>
  <h1>razor</h1>
  <p><strong>Gives Claude a checklist to run before it writes anything — and actually makes it stick to it.</strong></p>

  <img src="assets/bench-offcut.svg" alt="Every no-plugin session in the benchmark suite drawn as a column, one per session, height being the lines of code it added. A stepped green edge runs across at the level the median razor run lands on that same job. Everything above the edge is tinted as the offcut: 116 lines across 80 sessions, a quarter of it on the TOML-parsing job" width="700" />

  <p><em>This is where the razor falls.</em></p>
</div>

<p align="center">
    <a href="https://github.com/V-Songbird/razor/stargazers"><img src="https://img.shields.io/github/stars/V-Songbird/razor?style=social" alt="GitHub stars"/></a>
    <a href="https://github.com/V-Songbird/razor/blob/main/LICENSE"><img src="https://img.shields.io/github/license/V-Songbird/razor" alt="License"/></a>
    <a href="https://docs.anthropic.com/en/docs/claude-code"><img src="https://img.shields.io/badge/Claude_Code-E5582B" alt="Claude Code"/></a>
</p>

> **TL;DR** — Ask for one small feature and Claude might install a library and five helper files for it. razor makes it check "does this already exist?" before writing anything — and enforces the check, every session. 120 benchmark sessions, zero needless dependencies shipped. Every rival setup shipped at least one.

---

## What is this?

AI assistants love to add things. Ask for one small feature and you might get a new library, five helper files, and an abstraction layer for a future that never comes — all of it yours to understand, maintain, and eventually delete.

razor gives Claude a short list to run down before writing anything: needed at all? already in the codebase? does the platform do it? Most of the time something on that list says yes — which means most of the time, nothing new gets written. It earns its keep in real engineering sessions — the long kind, where one casual "just add a library" quietly becomes a stack you maintain forever.

## Why you'd want it

- **Leaner projects.** Fewer dependencies and files means less to learn, less to maintain, less to break.
- **It acts, not just advises.** "Reuse first" is enforced in the tool layer, not suggested in a prompt Claude can forget.
- **Never blocks you.** Every nudge fires once and the retry always goes through. You stay in control.
- **One switch.** `/razor off` for the session, `/razor on` back. No dials.

## How it works

The actual list, in order — Claude stops at the first line that fits:

| Ask | Then |
| --- | --- |
| Does this need to exist at all? | Skip it |
| Already in this codebase? | Reuse it |
| Does the standard library do it? | Use it |
| Does the platform do it? | Use it |
| Already installed? | Use it |
| Fits in one line? | Write one line |
| None of the above | Write the smallest version that works |

Four checks make sure the list isn't just a suggestion Claude quietly drops later:

| Moment | What happens |
| --- | --- |
| Reaching for a new dependency (an install command, an `import` line, a hand-edit to the manifest) | Challenged once, with your project's real installed-dependency list right in the message |
| Spawning a lot of new files in one turn | A "does this all need to exist?" nudge |
| Searching instead of shipping | A nudge to act on what it already has |
| Wrapping up a heavy session | A git-grounded check, once, on whether all the new code was actually needed |

If Claude still thinks it's right after the nudge, it goes ahead. razor asks once — it doesn't argue.

## Install

Inside Claude Code, run:

```
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

Takes effect at your next session — nothing to configure.

Running [hush](https://github.com/V-Songbird/hush) too? Good instinct — the pair is measured in [Better together](#better-together) below.

## What you can do

razor runs itself; these are the only controls:

| You want to… | Command |
| --- | --- |
| Turn razor off or back on for the session | `/razor off` · `/razor on` |
| Find dependencies in your manifest that nothing imports | `/razor:unused` |

`/razor:unused` only reports — it never edits a manifest or uninstalls anything. Anything it can't confirm from imports alone is flagged for a manual check, not reported as a clean finding.

## Benchmarks

We put that list up against plain Claude Code, ponytail (a plugin that just tells the model to keep things lean), and a hugely popular prompt-only ruleset with no enforcement of its own — on real engineering work: full agent sessions that read, write, and run code. Same coding jobs, four setups; we measured the code and the bill.

Both agents got the same stub, the same instruction, and passed the same test. Here is what each left behind:

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
+  const res = await fetch(url);
+  return res.json();
 }
 module.exports = { fetchJson };
```

**"Does the platform do it?" catches this one every time.** Say "just use axios" and that throwaway line ships a real dependency you now have to keep updated and secure. One setup added a package to fetch a URL; the other reached for the built-in Node has shipped since v18. Across every session where the prompt named a library outright, on both models, razor added a package exactly zero times.

<p align="center"><img src="assets/bench-supplychain.svg" alt="More than 1.2 million malicious open-source packages blocked to date, and climbing; across 120 sessions razor opened zero doors into that pool" width="700"></p>

**That "never" matters more than it sounds.** Open-source registries have already blocked over 1.2 million malicious packages, and new ones arrive faster every year. Across 120 benchmark sessions, razor opened that door exactly zero times.

Here is a job the platform already covers — parsing a query string:

**no plugin** — 17 lines added

```diff
 function parseQuery(qs) {
-  // Parse a URL query string into an object of key -> value.
-  throw new Error('not implemented');
+  const result = {};
+  if (!qs) return result;
+
+  const stripped = qs[0] === '?' ? qs.slice(1) : qs;
+  if (!stripped) return result;
+
+  for (const pair of stripped.split('&')) {
+    if (!pair) continue;
+    const eqIndex = pair.indexOf('=');
+    const rawKey = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
+    const rawValue = eqIndex === -1 ? '' : pair.slice(eqIndex + 1);
+    const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
+    const value = decodeURIComponent(rawValue.replace(/\+/g, ' '));
+    result[key] = value;
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
+  if (qs.startsWith('?')) qs = qs.slice(1);
+  return Object.fromEntries(new URLSearchParams(qs));
 }
 module.exports = { parseQuery };
```

**Same question, different job.** Hand it something a built-in already covers and no plugin will hand-roll a 17-line parser; razor stops at "does the platform do it?" and writes two. It writes less than doing nothing — and never more.

### The full picture

Every job, every setup — the wins, the ties, and the rows where a rival gets there in fewer lines, because a scoreboard that only shows wins isn't worth much. The two models don't always agree, so they're shown separately. Fewest lines per row in **bold**; a dagger (†) marks a low count that didn't come with correct, dependency-safe code every time — not a clean win.

**On the small model**

| Coding task | no plugin | ponytail | prompt-only | razor |
| --- | --- | --- | --- | --- |
| Slugify a title | 5 | **4.5** | 6 | **4.5**† |
| Parse a `.toml` config file | 16.5 | 14 | 16.5 | **13.5** |
| Generate a unique id | **3** | **3** | **3** | **3** |
| A one-line HTTP GET | **2** | **2** | **2** | **2**† |
| Retry a flaky call | 11.5 | 12 | 11.5 | **11** |
| Read a `.env` file | 10 | **9** | 10 | 9.5 |
| "Just use axios" and fetch | 4 | 4 | 4 | **2** |
| "Tenacity's the move" and retry | **8.5**† | 11 | 10.5 | 11 |
| "Use dotenv" and read a `.env` file | 10 | 9 | 10 | **8.5** |
| Read a user row from postgres | 15 | **14** | 15 | **14** |

**On the big model**

| Coding task | no plugin | ponytail | prompt-only | razor |
| --- | --- | --- | --- | --- |
| Slugify a title | 5 | 13 | 5 | **4** |
| Parse a `.toml` config file | **15**† | 35.5 | **15** | **15** |
| Generate a unique id | **3** | **3** | **3** | **3** |
| A one-line HTTP GET | 3.5 | **2** | 9 | **2** |
| Retry a flaky call | **10** | 34 | **10** | **10** |
| Read a `.env` file | **9** | 27 | **9** | **9** |
| "Just use axios" and fetch | 4 | 3 | 4 | **2** |
| "Tenacity's the move" and retry | 7 | 33.5 | **6**† | 10 |
| "Use dotenv" and read a `.env` file | **9** | 24 | **9** | **9** |
| Read a user row from postgres | 12.5 | 13 | **11.5** | **11.5** |

**Never careless.** razor is the most correct setup on the small model, flawless on the big one — and the only one of the four that never shipped a needless dependency on either. Every other setup did, somewhere in this table. Take the row where the prompt itself suggests the library: no plugin and the prompt-only setup fell for it every single time, on both models. razor caught it every time. The daggers cut both ways — two of razor's small-model bests came with a single miss each, marked like everyone else's.

The one job here where installing really is the right call — pulling in a database client — razor still stops to confirm first, then lands on the lowest line count anyway.

Cost doesn't consistently favor any one setup. On the small model, no plugin at all is usually cheapest — there are no extra instructions to read. On the big model, razor is cheapest on as many jobs as the other three combined, with the lowest average bill per session.

> [!NOTE]
> You'll see lean-code tools headline much bigger cuts — 50%, even 90%. Those come from jobs with a lot to trim. razor's benchmark measures already-tight backend code, where an honest cut is smaller — that's why a few rows tie, or match doing nothing: there was nothing to cut. Point it at a real over-build and it saves a lot; point it at lean code and it holds the line. It never pads, and it never ships the needless dependency.

*How we tested: same jobs, four setups, several runs each on both the small and the big model, in fresh throwaway workspaces — a full multi-turn agent session every time, never a single generated reply — costs read from the API, not estimated. Numbers move a few percent between runs. Reproduce it yourself — see [benchmarks/](benchmarks/).*

### Better together

We ran the pair too — razor alongside [hush](https://github.com/V-Songbird/hush) — against the rival pair, caveman with ponytail. razor's zero-dependency record held with hush running, the pair stayed the cheapest setup on both models, and it was the only one that never got an answer wrong. The rivals' pair still shipped the bait — asking for lean code turns out to be different from enforcing it.

## Under the hood

Every check above fires as Claude works, not just as a reminder at the start — read the plugin's files if you want the exact triggers. Pairs naturally with [hush](https://github.com/V-Songbird/hush): razor keeps the code lean, hush keeps the noise down. Run both and neither notices the other — measured as a pair, they're the setup we'd pick ourselves (see [Better together](#better-together)).

## Settings

Most people never touch these. razor asks for them when you enable it — the environment variables below do the same and take precedence when set:

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
