#!/usr/bin/env node
'use strict';

// Antigravity entrypoint. Select the native adapter explicitly; shared gates
// do not detect hosts. One process per event, one JSON answer per process.
//
// Antigravity has no session, prompt or subagent event, so its three events
// carry razor as follows. PreInvocation fires before every model call: the
// first one a conversation sees carries the ladder and the ledger baseline,
// as SessionStart does elsewhere, and the first one after each Stop carries
// the drift note, as UserPromptSubmit does. A turn is the stretch between two
// Stops, counted in the session state, and that count also keys the per-turn
// file budget. PreToolUse runs the same gates on the translated call. Stop
// runs the build check and asks for one more turn only once its
// once-per-session mark is on disk.
process.env.RAZOR_HOST = 'antigravity';

const harness = require('./lib/antigravity-harness');
const { readState, writeState, isActive } = require('./razor-lib');

function preInvocation(data) {
  const seen = readState(data.session_id);
  if (!isActive(seen)) return harness.flush('PreInvocation');
  const turn = seen.antigravityTurn || 0;
  if (!seen.ladderInjected) require('./session-start').main();
  if (!seen.ladderInjected || seen.noteTurn !== turn) require('./mode-toggle').main();
  // Read again: session-start may have saved the ledger baseline meanwhile.
  const state = readState(data.session_id);
  state.ladderInjected = true;
  state.noteTurn = turn;
  writeState(data.session_id, state);
  harness.flush('PreInvocation');
}

function preToolUse(data) {
  data.turn_id = String(readState(data.session_id).antigravityTurn || 0);
  require('./pre-tool-use').main();
  harness.flush('PreToolUse');
}

function stop(data) {
  const state = readState(data.session_id);
  if (!isActive(state)) return harness.flush('Stop');
  state.antigravityTurn = (state.antigravityTurn || 0) + 1;
  writeState(data.session_id, state);
  require('./build-ledger').main();
  const ledger = readState(data.session_id).ledger;
  harness.flush('Stop', { persisted: Boolean(ledger && ledger.fired === true) });
}

const EVENTS = { PreInvocation: preInvocation, PreToolUse: preToolUse, Stop: stop };

function main() {
  const event = process.argv[2];
  if (!Object.hasOwn(EVENTS, event)) return;
  const data = harness.readInput();
  // No conversation means no state to keep: allow the call, inject nothing,
  // let the stop stand.
  if (typeof data.session_id !== 'string' || !data.session_id.trim()) return harness.flush(event);
  EVENTS[event](data);
}

if (require.main === module) main();
module.exports = { main, EVENTS };
