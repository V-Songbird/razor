#!/usr/bin/env node
'use strict';

// UserPromptSubmit — session-scoped on/off toggle.
// "/razor off" (or "stop razor") parks the whole plugin for this session;
// "/razor on" re-arms it and re-injects the ladder. Boolean by design —
// no lite/full/ultra dial; the ladder either applies or it doesn't.

const { RULESET, readInput, readState, writeState } = require('./razor-lib');

function parseToggle(prompt) {
  const p = String(prompt || '').trim().toLowerCase();
  const m = p.match(/^[/@$]?razor(?::razor)?\s+(on|off)\b/);
  if (m) return m[1];
  if (/^(stop razor|razor off)[.!]?$/.test(p)) return 'off';
  return null;
}

function main() {
  const data = readInput();
  const toggle = parseToggle(data.prompt);
  if (!toggle) return;

  const state = readState(data.session_id);
  state.off = toggle === 'off';
  writeState(data.session_id, state);

  // UserPromptSubmit stdout is added to context.
  process.stdout.write(
    toggle === 'off' ? 'RAZOR OFF — the ladder and guards no longer apply this session.' : RULESET
  );
}

if (require.main === module) main();

module.exports = { parseToggle };
