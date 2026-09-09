<!-- foundry:edition Claude -->
<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png" />
    <img src="assets/banner-light.png" alt="razor" width="900" />
  </picture>
  <h1>razor</h1>
  <p><strong>Before adding code, ask whether the project already has what it needs.</strong></p>
</div>

<!-- foundry:platform identity -->
**Edition: Claude Code.** Use this edition’s installation and compatibility notes below.
<!-- /foundry:platform identity -->

[**Install**](#install) · [What is this?](#what-is-this) · [What you can do](#what-you-can-do) · [The numbers](#the-numbers) · [Going deeper](#going-deeper)

> **TL;DR** — Before adding code, ask whether the project already has what it needs.

<!-- foundry:hero -->
<p align="center"><img src="assets/hero.svg" alt="Razor original product visualization" width="700"></p>

Original Claude Code benchmark visualization. These measurements describe the recorded Claude sessions, not Codex performance. [Evidence and methodology](https://github.com/V-Songbird/foundry/tree/main/docs/razor).

<details>
<summary>Watch the recorded Claude Code demo</summary>

<p align="center"><img src="assets/demo.svg" alt="Recorded Claude Code demonstration of Razor" width="700"></p>

</details>
<!-- /foundry:hero -->

<p align="center"><img src="assets/mascot.svg" alt="Ember clears away extra packages and helper boxes, leaving only the requested work." width="700"></p>

## What is this?

AI assistants love to add things. One small feature can turn into a new library, helper files and abstractions that are now yours to maintain. razor adds a short checklist and targeted checks so existing code and language features get considered first.

## Why you'd want it

- Reuse what the project already has.
- Reconsider unnecessary dependencies before installing them.
- Notice file growth before a small task becomes a larger project.
- Find declared dependencies that no source file appears to use.

## How it works

A checklist asks whether the work is needed, already implemented or covered by the language. Targeted checks can request one reconsideration. A retry follows the host’s normal permissions. The unused-dependency audit reports findings without uninstalling anything.

## Install

<!-- foundry:platform install -->
Inside Claude Code:

```text
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

Start a new session to load the plugin.
<!-- /foundry:platform install -->

## What you can do

| You want to | Outcome |
| --- | --- |
| Keep a small task small | Check reuse, dependencies and file growth |
| Pause or resume the checks | Change the session toggle |
| Find unused dependencies | Receive a report with confirmed, likely and unknown findings |

<!-- foundry:platform commands -->
Use `/razor off` / `/razor on` for the session toggle and `/razor:unused` for a dependency report.
<!-- /foundry:platform commands -->

## The numbers

Each result belongs to the named model and recorded run. Missing measurements remain marked as unmeasured.

<!-- foundry:platform benchmarks -->
<!-- foundry:evidence {"platform":"Claude","status":"measured","models":["Claude Opus 5"],"source":"docs/razor/validation/claude-readme-benchmark-source-2026-09-08.md","date":"unknown","revision":"623dd2c549786336c447296115f9b1ff3112a5a8","dateReason":"The retained source excerpt does not state a run date.","reviewedAt":"2026-09-08"} -->
| Model | Setup | Correct and safe | Mean coding lines |
| --- | --- | --- | --- |
| Claude Opus 5 | No plugin | 35/39 | 18.3 |
| Claude Opus 5 | ponytail | 39/39 | 12.2 |
| Claude Opus 5 | razor | 39/39 | 9.6 |

A clean session completed the job without adding a package. Lines are averaged across the coding jobs. Mean session cost was $0.121 with razor, $0.155 without a plugin and $0.151 with ponytail. Blind comparisons did not establish better readability, and Sonnet cost savings did not reproduce reliably. These are recorded Claude results.
<!-- /foundry:platform benchmarks -->

*Results can vary between runs.*

## Going deeper

<!-- foundry:platform links -->
[How it works](docs/HOW-IT-WORKS.md) · [Settings](docs/SETTINGS.md) · [Benchmark details](docs/BENCHMARKS.md)
<!-- /foundry:platform links -->

[Foundry](https://github.com/V-Songbird/foundry) holds the research, methodology and detailed evidence for this plugin.

## Good to know

Input validation, security and error handling that protects your work remain necessary. Explicitly requested scope stays yours to choose. These checks are advisory, not a security boundary.

<!-- foundry:platform compatibility -->
The Claude integration has its own tool-event coverage. See [how razor works](docs/HOW-IT-WORKS.md) and [settings](docs/SETTINGS.md).
<!-- /foundry:platform compatibility -->

## License

MIT — see [LICENSE](LICENSE).
