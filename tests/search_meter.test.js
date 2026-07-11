'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { stepPhase } = require('../hooks/search-meter');

describe('unit: stepPhase', () => {
  test('pre-edit searches are never metered, however many in a row', () => {
    let phase;
    const results = [];
    for (let i = 0; i < 6; i++) {
      const { next, deny } = stepPhase(phase, 'Glob', 1);
      phase = next;
      results.push(deny);
    }
    assert.deepStrictEqual(results, [false, false, false, false, false, false]);
    assert.strictEqual(phase.hasEdited, false);
  });

  test('Edit flips the phase; the 2nd post-edit search is denied once, then self-clears', () => {
    let phase = stepPhase(undefined, 'Edit', 1).next;
    assert.strictEqual(phase.hasEdited, true);
    const results = [];
    for (let i = 0; i < 4; i++) {
      const { next, deny } = stepPhase(phase, 'Glob', 1);
      phase = next;
      results.push(deny);
    }
    assert.deepStrictEqual(results, [false, true, false, false]);
  });

  test('Write also flips the phase', () => {
    const phase = stepPhase(undefined, 'Write', 1).next;
    assert.strictEqual(phase.hasEdited, true);
  });

  test('Read resets the post-edit count but not the phase itself', () => {
    let phase = stepPhase(undefined, 'Edit', 1).next;
    phase = stepPhase(phase, 'Glob', 1).next;
    phase = stepPhase(phase, 'Glob', 1).next; // denied, fired=true
    assert.strictEqual(phase.fired, true);
    const afterRead = stepPhase(phase, 'Read', 1);
    assert.strictEqual(afterRead.deny, false);
    assert.deepStrictEqual(
      { hasEdited: afterRead.next.hasEdited, count: afterRead.next.count, fired: afterRead.next.fired },
      { hasEdited: true, count: 0, fired: false },
    );
    // a fresh post-edit streak can fire again after the reset
    let deny;
    ({ next: phase, deny } = stepPhase(afterRead.next, 'Glob', 1));
    assert.strictEqual(deny, false);
    ({ next: phase, deny } = stepPhase(phase, 'Glob', 1));
    assert.strictEqual(deny, true);
  });
});

describe('integration: post-edit search budget', () => {
  const input = (sessionId, toolName) => ({
    session_id: sessionId,
    transcript_path: '',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: {},
  });

  test('unlimited searches pass before the first Edit', () => {
    const session = freshSession();
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob'))), null);
    }
  });

  test('after an Edit, the 2nd search is denied, the 3rd passes, Read resets it', () => {
    const session = freshSession();
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Edit'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'))), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, 'Glob')));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(second.hookSpecificOutput.permissionDecisionReason, /post-edit budget 1/);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'))), null);

    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Read'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob'))), null);
  });

  test('Write also starts the metered phase', () => {
    const session = freshSession();
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Write'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'))), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, 'Glob')));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('unrelated tools are ignored, not counted or reset', () => {
    const session = freshSession();
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Edit'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'WebFetch'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'))), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, 'Glob')));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('shell commands reset the streak — running a check is acting, not searching', () => {
    const session = freshSession();
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Edit'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'))), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'PowerShell'))), null);
    // streak reset by the shell call — this search is #1 again, not #2
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob'))), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, 'Grep')));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('RAZOR_SEARCH_BUDGET=0 disables the meter', () => {
    const session = freshSession();
    const env = { RAZOR_SEARCH_BUDGET: '0' };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Edit'), env)), null);
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob'), env)), null);
    }
  });

  test('RAZOR_SEARCH_BUDGET=2 allows two post-edit searches before denying the third', () => {
    const session = freshSession();
    const env = { RAZOR_SEARCH_BUDGET: '2' };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Edit'), env)), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'), env)), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'Glob'), env)), null);
    const third = hookOutput(runHook('pre-tool-use.js', input(session, 'Grep'), env));
    assert.strictEqual(third.hookSpecificOutput.permissionDecision, 'deny');
  });
});
