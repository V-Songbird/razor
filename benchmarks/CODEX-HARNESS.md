# Codex headless comparison

The native runner compares the same task seeds with Razor enabled and disabled,
using the same explicit model, reasoning effort and permissions. It runs the
13 original tasks, four counter-examples where adding code is necessary, and
two multi-turn conversations. Arms are shuffled within each task/repetition.

From the plugin directory, run:

~~~powershell
fnm env --use-on-cd | Out-String | Invoke-Expression
node benchmarks/runner/codex-run.js --codex-bin "<absolute path to codex.exe>" --model gpt-5.6-sol --effort high --suite all --runs 2 --workers 2 --seed razor-sol-paired-20260908 --report benchmarks/results/codex-sol-high-paired.md
~~~

Use a native executable path on Windows rather than a PowerShell/npm command
shim. On Unix, an executable on PATH also works. The tested Windows runtime is
Codex 0.153.4. The account must already be signed in.

The runner first verifies native activation with a package-manager no-op:
baseline executes it directly; Razor must deny it once, then permit its retry.
An activation failure stops the comparison. No packages are actually installed.

Each session runs in a disposable project. A temporary Codex home holds the
authentication copy, hooks, session history and logs. The original user config
is untouched. Hook trust is bypassed only for the exact vetted benchmark hook
definitions; tool approval still uses Codex's automatic review and a
`workspace-write` sandbox. Windows selects the restricted unelevated sandbox.
Other plugins, memories, skills and browsing are disabled equally in both arms.

`--suite full|counter|note|all` chooses a group; `--tasks a,b` chooses tasks.
`--probe` runs activation only, `--smoke` adds one small task per arm, and
`--selftest` checks the original instruments offline. Unknown options are
rejected. `--help` explains the command without starting a model.

Every completed cell is checkpointed before its project is deleted. Resume
only pending cells with the same model, effort, seed, repetition count, Codex
runtime, source revision and instrument fingerprints. Incompatible checkpoints
are rejected before starting a model. Successful complete runs remove their
intermediate checkpoint. To resume:

~~~powershell
node benchmarks/runner/codex-run.js --codex-bin "<absolute path to codex.exe>" --model gpt-5.6-sol --effort high --suite all --runs 2 --seed razor-sol-paired-20260908 --resume-report benchmarks/results/codex-sol-high-paired.checkpoint.json --report benchmarks/results/codex-sol-high-paired.md
~~~

For a safe pause, create a file named `PAUSE` in the printed run root. The
runner finishes active cells, saves their measurements, and starts no more.
Avoid killing its console: Windows can terminate a parent before `finally`
runs. On resume, completed cells are never sampled again.

The output is a Markdown report and JSON measurements. Code files, local
package-manager shims, Razor state, raw events, logs, session history and the
temporary authentication copy are deleted even when a cell fails. Only derived
scores, counts, API references and paired text-equality results survive. No
generated code or credentials belong in a report or commit.

Interpret the measures separately:

- Correctness and safety use the original executable task scorers.
- LOC counts physical added lines against seeded HEAD for Git fixtures and
  source inventory for other fixtures. It does not measure semantic complexity
  or readability. No-code tasks retain their original zero-LOC convention.
- Editing observations compare final source against the original seed and
  record API references and dependency changes. Text equality is textual,
  not a proof of functional equivalence.
- Token totals are the last cumulative thread snapshot, including after resume.
  Input plus output is the total; cached input and reasoning output are subsets
  and are never counted twice. Separate approval-review threads are not included.
  Dollar cost is unavailable.
- Timing includes the native hook observer's process overhead and automatic
  approval review. Both arms use the same approval policy.
- Efficiency ratios include only matching task/model/repetition pairs where
  both arms pass correctness and safety. Runtime failures remain visible.
- A small run is exploratory; measured differences can vary on repetition.

The native runner adapts the headless transport, not the historical task
scorers. It allows shell reads in both arms because Codex uses shell tools to
inspect source; non-shell coding tasks receive the same original instruction
to write code without running it. Two-turn cases resume the exact session ID.

Conversation notes are scored as rendered text: absolute Markdown file-link
destinations are removed while their visible labels and narrative remain.
A directory named `note-drift` is not itself a note to the user.

Native functional checks are separate from the comparison:

~~~powershell
node benchmarks/runner/codex-parity.js --codex-bin "<absolute path to codex.exe>" --model gpt-5.6-sol --effort high --report benchmarks/results/codex-sol-high-parity.json
~~~

They cover imports, manifests, file budgets, on/off with resume, the once-only
ledger and writing/read-only subagents. The subagent probe declares a role
description in its temporary Codex config so the CLI exposes `agent_type`.
Model identity comes from native child metadata, not model self-report.

Reports stay local under benchmarks/results/; they are not published with the harness.
