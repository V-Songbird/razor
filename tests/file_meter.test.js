'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession, writeTranscript } = require('./helpers');
const { stepTurn, isExemptPath } = require('../hooks/file-meter');

// Nonexistent, outside tmpdir, cross-platform.
const newFile = (i) => path.join(__dirname, 'does-not-exist', `f${i}.js`);

describe('unit: stepTurn', () => {
  test('fires once when the budget is crossed, then self-clears', () => {
    let turn;
    const results = [];
    for (let i = 0; i < 7; i++) {
      const { next, deny } = stepTurn(turn, 'turn-1', 4);
      turn = next;
      results.push(deny);
    }
    assert.deepStrictEqual(results, [false, false, false, false, true, false, false]);
  });

  test('a new turn key resets the counter', () => {
    let turn;
    for (let i = 0; i < 5; i++) turn = stepTurn(turn, 'turn-1', 4).next;
    assert.strictEqual(turn.fired, true);
    const { next, deny } = stepTurn(turn, 'turn-2', 4);
    assert.strictEqual(deny, false);
    assert.deepStrictEqual({ count: next.count, fired: next.fired }, { count: 1, fired: false });
  });
});

describe('unit: isExemptPath', () => {
  test('tmpdir and scratchpad are exempt, repo paths are not', () => {
    assert.strictEqual(isExemptPath(path.join(os.tmpdir(), 'x', 'y.js')), true);
    assert.strictEqual(isExemptPath(path.join('D:', 'w', 'scratchpad', 'y.js')), true);
    assert.strictEqual(isExemptPath(newFile(0)), false);
  });
});

describe('integration: per-turn budget', () => {
  const input = (sessionId, transcript, filePath) => ({
    session_id: sessionId,
    transcript_path: transcript,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: filePath },
  });

  test('5th new file denied, 6th passes, new turn resets', () => {
    const session = freshSession();
    const t1 = writeTranscript('turn-uuid-1');
    for (let i = 1; i <= 4; i++) {
      assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t1, newFile(i)))), null);
    }
    const fifth = hookOutput(runHook('file-meter.js', input(session, t1, newFile(5))));
    assert.strictEqual(fifth.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(fifth.hookSpecificOutput.permissionDecisionReason, /razor: new file #5/);
    assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t1, newFile(6)))), null);

    const t2 = writeTranscript('turn-uuid-2');
    for (let i = 1; i <= 4; i++) {
      assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t2, newFile(10 + i)))), null);
    }
  });

  test('existing files are never gated', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-3');
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t, __filename))), null);
    }
  });

  test('tmpdir files are exempt even past budget', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-4');
    for (let i = 0; i < 6; i++) {
      const p = path.join(os.tmpdir(), 'razor-nope', `f${i}.js`);
      assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t, p))), null);
    }
  });

  test('RAZOR_FILE_BUDGET=0 disables the meter', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-5');
    for (let i = 0; i < 3; i++) {
      const r = runHook('file-meter.js', input(session, t, newFile(20 + i)), { RAZOR_FILE_BUDGET: '0' });
      assert.strictEqual(hookOutput(r), null);
    }
  });

  test('RAZOR_FILE_BUDGET=1 fires on the second new file', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-6');
    const env = { RAZOR_FILE_BUDGET: '1' };
    assert.strictEqual(hookOutput(runHook('file-meter.js', input(session, t, newFile(30)), env)), null);
    const second = hookOutput(runHook('file-meter.js', input(session, t, newFile(31)), env));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });
});
