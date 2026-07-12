#!/usr/bin/env node
'use strict';

// PreToolUse — single entry point for every razor gate.
//
// One process per tool call and one state read/write, with the gates applied
// in order against the same state object: dep guard, manifest guard, import
// guard, file meter, search meter. Every gate still records its own bookkeeping even
// when an earlier one already denied — the retry then passes all of them —
// and the first reason found is the one emitted (most specific wins).
//
// Gate state is per subagent (see gateStateId): a subagent's searches and
// writes never spend the main thread's budgets, and vice versa. The /razor
// toggle stays session-wide.

const { readInput, readState, writeState, isActive, gateStateId } = require('./razor-lib');

const GATES = [
  require('./dep-guard'),
  require('./manifest-guard'),
  require('./import-guard'),
  require('./file-meter'),
  require('./search-meter'),
];

function main() {
  const data = readInput();
  const sessionState = readState(data.session_id);
  if (!isActive(sessionState)) return;

  const stateId = gateStateId(data);
  const state = stateId === data.session_id ? sessionState : readState(stateId);

  let reason = null;
  for (const gate of GATES) {
    const r = gate.check(data, state);
    if (r && !reason) reason = r;
  }
  writeState(stateId, state);

  if (!reason) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
}

if (require.main === module) main();
