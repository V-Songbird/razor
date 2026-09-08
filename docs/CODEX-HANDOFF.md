# Codex setup and implementation handoff

Prepared 2026-09-08. Source: `D:\Projects\Personal\SoftwareDevelopment\claude-plugins\razor`,
exact branch `Codex`. Baseline: `e0cf7ceb4d09efb5ea651555aa8354d03b1c6c2e`
(Claude release 1.5.8). Native package: `.codex-plugin/plugin.json`,
version `1.5.8-codex.1`.

Installation, marketplace registration, hook trust, installed-state migration,
publishing and merging belong to the next session. The parent Foundry
repository and marketplace pins were not edited. The retained
`.claude-plugin/plugin.json` is an archival reference; the native hook wiring
in this branch requires Codex.

## Preserved behavior

The seven-rung checklist and scope-drift instruction are unchanged. The four
gate modules, unused-dependency audit script, thresholds, exemptions and
historical wire goldens are unchanged. Validation at trust boundaries,
data-loss protection, security, accessibility and explicitly requested work
remain protected.

Razor records one reconsideration and lets that dependency's retry follow
normal permissions. Distinct installs in one shell command can each receive
their own nudge. The audit remains report-only with confirmed / likely /
unknown buckets. Historical benchmark results and images retain their
Claude attribution.

## Native adaptation

| Surface | Codex implementation |
| --- | --- |
| Discovery | `.codex-plugin/plugin.json`, `skills/`, default `hooks/hooks.json` |
| Entry point | `node hooks/codex-hook.js <Event>` explicitly selects the native adapter |
| Session | `SessionStart`: startup, resume, clear, compact |
| Subagents | `SubagentStart`; writing/unknown roles get the ladder, read-only roles can skip |
| Tools | Canonical `Bash` and `apply_patch` use `tool_input.command` |
| Patches | Read-only compound patch preview, translated into existing gates |
| Identity | `turn_id`, shared root `session_id`, optional child `agent_id` |
| State | `PLUGIN_DATA`, otherwise `<temp>/razor-codex`; no Claude-state import |
| Settings | Existing `RAZOR_*` variables; no Claude `userConfig` assumptions |
| Stop | Single `decision: "block"` continuation, bounded by `stop_hook_active` |
| Controls | Ordinary messages `razor off/on` and Razor's `unused` skill |
| Windows | `commandWindows` starts PowerShell and initializes fnm when available |

The hooks do not modify project instructions, configuration, manifests or code.
Runtime writes are confined to Razor's state. The Windows safe writer accepts
the native data directory while retaining atomic replacement and symlink refusal.

A compound patch records every applicable gate before emitting the most
specific reason. Added paths are charged once per turn even when a denied
patch is retried. Moves retain source import history while checking the
destination package and test scope; renames do not spend the file budget.

## Runtime and prompt evidence

The inspected npm CLI reports 0.145.0; the desktop executable reports 0.153.4.
Both report stable hooks enabled. These are local observations, not a promise
about every older release.

The desktop app-server accepted all five exact definitions through `hooks/list`,
selected `commandWindows` and returned no parsing warnings/errors. The probe
used a temporary `CODEX_HOME` without installing or trusting user hooks.
It establishes loading and command selection, not installed activation.

Sources:

- [Codex hooks](https://developers.openai.com/codex/hooks)
- [Plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [PreToolUse schema, CLI 0.145.0](https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json)
- [PreToolUse schema, desktop 0.153.4](https://raw.githubusercontent.com/openai/codex/rust-v0.153.4/codex-rs/hooks/schema/generated/pre-tool-use.command.input.schema.json)
- [Native hook construction and child identity](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/hook_runtime.rs#L183)
- [Shared session identity](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/session/session.rs#L570)
- [Stop accepts empty stdout](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/hooks/src/events/stop.rs#L262)

Relevant product-owned templates were inspected with
`codex debug models --bundled`. Their reuse/simplicity guidance supports
retaining the ladder. No model-specific trigger phrase was substituted and no
private conversation instructions were extracted. Template inspection does
not establish model adherence or savings.

## Validation

From the Razor directory:

~~~powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
node --test tests/*.test.js
node benchmarks/runner/run.js --selftest
node scripts/git-hooks/check-readme-nav.js
git diff --check
~~~

The pre-port suite passed 331 tests. Final Windows validation passed all 370 tests (39 added), with no failures or skips. Added tests cover native lifecycle output,
state/toggle isolation, turn/agent identity, settings, compound patches,
dependency retries, file budgets, move scopes, empty manifests, malformed
input and failed Stop-state persistence.

The exact Windows command executed successfully from a plugin path with spaces.
Plugin and skill validators, README navigation and offline benchmark instrument
checks passed. Manifest review found no introduced errors or warnings.
Independent code review produced regression cases for moved dependency scope,
empty requirements updates and failed Stop-state persistence; all are covered.

CI is configured for Node 22 on Windows, Linux and macOS, targeting `main` and
`Codex`. Only Windows execution is claimed locally. Installed activation, live
skill invocation, non-Windows execution and comparative Codex model benchmarks
are not claimed.

## Coverage boundaries

File guards cover previewable local `apply_patch` changes. Fuzzy/ambiguous
context, colliding paths, unsupported remote formats, unreadable/binary input
and shell-wrapped patches abstain. Razor stays silent rather than speculate.

Writes through shell scripts or other editing tools bypass the patch guards.
`write_stdin` does not receive a new `PreToolUse` check. The Git build ledger
can still notice aggregate growth. Razor is advisory, not a security or
permission boundary.

The historical live benchmark runner invokes Claude and refuses this branch's
native Codex hook wiring. Set `RAZOR_DIR` to a separate original Claude checkout
to reproduce Claude runs. Offline selftest, rescoring and reporting still work
here. Codex measurements require a Codex runner and separately recorded results.

## Next session: installation and migration

1. Inspect this branch's latest commit and working tree. Keep the parent
   Foundry pointer and other submodules unchanged unless separately authorized.
2. Use the current Codex installation workflow for the intended source/catalog
   and the native manifest. Do not register the archival Claude manifest as
   the Codex package.
3. Review and trust the exact hooks through the client's supported review flow.
   Installing/enabling a plugin alone does not trust its hooks.
4. Transfer desired `RAZOR_*` preferences explicitly. Map old Claude install
   options to the documented environment controls. Toggles/counters/ledgers
   stay host-local; do not copy transient state blindly into new sessions.
5. Check activation separately in the intended CLI and desktop: startup and
   compacted checklist, writing-agent injection, unnecessary dependency denied
   once then retry, declared-dependency near-miss, import/manifest patch,
   multi-file budget, `razor off/on`, one build-note continuation and a
   report-only `$unused` invocation. Use disposable projects; no real package
   installation is needed to prove a hook decision.
6. Record actual hook delivery to the model. Fixture tests and plugin listings
   do not prove activation. Measure model behavior separately before claiming
   Codex savings.