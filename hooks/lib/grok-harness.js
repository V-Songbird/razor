'use strict';

// Grok Build wire adapter. ./harness is the Claude Code adapter; this module
// replaces what Grok's hook contract does differently. The runner sends
// camelCase (sessionId, toolName, toolInput, promptId, subagentId,
// subagentType, stopHookActive) and, in current source, copies some of those
// onto snake_case aliases. The gates speak Claude's names, so the mapping
// below is what makes a deny on Bash, Edit or Write a deny on Grok's tool.
//
// Tool schemas verified against xai-org/grok-build (main, 2026-10-30):
// run_terminal_command and the internal id run_terminal_cmd take `command`;
// search_replace and the OpenCode `edit` tool take file_path, old_string,
// new_string and replace_all, and an empty old_string writes the whole file;
// `write` takes file_path and content; hashline_edit takes file_path and
// edits. PowerShell has no tool of its own: a shell command is
// run_terminal_command, and the alias table maps that name to Bash.
const fs = require('fs');
const os = require('os');
const path = require('path');
const claude = require('./harness');

const SHELL_TOOLS = new Set(['run_terminal_command', 'run_terminal_cmd', 'bash']);
const EDIT_TOOLS = new Set(['search_replace', 'edit']);

function asString(value) {
  return typeof value === 'string' ? value : undefined;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value);
}

function objectArg(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// hashline_edit accepts its edits as an array, one object, or a JSON string
// of either. Anything else is no edit the gates can read.
function hashlineEdits(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') return [raw];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    // Not JSON: the gates see no new text.
  }
  return [];
}

function readFileIfPresent(file) {
  if (!file) return null;
  try {
    return fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    return null;
  }
}

// A whole-file write is a Write when the file is not there yet, and an Edit
// of the bytes on disk when it is. The manifest guard can then diff the
// result, and the file meter still ignores an overwrite.
function wholeFile(file, content) {
  const existing = readFileIfPresent(file);
  if (existing === null) return { tool_name: 'Write', tool_input: { file_path: file, content } };
  return { tool_name: 'Edit', tool_input: { file_path: file, old_string: existing, new_string: content } };
}

function mapEdit(args) {
  const file = asString(args.file_path);
  const oldString = typeof args.old_string === 'string' ? args.old_string : '';
  const newString = typeof args.new_string === 'string' ? args.new_string : '';
  if (!oldString) return { tool_name: 'Write', tool_input: { file_path: file, content: newString } };
  return {
    tool_name: 'Edit',
    tool_input: {
      file_path: file,
      old_string: oldString,
      new_string: newString,
      replace_all: args.replace_all === true,
    },
  };
}

// Anchored hashline ops are not applied here: the anchor scheme is the
// tool's, and a wrong preview would deny a change the host would refuse.
// Their new text is still handed to the import guard, which treats an empty
// old_string as text this adapter assembled. A single `write` op is the
// whole file and is previewed exactly.
function mapHashline(args) {
  const file = asString(args.file_path);
  const edits = hashlineEdits(args.edits);
  const only = edits.length === 1 ? edits[0] : null;
  if (only && only.op === 'write') {
    return wholeFile(file, typeof only.content === 'string' ? only.content : '');
  }
  const added = edits
    .map((edit) => (edit && typeof edit.content === 'string' ? edit.content : ''))
    .filter(Boolean)
    .join('\n');
  return { tool_name: 'Edit', tool_input: { file_path: file, old_string: '', new_string: added } };
}

function mapTool(name, args) {
  if (SHELL_TOOLS.has(name)) {
    return { tool_name: 'Bash', tool_input: { command: typeof args.command === 'string' ? args.command : '' } };
  }
  if (name === 'write') {
    return {
      tool_name: 'Write',
      tool_input: { file_path: asString(args.file_path), content: typeof args.content === 'string' ? args.content : '' },
    };
  }
  if (EDIT_TOOLS.has(name)) return mapEdit(args);
  if (name === 'hashline_edit') return mapHashline(args);
  return null;
}

let input;
function readInput() {
  if (input !== undefined) return input;
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf8'));
    input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    input = {};
  }
  const session = firstString(input.sessionId, input.session_id);
  if (session) input.session_id = session;
  if (!input.cwd) {
    const cwd = firstString(input.workspaceRoot, input.workspace_root);
    if (cwd) input.cwd = cwd;
  }
  const prompt = firstString(input.promptId, input.prompt_id);
  if (prompt) input.prompt_id = prompt;
  if (input.stopHookActive !== undefined) input.stop_hook_active = input.stopHookActive;
  const agent = firstString(input.subagentId, input.agent_id);
  if (agent) input.agent_id = agent;
  const agentType = firstString(input.subagentType, input.agent_type);
  if (agentType) input.agent_type = agentType;
  const transcript = firstString(input.transcriptPath, input.transcript_path);
  if (transcript) input.transcript_path = transcript;

  const toolName = firstString(input.toolName, input.tool_name);
  const toolArgs = objectArg(input.toolInput !== undefined ? input.toolInput : input.tool_input);
  if (toolName) {
    const mapped = mapTool(toolName, toolArgs);
    if (mapped) {
      input.tool_name = mapped.tool_name;
      input.tool_input = mapped.tool_input;
      input.razor_grok_tool = toolName;
    } else if (!input.tool_name) {
      input.tool_name = toolName;
      input.tool_input = toolArgs;
    }
  }
  return input;
}

function emitContext(event, text) {
  if (!text) return;
  // A continuation Stop has stopHookActive set. Suppressing it here is the
  // bound Codex uses too: a state file that could not record `fired` must
  // not ask again on every continuation.
  if (event === 'Stop' && readInput().stop_hook_active === true) return;
  claude.emitContext(event, text);
}

// The gates say `this Write` or `this Edit`. Grok's model called another tool.
function emitDeny(event, reason) {
  if (!reason) return;
  const tool = readInput().razor_grok_tool;
  claude.emitDeny(event, tool ? reason.replace(/\bthis (?:Write|Edit)\b/g, `this ${tool}`) : reason);
}

// Grok runs no install-time userConfig. The RAZOR_* variables and the
// built-in defaults apply, as on Codex and Antigravity.
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

// Plugin hooks receive GROK_PLUGIN_DATA and the CLAUDE_PLUGIN_DATA alias.
// Either is the host's data directory. Without one, state stays under tmp
// beside the other hosts' fallbacks.
function stateDir() {
  const fallback = path.join(os.tmpdir(), 'razor-grok');
  for (const dir of [process.env.GROK_PLUGIN_DATA, process.env.CLAUDE_PLUGIN_DATA, fallback].filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // An unwritable data directory costs one extra nudge, never the tool call.
    }
  }
  return fallback;
}

// A Stop at session teardown (channel_closed, shutdown) parses output and
// ignores it. Letting that fire consume the once-per-session mark would
// silence the question the model can still see on a later end_turn.
function stopObservesOnly(data) {
  return typeof data.reason === 'string' && data.reason !== 'end_turn';
}

module.exports = {
  ...claude,
  readInput,
  emitContext,
  emitDeny,
  settingOff,
  settingNumber,
  settingGiven,
  stateDir,
  stopObservesOnly,
  mapTool,
};
