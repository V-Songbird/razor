'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { readState, writeState, gateStateId, turnKey } = require('../hooks/razor-lib');

// Non-exempt (outside tmpdir/scratchpad), nonexistent, not under a tests/ dir.
const newFile = (i) => path.join(__dirname, '..', 'does-not-exist', `d${i}.js`);

const input = (sessionId, toolName, toolInput, extra) => ({
  session_id: sessionId,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput || {},
  ...extra,
});

describe('unit: state scoping helpers', () => {
  test('gateStateId namespaces by agent_id and falls back to the session', () => {
    assert.strictEqual(gateStateId({ session_id: 's1' }), 's1');
    assert.strictEqual(gateStateId({ session_id: 's1', agent_id: 'a9' }), 's1--a9');
  });

  test('turnKey prefers the harness prompt_id over the transcript', () => {
    assert.strictEqual(turnKey({ prompt_id: 'p-123', transcript_path: '/nope' }), 'p-123');
    assert.strictEqual(turnKey({ transcript_path: '' }), 'no-transcript');
  });
});

describe('integration: one process, one state', () => {
  test('a single Write feeds both the file meter and the search phase', () => {
    const session = freshSession();
    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(1) }, { prompt_id: 'p1' }))),
      null
    );
    const state = readState(session);
    assert.strictEqual(state.turn.count, 1);
    assert.strictEqual(state.searchPhase.hasEdited, true);
  });

  test('import guard outranks the file meter when one Write trips both; the retry passes both', () => {
    // Workspace at the plugin root: outside tmpdir (file meter live) and
    // outside tests/ (import guard live), with its own manifest.
    const ws = fs.mkdtempSync(path.join(__dirname, '..', 'disp-ws-'));
    try {
      fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4' } }));
      const session = freshSession();
      const env = { RAZOR_FILE_BUDGET: '1' };

      const first = input(session, 'Write', { file_path: path.join(ws, 'a.js'), content: 'const x = 1;\n' }, { prompt_id: 'p1' });
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', first, env)), null);

      const both = input(
        session,
        'Write',
        { file_path: path.join(ws, 'b.js'), content: "const axios = require('axios');\n" },
        { prompt_id: 'p1' }
      );
      const deny = hookOutput(runHook('pre-tool-use.js', both, env));
      assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(deny.hookSpecificOutput.permissionDecisionReason, /adds a new node dependency/);

      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', both, env)), null);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('integration: subagent budget isolation', () => {
  test("a subagent's searches never spend the main thread's post-edit budget", () => {
    const session = freshSession();
    runHook('pre-tool-use.js', input(session, 'Edit', {}));

    // Inside a subagent: fresh phase, unmetered pre-edit searching.
    const agent = { agent_id: 'agent-1' };
    for (let i = 0; i < 3; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep', {}, agent))), null);
    }

    // Main thread unaffected by the agent's searches: still budget 1.
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep', {}))), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, 'Glob', {})));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('a subagent gets its own file budget', () => {
    const session = freshSession();
    const env = { RAZOR_FILE_BUDGET: '1' };
    const agent = { agent_id: 'agent-2', prompt_id: 'p1' };
    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(10) }, agent), env)),
      null
    );
    const deny = hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(11) }, agent), env));
    assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');

    // Main thread's budget untouched by the agent's writes.
    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(12) }, { prompt_id: 'p1' }), env)),
      null
    );
  });

  test('the session-wide /razor off toggle silences subagent-scoped calls too', () => {
    const session = freshSession();
    writeState(session, { off: true });
    const agent = { agent_id: 'agent-3' };
    runHook('pre-tool-use.js', input(session, 'Edit', {}, agent));
    runHook('pre-tool-use.js', input(session, 'Grep', {}, agent));
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob', {}, agent))), null);
  });
});

describe('integration: prompt_id turn boundaries', () => {
  test('a new prompt_id resets the file budget without any transcript', () => {
    const session = freshSession();
    const env = { RAZOR_FILE_BUDGET: '1' };
    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(20) }, { prompt_id: 'turn-a' }), env)),
      null
    );
    const deny = hookOutput(
      runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(21) }, { prompt_id: 'turn-a' }), env)
    );
    assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');

    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Write', { file_path: newFile(22) }, { prompt_id: 'turn-b' }), env)),
      null
    );
  });
});
