'use strict';

// Gate (Write, via pre-tool-use.js) — per-turn new-file budget.
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
const { turnKey, settingNumber } = require('./razor-lib');
const { PROVENANCE, retryContract } = require('./dep-guard');

const BUDGET = settingNumber('FILE_BUDGET', 4);

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

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (BUDGET <= 0) return null; // 0 or negative disables the meter
  if (data.tool_name !== 'Write') return null;

  const filePath = data.tool_input && data.tool_input.file_path;
  if (!filePath || isExemptPath(filePath)) return null;
  if (fs.existsSync(filePath)) return null; // overwrite/edit, not a new file

  const { next, deny } = stepTurn(state.turn, turnKey(data), BUDGET);
  state.turn = next;

  if (!deny) return null;
  return (
    `razor: new file #${next.count} this turn (budget ${BUDGET}). ` +
    'Rung 2 — check whether existing files or modules already cover this before creating more. ' +
    PROVENANCE +
    'If every new file is genuinely needed, ' +
    retryContract('Write')
  );
}

module.exports = { check, stepTurn, isExemptPath, BUDGET };
