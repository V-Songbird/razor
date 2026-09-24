#!/usr/bin/env node
'use strict';

// Antigravity entrypoint. Select the native adapter explicitly; shared gates
// do not detect hosts. One process per event, one JSON answer per process.
//
// Antigravity has no session, prompt or subagent event, so its three events
// carry razor as follows. PreInvocation fires before every model call, and an
// injected message reaches only the call it rides, so every call carries the
// ladder, as SessionStart context does in every Claude Code request, and the
// drift note, as UserPromptSubmit does, except on the calls that answer the
// build check's continuation. Only the first call a conversation
// sees takes the ledger baseline. A turn starts at the call whose
// invocationNum is 0: the host restarts that count on each user turn, but not
// when a Stop continues the model, and a turn can end without a Stop. The
// turns counted in the session state key the per-turn file budget. PreToolUse
// runs the same gates on the translated call. Stop only runs the build check,
// and has the model continue only once its once-per-session mark is on disk;
// the turn it continues then goes without the drift note.
process.env.RAZOR_HOST = 'antigravity';

const harness = require('./lib/antigravity-harness');
const { RULESET, readState, writeState, isActive, emitContext } = require('./razor-lib');

function preInvocation(data) {
  const seen = readState(data.session_id);
  if (!isActive(seen)) return harness.flush('PreInvocation');
  if (data.invocationNum === 0) {
    seen.antigravityTurn = (seen.antigravityTurn || 0) + 1;
    writeState(data.session_id, seen);
  }
  if (seen.ladderInjected) {
    emitContext('PreInvocation', RULESET);
  } else {
    require('./session-start').main();
    // Read again: session-start may have saved the ledger baseline meanwhile.
    const state = readState(data.session_id);
    state.ladderInjected = true;
    writeState(data.session_id, state);
  }
  // The calls that answer the build check come after the turn's own answer, and
  // with the note beside that question the model took it for a later request.
  if (seen.continuedTurn !== (seen.antigravityTurn || 0)) require('./mode-toggle').main();
  harness.flush('PreInvocation');
}

function preToolUse(data) {
  data.turn_id = String(readState(data.session_id).antigravityTurn || 0);
  require('./pre-tool-use').main();
  harness.flush('PreToolUse');
}

function stop(data) {
  require('./build-ledger').main();
  const state = readState(data.session_id);
  const persisted = Boolean(state.ledger && state.ledger.fired === true);
  // The build check fires once per conversation, so the first Stop that finds
  // its mark is the one that continues the model.
  if (persisted && state.continuedTurn === undefined) {
    state.continuedTurn = state.antigravityTurn || 0;
    writeState(data.session_id, state);
  }
  harness.flush('Stop', { persisted });
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
