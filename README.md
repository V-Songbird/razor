<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg" />
    <img src="assets/logo.svg" alt="razor" width="240" />
  </picture>
  <h1>razor</h1>
  <p><strong>Before adding code, ask whether the project already has what it needs.</strong></p>
</div>

**Choose your edition: [Claude Code](https://github.com/V-Songbird/razor/tree/Claude) · [Codex](https://github.com/V-Songbird/razor/tree/Codex)**

[**Get started**](#get-started) · [What is this?](#what-is-this) · [How it works](#how-it-works) · [What you can do](#what-you-can-do) · [Evidence](#evidence-and-benchmarks)

> **TL;DR** — Before adding code, ask whether the project already has what it needs.

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

## Get started

Choose the assistant you use. Its edition page has the installation steps,
commands and compatibility notes for your setup.

| Your assistant | Status | Next step |
| --- | --- | --- |
| Claude Code | Available | [Install and get started](https://github.com/V-Songbird/razor/tree/Claude) |
| Codex | Available | [Install and get started](https://github.com/V-Songbird/razor/tree/Codex) |

## What you can do

| You want to | Outcome |
| --- | --- |
| Keep a small task small | Check reuse, dependencies and file growth |
| Pause or resume the checks | Change the session toggle |
| Find unused dependencies | Receive a report with confirmed, likely and unknown findings |

## Good to know

Input validation, security and error handling that protects your work remain necessary. Explicitly requested scope stays yours to choose. These checks are advisory, not a security boundary.

## Evidence and benchmarks

Measurements belong to the model and setup that produced them. Each edition
keeps its own results, limitations and any measurements still missing:

- [Claude Code results and limitations](https://github.com/V-Songbird/razor/tree/Claude#the-numbers)
- [Codex evidence and measurement status](https://github.com/V-Songbird/razor/tree/Codex#the-numbers)

## Going deeper

[Research and validation](https://github.com/V-Songbird/foundry/tree/main/docs/razor) · [Benchmark instruments and retained evidence](https://github.com/V-Songbird/foundry/tree/main/benchmarks/razor) · [Foundry](https://github.com/V-Songbird/foundry)

## License

MIT — see [LICENSE](LICENSE).
