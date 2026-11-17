'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { shouldInject } = require('../hooks/subagent-start');
const { RULESET, SUBAGENT_RULESET, DRIFT_NOTE, writeState } = require('../hooks/razor-lib');
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
    assert.strictEqual(parseToggle('razor on'), 'on');
    assert.strictEqual(parseToggle('razor:razor on'), 'on');
    assert.strictEqual(parseToggle('/razor:razor on.'), 'on');
    assert.strictEqual(parseToggle('  RAZOR OFF!  '), 'off');
    assert.strictEqual(parseToggle('stop razor.'), 'off');
  });

  test('a toggle followed by more text is not a toggle', () => {
    assert.strictEqual(parseToggle('razor off-by-one bug in parser.js'), null);
    assert.strictEqual(parseToggle('razor on windows fails'), null);
    assert.strictEqual(parseToggle('razor off\n\nfix the build'), null);
    assert.strictEqual(parseToggle('**razor off**'), null);
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

  test('subagent-start wraps the short ladder in the SubagentStart JSON envelope', () => {
    const out = hookOutput(
      runHook('subagent-start.js', {
        session_id: freshSession(),
        hook_event_name: 'SubagentStart',
        agent_type: 'general-purpose',
      })
    );
    assert.strictEqual(out.hookSpecificOutput.hookEventName, 'SubagentStart');
    assert.strictEqual(out.hookSpecificOutput.additionalContext, SUBAGENT_RULESET);
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

// The ladder is frozen by owner decision, but nothing detected a change to it:
// the only assertion compared the emitted string to the same constant it came
// from. These pin the content itself, with literals, so a drift fails here.
// The published benchmark numbers predate the one-lookup-per-rung sentence;
// they were measured with the earlier "One check is enough" wording.
const RUNG_OPENINGS = [
  '1. Not genuinely needed?',
  '2. Already in this codebase?',
  '3. Stdlib does it?',
  '4. Native platform feature does it?',
  '5. An already-installed dependency does it?',
  '6. Fits in one line?',
  '7. Only then: the minimum code that works',
];

function assertSevenRungs(ladder) {
  let at = -1;
  for (const opening of RUNG_OPENINGS) {
    const next = ladder.indexOf(opening);
    assert.notStrictEqual(next, -1, `missing rung: ${opening}`);
    assert.ok(next > at, `out of order: ${opening}`);
    at = next;
  }
  assert.strictEqual(ladder.match(/^\d\. /gm).length, 7);
}

describe('the frozen ladder', () => {
  test('opens with the marker the harness matches on', () => {
    assert.ok(RULESET.startsWith('RAZOR ACTIVE\n'), RULESET.slice(0, 40));
  });

  test('carries exactly seven rungs, in order, each with its own first words', () => {
    assertSevenRungs(RULESET);
  });

  test('keeps the no-narration, one-lookup-per-rung and never-cut clauses', () => {
    assert.match(RULESET, /Never narrate or deliberate the rungs in your output\./);
    assert.match(RULESET, /One lookup per rung is enough/);
    assert.match(RULESET, /Never cut: validation at trust boundaries/);
  });

  test('gives no order about the model\'s own reasoning', () => {
    assert.doesNotMatch(RULESET, /thinking|reasoning/i);
  });
});

// A subagent's copy rides every request of that subagent, so it gets a short
// form of the same ladder. It must stay a short form: the same seven rungs, the
// one-lookup and no-narration limits and the never-cut list, in under half the text.
describe('the subagent ladder', () => {
  test('opens with the same marker and carries the same seven rungs', () => {
    assert.ok(SUBAGENT_RULESET.startsWith('RAZOR ACTIVE\n'), SUBAGENT_RULESET.slice(0, 40));
    assertSevenRungs(SUBAGENT_RULESET);
  });

  test('keeps the one-lookup, no-narration, new-dependency and never-cut clauses', () => {
    assert.match(SUBAGENT_RULESET, /One lookup per rung/);
    assert.match(SUBAGENT_RULESET, /never narrate the rungs in your output/);
    assert.match(SUBAGENT_RULESET, /Never add a new one for what a few lines cover/);
    assert.match(SUBAGENT_RULESET, /Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility, or anything explicitly requested\./);
  });

  test('is under half the session ladder and gives no order about reasoning', () => {
    assert.ok(SUBAGENT_RULESET.length * 2 < RULESET.length, `${SUBAGENT_RULESET.length} of ${RULESET.length}`);
    assert.doesNotMatch(SUBAGENT_RULESET, /thinking|reasoning/i);
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
    assert.match(r.stdout, /If a later request has left the first prompt's task/);
    assert.doesNotMatch(r.stdout, /RAZOR ACTIVE/);
    // UserPromptSubmit takes raw text; wrapping it injects nothing, silently.
    assert.doesNotMatch(r.stdout, /hookSpecificOutput/);
  });

  test('the say-once sentence is present — without it the note repeats after a drift', () => {
    assert.match(DRIFT_NOTE, /Say it at most once in a session\./);
  });

  test('it is a note, not a gate: drift alone never stops, asks or declines', () => {
    assert.match(DRIFT_NOTE, /do the work anyway, then add one line/);
    assert.match(DRIFT_NOTE, /Drift alone is no reason to stop, ask or decline/);
    assert.match(DRIFT_NOTE, /stay quiet on the same job/);
  });

  // It rides every prompt, so its size is paid on every later request.
  test('stays short: under 300 characters', () => {
    assert.ok(DRIFT_NOTE.length < 300, String(DRIFT_NOTE.length));
  });

  test('it gives no standing order against asking or refusing for other reasons', () => {
    assert.doesNotMatch(DRIFT_NOTE, /never (stop to )?ask|never refuse/i);
  });

  test('a toggle prompt answers the toggle instead', () => {
    const off = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor off' });
    assert.match(off.stdout, /RAZOR OFF/);
    assert.doesNotMatch(off.stdout, /Drift alone/);

    const on = runHook('mode-toggle.js', { session_id: freshSession(), prompt: '/razor on' });
    assert.match(on.stdout, /RAZOR ACTIVE/);
    assert.doesNotMatch(on.stdout, /Drift alone/);
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
