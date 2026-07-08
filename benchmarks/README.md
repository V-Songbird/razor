# Reproduce razor's benchmarks

Curious whether the numbers on razor's front page hold up? This is the actual harness — run it yourself.

It drives **real headless Claude Code sessions** (`claude -p`) on the same fixed coding tasks, once with no plugin and once with razor, and reads the true cost and token counts straight out of the API's own usage JSON. No mocks, no estimates. Each session is scored on the code it leaves behind, and correctness is checked mechanically — the harness runs the produced code with `node` — so a lean answer that breaks the task scores as a *failure*, not a win.

## Before you start

- **Claude Code, signed in.** `claude` must be on your PATH and already authenticated (run any `claude` command once first). Every run bills your account — see the cost note below.
- **Node** on your PATH (any recent version) — it runs the harness *and* scores the code each session produces. If you use [fnm](https://github.com/Schniz/fnm), activate it in this shell first — e.g. on PowerShell: `fnm env --use-on-cd | Out-String | Invoke-Expression`.
- Run the commands **from this `benchmarks/` directory.**

## The honest disclaimer, up front

- **It costs real money.** The cheap default run is roughly **$1–3 on the small model (Haiku)** and takes a few minutes. The full suite, or running on the bigger model, costs more.
- **The numbers move between runs.** This is a handful of reps against a live model, not a powered experiment — Haiku is high-variance, and a small sweep is a small sample. Add reps for steadier numbers (`--runs 4`).
- **What you should see:** razor landing **at or below baseline on cost and code size**, with **no new dependencies added** and every task still passing — the same *shape* as our published charts. You will **not** reproduce our exact figures, and that's expected. If razor is leaner and no pricier with correctness intact, the claim holds.

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

**4. Go bigger** (optional) — every task, more reps, or the larger model (costs more):

```bash
node runner/run.js --full --runs 3        # every task, 3 reps each
node runner/run.js --default --models sonnet
```

Flags: `--task a,b` (pick tasks) · `--arms baseline,razor` · `--full` (whole suite) · `--runs N` · `--models haiku|sonnet` · `--workers N` · `--rescore <run-dir>` (recompute metrics offline, no API) · `RAZOR_DIR` (override the razor plugin location).

## Bring your own rival

Want to see how razor stacks up against some *other* plugin? Point `--rival-dir` at any plugin directory on your machine and it becomes a third arm — loaded exactly like razor, measured on the same tasks, same way:

```bash
node runner/run.js --default --rival-dir /path/to/other-plugin
node runner/report.js <the-run-dir-it-printed>
```

Options: `--rival-name <label>` (how it shows up in the report). We don't ship or name any rival — you bring whichever one you're curious about.

## Verify it yourself, for free

The claims also rest on razor's unit tests, which cost nothing to run — they exercise razor's gates and ruleset directly:

```bash
node --test razor/tests/*.test.js
```

(Run that from the repo root. On Windows Node 22, use the explicit `*.test.js` glob shown here — a bare `node --test tests/` with a trailing slash trips up on that version.)

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
