# Contributing

This plugin is part of the [Foundry Collection](https://github.com/V-Songbird/foundry) and is maintained by a single author. Contributions are welcome in the form of bug reports, suggestions, and pull requests.

---

## Before opening a PR

- Check existing issues first — the problem may already be tracked or intentionally deferred.
- For substantial changes (new skills, significant refactors), open an issue first to align on direction before writing code.

---

## Structure

One package serves Claude Code and Codex.

```
.claude-plugin/
└── plugin.json        # Claude Code metadata, settings and version
.codex-plugin/
└── plugin.json        # Codex metadata and version; points Codex at its hook file
CHANGELOG.md            # dated entries, newest first
LICENSE                 # MIT
README.md               # plain-language intro first, technical depth after
skills/                 # skills read by both hosts
├── skill-name/
│   ├── SKILL.md        # skill definition
│   └── references/     # Reference files loaded by the skill
hooks/
├── hooks.json          # Claude Code event wiring
├── codex-hooks.json    # Codex event wiring
├── codex-hook.js       # Codex event entrypoint
└── lib/                # shared runtime and host adapters
scripts/                # helper CLIs
tests/                  # Node tests and hook contract fixtures
```

Every README shares one skeleton, tone, and style, defined in foundry's [`.github/PLUGIN_README_TEMPLATE.md`](https://github.com/V-Songbird/foundry/blob/main/.github/PLUGIN_README_TEMPLATE.md).

---

## What to keep in mind

**Skills are instruction files read by both hosts.** Changes to `SKILL.md` affect how Claude Code and Codex interpret a skill — be precise, and verify the affected skill in a real session of each host before release. Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` in skill text; Codex does not, so Codex needs a path relative to the skill file.

**Hooks run on matching tool calls and session events.** Keep them fast, keep network calls out, and test on Windows, Linux, and macOS. Shared checks belong outside the host adapters. A new hook event needs an entry in both `hooks/hooks.json` and `hooks/codex-hooks.json`.

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
establish that a particular Claude Code or Codex installation has enabled or
trusted the hooks. For Codex, follow [the setup guide](docs/SETUP.md) for that
live check.

The recorded Claude Code benchmark data and artwork stay as recorded. Codex
results come from their own runs.

---

## Git hooks

Run this once after cloning:

```
git config core.hooksPath scripts/git-hooks
```

This enables the following commit checks:

- `pre-commit` runs `node --test tests/*.test.js` and blocks the commit on failure. It no-ops if this plugin has no `tests/` directory.
- Public source names and attribution are allowed in documentation and commit messages. Keep credentials and personal session data out of commits.

---

## Changelog

Add a dated entry at the top of `CHANGELOG.md` for every user-visible change.
The version lives in both `.claude-plugin/plugin.json` and
`.codex-plugin/plugin.json`. Change them together; the test suite fails when
they differ.

Installation, marketplace changes, and migration are separate from source
changes. A pull request must not update a contributor's installed plugins or
personal Claude Code or Codex configuration.

---
