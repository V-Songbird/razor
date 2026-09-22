'use strict';

// Antigravity wire adapter. ./harness is the Claude Code adapter; this module
// replaces what Antigravity's hook contract does differently: the call is
// nested under `toolCall` with PascalCase arguments, every hook run answers
// with one JSON object — a bare allow or deny for PreToolUse, `injectSteps`
// for PreInvocation, a `continue` decision for Stop — and there is no prompt,
// subagent or plugin data directory. hooks/antigravity-hook.js selects this
// file through RAZOR_HOST and flushes the buffered answer once its event ran.
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('./harness');

// Antigravity's tool names and arguments, read into the shape the gates
// already speak. A multi-chunk edit is one Edit whose old and new text are the
// chunks joined, which is all the import and manifest guards compare. Any
// other tool passes through unchanged and matches no gate.
const TOOLS = {
  run_command: (args) => ({ tool_name: 'Bash', tool_input: { command: args.CommandLine || '' } }),
  write_to_file: (args) => ({
    tool_name: 'Write',
    tool_input: { file_path: args.TargetFile, content: args.CodeContent || '' },
  }),
  replace_file_content: (args) => ({
    tool_name: 'Edit',
    tool_input: { file_path: args.TargetFile, old_string: args.TargetContent || '', new_string: args.ReplacementContent || '' },
  }),
  multi_replace_file_content: (args) => {
    const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
    const joined = (key) => chunks.map((chunk) => (chunk && chunk[key]) || '').join('\n');
    return {
      tool_name: 'Edit',
      tool_input: { file_path: args.TargetFile, old_string: joined('TargetContent'), new_string: joined('ReplacementContent') },
    };
  },
};

let input;
function readInput() {
  if (input !== undefined) return input;
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf-8'));
    input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    input = {};
  }
  // The conversation is the session and the first workspace is the project.
  // A command's own absolute Cwd is where its manifests are read from.
  if (typeof input.conversationId === 'string' && input.conversationId) input.session_id = input.conversationId;
  const call = input.toolCall;
  if (call && typeof call === 'object') {
    const args = call.args && typeof call.args === 'object' ? call.args : {};
    Object.assign(input, TOOLS[call.name] ? TOOLS[call.name](args) : { tool_name: call.name, tool_input: args });
    if (call.name === 'run_command' && typeof args.Cwd === 'string' && path.isAbsolute(args.Cwd)) input.cwd = args.Cwd;
  }
  if (!input.cwd && Array.isArray(input.workspacePaths) && typeof input.workspacePaths[0] === 'string') {
    input.cwd = input.workspacePaths[0];
  }
  return input;
}

// One answer per hook run. The emitters buffer and the entrypoint flushes,
// so two hooks sharing a run — the ladder and the drift note on a first
// invocation — never write two JSON documents.
const context = [];
let denial = null;

function emitContext(event, text) {
  if (text) context.push(text);
}

function emitDeny(event, reason) {
  if (reason) denial = reason;
}

// PreToolUse answers out loud in both directions: silence is not documented
// as consent here. PreInvocation injects each buffered text as one transient
// message. Stop asks for one more turn only when the caller confirmed the
// once-per-session mark reached disk, so a state file that cannot be written
// never turns the build check into a loop.
function flush(event, { persisted = true } = {}) {
  let answer = {};
  if (event === 'PreToolUse') {
    answer = denial ? { decision: 'deny', reason: denial } : { decision: 'allow' };
  } else if (event === 'Stop') {
    if (context.length && persisted) answer = { decision: 'continue', reason: context.join('\n\n') };
  } else if (context.length) {
    answer = { injectSteps: context.map((text) => ({ ephemeralMessage: text })) };
  }
  process.stdout.write(JSON.stringify(answer));
}

// Antigravity runs no install-time options. Razor's environment controls and
// defaults apply, exactly as on Codex.
function settingOff(name) {
  return process.env[`RAZOR_${name}`] === 'off';
}

function settingNumber(name, fallback) {
  const n = parseInt(process.env[`RAZOR_${name}`] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function settingGiven(name) {
  const value = process.env[`RAZOR_${name}`];
  return value !== undefined && value !== '';
}

// No plugin data directory is documented for this host, so state lives beside
// Codex's under the system temp directory.
function stateDir() {
  const dir = path.join(os.tmpdir(), 'razor-antigravity');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // An unwritable temp directory costs one extra nudge, never the tool call.
  }
  return dir;
}

// A tool call names no turn here. The entrypoint stamps `turn_id` with the
// number of Stop events the conversation has seen, so a turn is the stretch
// between two stops.
function turnKey(data) {
  return typeof data.turn_id === 'string' && data.turn_id ? data.turn_id : 'unknown-turn';
}

module.exports = {
  ...claude,
  readInput,
  emitContext,
  emitDeny,
  flush,
  settingOff,
  settingNumber,
  settingGiven,
  stateDir,
  turnKey,
};
