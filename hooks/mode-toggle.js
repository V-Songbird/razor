#!/usr/bin/env node
'use strict';

// UserPromptSubmit — session-scoped on/off toggle, and the drift note.
// "/razor off" (or "stop razor") parks the whole plugin for this session;
// "/razor on" re-arms it and re-injects the ladder. Boolean by design —
// no lite/full/ultra dial; the ladder either applies or it doesn't.
// Every other prompt carries the drift note instead: one line telling the
// session to say so when a later request has left the task the first prompt
// named. A note, never a gate — it has never once stopped a session.

const {
  RULESET, DRIFT_NOTE, readInput, emitContext, readState, writeState, killed, isActive, settingOff,
} = require('./razor-lib');

function parseToggle(prompt) {
  const p = String(prompt || '').trim().toLowerCase();
  const m = p.match(/^\/?razor(?::razor)?\s+(on|off)\b/);
  if (m) return m[1];
  if (/^(stop razor|razor off)[.!]?$/.test(p)) return 'off';
  return null;
}

function main() {
  if (killed()) return; // RAZOR_DISABLE=1 silences the toggle too — gates are off either way
  const data = readInput();
  const toggle = parseToggle(data.prompt);

  if (toggle) {
    const state = readState(data.session_id);
    state.off = toggle === 'off';
    writeState(data.session_id, state);
    emitContext(
      'UserPromptSubmit',
      toggle === 'off' ? 'RAZOR OFF — the ladder and guards no longer apply this session.' : RULESET
    );
    return;
  }

  if (settingOff('DRIFT_NOTE')) return;
  if (!isActive(readState(data.session_id))) return;
  emitContext('UserPromptSubmit', DRIFT_NOTE);
}

if (require.main === module) main();

module.exports = { parseToggle };
