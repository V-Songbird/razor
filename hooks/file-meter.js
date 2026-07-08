#!/usr/bin/env node
'use strict';

// PreToolUse (Write) — per-turn new-file budget.
//
// Counts files the Write tool is about to create (the path doesn't exist
// yet). When the count crosses the budget, that one Write is denied with a
// rung-2 reason; the retry and everything after it in the same turn pass.
// One forced reconsideration per turn, self-clearing, existing files are
// never gated (edits/overwrites aren't sprawl).
//
// Temp and scratchpad files are exempt — working files aren't code sprawl.
// Known limit: files created via Bash heredocs bypass the Write tool and
// this meter with them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readInput, readState, writeState, isActive, currentTurnKey } = require('./razor-lib');

const BUDGET = (() => {
  const n = parseInt(process.env.RAZOR_FILE_BUDGET || '', 10);
  return Number.isFinite(n) ? n : 4;
})();

function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function isExemptPath(filePath) {
  const target = norm(filePath);
  const tmp = norm(os.tmpdir());
  return target === tmp || target.startsWith(tmp + '/') || target.includes('/scratchpad/');
}

// Pure budget step: given the previous turn state, the current turn key and
// the budget, returns the next state and whether this Write gets denied.
function stepTurn(turn, turnKey, budget) {
  const next =
    turn && turn.turnKey === turnKey ? { ...turn } : { turnKey, count: 0, fired: false };
  next.count += 1;
  const deny = next.count > budget && !next.fired;
  if (deny) next.fired = true;
  return { next, deny };
}

function main() {
  if (BUDGET <= 0) return; // 0 or negative disables the meter
  const data = readInput();
  if (!isActive(readState(data.session_id))) return;

  const filePath = data.tool_input && data.tool_input.file_path;
  if (!filePath || isExemptPath(filePath)) return;
  if (fs.existsSync(filePath)) return; // overwrite/edit, not a new file

  const state = readState(data.session_id);
  const { next, deny } = stepTurn(state.turn, currentTurnKey(data.transcript_path), BUDGET);
  state.turn = next;
  writeState(data.session_id, state);

  if (!deny) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `razor: new file #${next.count} this turn (budget ${BUDGET}). ` +
          'Rung 2 — check whether existing files or modules already cover this before creating more. ' +
          'If every new file is genuinely needed, re-issue the Write unchanged; this gate fires once per turn.',
      },
    })
  );
}

if (require.main === module) main();

module.exports = { stepTurn, isExemptPath, BUDGET };
