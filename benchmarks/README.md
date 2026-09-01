# Reproduce razor's benchmarks

Curious whether the numbers on razor's front page hold up? This is the actual harness — run it yourself.

It drives **real headless Claude Code sessions** (`claude -p`) on the same fixed coding tasks, once with no plugin and once with razor. Cost and token counts come straight out of the API's own usage JSON. No mocks, no estimates, and no single-shot prompts — a canned reply can't tell you what a plugin costs across a real multi-turn session. Each session is scored on the code it leaves behind, and correctness is checked mechanically — the harness runs the produced code with `node`. A lean answer that breaks the task scores as a *failure*, not a win.

## Before you start

- **Claude Code, signed in.** `claude` must be on your PATH and already authenticated (run any `claude` command once first). Every run bills your account — see the cost note below.
- **Node** on your PATH (any recent version) — it runs the harness *and* scores the code each session produces. If you use [fnm](https://github.com/Schniz/fnm), activate it in this shell first — e.g. on PowerShell: `fnm env --use-on-cd | Out-String | Invoke-Expression`.
- Run the commands **from this `benchmarks/` directory.**

## The honest disclaimer, up front

> [!WARNING]
> This costs real money. The cheap default run measured about **$3 on Sonnet** and takes a few minutes; the same run on Opus is roughly twice that. The full set — every task, three arms, three reps, both models, 234 sessions — measured **$36**. Those are real bills from this machine, not a quote; yours will differ.

> [!NOTE]
> The numbers move between runs — a handful of reps against a live model, not a powered experiment. A small sweep is a small sample; add reps for steadier numbers (`--runs 4`). A result only counts when both models agree on the direction.

**What you should see:** razor landing **at or below baseline on cost and code size**, with **no new dependencies added** and every task still passing — the same *shape* as our published charts. You will **not** reproduce our exact figures, and that's expected. If razor is leaner and no pricier with correctness intact, the claim holds.

A default run uses Sonnet, so the plugin README's **On Claude Sonnet** table is the one to compare against. `--models` accepts `sonnet` and `opus`, and both published tables come from a single interleaved run across the two.

## Run it

**1. Prove the instruments first** (free — no API spend) to confirm each task scores a correct answer as correct, catches a wrong one, and finds the razor plugin:

```bash
node runner/run.js --selftest
```

If it prints `all instruments valid`, you're good.

**2. Smoke test** (one cheap task per arm, ~1 min, tiny spend) to confirm the plumbing actually drives `claude`:

```bash
node runner/run.js --smoke
```

**3. The real thing** — the cheap default subset — then turn the run into charts and a readable report:

```bash
node runner/run.js --default
node runner/report.js <the-run-dir-it-printed>
```

`run.js` prints the exact run directory when it finishes. (Runs land in your system temp dir, *outside* your project, on purpose: each cell is a real Claude session with permissions bypassed, so keeping the workspaces out of any git tree means a sandboxed run can never touch your repo. Set `RAZOR_BENCH_RUNS` to put them elsewhere.)

One consequence worth knowing: razor treats anything under your system temp
directory as scratch, so the new-file check never speaks there. A run left at
its default location cannot exercise that check. Point `RAZOR_BENCH_RUNS`
somewhere outside the temp directory if that is what you are testing.

**4. Go bigger** (optional) — every task, more reps, or the larger model (costs more):

```bash
node runner/run.js --full --runs 3      # every task, 3 reps each
node runner/run.js --default --models opus
```

Flags: `--task a,b` (pick tasks) · `--arms baseline,razor` · `--full` (whole suite) · `--counter` (the other suite, below) · `--note` (the note suite, below) · `--runs N` · `--models sonnet|opus` · `--effort low|medium|high` (reasoning effort for every cell; left to the CLI default when unset) · `--workers N` · `--seed N` (replay an earlier run's arm order) · `--rescore <run-dir>` (recompute metrics offline, no API) · `RAZOR_DIR` (override the razor plugin location).

The setups take turns in a shuffled order rather than one finishing before the next starts, so neither pays more of the cold-start cost than the other. The run prints its seed and saves it — pass `--seed` to repeat the exact same order.

## The other suite: when adding is the right answer

Every job in the main suite has the same shape. The best answer is to add
nothing. That only ever shows whether razor can say no.

`--counter` runs four jobs that go the other way. Each one needs something
added, and each one names something razor could wrongly talk Claude out of:

| Job | What the job needs | What would go wrong |
| --- | --- | --- |
| `need-installed-dep` | Use the library the project already installed | Writing it by hand, so the output stops matching |
| `need-old-node` | Ship code that runs on Node 16 | Using `fetch`, which that version does not have |
| `need-abstraction` | Two storage backends behind one shape, as asked | Building only one of them |
| `need-validation` | Check untrusted input at a public endpoint | Trimming the checks away |

```bash
node runner/run.js --counter --arms baseline,razor --runs 3
```

These four are kept out of `--full` on purpose, so the published tables stay
the published tables.

## The note suite: when the session has wandered off

Every job above is a single request. That can never show a behaviour which
depends on what you asked for earlier, and razor has one: the line it adds when
a request has left the task the session started on.

`--note` runs two conversations. Both open the same way, and differ only in
what you ask for second:

| Job | The second request | What should happen |
| --- | --- | --- |
| `note-drift` | Something unrelated, in a new file | The work gets done, and a line says the session has moved off its original task |
| `note-steady` | The first request's own spec was wrong, fix it | The work gets done and nothing is said — it is the same job |

`note-steady` is the one that matters. A warning there is a false alarm, and a
setup that cries wolf on ordinary corrections is worse than one that says
nothing at all.

```bash
node runner/run.js --note --arms baseline,razor --runs 3
```

These two are kept out of `--full` as well. They score a message rather than
code, so every code column reads zero for them by design.

## Bring your own rival

Want to see how razor stacks up against some *other* plugin? Point `--rival-dir` at any plugin directory on your machine and it becomes a third arm — loaded exactly like razor, measured on the same tasks, same way:

```bash
node runner/run.js --default --rival-dir /path/to/other-plugin
```

One rival is the common case. To race several builds at once — say three
cut-down copies of a plugin against the real one — name each with its own
`--arm-dir`:

```bash
node runner/run.js --default --arms baseline,razor,cutA,cutB \
  --arm-dir cutA=/path/to/build-a --arm-dir cutB=/path/to/build-b
node runner/report.js <the-run-dir-it-printed>
```

Options: `--rival-name <label>` (how it shows up in the report). We don't ship or name any rival — you bring whichever one you're curious about.

## Verify it yourself, for free

The claims also rest on razor's unit tests, which cost nothing to run — they exercise razor's gates and ruleset directly:

```bash
node --test tests/*.test.js
```

(Run that from the razor repo root. On Windows Node 22, use the explicit `*.test.js` glob shown here — a bare `node --test tests/` with a trailing slash trips up on that version.)

## What's measured

Each run records, per session: cost, tokens, wall time, turns, the **code delivered** (lines and new files), whether a **new dependency** was added, and a pass/fail from the task's ground-truth check. Every cell's workspace and raw transcript is kept, so any measurement is recomputable offline with `--rescore` — tweaking a metric never costs you API twice.

All tasks are self-contained (seeds are inline in `runner/tasks.js`) and solvable with a Node builtin or the platform, so the lean answer is objectively small and the scorer can execute it with `node`:

| tier | what it probes |
|---|---|
| **dependency traps** | a job a Node builtin covers, but that tempts a new dependency — `safe` = no new dep added |
| **vibe-coder dep traps** | same, but the prompt itself casually names a needless library ("let's just use axios") |
| **reuse trap** | a seeded mini-codebase where nothing is actually reusable — does the agent glance and move on, or over-search? |
| **sprawl trap** | an open-ended feature edit — measures new files + diff size against a working behavior check |
| **injection overhead** | no-code tasks, where a plugin can only add tokens/cost/time — the pure overhead tax |

This **can** show whether razor changes what the agent builds and what it costs, on ground-truthed tasks you can inspect. It **can't** prove production-readiness from a handful of tasks — a deterministic check is a floor, not a full proof, and on a small, high-variance sample you should read trends, not decimals.

### A note on fairness

razor's once-per-session ladder is part of the product, so its token cost is included in the measurement, not subtracted. Each arm runs in a fresh throwaway workspace outside any git repo, with only that one plugin loaded (`--setting-sources project,local`, no MCP servers, a scoped tool allowlist) — so a difference between arms is the plugin, nothing else.

## Where a run lands

Each run writes `results.json` (one record per session — task, arm, model, cost, tokens, code size, dependency verdict, pass/fail) and `summary.json` into the run directory it prints when it finishes. `report.js` adds `report.md` and `charts.svg` there. That directory sits in your system temp dir unless `RAZOR_BENCH_RUNS` points it elsewhere, so nothing lands in your project and nothing leaves your machine. The front page's numbers came from a run of this same harness; run it yourself to regenerate them from scratch.
