---
name: razor-unused
description: Audits a project's manifest for dependencies no source file imports — the reverse of razor's write-time gates (which block NEW dependencies), this finds EXISTING dead weight. Report-only; never edits any file.
when_to_use: Trigger when the user wants to find unused dependencies, says "find unused deps", "audit dependencies", "what deps aren't used", "check for dead dependencies", or invokes /razor:unused.
argument-hint: "[project directory, defaults to cwd]"
allowed-tools: Bash, PowerShell, Read
---

# razor:unused

Runs a mechanical audit — declared dependencies (`package.json`, `requirements.txt`/`pyproject.toml`) with no matching import anywhere in the project's source — and presents the findings. Never removes a dependency itself; the user decides.

## 1. Run the script

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/unused-deps.js" <projectDir>
```

Default `<projectDir>` to the current working directory if the user didn't name one. The script:
- reads declared deps for whichever ecosystems have a manifest present (node, python — the ecosystems razor's gates already cover),
- walks source files (skipping `node_modules`, `dist`, `.git`, and other generated/vendored dirs; test files ARE included — a test-only import still counts as used),
- normalizes declared names against import roots in the suppressing direction (e.g. `python-dotenv` counts as used when the code imports `dotenv`) — a false "unused" is the failure mode the script avoids, not the one it risks,
- splits misses into two buckets: **unused** (no mention anywhere) and **possibly used outside imports** (the name turns up in `package.json` scripts or a root config file — eslint/babel/webpack/vite/jest/etc. — meaning it's likely invoked as a CLI tool or plugin, not imported).

## 2. Present the findings

Report the **unused** bucket as the actual findings — these are high-confidence. Report the **possibly used** bucket separately, each one marked `(check)`, and say why: the name showed up outside any import (a script or config reference) so removing it needs a manual look, not a mechanical one.

Favor fewer, high-confidence findings over a long speculative list — if the unused bucket is empty, say so plainly rather than padding the report with the possibly-used bucket dressed up as findings.

Always include the script's known-limits line verbatim (static import scanning can't see `import(variable)`, runtime `require()`-by-string, or CLI tools invoked via `npx`/`exec`) so the user knows what a clean report doesn't guarantee.

## 3. Never remove anything

This skill is report-only. Do not edit `package.json`, `requirements.txt`, `pyproject.toml`, or run an uninstall command as part of this skill, even if the user's phrasing sounds like a request to clean up — surface the findings and let the user decide what to remove.
