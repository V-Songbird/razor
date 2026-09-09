<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png" />
    <img src="assets/banner-light.png" alt="razor" width="900" />
  </picture>
  <h1>razor</h1>
  <p><strong>Before adding code, ask whether the project already has what it needs.</strong></p>
</div>

**Choose your edition: [Claude Code](https://github.com/V-Songbird/razor/tree/Claude) · [Codex](https://github.com/V-Songbird/razor/tree/Codex)**

[**Get started**](#get-started) · [What is this?](#what-is-this) · [How it works](#how-it-works) · [What you can do](#what-you-can-do) · [Evidence](#evidence-and-benchmarks)



## What is this?

You ask for a small query parser. The assistant reaches for a package, adds helper files, and leaves you more code to maintain. Razor asks whether the language or your project already has what the task needs.

It puts a short checklist before new code and uses targeted checks to prompt reconsideration of unnecessary additions. The aim is to finish the requested work with less to maintain. This example illustrates the workflow; the measurements below describe specific recorded runs.

<p align="center"><img src="assets/mascot.svg" alt="Ember considers additions, learns the Razor checklist and gets to work." width="700"></p>



## Why you'd want it

- Reuse what the project already has.
- Reconsider unnecessary dependencies before installing them.
- Notice file growth before a small task becomes a larger project.
- Find declared dependencies that no source file appears to use.

## How it works

A checklist asks whether the work is needed, already implemented or covered by the language. Targeted checks can request one reconsideration. A retry follows the host’s normal permissions. The unused-dependency audit reports findings without uninstalling anything.

## What you can do

| You want to | Outcome |
| --- | --- |
| Keep a small task small | Check reuse, dependencies and file growth |
| Pause or resume the checks | Change the session toggle |
| Find unused dependencies | Receive a report with confirmed, likely and unknown findings |

## What you can do

| You want to | Outcome |
| --- | --- |
| Keep a small task small | Check reuse, dependencies and file growth |
| Pause or resume the checks | Change the session toggle |
| Find unused dependencies | Receive a report with confirmed, likely and unknown findings |

## Get started

Choose the assistant you use. Its edition page has the installation steps,
commands and compatibility notes for your setup.

| Your assistant | Status | Next step |
| --- | --- | --- |
| Claude Code | Available | [Install and get started](https://github.com/V-Songbird/razor/tree/Claude) |
| Codex | Available | [Install and get started](https://github.com/V-Songbird/razor/tree/Codex) |

## Good to know

Input validation, security and error handling that protects your work remain necessary. Explicitly requested scope stays yours to choose. These checks are advisory, not a security boundary.

## Evidence and benchmarks

<!-- foundry:hero -->
<p align="center"><img src="assets/hero.svg" alt="Razor original product visualization" width="700"></p>

Original Claude Code benchmark visualization. These measurements describe the recorded Claude sessions, not Codex performance. [Evidence and methodology](https://github.com/V-Songbird/foundry/tree/main/docs/razor).

<details>
<summary>Watch the recorded Claude Code demo</summary>

<p align="center"><img src="assets/demo.svg" alt="Recorded Claude Code demonstration of Razor" width="700"></p>

</details>
<!-- /foundry:hero -->

Measurements belong to the model and setup that produced them. Each edition
keeps its own results, limitations and any measurements still missing:

- [Claude Code results and limitations](https://github.com/V-Songbird/razor/tree/Claude#the-numbers)
- [Codex evidence and measurement status](https://github.com/V-Songbird/razor/tree/Codex#the-numbers)

## Going deeper

[Research and validation](https://github.com/V-Songbird/foundry/tree/main/docs/razor) · [Benchmark instruments and retained evidence](https://github.com/V-Songbird/foundry/tree/main/benchmarks/razor) · [Foundry](https://github.com/V-Songbird/foundry)

## License

MIT — see [LICENSE](LICENSE).
