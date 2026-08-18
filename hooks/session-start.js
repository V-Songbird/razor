#!/usr/bin/env node
'use strict';

// SessionStart — inject the ladder into the main thread and snapshot the
// git baseline for the build ledger, taken once per session (resume/compact
// keep the original baseline). The snapshot includes the tree's pre-existing
// dirt — dirty insertions, deletions, added and untracked files — so the
// ledger only ever charges the session for its own delta.
// SessionStart accepts raw stdout as context, so no JSON envelope needed.

const { RULESET, readInput, readState, writeState, isActive, settingOff, gcStateFiles, git } = require('./razor-lib');
const { parseShortstat } = require('./build-ledger');

function main() {
  const data = readInput();
  gcStateFiles();
  const state = readState(data.session_id);
  if (!isActive(state)) return;

  // The ladder goes out first. Everything below it is git, and a repo slow
  // enough to burn the hook's timeout must cost at most the ledger baseline —
  // never the injection, which is the whole product.
  process.stdout.write(RULESET);

  if (!state.ledger && !settingOff('LEDGER')) {
    const baseSha = git(['rev-parse', 'HEAD'], data.cwd);
    if (baseSha) {
      const list = (s) => (s || '').split('\n').filter(Boolean);
      const dirty = parseShortstat(git(['diff', '--shortstat', 'HEAD'], data.cwd) || '');
      state.ledger = {
        baseSha,
        baseInsertions: dirty.insertions,
        baseDeletions: dirty.deletions,
        baseAdded: list(git(['diff', '--diff-filter=A', '--name-only', 'HEAD'], data.cwd)).length,
        // Names, not a count: a pre-existing untracked file the session
        // merely stages or commits must stay off the session's bill.
        baseUntrackedFiles: list(git(['ls-files', '--others', '--exclude-standard'], data.cwd)),
        fired: false,
      };
      writeState(data.session_id, state);
    }
  }
}

if (require.main === module) main();
