# Contributing

This plugin is part of the [Foundry Collection](https://github.com/V-Songbird/foundry) and is maintained by a single author. Contributions are welcome in the form of bug reports, suggestions, and pull requests.

---

## Before opening a PR

- Check existing issues first — the problem may already be tracked or intentionally deferred.
- For substantial changes (new skills, significant refactors), open an issue first to align on direction before writing code.

---

## Structure

One package serves Claude Code, Codex and Antigravity.

```
.claude-plugin/
└── plugin.json        # Claude Code metadata, settings and version
.codex-plugin/
└── plugin.json        # Codex metadata and version; points Codex at its hook file
plugin.json             # Antigravity metadata and the same version
hooks.json              # Antigravity event wiring, keyed by the plugin name
AGENTS.md               # contributor rules for every host; CLAUDE.md imports them
LICENSE                 # MIT
README.md               # plain-language intro first, technical depth after
docs/knowledge/         # how it works, settings, Codex setup, benchmark details
                        # and the changelog, dated entries newest first
skills/                 # skills read by every host
├── skill-name/
│   ├── SKILL.md        # skill definition
│   └── references/     # Reference files loaded by the skill
hooks/
├── hooks.json          # Claude Code event wiring
├── codex-hooks.json    # Codex event wiring
├── codex-hook.js       # Codex event entrypoint
├── antigravity-hook.js # Antigravity event entrypoint
└── lib/                # shared runtime and host adapters
scripts/                # helper CLIs
tests/                  # Node tests and hook contract fixtures
```

The README puts plain-language sections first and technical depth behind links, and names the host beside every host-specific instruction and result; [`AGENTS.md`](AGENTS.md) holds those rules.

---

## What to keep in mind

**Skills are instruction files read by every host.** Changes to `SKILL.md` affect how Claude Code, Codex and Antigravity interpret a skill — be precise, and verify the affected skill in a real session of each host before release. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in skill text; Codex and Antigravity do not, so they need a path relative to the skill file.

**Hooks run on matching tool calls and session events.** Keep them fast, keep network calls out, and test on Windows, Linux, and macOS. Shared checks belong outside the host adapters. A new hook event needs an entry in `hooks/hooks.json`, `hooks/codex-hooks.json` and, when Antigravity has the event, the root `hooks.json`; `hooks/antigravity-hook.js` maps that host's three events onto the shared checks.

---

## Tests

If this plugin has scripted behavior, run its tests before submitting:

```
node --test tests/*.test.js
```

CI runs the suite on Windows, Linux, and macOS with Node 22. The suite needs
no dependency installation. On Windows with fnm, initialize Node first:

```powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
node --test tests/*.test.js
```

Run it from a checkout outside your system temp directory. The new-file check
skips temp paths, so its tests fail there.

Include regression coverage for changed script behavior. Hook contract tests
check messages, counters, and file effects in isolated fixtures. They do not
establish that a particular Claude Code, Codex or Antigravity installation has
enabled or trusted the hooks. For Codex, follow [the setup guide](docs/knowledge/codex-setup.md)
for that live check; for Antigravity, `agy plugin validate .` checks the package
shape and a disposable project shows whether the hooks fire.

The recorded Claude Code benchmark data and artwork stay as recorded. Codex
results come from their own runs.

---

## Git hooks

Run this once after cloning:

```
git config core.hooksPath scripts/git-hooks
```

This enables the following commit checks:

- `pre-commit` runs `node --test tests/*.test.js` and blocks the commit on failure. It no-ops if this plugin has no `tests/` directory. It also blocks a commit that stages a `README.md` whose navigation links no longer resolve.
- The three plugins keep byte-identical copies of `pre-commit`; change them together.
- Public source names and attribution are allowed in documentation and commit messages. Keep credentials and personal session data out of commits.

---

## Changelog

Add a dated entry at the top of [`docs/knowledge/changelog.md`](docs/knowledge/changelog.md) for every user-visible change.
The version lives in `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`
and `plugin.json`. Change them together; the test suite fails when they differ.

Installation, marketplace changes, and migration are separate from source
changes. A pull request must not update a contributor's installed plugins or
personal Claude Code, Codex or Antigravity configuration.

---
