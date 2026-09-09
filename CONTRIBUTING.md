# Contributing

This plugin is part of the [Foundry Collection](https://github.com/V-Songbird/foundry) and is maintained by a single author. Contributions are welcome in the form of bug reports, suggestions, and pull requests.

---

## Before opening a PR

- Check existing issues first — the problem may already be tracked or intentionally deferred.
- For substantial changes (new skills, significant refactors), open an issue first to align on direction before writing code.

---

## Structure

```
.codex-plugin/
└── plugin.json        # Codex metadata and package version
CHANGELOG.md            # dated entries, newest first
LICENSE                 # MIT
README.md               # plain-language intro first, technical depth after
skills/                 # if the plugin has skills
├── skill-name/
│   ├── SKILL.md        # Codex skill definition
│   └── references/     # Reference files loaded by the skill
hooks/
├── hooks.json          # native Codex event wiring
├── codex-hook.js       # Codex event entrypoint
└── lib/                # shared runtime and host adapters
scripts/                # helper CLIs
tests/                  # Node tests and hook contract fixtures
```

Every README shares one skeleton, tone, and style, defined in foundry's [`.github/PLUGIN_README_TEMPLATE.md`](https://github.com/V-Songbird/foundry/blob/main/.github/PLUGIN_README_TEMPLATE.md).

---

## What to keep in mind

**Skills are Codex-facing instruction files.** Changes to `SKILL.md` affect how Codex interprets a skill — be precise, and verify the affected skill in a real session before release. Resolve bundled scripts relative to the skill file; hook environment variables are not a skill's shell environment.

**Hooks run on matching tool calls and session events.** Keep them fast, keep network calls out, and test on Windows, Linux, and macOS. Shared checks belong outside the Codex event adapter.

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

Include regression coverage for changed script behavior. Hook contract tests
check messages, counters, and file effects in isolated fixtures. They do not
establish that a particular Codex installation has enabled or trusted the
hooks. Follow [the setup guide](docs/SETUP.md) for that live check.

The recorded benchmark data and artwork describe Claude Code. Preserve those
results as recorded; Codex performance comparisons need separate runs.

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
The Codex package version lives in `.codex-plugin/plugin.json`. Keep its
prerelease suffix for Codex-specific releases. The retained Claude manifest
has no version; its historical release numbers belong to the
[foundry](https://github.com/V-Songbird/foundry) listing.

Installation, marketplace changes, and migration are separate from source
changes. A pull request must not update a contributor's installed plugins or
personal Codex configuration.

---

## Code of conduct

This project follows the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md).
