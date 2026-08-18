'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

/**
 * Run a hook script from hooks/ with JSON stdin; returns spawnSync result.
 *
 * Every razor hook exits 0 — silence is how it says "nothing to do". So a
 * crash also produces empty stdout, and without this check every
 * "stays silent" assertion in the suite would pass for a hook that threw
 * before it ran. Fail loudly instead, with the child's own stderr.
 */
function runHook(name, stdinData, env) {
  const result = spawnSync('node', [path.join(HOOKS_DIR, name)], {
    input: stdinData === undefined ? undefined : JSON.stringify(stdinData),
    encoding: 'utf-8',
    timeout: 30000,
    env: { ...process.env, ...(env || {}) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw new Error(
      `${name} exited ${result.status}${result.signal ? ` (${result.signal})` : ''}: ${result.stderr || '(no stderr)'}`
    );
  }
  return result;
}

/** Parse hook stdout as JSON, or null when the hook stayed silent. */
function hookOutput(result) {
  const out = (result.stdout || '').trim();
  return out ? JSON.parse(out) : null;
}

/**
 * Unique session id per test so state files never collide. pid+counter
 * alone is not enough: state files outlive the run and Windows recycles
 * pids, so a later run can read a previous run's state and see gates that
 * already fired. The timestamp+random suffix makes ids unique across runs.
 */
let counter = 0;
function freshSession() {
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `razor-test-${process.pid}-${unique}-${++counter}`;
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
