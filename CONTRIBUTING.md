# Contributing

Razor is part of the [Foundry marketplace](https://github.com/V-Songbird/foundry) and has a single maintainer. Contributions are welcome as bug reports, suggestions and pull requests.

One package serves Claude Code, Codex and Antigravity.

---

## Before opening a PR

- Check existing issues first. The problem may already be tracked or deliberately deferred.
- For a substantial change, such as a new skill or a significant refactor, open an issue first to agree on direction.
- Branch from `main` and open the pull request against `main`.

---

## Structure

```text
.claude-plugin/
└── plugin.json          # Claude Code metadata, settings and version
.codex-plugin/
└── plugin.json          # Codex metadata and version; points Codex at its hook file
plugin.json              # Antigravity metadata and the same version
hooks.json               # Antigravity event wiring, keyed by the plugin name
.github/
└── workflows/           # CI
LICENSE                  # MIT
README.md                # the front page: what it is, install, results
CONTRIBUTING.md          # this file
SECURITY.md              # how to report a vulnerability
assets/                  # README art and the icons the manifests name
docs/
└── knowledge/           # how it works, settings and benchmarks pages, with a
                         # published run's per-session results and the script
                         # that prints its table
skills/
└── unused/
    ├── SKILL.md         # the unused-dependency audit, read by every host
    ├── agents/          # Codex display name and default prompt
    └── assets/          # the skill's icons
hooks/
├── hooks.json           # Claude Code event wiring
├── codex-hooks.json     # Codex event wiring
├── codex-hook.js        # Codex event entrypoint
├── antigravity-hook.js  # Antigravity event entrypoint
├── *.js                 # the checks: each gate, the build check, the toggle
├── windows-launcher.ps1 # fallback the Codex hooks use on Windows
└── lib/                 # shared runtime and host adapters
scripts/
├── unused-deps.js       # the audit the unused skill runs
├── build-windows-launchers.js # checks, or with --write regenerates, the
│                        # Windows commands in hooks/codex-hooks.json
└── git-hooks/           # pre-commit and the README navigation check
tests/                   # Node tests and hook contract fixtures
```

The README is the front page. The pages under `docs/knowledge/` hold the detail it links, and a fact lives in one place: the README states the short form and links the page. The README and those pages name the host beside every host-specific instruction and result.

---

## What to keep in mind

**Skills are instruction files read by every host.** Changes to `SKILL.md` affect how Claude Code, Codex and Antigravity interpret a skill. Be precise, and verify the affected skill in a real session of each host before release. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in skill text. Codex and Antigravity do not, so they need a path relative to the skill file.

**Hooks run on matching tool calls and session events.** Keep them fast, keep network calls out, and test on Windows, Linux and macOS. Shared checks belong outside the host adapters.

**Hook registration lives in three files.** A new hook event needs an entry in `hooks/hooks.json` and `hooks/codex-hooks.json`. When Antigravity has the event, it also needs one in the root `hooks.json`. `hooks/antigravity-hook.js` maps that host's three events onto the shared checks. After changing `hooks/codex-hooks.json`, run `node scripts/build-windows-launchers.js --write` so each Windows command matches. Without `--write`, the script only checks.

**Published figures follow one rule.** Each result names its host, model, date and sample size. Losses and limits stay, a host with no results shows `Not measured`, and a result from one host never stands for another. A published figure stays as recorded, and each host's results come from that host's own runs.

---

## Tests

Run the tests before submitting:

```bash
node --test tests/*.test.js
```

A pull request that changes behavior without updating its tests is not merged. Include regression coverage for changed script behavior.

CI runs the suite on Windows, Linux and macOS with Node 22. The suite needs no dependency installation. On Windows with fnm, initialize Node first:

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
node --test tests/*.test.js
```

Run the suite from a checkout outside your system temp directory. The new-file check skips temp paths, so its tests fail there.

Each hook or shell the suite starts gets 90 seconds, so the suite still passes while other suites run on the same machine, and a hung hook still fails. To allow more, set `RAZOR_TEST_SPAWN_TIMEOUT_MS`, for example to `180000`. A value below 90000 is ignored.

The suite also fixes `RAZOR_GIT_TIMEOUT_MS` at 10000 for itself and every hook it starts, so a slow `git` cannot drop the build check's starting point. Exporting another value does not reach the suite.

The suite ignores inherited `RAZOR_*`, `CLAUDE_PLUGIN_*` and `PLUGIN_DATA` variables, so exported settings do not change results. It runs in one private temporary folder per process, which it removes at exit.

Hook contract tests check messages, counters and file effects in isolated fixtures. They do not establish that a particular Claude Code, Codex or Antigravity installation has enabled or trusted the hooks.

Validate the package for each host when you can:

- **Claude Code:** `claude plugin validate .`.
- **Codex:** follow [the README's Codex steps](README.md#codex) for the live check that the hooks are trusted and fire.
- **Antigravity:** `agy plugin validate .` checks the package shape, and a disposable project shows whether the hooks fire.

---

## Git hooks

Run this once after cloning:

```bash
git config core.hooksPath scripts/git-hooks
```

This enables a `pre-commit` hook that runs `node --test tests/*.test.js` and blocks the commit on failure. It also blocks a commit that stages a Markdown file while the root `README.md` lacks its navigation line, or while a link to a heading anchor in any tracked Markdown file no longer resolves. CI runs the same anchor check.

Every Foundry plugin keeps byte-identical copies of the commit gates under `scripts/git-hooks/` and of the tests that cover them. A change to one goes into all of them.

Public source names and attribution are allowed in documentation and commit messages. Keep credentials and personal session data out of commits.

---

## Release notes

Release notes live on the [releases page](https://github.com/V-Songbird/razor/releases). Describe every user-visible change in your pull request, so it can go into the next release's notes.

The version lives in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json` and `plugin.json`. Change them together; the test suite fails when they differ.

A pull request never changes a contributor's installed plugins or personal configuration.

---

## Code of conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). To report behavior that goes against it, contact the maintainer privately through the address in [SECURITY.md](SECURITY.md).
