---
type: knowledge
summary: "Every current limit of Razor and what it means for a user: advice not enforcement, which tools the file checks see, patches Codex skips, the build check's reach, the audit's blind spots and Antigravity's differences."
related_files:
  - README.md
  - hooks/hooks.json
---

# Razor limits

This page lists every current limit of Razor and what it means for you. The README names the four that matter most, under [Good to know](../../README.md#good-to-know).

**Razor advises; it does not enforce.** These checks are not a security boundary.

| Limit | What it means for you |
| --- | --- |
| Your safeguards stay yours | Input validation, security and error handling that protects your work remain necessary. Scope you asked for explicitly stays yours to choose. |
| File checks see one tool | They see only `Write` and `Edit` in Claude Code, `apply_patch` in Codex, and Antigravity's file write and edit tools. |
| Shell-written files skip the file checks | This holds on every host. Shell commands are still checked for dependency installs, and the build check can still notice the growth. |
| Codex stays silent on some patches | A patch that needs fuzzy matching, has ambiguous context or colliding paths, or targets remote, unreadable or binary content. `write_stdin` gets no check. |
| The build check reads the whole working tree | Another session or tool writing in the same checkout can make it fire. Edits inside parts of a file already changed at session start are only approximated. |
| The audit cannot follow names built at runtime | "Confirmed unused" is not a promise that nothing loads the package. |
| The scope-drift note can miss a drift | It adds one line, at most once a session, and never blocks or asks. |
| Antigravity sends the checklist with every model call | Its subagents receive no checklist. |
