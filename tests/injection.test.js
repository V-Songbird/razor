'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { shouldInject } = require('../hooks/subagent-start');
const { RULESET, DRIFT_NOTE, writeState } = require('../hooks/razor-lib');
const { parseToggle } = require('../hooks/mode-toggle');

describe('unit: shouldInject', () => {
  test('default skip list covers read-only built-ins', () => {
    for (const t of ['Explore', 'Plan', 'claude-code-guide', 'statusline-setup']) {
      assert.strictEqual(shouldInject(t, {}), false, t);
    }
  });

  test('a built-in skip matches scoped or bare', () => {
    for (const t of ['explore', 'Explore', 'some-plugin:explore', 'SOME-PLUGIN:Explore']) {
      assert.strictEqual(shouldInject(t, {}), false, t);
    }
  });

  test('unknown and code-writing agents get the ruleset', () => {
    for (const t of [
      'general-purpose',
      'claude',
      'some-plugin:implementer',
      'some-plugin:reviser',
      'my-custom-agent',
    ]) {
      assert.strictEqual(shouldInject(t, {}), true, t);
    }
  });

  test('RAZOR_AGENT_SKIP extends the default list, bare or plugin-scoped', () => {
    const env = { RAZOR_AGENT_SKIP: 'code-reviewer, doc-checker' };
    assert.strictEqual(shouldInject('some-plugin:code-reviewer', env), false);
    assert.strictEqual(shouldInject('doc-checker', env), false);
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

    const dep = runHook('pre-tool-use.js', {
      session_id: session,
      tool_name: 'Bash',
      tool_input: { command: 'npm i lodash' },
    });
    assert.strictEqual(dep.stdout.trim(), '');

    const on = runHook('mode-toggle.js', { session_id: session, prompt: '/razor on' });
    assert.match(on.stdout, /RAZOR ACTIVE/);

    const dep2 = hookOutput(
      runHook('pre-tool-use.js', {
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
});

// The ladder is frozen by owner decision and the published benchmark numbers
// are tied to its exact text, but nothing detected a change to it: the only
// assertion compared the emitted string to the same constant it came from.
// These pin the content itself, with literals, so a drift fails here.
describe('the frozen ladder', () => {
  test('opens with the marker the harness matches on', () => {
    assert.ok(RULESET.startsWith('RAZOR ACTIVE\n'), RULESET.slice(0, 40));
  });

  test('carries exactly seven rungs, in order, each with its own first words', () => {
    const openings = [
      '1. Not genuinely needed?',
      '2. Already in this codebase?',
      '3. Stdlib does it?',
      '4. Native platform feature does it?',
      '5. An already-installed dependency does it?',
      '6. Fits in one line?',
      '7. Only then: the minimum code that works',
    ];
    let at = -1;
    for (const opening of openings) {
      const next = RULESET.indexOf(opening);
      assert.notStrictEqual(next, -1, `missing rung: ${opening}`);
      assert.ok(next > at, `out of order: ${opening}`);
      at = next;
    }
    assert.strictEqual(RULESET.match(/^\d\. /gm).length, 7);
  });

  test('keeps the three clauses the measured behaviour rests on', () => {
    assert.match(RULESET, /Never narrate or deliberate the rungs/);
    assert.match(RULESET, /One check is enough, anywhere in this task/);
    assert.match(RULESET, /Never cut: validation at trust boundaries/);
  });
});

describe('the ladder does not depend on git finishing', () => {
  test('session-start emits the ladder even where git cannot run', () => {
    // cwd points nowhere, so every git() call fails and no ledger is recorded.
    const r = runHook('session-start.js', {
      session_id: freshSession(),
      hook_event_name: 'SessionStart',
      cwd: '/definitely/not/a/repo/anywhere',
    });
    assert.match(r.stdout, /RAZOR ACTIVE/);
  });
});

describe('the drift note', () => {
  test('an ordinary prompt carries the note, and nothing else', () => {
    const r = runHook('mode-toggle.js', { session_id: freshSession(), prompt: 'fix the login bug' });
    assert.match(r.stdout, /Stay on the task the first user prompt named/);
    assert.doesNotMatch(r.stdout, /RAZOR ACTIVE/);
    // UserPromptSubmit takes raw text; wrapping it injects nothing, silently.
    assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
  });

  test('the say-once sentence is present — without it the note repeats after a drift', () => {
    assert.match(DRIFT_NOTE, /Say it at most once in a session/);
  });

  test('it is a note, not a gate: it never asks and never refuses', () => {
    assert.match(DRIFT_NOTE, /do the work anyway/);
    assert.match(DRIFT_NOTE, /Never stop to ask, never refuse/);
    assert.match(DRIFT_NOTE, /never say it when the request is still the same job/);
  });

  test('a toggle prompt answers the toggle instead', () => {
    const off = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor off' });
    assert.match(off.stdout, /RAZOR OFF/);
    assert.doesNotMatch(off.stdout, /Stay on the task/);

    const on = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor on' });
    assert.match(on.stdout, /RAZOR ACTIVE/);
    assert.doesNotMatch(on.stdout, /Stay on the task/);
  });

  test('"/razor off" silences it for the rest of the session', () => {
    const session = freshSession();
    writeState(session, { off: true });
    const r = runHook('mode-toggle.js', { session_id: session, prompt: 'add a retry helper' });
    assert.strictEqual(r.stdout.trim(), '');
  });

  test('the setting and the kill switch each silence it', () => {
    const prompt = { session_id: freshSession(), prompt: 'add a retry helper' };
    assert.strictEqual(runHook('mode-toggle.js', prompt, { RAZOR_DRIFT_NOTE: 'off' }).stdout.trim(), '');
    assert.strictEqual(
      runHook('mode-toggle.js', prompt, { CLAUDE_PLUGIN_OPTION_DRIFT_NOTE: 'false' }).stdout.trim(),
      ''
    );
    assert.strictEqual(runHook('mode-toggle.js', prompt, { RAZOR_DISABLE: '1' }).stdout.trim(), '');
  });
});
