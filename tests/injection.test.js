'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { shouldInject, DEFAULT_SKIP } = require('../hooks/subagent-start');
const { RULESET, writeState } = require('../hooks/razor-lib');
const { parseToggle } = require('../hooks/mode-toggle');

describe('unit: shouldInject', () => {
  test('default skip list covers read-only built-ins', () => {
    for (const t of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']) {
      assert.strictEqual(shouldInject(t, {}), false, t);
    }
  });

  test('unknown and code-writing agents get the ruleset', () => {
    for (const t of ['general-purpose', 'claude', 'forge:forge-implementer', 'my-custom-agent']) {
      assert.strictEqual(shouldInject(t, {}), true, t);
    }
  });

  test('RAZOR_AGENT_SKIP extends the default list, bare or plugin-scoped', () => {
    const env = { RAZOR_AGENT_SKIP: 'adversarial-critic, forge-expert' };
    assert.strictEqual(shouldInject('forge:adversarial-critic', env), false);
    assert.strictEqual(shouldInject('forge:forge-expert', env), false);
    assert.strictEqual(shouldInject('Explore', env), false); // defaults kept
    assert.strictEqual(shouldInject('general-purpose', env), true);
  });

  test('RAZOR_AGENT_INJECT overrides any skip', () => {
    assert.strictEqual(shouldInject('Explore', { RAZOR_AGENT_INJECT: 'explore' }), true);
  });
});

describe('unit: parseToggle', () => {
  test('recognized forms', () => {
    assert.strictEqual(parseToggle('/razor off'), 'off');
    assert.strictEqual(parseToggle('/razor on'), 'on');
    assert.strictEqual(parseToggle('/razor:razor off'), 'off');
    assert.strictEqual(parseToggle('razor off'), 'off');
    assert.strictEqual(parseToggle('stop razor'), 'off');
    assert.strictEqual(parseToggle('Stop Razor!'), 'off');
  });

  test('unrelated prompts are ignored', () => {
    assert.strictEqual(parseToggle('sharpen the razor logic in utils.js'), null);
    assert.strictEqual(parseToggle('fix the login bug'), null);
    assert.strictEqual(parseToggle(''), null);
  });
});

describe('integration: injection lifecycle', () => {
  test('session-start emits the ladder as raw stdout', () => {
    const r = runHook('session-start.js', { session_id: freshSession(), hook_event_name: 'SessionStart' });
    assert.match(r.stdout, /RAZOR ACTIVE/);
    assert.match(r.stdout, /first rung that holds/);
    // rung 5 covers dependency-by-import, not just install commands
    assert.match(r.stdout, /IS adding a dependency/);
  });

  test('session-start is silent under RAZOR_DISABLE', () => {
    const r = runHook(
      'session-start.js',
      { session_id: freshSession(), hook_event_name: 'SessionStart' },
      { RAZOR_DISABLE: '1' }
    );
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('subagent-start wraps the ladder in the SubagentStart JSON envelope', () => {
    const out = hookOutput(
      runHook('subagent-start.js', {
        session_id: freshSession(),
        hook_event_name: 'SubagentStart',
        agent_type: 'general-purpose',
      })
    );
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, RULESET);
  });

  test('subagent-start is silent for skipped agent types', () => {
    const r = runHook('subagent-start.js', {
      session_id: freshSession(),
      hook_event_name: 'SubagentStart',
      agent_type: 'Explore',
    });
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('"/razor off" parks every hook for the session; "/razor on" re-arms', () => {
    const session = freshSession();
    const off = runHook('mode-toggle.js', { session_id: session, prompt: '/razor off' });
    assert.match(off.stdout, /RAZOR OFF/);

    const sessionStart = runHook('session-start.js', { session_id: session, hook_event_name: 'SessionStart' });
    assert.strictEqual(sessionStart.stdout.trim(), '');

    const dep = runHook('dep-guard.js', {
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'npm i lodash' },
    });
    assert.strictEqual(dep.stdout.trim(), '');

    const on = runHook('mode-toggle.js', { session_id: session, prompt: '/razor on' });
    assert.match(on.stdout, /RAZOR ACTIVE/);

    const dep2 = hookOutput(
      runHook('dep-guard.js', {
        session_id: session,
        tool_name: 'Bash',
        tool_input: { command: 'npm i axios' },
      })
    );
    assert.strictEqual(dep2.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('state fails safe to on when the subagent session is unknown', () => {
    // writeState never ran for this id — isActive defaults to on.
    const out = hookOutput(
      runHook('subagent-start.js', {
        session_id: freshSession(),
        hook_event_name: 'SubagentStart',
        agent_type: 'general-purpose',
      })
    );
    assert.ok(out.hookSpecificOutput.additionalContext.includes('RAZOR ACTIVE'));
  });

  test('an off state written directly silences the subagent hook', () => {
    const session = freshSession();
    writeState(session, { off: true });
    const r = runHook('subagent-start.js', {
      session_id: session,
      hook_event_name: 'SubagentStart',
      agent_type: 'general-purpose',
    });
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('DEFAULT_SKIP stays lean — every entry is a known non-coding agent', () => {
    assert.ok(DEFAULT_SKIP.length <= 8);
  });
});
