---
name: unused
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
- reads declared deps for whichever ecosystems have a manifest present (node, python — the ecosystems razor's write-time import gate covers),
- walks source files (skipping `node_modules`, `dist`, `.git`, and other generated/vendored dirs; test files ARE included — a test-only import still counts as used),
- counts type-only imports and imports living in `.vue`/`.svelte`/`.astro`/`.mdx` source as real usage,
- audits each workspace package of a monorepo against its own manifest and its own files, never the root's,
- honours the ignore list the project already declares for its own resolver, so a dependency you already answered for is not asked about again,
- normalizes declared names against import roots in the suppressing direction (e.g. `python-dotenv` counts as used when the code imports `dotenv`, `pillow` when it imports `PIL`) — normalization only ever hides a finding, never invents one; the blind spots that remain are named in the script's known-limits line,
- splits misses into **three** buckets by how much could actually be proved.

The three buckets, and what separates them:

| Bucket | What it means |
| --- | --- |
| **Confirmed unused** | The installed tree was read: no import, the package ships no command, and no installed package peer-requires it. Only possible when dependencies are installed. |
| **Likely unused** | Nothing referenced it, but nothing could prove it — no installed tree to read, or a python project, where no package metadata was available. A lead, not a verdict. |
| **Unknown** | Something references it, or only a resolver can settle it: named in a script or config file, a `@types/*`/toolchain dep, a package that ships a command, or one that satisfies another package's peer dependency. |

For a node project, the script also detects whether **knip** is installed or resolvable from the target project. It resolves what this audit still cannot: entry-point reachability, config-only plugin loading, and true `@types` pairing. When knip is present, the report names it as the authoritative escalation for those classes. When it isn't, the report says nothing about it — razor never suggests installing a new tool into the target project.

## 2. Present the findings

Lead with **Confirmed unused** — that is the bucket a resolver checked. Report **Likely unused** as leads, and say plainly why they are only leads: nothing referenced them and nothing proved it. Report **Unknown** separately with the reason the script printed for each.

Never describe a likely-unused or unknown entry as high confidence — if no resolver ran, the report does not claim one did. If the confirmed bucket is empty, say so plainly rather than promoting the other two buckets to fill the space.

If the script's output names knip as available, relay that escalation verbatim (including the `npx knip` command it prints) — do not run knip yourself, install it, or add it to any manifest; it stays the user's call.

Always include the script's known-limits line verbatim, so the user knows what a clean report doesn't guarantee.

## 3. Never remove anything

This skill is report-only. Do not edit `package.json`, `requirements.txt`, `pyproject.toml`, or run an uninstall command as part of this skill, even if the user's phrasing sounds like a request to clean up — surface the findings and let the user decide what to remove.
