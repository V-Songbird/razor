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

const { readInput, readState, writeState, isActive, git } = require('./razor-lib');

const LOC_BUDGET = (() => {
  const n = parseInt(process.env.RAZOR_LEDGER_LOC || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 500;
})();

const FILES_BUDGET = (() => {
  const n = parseInt(process.env.RAZOR_LEDGER_FILES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 8;
})();

// Sprawl = big net growth with next-to-no deletion, or a pile of new files.
// A large diff that also deletes a lot is refactoring, not sprawl.
function shouldFire(stats, locBudget, filesBudget) {
  const sprawlLoc =
    stats.insertions - stats.deletions > locBudget && stats.deletions < stats.insertions * 0.1;
  return sprawlLoc || stats.newFiles > filesBudget;
}

function diffStats(ledger, cwd) {
  const shortstat = git(['diff', '--shortstat', ledger.baseSha], cwd);
  if (shortstat === null) return null; // base sha gone (rebase) or not a repo
  const insertions = parseInt((/(\d+) insertion/.exec(shortstat) || [])[1] || '0', 10);
  const deletions = parseInt((/(\d+) deletion/.exec(shortstat) || [])[1] || '0', 10);

  const added = git(['diff', '--diff-filter=A', '--name-only', ledger.baseSha], cwd) || '';
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd) || '';
  const count = (s) => s.split('\n').filter(Boolean).length;
  const newFiles = count(added) + Math.max(0, count(untracked) - (ledger.baseUntracked || 0));

  return { insertions, deletions, newFiles };
}

function main() {
  if (process.env.RAZOR_LEDGER === 'off') return;
  const data = readInput();
  const state = readState(data.session_id);
  if (!isActive(state)) return;

  const ledger = state.ledger;
  if (!ledger || !ledger.baseSha || ledger.fired) return;

  const stats = diffStats(ledger, data.cwd);
  if (!stats || !shouldFire(stats, LOC_BUDGET, FILES_BUDGET)) return;

  ledger.fired = true;
  writeState(data.session_id, state);

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext:
          `razor ledger: +${stats.insertions} / -${stats.deletions} LOC, ` +
          `${stats.newFiles} new files since session start. ` +
          'Deletion-positive diffs are the goal — is all of this needed? ' +
          '(fires once per session; RAZOR_LEDGER=off to silence)',
      },
    })
  );
}

if (require.main === module) main();

module.exports = { shouldFire, diffStats };
