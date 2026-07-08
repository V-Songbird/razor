#!/usr/bin/env node
'use strict';

// SessionStart — inject the ladder into the main thread and snapshot the
// git baseline for the build ledger (base commit + untracked count, taken
// once per session; resume/compact keep the original baseline).
// SessionStart accepts raw stdout as context, so no JSON envelope needed.

const { RULESET, readInput, readState, writeState, isActive, git } = require('./razor-lib');

function main() {
  const data = readInput();
  const state = readState(data.session_id);
  if (!isActive(state)) return;

  if (!state.ledger && process.env.RAZOR_LEDGER !== 'off') {
    const baseSha = git(['rev-parse', 'HEAD'], data.cwd);
    if (baseSha) {
      const untracked = git(['ls-files', '--others', '--exclude-standard'], data.cwd) || '';
      state.ledger = {
        baseSha,
        baseUntracked: untracked.split('\n').filter(Boolean).length,
        fired: false,
      };
      writeState(data.session_id, state);
    }
  }

  process.stdout.write(RULESET);
}

if (require.main === module) main();
