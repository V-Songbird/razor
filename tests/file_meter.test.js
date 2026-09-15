'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession, writeTranscript } = require('./helpers');
const { stepTurn, classify, isExemptPath } = require('../hooks/file-meter');

// Nonexistent, outside tmpdir, outside any test/docs/config tree, so it
// classifies as production. Not under tests/ — that is the point of the
// classifier.
const REPO = path.join(__dirname, '..');
const newFile = (i) => path.join(REPO, 'src-does-not-exist', `f${i}.js`);

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

  test('uncounted kinds are tallied but never charged', () => {
    let turn;
    for (const kind of ['test', 'migration', 'config', 'docs', 'fixture', 'generated']) {
      turn = stepTurn(turn, 'turn-1', 1, kind).next;
    }
    assert.strictEqual(turn.count, 0);
    assert.strictEqual(turn.fired, false);
    assert.deepStrictEqual(turn.kinds, {
      test: 1,
      migration: 1,
      config: 1,
      docs: 1,
      fixture: 1,
      generated: 1,
    });
  });

  test('countAll charges every kind, for an operator-set ceiling', () => {
    let turn;
    const results = [];
    for (const kind of ['test', 'docs', 'production']) {
      const { next, deny } = stepTurn(turn, 'turn-1', 2, kind, true);
      turn = next;
      results.push(deny);
    }
    assert.deepStrictEqual(results, [false, false, true]);
  });
});

describe('unit: classify', () => {
  const cases = [
    ['src/service/order.js', 'production'],
    ['lib/parse.py', 'production'],
    ['tests/order.test.js', 'test'],
    ['src/order.spec.ts', 'test'],
    ['test_order.py', 'test'],
    ['__tests__/order.js', 'test'],
    ['tests/fixtures/order.json', 'test'],
    ['testdata/order.bin', 'fixture'],
    ['__snapshots__/order.js.snap', 'fixture'],
    ['db/migrations/001_add_orders.sql', 'migration'],
    ['dist/bundle.js', 'generated'],
    ['src/api.pb.go', 'generated'],
    ['src/proto/order_pb2.py', 'generated'],
    ['types/index.d.ts', 'generated'],
    ['docs/design.md', 'docs'],
    ['NOTES.md', 'docs'],
    ['config/app.yaml', 'config'],
    ['package.json', 'config'],
    ['.eslintrc.json', 'config'],
    ['vite.config.ts', 'config'],
    ['Dockerfile', 'config'],
    // Content and tooling, not modules to maintain: five icons used to spend
    // the whole production budget and deny the sixth write of the turn.
    ['public/icons/home.svg', 'asset'],
    ['assets/logo.png', 'asset'],
    ['fonts/inter.woff2', 'asset'],
    ['.gitignore', 'config'],
    ['.editorconfig', 'config'],
    ['.env.example', 'config'],
  ];
  for (const [file, kind] of cases) {
    test(`${file} -> ${kind}`, () => {
      assert.strictEqual(classify(path.join(REPO, file)), kind);
    });
  }
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

  test('5th new production file denied, 6th passes, new turn resets', () => {
    const session = freshSession();
    const t1 = writeTranscript('turn-uuid-1');
    for (let i = 1; i <= 4; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t1, newFile(i)))), null);
    }
    const fifth = hookOutput(runHook('pre-tool-use.js', input(session, t1, newFile(5))));
    assert.strictEqual(fifth.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(fifth.hookSpecificOutput.permissionDecisionReason, /razor: new production file #5/);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t1, newFile(6)))), null);

    const t2 = writeTranscript('turn-uuid-2');
    for (let i = 1; i <= 4; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t2, newFile(10 + i)))), null);
    }
  });

  test('a feature shipping with tests, a migration and config is never denied', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-shape');
    const files = [
      'src-does-not-exist/order.js',
      'tests/order.test.js',
      'tests/order2.test.js',
      'db/migrations/001_orders.sql',
      'db/migrations/002_orders.sql',
      'config/orders.yaml',
      'docs/orders.md',
      'dist/orders.min.js',
    ].map((f) => path.join(REPO, f));
    for (const f of files) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, f))), null);
    }
  });

  test('the deny names the uncounted work and the placement', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-msg');
    runHook('pre-tool-use.js', input(session, t, path.join(REPO, 'tests', 'a.test.js')));
    runHook('pre-tool-use.js', input(session, t, path.join(REPO, 'docs', 'a.md')));
    for (let i = 1; i <= 4; i++) {
      runHook('pre-tool-use.js', input(session, t, newFile(40 + i)));
    }
    const denied = hookOutput(runHook('pre-tool-use.js', input(session, t, newFile(45))));
    const reason = denied.hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /razor: new production file #5 this turn \(budget 4\)/);
    assert.match(reason, /uncounted: 1 tests, 1 docs/);
    assert.match(reason, /creates a new directory, src-does-not-exist\//);
    assert.match(reason, /does this shape match what was asked for\?/);
  });

  test('existing files are never gated', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-3');
    for (let i = 0; i < 6; i++) {
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, __filename))), null);
    }
  });

  test('tmpdir files are exempt even past budget', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-4');
    for (let i = 0; i < 6; i++) {
      const p = path.join(os.tmpdir(), 'razor-nope', `f${i}.js`);
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, p))), null);
    }
  });

  test('RAZOR_FILE_BUDGET=0 disables the meter', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-5');
    for (let i = 0; i < 3; i++) {
      const r = runHook('pre-tool-use.js', input(session, t, newFile(20 + i)), { RAZOR_FILE_BUDGET: '0' });
      assert.strictEqual(hookOutput(r), null);
    }
  });

  test('RAZOR_FILE_BUDGET=1 fires on the second new file', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-6');
    const env = { RAZOR_FILE_BUDGET: '1' };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, newFile(30)), env)), null);
    const second = hookOutput(runHook('pre-tool-use.js', input(session, t, newFile(31)), env));
    assert.strictEqual(second.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('an explicit budget is a raw ceiling: tests and docs count too', () => {
    const session = freshSession();
    const t = writeTranscript('turn-uuid-raw');
    const env = { RAZOR_FILE_BUDGET: '2' };
    const files = [
      path.join(REPO, 'tests', 'raw1.test.js'),
      path.join(REPO, 'docs', 'raw1.md'),
      path.join(REPO, 'config', 'raw1.yaml'),
    ];
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, files[0]), env)), null);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, t, files[1]), env)), null);
    const third = hookOutput(runHook('pre-tool-use.js', input(session, t, files[2]), env));
    assert.strictEqual(third.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(third.hookSpecificOutput.permissionDecisionReason, /razor: new file #3/);
  });
});
