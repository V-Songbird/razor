#!/usr/bin/env node
'use strict';

// Stop — build ledger: threshold-gated outcome meter.
//
// The gates prevent; this measures. At turn end, compare the working tree
// against the SessionStart snapshot (base commit + untracked count). If the
// session looks like sprawl — large insertion-heavy diff with almost no
// deletions, or many new files — inject one question, once per session.
// Silent while the session behaves; the thresholds are generous on purpose
// so a legitimately large requested task never trips it.

const { readInput, emitContext, readState, writeState, isActive, settingOff, settingNumber, git } = require('./razor-lib');

const LOC_BUDGET = (() => {
  const n = settingNumber('LEDGER_LOC', 500);
  return n > 0 ? n : 500;
})();

const FILES_BUDGET = (() => {
  const n = settingNumber('LEDGER_FILES', 8);
  return n > 0 ? n : 8;
})();

// Sprawl = big net growth with next-to-no deletion, or a pile of new files.
// A large diff that also deletes a lot is refactoring, not sprawl.
function shouldFire(stats, locBudget, filesBudget) {
  const sprawlLoc =
    stats.insertions - stats.deletions > locBudget && stats.deletions < stats.insertions * 0.1;
  return sprawlLoc || stats.newFiles > filesBudget;
}

function parseShortstat(shortstat) {
  return {
    insertions: parseInt((/(\d+) insertion/.exec(shortstat) || [])[1] || '0', 10),
    deletions: parseInt((/(\d+) deletion/.exec(shortstat) || [])[1] || '0', 10),
  };
}

// The session's own delta: the working tree vs the base commit, minus the
// dirt that was already there when the session started. Files that were
// untracked at session start are excluded by NAME — staging or committing
// them mid-session must not move their content onto the session's bill.
// razor: count-level subtraction for edits to pre-existing files; per-line
// attribution needs a full diff snapshot at session start.
function diffStats(ledger, cwd) {
  const numstat = git(['diff', '--numstat', ledger.baseSha], cwd);
  if (numstat === null) return null; // base sha gone (rebase) or not a repo
  const baseNames = new Set(ledger.baseUntrackedFiles || []);
  let insertions = 0;
  let deletions = 0;
  for (const line of numstat.split('\n')) {
    const [ins, del, file] = line.split('\t');
    if (!file || baseNames.has(file)) continue;
    insertions += parseInt(ins, 10) || 0;
    deletions += parseInt(del, 10) || 0;
  }
  insertions = Math.max(0, insertions - (ledger.baseInsertions || 0));
  deletions = Math.max(0, deletions - (ledger.baseDeletions || 0));

  const list = (s) => (s || '').split('\n').filter(Boolean);
  const added = list(git(['diff', '--diff-filter=A', '--name-only', ledger.baseSha], cwd));
  const untracked = list(git(['ls-files', '--others', '--exclude-standard'], cwd));
  const fresh = [...new Set([...added, ...untracked])].filter((f) => !baseNames.has(f));
  const newFiles = Math.max(0, fresh.length - (ledger.baseAdded || 0));

  return { insertions, deletions, newFiles };
}

function main() {
  if (settingOff('LEDGER')) return;
  const data = readInput();
  const state = readState(data.session_id);
  if (!isActive(state)) return;

  const ledger = state.ledger;
  if (!ledger || !ledger.baseSha || ledger.fired) return;

  const stats = diffStats(ledger, data.cwd);
  if (!stats || !shouldFire(stats, LOC_BUDGET, FILES_BUDGET)) return;

  ledger.fired = true;
  writeState(data.session_id, state);

  emitContext(
    'Stop',
    `razor ledger: +${stats.insertions} / -${stats.deletions} LOC, ` +
      `${stats.newFiles} new files since session start. ` +
      'Deletion-positive diffs are the goal — is all of this needed? ' +
      '(fires once per session; RAZOR_LEDGER=off to silence)'
  );
}

if (require.main === module) main();

module.exports = { shouldFire, diffStats, parseShortstat };
