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

// A package manifest's content before and after a multi-chunk edit, its chunks
// applied in order, or null. As with locate() in ./codex-tools, a target that
// is missing leaves nothing to preview, and so does a file that cannot be read.
// A target that occurs more than once is replaced everywhere when its chunk
// sets AllowMultiple, as the host does, and otherwise leaves nothing to
// preview, because the host refuses that chunk. When the chunks do not apply
// as written, they are applied again to the file's LF view, as the manifest
// guard's simulate() does for a single edit. The manifest guard is required
// on use because it loads razor-lib, which loads this adapter.
function wholeManifestEdit(file, chunks) {
  const { GUARDED } = require('../manifest-guard');
  if (typeof file !== 'string' || !Object.hasOwn(GUARDED, path.basename(file).toLowerCase())) return null;
  let existing;
  try {
    existing = fs.readFileSync(path.resolve(file), 'utf-8');
  } catch {
    return null;
  }
  const text = applyChunks(existing, chunks) ?? applyChunks(existing.replace(/\r\n/g, '\n'), chunks);
  return text === null ? null : { file_path: file, old_string: existing, new_string: text };
}

function applyChunks(text, chunks) {
  for (const chunk of chunks) {
    const target = chunk && chunk.TargetContent;
    const at = typeof target === 'string' && target ? text.indexOf(target) : -1;
    if (at === -1) return null;
    const replacement = chunk.ReplacementContent || '';
    if (chunk.AllowMultiple === true) text = text.split(target).join(replacement);
    else if (text.includes(target, at + 1)) return null;
    else text = text.slice(0, at) + replacement + text.slice(at + target.length);
  }
  return text;
}

// The host types TargetFile as a string. Any other value is left out, so no
// gate reads it as a path.
const targetFile = (args) => (typeof args.TargetFile === 'string' ? args.TargetFile : undefined);

// Antigravity's tool names and arguments, read into the shape the gates
// already speak. AllowMultiple, which lets the host replace every match of a
// target, is replace_all. A multi-chunk edit is one Edit whose new text is
// the chunks' replacements joined, which is all the import guard compares.
// Its old text is left empty: joined targets are seldom on disk, and an empty
// old_string tells the gates this is no edit the host could refuse. So a
// package manifest's edit, when it can be previewed, becomes the whole file
// it would produce, as Codex's patch preview does. Any other tool passes
// through unchanged and matches no gate.
const TOOLS = {
  run_command: (args) => ({ tool_name: 'Bash', tool_input: { command: args.CommandLine || '' } }),
  write_to_file: (args) => ({
    tool_name: 'Write',
    tool_input: { file_path: targetFile(args), content: args.CodeContent || '' },
  }),
  replace_file_content: (args) => ({
    tool_name: 'Edit',
    tool_input: {
      file_path: targetFile(args),
      old_string: args.TargetContent || '',
      new_string: args.ReplacementContent || '',
      replace_all: args.AllowMultiple === true,
    },
  }),
  multi_replace_file_content: (args) => {
    const file = targetFile(args);
    const chunks = Array.isArray(args.ReplacementChunks) ? args.ReplacementChunks : [];
    const replacements = chunks.map((chunk) => (chunk && chunk.ReplacementContent) || '').join('\n');
    return {
      tool_name: 'Edit',
      tool_input: wholeManifestEdit(file, chunks) || { file_path: file, old_string: '', new_string: replacements },
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

// A deny names the tool the call used, in its reason and in the retry sentence
// that asks for the exact same call. The gates speak of Write and Edit, which
// this host does not have; nativeReason() in ./codex-tools does the same for
// Codex.
function emitDeny(event, reason) {
  if (!reason) return;
  const call = readInput().toolCall;
  const tool = call && typeof call.name === 'string' ? call.name : '';
  denial = tool ? reason.replace(/\b(this|exact same) (?:Write|Edit)\b/g, (_, lead) => `${lead} ${tool}`) : reason;
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
// number of model calls numbered 0 the conversation has seen, so a turn starts
// at each user turn's first call.
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
