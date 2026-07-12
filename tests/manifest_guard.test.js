'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { jsonDepNames, reqDepNames, simulate } = require('../hooks/manifest-guard');

const PKG = JSON.stringify(
  { name: 'ws', version: '1.0.0', dependencies: { express: '^4.19.2', lodash: '^4.17.21' } },
  null,
  2
);

function workspace(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-mg-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const input = (sessionId, toolName, toolInput) => ({
  session_id: sessionId,
  hook_event_name: 'PreToolUse',
  tool_name: toolName,
  tool_input: toolInput,
});

describe('unit: dependency-name extraction', () => {
  test('package.json: dependencies + devDependencies, lowercased', () => {
    const names = jsonDepNames(JSON.stringify({
      dependencies: { Express: '^4' }, devDependencies: { jest: '^29' }, scripts: { test: 'x' },
    }));
    assert.deepStrictEqual([...names].sort(), ['express', 'jest']);
  });

  test('unparseable JSON yields null, not an empty set', () => {
    assert.strictEqual(jsonDepNames('{ not json'), null);
  });

  test('requirements.txt: names without specifiers, comments and flags skipped', () => {
    const names = reqDepNames('# deps\nrequests==2.31\nFlask[async]>=2\n-r other.txt\n\n');
    assert.deepStrictEqual([...names].sort(), ['flask', 'requests']);
  });

  test('simulate applies an Edit against on-disk content', () => {
    assert.strictEqual(simulate('Edit', { old_string: 'b', new_string: 'x' }, 'abc'), 'axc');
    assert.strictEqual(simulate('Edit', { old_string: 'zz', new_string: 'x' }, 'abc'), null);
    assert.strictEqual(simulate('Write', { content: 'new' }, 'abc'), 'new');
  });
});

describe('integration: manifest gate', () => {
  test('Write that adds a dependency to package.json: denied once with evidence, retry passes', () => {
    const ws = workspace({ 'package.json': PKG });
    const session = freshSession();
    const write = input(session, 'Write', {
      file_path: path.join(ws, 'package.json'),
      content: PKG.replace('"lodash": "^4.17.21"', '"lodash": "^4.17.21",\n    "pg": "^8.11.0"'),
    });
    const first = hookOutput(runHook('pre-tool-use.js', write));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /adds a new node dependency/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /`pg`/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /Already installed \(2\): express, lodash/);

    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('Edit fragment that adds a dependency is gated the same way', () => {
    const ws = workspace({ 'package.json': PKG });
    const session = freshSession();
    const edit = input(session, 'Edit', {
      file_path: path.join(ws, 'package.json'),
      old_string: '"lodash": "^4.17.21"',
      new_string: '"lodash": "^4.17.21",\n    "axios": "^1.7.0"',
    });
    const first = hookOutput(runHook('pre-tool-use.js', edit));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /`axios`/);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', edit)), null);
  });

  test('version bumps of existing entries never fire', () => {
    const ws = workspace({ 'package.json': PKG });
    const edit = input(freshSession(), 'Edit', {
      file_path: path.join(ws, 'package.json'),
      old_string: '"express": "^4.19.2"',
      new_string: '"express": "^5.0.0"',
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', edit)), null);
  });

  test('creating a fresh manifest is scaffolding, not gated', () => {
    const ws = workspace({});
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'package.json'),
      content: JSON.stringify({ name: 'new', dependencies: { pg: '^8' } }),
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('requirements.txt line adds are gated, python ecosystem named', () => {
    const ws = workspace({ 'requirements.txt': 'flask==3.0.3\nrequests==2.32.3\n' });
    const session = freshSession();
    const edit = input(session, 'Edit', {
      file_path: path.join(ws, 'requirements.txt'),
      old_string: 'requests==2.32.3\n',
      new_string: 'requests==2.32.3\ntenacity==8.3.0\n',
    });
    const first = hookOutput(runHook('pre-tool-use.js', edit));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /adds a new python dependency/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /`tenacity`/);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', edit)), null);
  });

  test('RAZOR_MANIFEST_GUARD=off disables the gate', () => {
    const ws = workspace({ 'package.json': PKG });
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'package.json'),
      content: PKG.replace('"lodash": "^4.17.21"', '"lodash": "^4.17.21",\n    "pg": "^8.11.0"'),
    });
    const r = runHook('pre-tool-use.js', write, { RAZOR_MANIFEST_GUARD: 'off' });
    assert.strictEqual(hookOutput(r), null);
  });
});

describe('integration: one reconsideration per dependency, across gates', () => {
  test('an install deny covers the later manifest edit for the same package', () => {
    const ws = workspace({ 'package.json': PKG });
    const session = freshSession();
    const install = hookOutput(
      runHook('pre-tool-use.js', input(session, 'Bash', { command: 'npm install pg' }))
    );
    assert.strictEqual(install.hookSpecificOutput.permissionDecision, 'deny');

    const edit = input(session, 'Edit', {
      file_path: path.join(ws, 'package.json'),
      old_string: '"lodash": "^4.17.21"',
      new_string: '"lodash": "^4.17.21",\n    "pg": "^8.11.0"',
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', edit)), null);
  });

  test('a manifest deny covers the later install and import for the same package', () => {
    const ws = workspace({ 'package.json': PKG });
    const session = freshSession();
    const edit = input(session, 'Edit', {
      file_path: path.join(ws, 'package.json'),
      old_string: '"lodash": "^4.17.21"',
      new_string: '"lodash": "^4.17.21",\n    "pg": "^8.11.0"',
    });
    const first = hookOutput(runHook('pre-tool-use.js', edit));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');

    assert.strictEqual(
      hookOutput(runHook('pre-tool-use.js', input(session, 'Bash', { command: 'npm install pg' }))),
      null
    );
    // package.json on disk still lacks pg (hooks never write), so the import
    // guard would fire — the shared ledger keeps it silent instead.
    const code = input(session, 'Write', {
      file_path: path.join(ws, 'db.js'),
      content: "const { Pool } = require('pg');\nmodule.exports = {};\n",
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', code)), null);
  });
});
