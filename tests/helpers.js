'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

/** Run a hook script from hooks/ with JSON stdin; returns spawnSync result. */
function runHook(name, stdinData, env) {
  return spawnSync('node', [path.join(HOOKS_DIR, name)], {
    input: stdinData === undefined ? undefined : JSON.stringify(stdinData),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...(env || {}) },
  });
}

/** Parse hook stdout as JSON, or null when the hook stayed silent. */
function hookOutput(result) {
  const out = (result.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

/** Unique session id per test so tmpdir state files never collide. */
let counter = 0;
function freshSession() {
  return `razor-test-${process.pid}-${++counter}`;
}

/** Minimal transcript containing one real user prompt with the given uuid. */
function writeTranscript(uuid) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'razor-t-')), 't.jsonl');
  const line = JSON.stringify({
    type: 'user',
    uuid,
    message: { role: 'user', content: 'do the thing' },
  });
  fs.writeFileSync(file, line + '\n');
  return file;
}

module.exports = { runHook, hookOutput, freshSession, writeTranscript, HOOKS_DIR };
