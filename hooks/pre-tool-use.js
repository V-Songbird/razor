#!/usr/bin/env node
'use strict';

// PreToolUse — single entry point for every razor gate.
//
// One process per tool call and one state read/write, with the gates applied
// in order against the same state object: dep guard, manifest guard, import
// guard, file meter. Every gate still records its own bookkeeping even
// when an earlier one already denied — the retry then passes all of them —
// and the first reason found is the one emitted (most specific wins).
//
// Gate state is per subagent (see gateStateId): a subagent's searches and
// writes never spend the main thread's budgets, and vice versa. The /razor
// toggle stays session-wide.

const { readInput, emitDeny, readState, writeState, isActive, gateStateId, turnKey } = require('./razor-lib');

const { toToolCalls, nativeReason, pathKey } = require('./lib/codex-tools');
const MANIFEST_GUARD = require('./manifest-guard');
const IMPORT_GUARD = require('./import-guard');
const FILE_METER = require('./file-meter');

const GATES = [
  require('./dep-guard'),
  MANIFEST_GUARD,
  IMPORT_GUARD,
  FILE_METER,
];

function main() {
  const data = readInput();
  const sessionState = readState(data.session_id);
  if (!isActive(sessionState)) return;

  const stateId = gateStateId(data);
  const state = stateId === data.session_id ? sessionState : readState(stateId);

  const nativePatch = data.tool_name === 'apply_patch';
  const calls = nativePatch ? toToolCalls(data) : [data];
  let reason = null;
  for (const gate of GATES) {
    for (const call of calls) {
      // A denied compound patch has not created its files yet. Its retry
      // must not spend the file budget again for those same paths.
      if (nativePatch && gate === FILE_METER && call.tool_name === 'Write') {
        const key = turnKey(data);
        if (!state.codexPatchFiles || state.codexPatchFiles.turnKey !== key) {
          state.codexPatchFiles = { turnKey: key, paths: [] };
        }
        const file = pathKey(call.tool_input.file_path);
        if (state.codexPatchFiles.paths.includes(file)) continue;
        state.codexPatchFiles.paths.push(file);
      }
      const view = gate === MANIFEST_GUARD ? 'manifest' : gate === IMPORT_GUARD ? 'import' : null;
      const gateInput = nativePatch && view && call.razor_gate_views ? call.razor_gate_views[view] : call;
      const r = gate.check(gateInput, state);
      if (r && !reason) reason = r;
    }
  }
  writeState(stateId, state);

  emitDeny('PreToolUse', nativePatch ? nativeReason(reason) : reason);
}

if (require.main === module) main();

module.exports = { main };
