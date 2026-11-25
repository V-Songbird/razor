---
type: knowledge
summary: "How to install Razor in Claude Code, Codex and Antigravity, check that it worked and update it to a new release on each host."
related_files:
  - README.md
  - .claude-plugin/plugin.json
  - plugin.json
---

# Install and update Razor

This page says how to install Razor on each host, how to tell it worked and how to move to a new release. The short form is in the README, under [Install](../../README.md#install).

## Contents

- [Claude Code](#claude-code)
- [Codex](#codex)
- [Antigravity](#antigravity)
- [Update](#update)

## Claude Code

You need Claude Code 2.1.323 or later, Node.js 22 or later, and Git.

Inside Claude Code, run:

```text
/plugin marketplace add V-Songbird/foundry
/plugin install razor@foundry
```

Then start a new session.

To check that it worked, run `claude plugin list` in a terminal. The list names `razor`.

## Codex

You need a Codex host with plugin support, Node.js 22 or later, and Git.

In a terminal, run:

```text
codex plugin marketplace add V-Songbird/foundry
codex plugin add razor@foundry
```

Trust the hooks in your client's review flow. Then start a new session. [Checking a Codex install](how-it-works.md#checking-a-codex-install) says what to watch for.

To check that it worked, run `codex plugin list --marketplace foundry` in a terminal. The list names `razor`.

## Antigravity

You need the Antigravity CLI, Node.js 22 or later, and Git. It has no plugin marketplace, so you install from a Foundry clone. Replace `<path-to-clone>` with a folder of your choice.

In a terminal, run:

```shell
git clone --recurse-submodules https://github.com/V-Songbird/foundry.git <path-to-clone>
agy plugin install <path-to-clone>/razor
agy plugin list
```

Then start a new conversation. The list names `razor` when it worked.

## Update

### Claude Code

In Claude Code, run these. Then start a new session:

```text
/plugin marketplace update foundry
/plugin update razor@foundry
```

### Codex

In Codex, run these. Then start a new session. A changed hook stays off until you trust it again in `/hooks`:

```text
codex plugin marketplace upgrade
codex plugin remove razor@foundry
codex plugin add razor@foundry
```

### Antigravity

In Antigravity, run these. Then start a new conversation:

```shell
git -C <path-to-clone> pull
git -C <path-to-clone> submodule update --init
agy plugin install <path-to-clone>/razor
```
