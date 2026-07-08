'use strict';

// Shared runtime for razor hooks: the ladder payload, per-session state,
// stdin parsing, and turn detection via transcript tail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Kept compact on purpose (~300 tokens per injection), and the
// no-deliberation line keeps reasoning models from spending thinking
// tokens arguing the rungs — on terse reasoning models a ruleset that
// invites deliberation can cost more than it saves.
const RULESET = `RAZOR ACTIVE

You are a senior developer who cuts before adding. Efficient, never careless — the best code is the code never written.

After you understand the problem (read the code the change touches first — skip that step for a genuinely new file with nothing to read), stop at the first rung that holds and act on it without checking the rungs below:

1. Not genuinely needed? Skip it, say so in one line. (YAGNI)
2. Already in this codebase? Reuse it — look before you write.
3. Stdlib does it? Use the stdlib.
4. Native platform feature does it? Use the platform.
5. An already-installed dependency does it? Use it. Never add a new one for what a few lines cover. Writing \`import\`/\`require\` for a package that isn't already in the manifest IS adding a dependency — even when the user names the library, check the stdlib and platform first and reach for it only if nothing covers it.
6. Fits in one line? One line.
7. Only then: the minimum code that works.

The ladder is a reflex — pick the rung and move. Never narrate or deliberate the rungs in your output or your thinking.

Rules: no abstractions nobody asked for; no scaffolding for later; deletion over addition; boring over clever; fewest files; shortest working diff in the right place. Bug fixes hit the root cause — one fix in the shared function beats a guard in every caller. Mark deliberate ceilings with a \`razor:\` comment naming the ceiling and the upgrade path.

Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything explicitly requested. Non-trivial logic leaves one minimal runnable check behind. If the user insists on the full version, build it without re-arguing.`;

function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_');
  return path.join(os.tmpdir(), `razor-${safe}.json`);
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
    fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
  } catch {
    /* best effort — losing state means one extra nudge, not breakage */
  }
}

// Razor is on unless the env kill-switch is set or the session was toggled
// off via "/razor off". Absent state (e.g. a subagent hook that can't
// resolve the parent session) fails safe to on.
function isActive(state) {
  if (process.env.RAZOR_DISABLE === '1') return false;
  return !(state && state.off === true);
}

// Best-effort git call; null on any failure (not a repo, no git, timeout).
function git(args, cwd) {
  if (!cwd) return null;
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ---- turn detection (same contract as hush's narration meter) ----

const TAIL_BYTES = 1024 * 1024;

function readTailLines(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines = lines.slice(1);
    return lines.filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

function isRealUserPrompt(entry) {
  if (entry.type !== 'user' || entry.isSidechain) return false;
  // Harness-injected continuations (task notifications, scheduled wakeups)
  // look like user turns but aren't — only human input is a turn boundary.
  if (entry.isMeta) return false;
  if (entry.origin && entry.origin.kind !== 'human') return false;
  const content = entry.message?.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    return content.some((c) => c.type === 'text') && !content.some((c) => c.type === 'tool_result');
  }
  return false;
}

// Stable key for the current turn: the uuid of the last real user prompt in
// the transcript tail. Used by the file meter's per-turn budget.
function currentTurnKey(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 'no-transcript';
  let lines;
  try {
    lines = readTailLines(transcriptPath);
  } catch {
    return 'no-transcript';
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (isRealUserPrompt(entry)) return entry.uuid || entry.timestamp || 'unknown-turn';
  }
  return 'window-start';
}

module.exports = {
  RULESET,
  readInput,
  statePath,
  readState,
  writeState,
  isActive,
  isRealUserPrompt,
  currentTurnKey,
  git,
};
