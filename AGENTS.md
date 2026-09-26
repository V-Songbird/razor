# razor

razor is one plugin for Claude Code, Codex and Antigravity: a checklist before new code and a
few checks behind it, so a small task stays small. Its hooks and scripts are dependency-free Node.js and run
with Node.js 22 or later and Git; there is no install or build step. This repository is Foundry's
razor submodule and ships from `main`.

## Start here

- Before changing a check, read [how razor works](docs/knowledge/how-it-works.md); each check speaks at most once and the retry always goes through.
- Before adding or renaming a setting, read [settings](docs/knowledge/settings.md).
- Before touching Codex behavior, read [the Codex setup guide](docs/knowledge/codex-setup.md); patch guards only see previewable local `apply_patch` changes.
- Before touching a README number, read [the numbers](docs/knowledge/benchmarks.md).
- Before a release, read [the changelog](docs/knowledge/changelog.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Rules that outrank everything

- One package serves the three hosts. Shared checks live outside the host adapters, and a new hook event needs an entry in `hooks/hooks.json`, `hooks/codex-hooks.json` and, when Antigravity has the event, the root `hooks.json`.
- The three manifests, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `plugin.json`, carry the same version, changed together; the suite fails when they differ. Foundry's catalogs carry no version for razor and only move `source.sha`.
- razor never edits code, manifests or lockfiles and never grants a permission; every check is a message to the assistant.

## Commands

| Command | Purpose | Cost |
| --- | --- | --- |
| `node --test tests/*.test.js` | The suite | Local fixtures inside the plugin root; fails from a checkout under the system temp directory |
| `node scripts/git-hooks/check-readme-nav.js` | The root README has its nav, and every heading anchor linked from a tracked Markdown file resolves | Local |
| `node scripts/build-windows-launchers.js --write` | After editing `hooks/windows-launcher.ps1` or a hook in `hooks/codex-hooks.json`, regenerate that file's `commandWindows` launchers; the suite fails naming the first stale one | Local |
| `claude plugin validate .` | Claude Code package shape | Local |
| `agy plugin validate .` | Antigravity package shape | Local; needs the Antigravity CLI |
| `git config core.hooksPath scripts/git-hooks` | One-time: the pre-commit hook runs the suite and the nav check | Local |

## Where things live

| Path | Content |
| --- | --- |
| `hooks/` | `pre-tool-use.js` runs `dep-guard.js`, `import-guard.js`, `manifest-guard.js` and `file-meter.js`; `build-ledger.js`, `mode-toggle.js`, `session-start.js` and `subagent-start.js` cover the other events; `codex-hook.js` and `antigravity-hook.js` translate those hosts' events; `razor-lib.js` and `lib/` hold the shared state and the three host adapters; `windows-launcher.ps1` is the source of each `commandWindows` in `codex-hooks.json` |
| `scripts/unused-deps.js` | The scanner behind the `unused` skill; `scripts/build-windows-launchers.js` builds and checks the Windows launchers; `scripts/git-hooks/` holds the commit gates |
| `skills/unused/` | The one skill |
| `tests/` | The `node:test` suite and the `contract/` fixtures |
| `docs/knowledge/` | How it works, settings, Codex setup, benchmark details and the changelog |
| `.claude-plugin/`, `.codex-plugin/`, `plugin.json`, `hooks.json` | Host manifests with the same version; the Codex manifest names `hooks/codex-hooks.json`, and the root manifest and `hooks.json` are what Antigravity reads |

## Conventions

The README serves every host and names the host beside every host-specific instruction and
result. Results identify the actual host, model, source and date; keep losses and limits, show
`Not measured` where evidence is absent, and never present a Claude Code result as a Codex
result. Benchmark runners, datasets and experiments are not part of the package; `tests/` holds
functional tests only. `CLAUDE.md` imports this file; keep shared contributor facts here.

## Pitfalls

- **Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in skill text; Codex and Antigravity do not.** They need a path relative to the skill file.
- **`tests/dispatcher.test.js` and `tests/contract.test.js` build workspaces inside the plugin root.** `disp-ws-*/` and `contract-ws-*/` residue from a failed run is ignored, never staged.
- **Files written by a shell command skip the file checks in every host.** Only the assistant's own editing tool passes through them.
- **Antigravity has no session, prompt or subagent event.** An injected message reaches only the model call it rides, so the ladder and the drift note ride every call, except that the calls answering the build check carry no drift note, the ledger baseline only the first call of a conversation, and the toggle and the subagent checklist do not exist there; a turn starts at the call whose `invocationNum` is 0, so a Stop continuation stays in its turn and a turn with no Stop still ends.
