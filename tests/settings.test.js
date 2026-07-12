'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');

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

  test('search_budget option is honored', () => {
    const session = freshSession();
    const env = { CLAUDE_PLUGIN_OPTION_SEARCH_BUDGET: '2' };
    runHook('pre-tool-use.js', input(session, 'Edit', {}), env);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep', {}), env)), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob', {}), env)), null);
    const third = hookOutput(runHook('pre-tool-use.js', input(session, 'Grep', {}), env));
    assert.strictEqual(third.hookSpecificOutput.permissionDecision, 'deny');
  });
});

describe('integration: persistent state dir and cleanup', () => {
  test('state lands in CLAUDE_PLUGIN_DATA and session-end removes it, agent files included', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-data-'));
    const session = freshSession();
    const env = { CLAUDE_PLUGIN_DATA: dataDir };

    runHook('pre-tool-use.js', input(session, 'Edit', {}), env);
    runHook('pre-tool-use.js', input(session, 'Grep', {}, { agent_id: 'ag1' }), env);
    const files = fs.readdirSync(dataDir).filter((f) => f.startsWith('razor-') && f.endsWith('.json'));
    assert.strictEqual(files.length, 2); // session state + agent-scoped state

    runHook('session-end.js', { session_id: session, hook_event_name: 'SessionEnd' }, env);
    assert.strictEqual(fs.readdirSync(dataDir).length, 0);
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
