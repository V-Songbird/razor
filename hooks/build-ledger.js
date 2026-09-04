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
const { classify } = require('./file-meter');

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

// Sum a --numstat block, skipping the paths the ledger never charges. Both
// the session-start baseline and the turn-end tally go through here, so a
// path exempt from one is exempt from the other — an asymmetry would have the
// baseline subtract lines the tally never counted, and the meter would go
// quiet for the rest of the session.
function tally(numstat, skip = () => false) {
  let insertions = 0;
  let deletions = 0;
  for (const line of (numstat || '').split('\n')) {
    const [ins, del, file] = line.split('\t');
    if (!file || skip(file) || isUncounted(file)) continue;
    insertions += parseInt(ins, 10) || 0;
    deletions += parseInt(del, 10) || 0;
  }
  return { insertions, deletions };
}

// The session's own delta: the working tree vs the base commit, minus the
// dirt that was already there when the session started. Files that were
// untracked at session start are excluded by NAME — staging or committing
// them mid-session must not move their content onto the session's bill.
// razor: count-level subtraction for edits to pre-existing files; per-line
// attribution needs a full diff snapshot at session start.
// A regenerated lockfile is thousands of insertions nobody wrote, and it lands
// with almost no deletions -- exactly the shape shouldFire reads as sprawl.
// The benchmark runner's own diff metric already skips these; the ledger has
// to as well or a routine dependency update ends the session with a question
// about code the agent never authored.
// git reports every path with forward slashes, so the name is what is after
// the last one.
function isLockfile(file) {
  const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase();
  return name.endsWith('.lock') || name.endsWith('-lock.json') || name.endsWith('-lock.yaml');
}

// Prose is not sprawl. file-meter already classifies a new docs file and
// refuses to charge it against the file budget; the ledger has to agree, or a
// repo that mandates ADR amendments and doc comments ends every session with
// a question about lines nobody would want cut. classify() owns the path
// shapes so the two meters cannot drift apart.
function isUncounted(file) {
  return isLockfile(file) || classify(file) === 'docs';
}

function diffStats(ledger, cwd) {
  const numstat = git(['diff', '--numstat', ledger.baseSha], cwd);
  if (numstat === null) return null; // base sha gone (rebase) or not a repo
  const baseNames = new Set(ledger.baseUntrackedFiles || []);
  let { insertions, deletions } = tally(numstat, (file) => baseNames.has(file));
  insertions = Math.max(0, insertions - (ledger.baseInsertions || 0));
  deletions = Math.max(0, deletions - (ledger.baseDeletions || 0));

  const list = (s) => (s || '').split('\n').filter(Boolean);
  const added = list(git(['diff', '--diff-filter=A', '--name-only', ledger.baseSha], cwd));
  const untracked = list(git(['ls-files', '--others', '--exclude-standard'], cwd));
  const fresh = [...new Set([...added, ...untracked])].filter(
    (f) => !baseNames.has(f) && !isUncounted(f)
  );
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

module.exports = { shouldFire, diffStats, tally, isUncounted };
