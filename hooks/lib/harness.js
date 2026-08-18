'use strict';

// The harness boundary: the only file that knows how this host talks to a
// hook. How input arrives, what shape output must take for each event, where
// settings and state live, and how a turn and a subagent are identified.
//
// Everything above this file is pure razor logic — gates, budgets, the
// ladder. Nothing there reads process.stdin, writes process.stdout, or names
// a host-specific field. Porting razor to another host means writing a second
// file with this surface, not touching a gate.

const fs = require('fs');
const os = require('os');

// ---- input ----

// Hook payloads arrive as one JSON object on fd 0. A malformed or empty
// payload is not worth crashing over: an empty object makes every gate
// no-op, which is the fail-safe direction.
function readInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf-8') || '{}');
  } catch {
    return {};
  }
}

// ---- output ----

// This host is not symmetric about hook output. SessionStart and
// UserPromptSubmit take raw stdout as context. SubagentStart DROPS raw
// stdout and requires the envelope; Stop requires it too. Getting this
// backwards fails silently — the hook runs, exits 0, and injects nothing.
const RAW_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

function emitContext(event, text) {
  if (!text) return;
  if (RAW_CONTEXT_EVENTS.has(event)) {
    process.stdout.write(text);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: text },
    })
  );
}

// A deny is one forced reconsideration, never a block: the retry always
// passes. razor never emits "ask" — that would interrupt the user.
function emitDeny(event, reason) {
  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

// ---- settings ----

// Settings resolve in order: explicit RAZOR_* env var, then the plugin
// option set at enable time (CLAUDE_PLUGIN_OPTION_*, uppercased by the
// host), then the built-in default.
function settingOff(name) {
  const env = process.env[`RAZOR_${name}`];
  if (env !== undefined && env !== '') return env === 'off';
  return process.env[`CLAUDE_PLUGIN_OPTION_${name}`] === 'false';
}

function settingNumber(name, fallback) {
  const env = process.env[`RAZOR_${name}`];
  const raw = env !== undefined && env !== '' ? env : process.env[`CLAUDE_PLUGIN_OPTION_${name}`];
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// True when the setting was named explicitly rather than left at its
// default — the difference between "the operator chose this ceiling" and
// "razor picked one".
function settingGiven(name) {
  const env = process.env[`RAZOR_${name}`];
  if (env !== undefined && env !== '') return true;
  const opt = process.env[`CLAUDE_PLUGIN_OPTION_${name}`];
  return opt !== undefined && opt !== '';
}

// ---- state location ----

// State lives in the plugin's persistent data directory when the host
// provides one (tmp cleaners can't re-arm fired gates mid-session there);
// tmpdir is the fallback.
function stateDir() {
  const dir = process.env.CLAUDE_PLUGIN_DATA;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      /* unwritable — fall through to tmpdir */
    }
  }
  return os.tmpdir();
}

// ---- identity ----

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
  // Host-injected continuations (task notifications, scheduled wakeups)
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
// the transcript tail. The fallback for hosts that don't send prompt_id.
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

// Turn key for per-turn budgets: the host provides prompt_id on tool events
// (one uuid per user turn); the transcript tail is the fallback.
function turnKey(data) {
  return data.prompt_id || currentTurnKey(data.transcript_path);
}

// Gate state is namespaced per subagent: tool calls made inside a subagent
// carry agent_id, and its budgets must not share the main thread's meters —
// an exploration agent's searches aren't the main session's re-verification
// reflex. The /razor toggle stays session-wide (read from the plain
// session_id state).
function gateStateId(data) {
  return data.agent_id ? `${data.session_id || 'unknown'}--${data.agent_id}` : data.session_id;
}

module.exports = {
  readInput,
  emitContext,
  emitDeny,
  settingOff,
  settingNumber,
  settingGiven,
  stateDir,
  isRealUserPrompt,
  currentTurnKey,
  turnKey,
  gateStateId,
};
