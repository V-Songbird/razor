#!/usr/bin/env node
'use strict';

// Select the native adapter explicitly; shared gates do not detect hosts.
process.env.RAZOR_HOST = 'codex';

const EVENTS = {
  SessionStart: './session-start',
  SubagentStart: './subagent-start',
  PreToolUse: './pre-tool-use',
  Stop: './build-ledger',
  UserPromptSubmit: './mode-toggle',
};

function main() {
  const event = process.argv[2];
  if (!Object.hasOwn(EVENTS, event)) return;
  const data = require('./lib/codex-harness').readInput();
  if (typeof data.session_id !== 'string' || !data.session_id.trim()) return;
  if (data.hook_event_name !== event) return;
  require(EVENTS[event]).main();
}

if (require.main === module) main();
module.exports = { main, EVENTS };