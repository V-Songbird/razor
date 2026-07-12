#!/usr/bin/env node
'use strict';

// SessionEnd — remove this session's state files (session-scoped and
// agent-scoped). Sessions that never get here are swept by the
// session-start GC instead.

const { readInput, clearSessionState } = require('./razor-lib');

function main() {
  clearSessionState(readInput().session_id);
}

if (require.main === module) main();
