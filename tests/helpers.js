'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Hooks read their settings and host from these variables: RAZOR_* (every
// setting, RAZOR_DISABLE and RAZOR_HOST), Claude Code's plugin options and
// data directory, and Codex's PLUGIN_DATA. A suite started from a shell or a
// host that sets one must not inherit it: every test file that loads this
// module, and every hook it spawns, sees none of them, and a test that needs
// one sets it explicitly.
//
// Every child the suite spawns gets 30 s. A loaded machine can need longer,
// so RAZOR_TEST_SPAWN_TIMEOUT_MS raises that limit; a lower value never
// applies. It is read here, before the cleanup below removes it.
const SPAWN_TIMEOUT_MS = Math.max(30000, Number.parseInt(process.env.RAZOR_TEST_SPAWN_TIMEOUT_MS, 10) || 0);
const INHERITED_HOST_ENV = /^(RAZOR_|CLAUDE_PLUGIN_|PLUGIN_DATA$)/;
for (const key of Object.keys(process.env)) {
  if (INHERITED_HOST_ENV.test(key)) delete process.env[key];
}

// The hooks give each git call 2 s. A loaded machine can take longer, and a
// slow git drops the build check's baseline, so the suite raises that budget
// for itself and every hook it spawns. The product default is unchanged.
process.env.RAZOR_GIT_TIMEOUT_MS = '10000';

// One private temp directory per test process, removed when the process
// exits. TEMP, TMP and TMPDIR point at it, so os.tmpdir() in every test file
// that loads this module, and in every hook a test spawns, lands inside it:
// fixture workspaces and the state files hooks keep in temp never reach the
// system temp directory, and the session-start sweep of old state files only
// ever sees this process's own.
//
// A process killed before it exits never runs that handler. The directories
// sit under one parent and start with their process id, so each new process
// removes those whose process is gone, and a killed run's temp lasts only
// until the next run.
const TEST_TEMP_PARENT = path.join(os.tmpdir(), 'razor-tests');
fs.mkdirSync(TEST_TEMP_PARENT, { recursive: true });
for (const name of fs.readdirSync(TEST_TEMP_PARENT)) {
  const pid = Number.parseInt(name, 10);
  if (!(pid > 0) || processAlive(pid)) continue;
  try {
    fs.rmSync(path.join(TEST_TEMP_PARENT, name), { recursive: true, force: true });
  } catch {
    // still held open; the next run tries again
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
const TEST_TEMP = fs.mkdtempSync(path.join(TEST_TEMP_PARENT, `${process.pid}-`));
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = TEST_TEMP;
process.on('exit', () => {
  try {
    fs.rmSync(TEST_TEMP, { recursive: true, force: true });
  } catch {
    // a file still held open keeps the directory; the run's result stands
  }
});

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
    timeout: SPAWN_TIMEOUT_MS,
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

module.exports = { runHook, hookOutput, freshSession, writeTranscript, HOOKS_DIR, SPAWN_TIMEOUT_MS };
