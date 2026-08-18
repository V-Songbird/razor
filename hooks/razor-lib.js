'use strict';

// Shared runtime for razor hooks: the ladder payload, per-session state, and
// the toggle. Everything host-specific — reading stdin, shaping stdout,
// resolving settings, locating state, identifying a turn — lives behind
// lib/harness.js, and is re-exported here so hooks and tests keep one import.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { safeWriteFileSync } = require('./lib/safe-write');
const harness = require('./lib/harness');

// Kept compact on purpose (~300 tokens per injection), and the
// no-deliberation line keeps reasoning models from spending thinking
// tokens arguing the rungs — on terse reasoning models a ruleset that
// invites deliberation can cost more than it saves.
const RULESET = `RAZOR ACTIVE

You are a senior developer who cuts before adding. Efficient, never careless — the best code is the code never written.

After you understand the problem (read the code the change touches first — skip that step for a genuinely new file with nothing to read), stop at the first rung that holds and act on it without checking the rungs below:

1. Not genuinely needed? Skip it, say so in one line. (YAGNI)
2. Already in this codebase? One search for it — reuse a hit, or move on the instant it comes up empty.
3. Stdlib does it? Use the stdlib.
4. Native platform feature does it? Use the platform.
5. An already-installed dependency does it? Use it. Never add a new one for what a few lines cover. Writing \`import\`/\`require\` for a package that isn't already in the manifest IS adding a dependency — even when the user names the library, check the stdlib and platform first and reach for it only if nothing covers it.
6. Fits in one line? One line.
7. Only then: the minimum code that works, in as few statements.

The ladder is a reflex — pick the rung and move: act on it in this same response, even when it differs from what the user named — ship the rung's version and note the swap in one line. Never narrate or deliberate the rungs in your output or your thinking. One check is enough, anywhere in this task — a search, a manifest read, a file-existence check, a convention scan. If it already came back empty, or a tool error already told you what to do, act on that; don't re-verify or broaden it.

Rules: no abstractions nobody asked for; no scaffolding for later; deletion over addition; boring over clever; fewest files; shortest working diff in the right place. Bug fixes hit the root cause — one fix in the shared function beats a guard in every caller.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything explicitly requested. If the user insists on the full version, build it without re-arguing.`;

function safeId(id) {
  return String(id || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
}

function statePath(sessionId) {
  return path.join(harness.stateDir(), `razor-${safeId(sessionId)}.json`);
}

// State files are swept by age alone — a session's file must outlive the
// session so a later --resume still sees its /razor off toggle.
const GC_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function gcStateFiles() {
  const dir = harness.stateDir();
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - GC_AGE_MS;
  for (const name of names) {
    if (!/^razor-.*\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {
      /* best effort */
    }
  }
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf-8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  try {
    safeWriteFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    /* best effort — losing state means one extra nudge, not breakage */
  }
}

// The env kill-switch. Separate from isActive because the toggle hook must
// stay silent under it while still honouring "/razor on" in an ordinary
// session that was toggled off.
function killed() {
  return process.env.RAZOR_DISABLE === '1';
}

// Razor is on unless the env kill-switch is set or the session was toggled
// off via "/razor off". Absent state (e.g. a subagent hook that can't
// resolve the parent session) fails safe to on.
function isActive(state) {
  if (killed()) return false;
  return !(state && state.off === true);
}

// Best-effort git call; null on any failure (not a repo, no git, timeout).
// The per-call budget is deliberately small: SessionStart makes four of these
// and Stop three, and every one of them has to finish inside the hook timeout
// declared in hooks.json or the harness kills the process mid-work.
function git(args, cwd) {
  if (!cwd) return null;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

module.exports = {
  RULESET,
  gcStateFiles,
  readState,
  writeState,
  isActive,
  killed,
  git,
  // Re-exported from the harness boundary so no gate imports it directly.
  readInput: harness.readInput,
  emitContext: harness.emitContext,
  emitDeny: harness.emitDeny,
  settingOff: harness.settingOff,
  settingNumber: harness.settingNumber,
  settingGiven: harness.settingGiven,
  isRealUserPrompt: harness.isRealUserPrompt,
  turnKey: harness.turnKey,
  gateStateId: harness.gateStateId,
};
