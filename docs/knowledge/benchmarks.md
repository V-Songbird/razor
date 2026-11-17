---
type: knowledge
summary: "Every published razor measurement: the Claude Opus 5.5 run with its drift tests, the Claude Opus 5 run with the ponytail comparison, the earlier Claude runs and where razor does not win, and the Codex run on GPT-5.6 Sol; read before changing a published number."
related_files:
  - README.md
  - assets/hero.svg
  - assets/demo.svg
---

# Razor benchmarks

This page holds every measurement Razor publishes, with its method and its limits. The README shows the newest table for each host, under [The numbers](../../README.md#the-numbers).

Each result belongs to the named model and recorded run. Missing measurements stay marked as unmeasured. These are a few hundred sessions against a live model, not a powered experiment. Numbers move between runs, so read the direction, not the decimals.

## Contents

- [How to read these results](#how-to-read-these-results)
- [Claude Code: Claude Opus 5.5](#claude-code-claude-opus-55)
- [Claude Code: Claude Opus 5](#claude-code-claude-opus-5)
- [Claude Code: where Razor does not win](#claude-code-where-razor-does-not-win)
- [Codex: GPT-5.6 Sol](#codex-gpt-56-sol)
- [Antigravity](#antigravity)

## How to read these results

The Codex run and the Claude Opus 5.5 runs measured the checklist's current one-lookup-per-rung sentence. The Claude Opus 5 run and the earlier Claude Code runs used its earlier "One check is enough, anywhere in this task" wording.

The benchmark harness and the raw records behind these figures are kept outside this repository. They are not distributed with the plugin. [Foundry](https://github.com/V-Songbird/foundry) lists this plugin.

## Claude Code: Claude Opus 5.5

<!-- foundry:evidence {"platform":"Claude","status":"measured","models":["Claude Opus 5.5"],"date":"2026-10-13","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Claude Opus 5.5 | No plugin | 24/26 | 16.2 |
| Claude Opus 5.5 | razor | 26/26 | 8.7 |

Claude Code 2.1.296 on Windows, `claude-opus-5-5` at the CLI's default effort, on 2026-10-13 against Razor checked out at `a6ecf5f`, whose plugin code is identical to release [1.8.1](https://github.com/V-Songbird/razor/releases/tag/v1.8.1) (`6174db6`): the 13 jobs of the full suite, twice each per setup, 26 sessions per setup, none failed to run. Both no-plugin failures were the same job: told to use axios, it imported axios into a project that does not have it. Lines are averaged over the eleven coding jobs, 22 sessions per setup; Razor wrote fewer lines on ten of them and tied on the eleventh.

Mean session cost was $0.086 with Razor and $0.100 without a plugin, a difference of $0.014 ± $0.013 per job. Razor cost more on four of the 13 jobs: the two with no code, by 17% on the question and 14% on the typo fix, and two coding jobs. Its time saving, 3.2 ± 5.9 seconds per job, is inside the noise. Two repetitions are exploratory, not a stable estimate. These workspaces sat outside the temp folder, so Razor's new-file check was active; it did not speak.

### Drift note tests

These runs measured the note's earlier, longer wording, which Razor shipped from release 1.8.1 through 1.9.5. The current, shorter wording keeps the same parts and has not been measured.

The drift note was tested on the same host, model, effort, date and revision, in 6 two-request conversations per setup: Razor noted unrelated second requests in 3 of 3 conversations, against 0 of 3 without a plugin, and stayed quiet on 3 of 3 same-job corrections. The suite scores the message, not the code the second request asked for. A Razor conversation cost $0.197 against $0.169 without a plugin, 17% more.

A run on release [1.8.2](https://github.com/V-Songbird/razor/releases/tag/v1.8.2) (`9eb5215`), same host, model, effort and date, 9 conversations per setup, added a third unrelated request: Razor noted the first unrelated request in 3 of 3 conversations and did not repeat the note on the third request in any. A Razor conversation with three requests cost $0.323 against $0.288 without a plugin, 12% more. Three conversations of each kind are exploratory, not a stable estimate.

A larger run on release [1.8.3](https://github.com/V-Songbird/razor/releases/tag/v1.8.3) (`527e900`), same host, model, effort and date, compared Razor with a copy that delivers the note once at session start, with no no-plugin setup: four kinds of conversation, ten of each, 40 conversations per setup. The note, delivered beside every request as Razor ships it, followed unrelated work in 29 of 30 conversations on the three kinds that drift, against 24 of 30 for the copy delivered once at session start. In the three-request conversations it came after the second request in 9 of 10 and was repeated after the third in 0 of 9. It never fired on a correction. Ten conversations of each kind are also exploratory.

## Claude Code: Claude Opus 5

<!-- foundry:evidence {"platform":"Claude","status":"measured","models":["Claude Opus 5"],"date":"unknown","revision":"not recorded","revisionReason":"The run was published on 2026-09-01 in cbc92f3; the razor revision it measured is not recorded.","dateReason":"The retained source excerpt does not state a run date.","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Claude Opus 5 | No plugin | 35/39 | 18.3 |
| Claude Opus 5 | ponytail | 39/39 | 12.2 |
| Claude Opus 5 | razor | 39/39 | 9.6 |

Claude Code with its CLI version and effort not recorded, Claude Opus 5, 39 sessions per setup in one run; the run date and the Razor revision are not recorded, and the result was published on 2026-09-01 in `cbc92f3`. A clean session completed the job without adding a package. Lines are averaged over the eleven coding jobs; Razor wrote fewer lines than [ponytail](https://github.com/DietrichGebert/ponytail), another plugin that tells Claude to write less, on nine of them and tied on the other two, and ponytail also blocked every unnecessary package. Mean session cost was $0.121 with Razor, $0.155 without a plugin and $0.151 with ponytail. The runner put this run in a temp folder by default, where Razor's new-file check stays silent, so treat it as measuring Razor's other checks only.

The README shows two graphics from this run. The first covers the 27 no-plugin sessions on the nine dependency jobs: 193 lines above Razor's edge never shipped with razor.

![The Razor's edge across 27 columns, one per session without a plugin on the Claude Opus 5 run's nine dependency jobs. Each column is the lines that session added, and the edge sits where Razor's middle session landed on the same job: 193 lines above the edge never shipped with razor.](../../assets/hero.svg)

A recorded Claude Code demo on Claude Opus 5, published September 4, 2026 (run date not recorded), gave one session each the same ask, implement `parseQuery` in `query.js`: without Razor, Claude wrote it in 18 lines; with Razor, in 4 lines built on `Object.fromEntries` and `URLSearchParams`. The averages over 3 sessions each way were the same.

## Claude Code: where Razor does not win

These results come from earlier Claude Code runs on Claude Sonnet and Claude Opus, with model versions, effort and Razor revisions not recorded.

In a batch on Claude Code 2.1.251 on 2026-08-29, a blind reviewer judged 66 pairs of answers to the same job in both orders, 132 judge calls. 27 pairs got the same verdict both ways, and Razor's answer was preferred in 11 of those 27 (41%), against a 60% bar set beforehand.

In the same batch, 24 sessions where Claude split the work across five helper agents, each of which received the full checklist, Razor cost about 2% more: $0.221 against $0.216 on Sonnet and $0.474 against $0.464 on Opus, for 13–31% less code. Its code is not measurably flatter or less branchy per line either. Helper agents now receive a short form of the checklist, which has not been measured.

The cost saving on Sonnet is not settled. Two runs of the same jobs, on Claude Code 2.1.235 and 2.1.238 on 2026-08-19 and 2026-08-20, 78 sessions per setup per model when pooled, disagree: one found Razor 9% cheaper and the other level. Only the Opus saving reproduced. Across the earlier Claude Code runs, the gains were smaller on Sonnet across the board: the same direction, less far and less reliably.

The Claude tables above are Opus results only. These earlier runs are read as having put their workspaces in the temp folder, where Razor's new-file check stays silent, so they measure its other checks only.

## Codex: GPT-5.6 Sol

<!-- foundry:evidence {"platform":"Codex","status":"measured","models":["GPT-5.6 Sol"],"date":"2026-10-09","reviewedAt":"2026-11-14"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| GPT-5.6 Sol | No plugin | 19/26 | 18.7 |
| GPT-5.6 Sol | razor | 26/26 | 10.4 |

Controlled run on Codex CLI 0.161.0 at high reasoning on Windows, on 2026-10-09 against Razor `18d1d0a`: 19 tasks, twice each per setup, 38 cases, of which the table covers the 26 in the full task group. Across all groups, Razor passed 38/38 cases versus 29/38 without it. On the pairs both setups passed, Razor's median ratio to no plugin was 0.500 for coding lines (23 pairs). Over 29 pairs, elapsed time was 15.1% higher, input tokens 5.1% higher and output tokens 6.2% lower; timings include the overhead of observing Razor's hooks. Two repetitions are exploratory, not a stable estimate. This result does not compare Sol against Claude.

## Antigravity

<!-- foundry:evidence {"platform":"Antigravity","status":"pending","reason":"No Antigravity performance measurements are available."} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Not measured | Not measured | Not measured | Not measured |

No Antigravity session has been measured yet.

*Results can vary between runs.*
