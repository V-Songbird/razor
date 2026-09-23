---
type: knowledge
summary: "The benchmark results behind the README: the Claude Code runs on correctness, package-free sessions, code size, whole-session growth, real-repository behavior, speed, cost, spawned agents and where razor does not win, the Claude Opus 5 run beside a rival plugin, and the exploratory Codex run; read before changing a published number."
related_files:
  - README.md
---

# The numbers

Everything here comes from real sessions — full conversations, not canned
replies. Most sections are Claude Code runs on Claude Sonnet and Claude Opus,
once with no plugin and once with razor. The two runs the README's table shows,
[Claude Opus 5 beside a rival plugin](#claude-opus-5-beside-a-rival-plugin) and
[Codex](#codex), have their own sections at the end and are not pooled with the
others. Cost and token counts come out of the API's own usage data.
Every session is scored on the code it left behind, and correctness is checked
by running that code. **A short answer that breaks the task scores as a
failure, not a win.**

The harness is kept outside this repository; each section below keeps its run's setup so the
figures can be judged.

> [!NOTE]
> Numbers move between runs, sometimes by a lot. These are a few hundred
> sessions against a live model, not a powered experiment. Read the direction,
> not the decimals. Where two runs disagree, this page says so.

## The runs on this page

Each section below names the run it comes from. Runs in different rows are
not pooled.

| run | host | model | date | n | razor revision |
| --- | --- | --- | --- | --- | --- |
| corpus | Claude Code 2.1.235 and 2.1.238 | Claude Sonnet and Claude Opus, model version not recorded | 2026-08-19 and 2026-08-20 | two pooled runs, 78 sessions per setup per model | not recorded |
| held-out tests | replay of corpus sessions | Claude Sonnet and Claude Opus, model version not recorded | 2026-08-29 | 240 sessions, 102 test cases | not recorded |
| 2026-08-29 batch | Claude Code 2.1.251 | Claude Sonnet and Claude Opus, model version not recorded | 2026-08-29 | 48, 24, 24 sessions and 132 judged pairs, per section | not recorded |
| [Opus 5 rival](#claude-opus-5-beside-a-rival-plugin) | Claude Code, CLI version not recorded | Claude Opus 5 | date unknown | 39 sessions per setup | not recorded; published 2026-09-01 (`cbc92f3`) |
| [Codex](#codex) | Codex CLI 0.153.4 | GPT-5.6 Sol | 2026-09-08 | 38 cases per setup | `66a5b7f` |

The batch ran on a newer Claude Code than the corpus, so its figures are not
comparable with the corpus tables.

## Does it still work?

*Run: corpus.*

The first question, because everything else is worthless without it.

A session is **clean** only if the code is correct *and* no package was added.
Across 156 sessions per setup, on both models:

| setup | clean sessions |
| --- | --- |
| no plugin | 146 / 156 |
| **razor** | **156 / 156** |

A pooled total, unlike the rest of this page: every session on the
then-current build, seven runs including the corpus, dates not all recorded.
Pooled that way, **razor is 258 for 258**, with zero package installs
attempted. The no-plugin arm, over 240 sessions, got 10 wrong, added packages
in 13, and reached for a package manager 5 times.

Every single package-manager command in the whole set came from the no-plugin
arm.

## The job razor exists for

*Run: corpus.*

Three of the jobs plant a throwaway phrase in the prompt — *"just use axios"*,
*"p-retry's the move"*, *"dotenv does this"*. 36 sessions per setup.

| setup | correct | package-free |
| --- | --- | --- |
| no plugin | 28 / 36 | 26 / 36 |
| **razor** | **36 / 36** | **36 / 36** |

On one of those jobs with Sonnet, plain Claude Code got it wrong **6 times out
of 6**. It took the throwaway line literally, wrote `require('axios')` into a
project that does not have axios, and the delivered code would not load.

## How much code

*Run: corpus.*

Lines of production code for the same job, averaged over 66 sessions per setup
per model. Test files are counted separately and are not in these figures.

| model | no plugin | razor |
| --- | --- | --- |
| Claude Opus | 18.7 | **11.6** |
| Claude Sonnet | 16.0 | **12.3** |

Across the 22 job-and-model rows, razor writes fewer lines on 20 and ties on 2.
It is never the wordiest.

It also cuts the bad days, not just the average. On Opus, the worst 10% of
no-plugin sessions run to 49 lines; razor's run to 27. Sessions that spiral past
9 tool calls: 15 out of 78 without the plugin, 3 out of 78 with it.

## Over a whole session

*Run: 2026-08-29 batch, 24 sessions.*

Every figure above is one request. This one is five, on the same codebase:
build a feature, build another, fix a bug in the second one, build two more.
Same prompts for both setups.

**Total lines of code in the project after each turn, Claude Opus:**

| after turn | no plugin | razor |
| --- | --- | --- |
| 1 | 57 | **29** |
| 2 | 99 | **44** |
| 3 | 100 | **43** |
| 4 | 125 | **55** |
| 5 | **136** | **58** |

On Sonnet the same shape, smaller: 113 lines against 78.

**The gap grows.** It is 49% at turn one and 58% by turn five. And nothing
broke: **all 24 sessions passed all five features, with zero regressions in
either setup** — including turn three, the bug fix built to depend on what turn
two wrote. Smaller code was not harder to extend.

The whole five-turn conversation also cost 20% less on Opus.

## Does the shorter code do less?

*Run: held-out tests.*

The fair question, and the one we most wanted to be sure about.

We wrote 102 test cases straight from the job descriptions — before looking at
a single answer — then had a second pass strip out anything that would reward a
short answer for being short. Every test set was checked against a known-good
and a known-bad answer first, so we know they catch real mistakes.

Replayed across 240 finished sessions: **every setup passed 100% of them.**
There is not one behaviour razor's answer misses that the longer answer catches.

## In a real repository

*Run: 2026-08-29 batch, 48 sessions.*

The jobs above live in small folders. This one is a 61-file project with 8
installed packages, a real folder layout and a house convention you only see if
you look. Four jobs, 48 sessions.

| model | setup | correct | did the right thing structurally | tool calls | cost |
| --- | --- | --- | --- | --- | --- |
| Opus | no plugin | 12/12 | 12/12 | 13.6 | $0.284 |
| Opus | **razor** | **12/12** | **12/12** | **8.7** | **$0.222** |
| Sonnet | no plugin | 12/12 | 9/12 | 10.0 | $0.111 |
| Sonnet | razor | 12/12 | 9/12 | 9.3 | $0.106 |

The worry going in was that razor's "one search, then move on" would make it
duplicate a helper that already exists. **It did not.** It reused the existing
helper and the already-installed package exactly as often as plain Claude Code,
matched it on the project's naming convention, and got there on Opus with **36%
fewer tool calls for 22% less money**.

## Speed and cost

*Run: corpus.*

Per session, averaged over 78 sessions per setup per model.

| model | setup | turns | seconds | words written | context used |
| --- | --- | --- | --- | --- | --- |
| Opus | no plugin | 7.5 | 29.4 | 1,772 | 147k |
| Opus | **razor** | **5.5** | **19.7** | **1,137** | **114k** |
| Sonnet | no plugin | 4.8 | 11.9 | 793 | 130k |
| Sonnet | razor | 4.4 | **11.1** | 693 | **119k** |

On a job with nothing to trim — a plain question, no code — razor's checklist
costs a few percent more and earns most of it back in a shorter answer.

## Spawned agents

*Run: 2026-08-29 batch, 24 sessions.*

When Claude splits work across five helper agents, the checklist goes to each
one. That is five copies, so it is fair to ask what it costs.

| model | setup | lines written | cost |
| --- | --- | --- | --- |
| Sonnet | no plugin | 44.7 | $0.216 |
| Sonnet | **razor** | **30.7** | $0.221 |
| Opus | no plugin | 32.0 | $0.464 |
| Opus | **razor** | **28.0** | $0.474 |

**About 2% more, for 13–31% less code.** The discipline survives the split, and
where splitting the work was the wrong call, both setups correctly declined to
do it.

## Where razor does not win

*Runs: the blind review is the 2026-08-29 batch, 132 judged pairs; the Sonnet cost runs are the corpus.*

> [!IMPORTANT]
> These are real results and they are here on purpose.

**It does not make code easier to review.** We showed 66 pairs of answers to a
blind reviewer, the same job each time, with the labels stripped and the order
swapped so position could not sway it. razor's answer was preferred **41% of
the time**, against a 60% bar we set beforehand. Its code is not measurably
flatter or less branchy per line either — the raw advantage there turns out to
be the length advantage wearing a different hat.

**The cost saving on Sonnet is not settled.** Two runs of the same jobs
disagree: one says razor is 9% cheaper, the other says it is level. Only the
Opus saving reproduces.

**The gains are smaller on Sonnet across the board.** Most of the headline
numbers on this page are Opus numbers. Sonnet moves in the same direction, less
far, and less reliably.

## Claude Opus 5 beside a rival plugin

| | |
| --- | --- |
| Host | Claude Code, CLI version not recorded |
| Model | Claude Opus 5 |
| Setups | no plugin, [ponytail](https://github.com/DietrichGebert/ponytail) (a plugin that also tells Claude to write less), razor |
| n | 39 sessions per setup, in one run |
| Date | date unknown: the retained record does not state the run date |
| Revision | not recorded; published 2026-09-01 (`cbc92f3`) |

| setup | clean sessions | mean coding lines | mean session cost |
| --- | --- | --- | --- |
| no plugin | 35 / 39 | 18.3 | $0.155 |
| ponytail | 39 / 39 | 12.2 | $0.151 |
| **razor** | **39 / 39** | **9.6** | **$0.121** |

A clean session is correct and adds no package. Lines are averaged over the
eleven coding jobs; razor wrote fewer lines than ponytail on nine of them and
tied on the other two. ponytail also blocked every unnecessary package.

## Codex

| | |
| --- | --- |
| Host | Codex CLI 0.153.4 on Windows |
| Model | GPT-5.6 Sol, high reasoning |
| Setups | no plugin, razor |
| n | 19 tasks, 2 repetitions each, per setup (38 cases); the full task group is 26 of them |
| Date | 2026-09-08 |
| Revision | razor `66a5b7f404c5d7f75d938354093d044287903fda` |
| Status | exploratory: two repetitions are not a stable estimate |

| task group | setup | correct and safe | mean coding lines |
| --- | --- | --- | --- |
| full | no plugin | 19 / 26 | 19.2 |
| full | **razor** | **26 / 26** | **9.6** |
| all | no plugin | 29 / 38 | — |
| all | **razor** | **38 / 38** | — |

On the pairs both setups passed, elapsed time was 1.8% higher and input tokens
0.8% higher with razor; neither improved. This compares Sol with and without
razor. It does not compare Sol against Claude.

## Reproducing this

The harness that drove these sessions is kept outside this repository and is
not distributed with the plugin. A rerun against the same fixed jobs costs real
money, and you will not reproduce these exact figures. If razor comes out leaner and no
pricier with correctness intact, the claim holds.
