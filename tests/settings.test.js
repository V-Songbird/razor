'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { shouldFire } = require('../hooks/build-ledger');

const newFile = (i) => path.join(__dirname, '..', 'does-not-exist', `s${i}.js`);

const input = (sessionId, toolName, toolInput, extra) => ({
  session_id: sessionId,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput || {},
  ...extra,
});

describe('integration: plugin options (CLAUDE_PLUGIN_OPTION_*)', () => {
  test('file_budget option is honored', () => {
    const session = freshSession();
    const env = { CLAUDE_PLUGIN_OPTION_FILE_BUDGET: '1' };
    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(1) }, { prompt_id: 'p1' }), env)),
      null
    );
    const deny = hookOutput(
      runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(2) }, { prompt_id: 'p1' }), env)
    );
    assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('an explicit RAZOR_FILE_BUDGET env var overrides the option', () => {
    const session = freshSession();
    const env = { CLAUDE_PLUGIN_OPTION_FILE_BUDGET: '1', RAZOR_FILE_BUDGET: '2' };
    for (let i = 3; i <= 4; i++) {
      assert.strictEqual(
        hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(i) }, { prompt_id: 'p1' }), env)),
        null
      );
    }
    const deny = hookOutput(
      runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(5) }, { prompt_id: 'p1' }), env)
    );
    assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('dep_guard=false option silences the install gate', () => {
    const r = runHook(
      'pre-tool-use.js',
      input(freshSession(), 'Bash', { command: 'npm i lodash' }),
      { CLAUDE_PLUGIN_OPTION_DEP_GUARD: 'false' }
    );
    assert.strictEqual(hookOutput(r), null);
  });

  test('an explicit RAZOR_DEP_GUARD env var wins over the option', () => {
    const out = hookOutput(
      runHook('pre-tool-use.js', input(freshSession(), 'Bash', { command: 'npm i lodash' }), {
        CLAUDE_PLUGIN_OPTION_DEP_GUARD: 'false',
        RAZOR_DEP_GUARD: 'on',
      })
    );
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  });

});

describe('integration: persistent state dir and cleanup', () => {
  test('state lands in CLAUDE_PLUGIN_DATA, agent-scoped files included', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-data-'));
    const session = freshSession();
    const env = { CLAUDE_PLUGIN_DATA: dataDir };

    runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(30) }, { prompt_id: 'p1' }), env);
    runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(31) }, { agent_id: 'ag1', prompt_id: 'p1' }), env);
    const files = fs.readdirSync(dataDir).filter((f) => f.startsWith('razor-') && f.endsWith('.json'));
    assert.strictEqual(files.length, 2); // session state + agent-scoped state
  });

  test('session-start sweeps razor state files older than a week, keeps fresh ones', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-data-'));
    const stale = path.join(dataDir, 'razor-dead-session.json');
    const fresh = path.join(dataDir, 'razor-live-session.json');
    fs.writeFileSync(stale, '{}');
    fs.writeFileSync(fresh, '{}');
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stale, eightDaysAgo, eightDaysAgo);

    runHook(
      'session-start.js',
      { session_id: freshSession(), hook_event_name: 'SessionStart' },
      { CLAUDE_PLUGIN_DATA: dataDir }
    );
    assert.strictEqual(fs.existsSync(stale), false);
    assert.strictEqual(fs.existsSync(fresh), true);
  });
});

describe('RAZOR_DISABLE silences every hook, not just the gates', () => {
  test('mode-toggle emits nothing for "/razor on" under the kill switch', () => {
    const r = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor on' }, { RAZOR_DISABLE: '1' });
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('mode-toggle still answers "/razor on" without the kill switch', () => {
    const r = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor on' }, { RAZOR_DISABLE: '' });
    assert.match(r.stdout, /RAZOR ACTIVE/);
  });
});

describe('the plugin-option wiring reaches every gate it declares', () => {
  const off = (key) => ({ [`CLAUDE_PLUGIN_OPTION_${key}`]: 'false' });

  test('dep_guard=false silences the install gate', () => {
    const r = runHook('pre-tool-use.js', {
      session_id: freshSession(), tool_name: 'Bash', tool_input: { command: 'npm i axios' },
    }, off('DEP_GUARD'));
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('import_guard=false silences the import gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-opt-imp-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4' } }));
    const r = runHook('pre-tool-use.js', {
      session_id: freshSession(), tool_name: 'Write',
      tool_input: { file_path: path.join(dir, 'a.js'), content: "require('axios');\n" },
    }, off('IMPORT_GUARD'));
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('manifest_guard=false silences the manifest gate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-opt-man-'));
    const file = path.join(dir, 'package.json');
    fs.writeFileSync(file, JSON.stringify({ dependencies: { lodash: '^4' } }, null, 2));
    const r = runHook('pre-tool-use.js', {
      session_id: freshSession(), tool_name: 'Edit',
      tool_input: { file_path: file, old_string: '"lodash": "^4"', new_string: '"lodash": "^4",\n    "axios": "^1"' },
    }, off('MANIFEST_GUARD'));
    assert.strictEqual(r.stdout.trim(), '');
  });
});

describe('the ledger thresholds are readable knobs', () => {
  test('a generous budget does not fire on a diff a tight one would catch', () => {
    assert.strictEqual(shouldFire({ insertions: 600, deletions: 0, newFiles: 2 }, 500, 8), true);
    assert.strictEqual(shouldFire({ insertions: 600, deletions: 0, newFiles: 2 }, 5000, 8), false);
  });

  test('the new-file budget fires on its own', () => {
    assert.strictEqual(shouldFire({ insertions: 10, deletions: 5, newFiles: 9 }, 500, 8), true);
    assert.strictEqual(shouldFire({ insertions: 10, deletions: 5, newFiles: 9 }, 500, 20), false);
  });
});
