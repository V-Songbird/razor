'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { freshSession } = require('./helpers');
const { parsePatch, previewUpdate, toToolCalls, nativeReason } = require('../hooks/lib/codex-tools');

const ROOT = path.resolve(__dirname, '..');
const patch = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch'].join('\n');
const input = (cwd, command, extra = {}) => ({
  session_id: freshSession(), turn_id: 'turn-a', cwd,
  hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command },
  ...extra,
});

function workspace(t, files = {}) {
  const ws = fs.mkdtempSync(path.join(ROOT, 'codex-patch-ws-'));
  t.after(() => {
    assert.ok(ws.startsWith(path.join(ROOT, 'codex-patch-ws-')));
    fs.rmSync(ws, { recursive: true, force: true });
  });
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(ws, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return ws;
}

function invoke(data, env = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'hooks/codex-hook.js'), 'PreToolUse'], {
    input: JSON.stringify(data), encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env, PLUGIN_DATA: path.join(data.cwd, '.state'),
      RAZOR_FILE_BUDGET: '', RAZOR_IMPORT_GUARD: '', RAZOR_MANIFEST_GUARD: '',
      RAZOR_DEP_GUARD: '', ...env,
    },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function state(data) {
  return JSON.parse(fs.readFileSync(path.join(data.cwd, '.state', 'razor-' + data.session_id + '.json'), 'utf8'));
}

function denyReason(output) {
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  return output.hookSpecificOutput.permissionDecisionReason;
}

describe('Codex patch preview', () => {
  test('passes existing canonical calls through without mutation', () => {
    const data = { tool_name: 'Bash', tool_input: { command: 'npm i axios' } };
    assert.equal(toToolCalls(data)[0], data);
    assert.deepEqual(toToolCalls(null), []);
  });

  test('parses compound add/update/move/delete and addition-only chunks', () => {
    const parsed = parsePatch(patch(
      '*** Add File: a.js', '+const a = 1;', '+',
      '*** Update File: b.js', '*** Move to: c.js', '@@ function b() {', '-old', '+new',
      '@@', '+tail', '*** End of File',
      '*** Delete File: d.js'
    ));
    assert.deepEqual(parsed.map((file) => file.kind), ['Add', 'Update', 'Delete']);
    assert.equal(parsed[1].move, 'c.js');
    assert.equal(parsed[1].chunks[0].anchor, 'function b() {');
    assert.equal(parsed[1].chunks[1].eof, true);
  });

  test('previews ordered hunks against original content and honors EOF', () => {
    const chunks = parsePatch(patch(
      '*** Update File: x.js', '@@ function a() {', '-old', '+changed', ' }',
      '@@ function b() {', ' keep', '-last', '+tail', '*** End of File'
    ))[0].chunks;
    assert.equal(
      previewUpdate('function a() {\nold\n}\nfunction b() {\nkeep\nlast\n', chunks),
      'function a() {\nchanged\n}\nfunction b() {\nkeep\ntail\n'
    );
    assert.equal(previewUpdate('function a() {\nold\n}\nfunction b() {\nkeep\nlast\nmore\n', chunks), null);
  });

  test('addition-only update appends, including with an anchor', () => {
    const chunks = parsePatch(patch('*** Update File: x', '@@ start', '+added'))[0].chunks;
    assert.equal(previewUpdate('start\nmiddle\n', chunks), 'start\nmiddle\nadded\n');
  });

  test('accepts CRLF, headerless first chunks and EOF newline context', () => {
    const command = patch('*** Update File: x', '-old', '+new', ' ', '*** End of File').replace(/\n/g, '\r\n');
    assert.equal(previewUpdate('old\r\n', parsePatch(command)[0].chunks), 'new\n');
  });

  test('retains indented patch markers and bare blank lines as context', () => {
    const chunks = parsePatch(patch(
      '*** Update File: x', '@@', ' *** Update File: text', '', '-old', '+new'
    ))[0].chunks;
    assert.equal(previewUpdate('*** Update File: text\n\nold\n', chunks), '*** Update File: text\n\nnew\n');
  });

  test('abstains on fuzzy, repeated, overlapping and binary input', () => {
    const chunks = parsePatch(patch('*** Update File: x', '@@', '-old', '+new'))[0].chunks;
    for (const content of [' old\n', 'old\nold\n', 'old\0\n', 'old\r']) {
      assert.equal(previewUpdate(content, chunks), null);
    }
    const overlap = parsePatch(patch('*** Update File: x', '@@', '-old', '+one', '@@', '-old', '+two'))[0].chunks;
    assert.equal(previewUpdate('old\n', overlap), null);
  });

  test('rejects malformed syntax and unsupported shells/remote targets', () => {
    for (const command of [
      undefined, {}, '', 'echo hello',
      patch('*** Add File: x', 'missing plus'),
      patch('*** Update File: x', '@@'),
      patch('*** Update File: x', '@@', '@@', '+x'),
      patch('*** Update File: x', '*** Move to: y'),
      patch('*** Delete File: x', '+bad'),
      patch('*** Environment ID: remote', '*** Add File: x', '+hi'),
      'apply_patch <<\'PATCH\'\n' + patch('*** Add File: x', '+hi') + '\nPATCH',
      patch('*** Add File: x', '+hi') + '\ntrailer',
    ]) assert.equal(parsePatch(command), null);
    assert.deepEqual(toToolCalls(input(ROOT, patch('*** Add File: ssh://host/x', '+hi'))), []);
  });

  test('resolves paths using hook cwd and never writes patch targets', (t) => {
    const ws = workspace(t, { 'old.js': 'const value = 1;\n', 'gone.js': 'remove me\n' });
    const data = input(ws, patch(
      '*** Add File: space name/new.js', '+const a = 1;',
      '*** Update File: old.js', '*** Move to: next.js', '@@', '-const value = 1;', '+const value = 2;',
      '*** Delete File: gone.js'
    ));
    const calls = toToolCalls(data);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].tool_name, 'Write');
    assert.equal(calls[0].tool_input.file_path, path.join(ws, 'space name/new.js'));
    assert.equal(calls[1].tool_name, 'Edit');
    assert.equal(calls[1].tool_input.file_path, path.join(ws, 'old.js'));
    assert.equal(calls[1].tool_input.new_string, 'const value = 2;\n');
    assert.equal(calls[1].turn_id, data.turn_id);
    assert.equal(fs.readFileSync(path.join(ws, 'old.js'), 'utf8'), 'const value = 1;\n');
    assert.equal(fs.existsSync(path.join(ws, 'next.js')), false);
    assert.equal(fs.existsSync(path.join(ws, 'space name')), false);
    assert.equal(fs.existsSync(path.join(ws, 'gone.js')), true);
  });

  test('abstains on whole patch when targets collide or a later update cannot apply', (t) => {
    const ws = workspace(t, { 'old.js': 'old\n' });
    for (const command of [
      patch('*** Add File: a.js', '+a', '*** Add File: ./a.js', '+b'),
      patch('*** Update File: old.js', '*** Move to: a.js', '@@', '-old', '+new', '*** Add File: a.js', '+a'),
      patch('*** Add File: a.js', '+a', '*** Update File: old.js', '@@', '-missing', '+new'),
      patch('*** Add File: a.js', '+a', '*** Update File: missing.js', '@@', '+new'),
      patch('*** Add File: old.js/child.js', '+a'),
      patch('*** Update File: old.js', '*** Move to: old.js/child.js', '@@', '-old', '+new'),
    ]) assert.deepEqual(toToolCalls(input(ws, command)), []);
  });

  test('native output names only the tool the model can retry', () => {
    assert.equal(nativeReason('this Edit: exact same Edit'), 'this apply_patch: exact same apply_patch');
    assert.equal(nativeReason('this Write: exact same Write'), 'this apply_patch: exact same apply_patch');
    assert.equal(nativeReason(null), null);
  });
});

describe('Codex PreToolUse native integration', () => {
  test('compound patch books every gate once, preserves global precedence, and retry passes', (t) => {
    const ws = workspace(t, { 'package.json': '{\n  "dependencies": {}\n}\n' });
    const data = input(ws, patch(
      '*** Add File: a.js', '+const a = require("axios");',
      '*** Add File: b.js', '+const b = require("got");',
      '*** Update File: package.json', '@@', '-  "dependencies": {}', '+  "dependencies": {"zod": "^4"}'
    ));
    const reason = denyReason(invoke(data, { RAZOR_FILE_BUDGET: '1' }));
    assert.match(reason, /this apply_patch to package.json/);
    assert.match(reason, /exact same apply_patch/);
    assert.doesNotMatch(reason, /\bWrite\b|\bEdit\b/);
    const booked = state(data);
    for (const name of ['zod', 'axios', 'got']) assert.equal(booked.deniedImports['node:' + name], true);
    assert.equal(booked.turn.count, 2);
    assert.equal(booked.turn.fired, true);
    assert.equal(booked.turn.turnKey, data.turn_id);
    assert.equal(invoke(data, { RAZOR_FILE_BUDGET: '1' }), null);
    assert.equal(state(data).turn.count, 2);
    assert.equal(fs.existsSync(path.join(ws, 'a.js')), false);
    assert.equal(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'), '{\n  "dependencies": {}\n}\n');
  });

  test('new imports in several files all reconsider on the initial denial', (t) => {
    const ws = workspace(t, { 'package.json': '{}', 'a.js': 'const a = 1;\n', 'b.py': 'x = 1\n', 'requirements.txt': '' });
    const data = input(ws, patch(
      '*** Update File: a.js', '@@', '+const a = require("axios");',
      '*** Update File: b.py', '@@', '+import requests'
    ));
    assert.match(denyReason(invoke(data)), /axios/);
    assert.equal(state(data).deniedImports['node:axios'], true);
    assert.equal(state(data).deniedImports['python:requests'], true);
    assert.equal(invoke(data), null);
    assert.equal(state(data).turn, undefined);
  });

  test('edits and moves grandfather existing imports while new imports still gate', (t) => {
    const ws = workspace(t, { 'package.json': '{}', 'old.js': 'const old = require("already-undeclared");\nconst value = 1;\n' });
    const moved = input(ws, patch(
      '*** Update File: old.js', '*** Move to: moved.js', '@@', '-const value = 1;', '+const value = 2;'
    ));
    assert.equal(invoke(moved, { RAZOR_FILE_BUDGET: '1' }), null);
    assert.equal(state(moved).turn, undefined);
    assert.equal(state(moved).deniedImports, undefined);
    const added = input(ws, patch(
      '*** Update File: old.js', '*** Move to: moved.js', '@@', '+const next = require("axios");'
    ));
    const reason = denyReason(invoke(added));
    assert.match(reason, /axios/);
    assert.doesNotMatch(reason, /already-undeclared/);
  });

  test('rename with unchanged context and deletion spend no new-file budget', (t) => {
    const ws = workspace(t, { 'package.json': '{}', 'old.js': 'require("unknown");\n', 'gone.js': 'gone\n' });
    const data = input(ws, patch(
      '*** Update File: old.js', '*** Move to: moved.js', '@@', ' require("unknown");',
      '*** Delete File: gone.js'
    ));
    assert.equal(invoke(data, { RAZOR_FILE_BUDGET: '1' }), null);
    assert.equal(state(data).turn, undefined);
    assert.equal(state(data).deniedImports, undefined);
  });

  test('moves check new imports against destination dependencies while retaining source imports', (t) => {
    const ws = workspace(t, {
      'package.json': '{}',
      'client/package.json': '{"dependencies":{"axios":"*"}}',
      'old.js': 'require("already-undeclared");\n',
    });
    const data = input(ws, patch(
      '*** Update File: old.js', '*** Move to: client/new.js', '@@', '+require("axios");'
    ));
    assert.equal(invoke(data), null);
    assert.equal(state(data).deniedImports, undefined);
    assert.equal(state(data).turn, undefined);
  });

  test('a source-only dependency still gates when a move newly imports it at the destination', (t) => {
    const ws = workspace(t, {
      'package.json': '{}',
      'client/package.json': '{"dependencies":{"axios":"*"}}',
      'client/old.js': 'const value = 1;\n',
    });
    const data = input(ws, patch(
      '*** Update File: client/old.js', '*** Move to: new.js', '@@', '+require("axios");'
    ));
    assert.match(denyReason(invoke(data)), /axios/);
    assert.equal(state(data).deniedImports['node:axios'], true);
    assert.equal(state(data).turn, undefined);
    assert.equal(invoke(data), null);
  });

  test('move import exemptions follow the destination test classification', (t) => {
    const ws = workspace(t, {
      'package.json': '{}', 'old.js': 'const value = 1;\n', 'tests/old.test.js': 'const value = 1;\n',
    });
    const intoTests = input(ws, patch(
      '*** Update File: old.js', '*** Move to: tests/new.test.js', '@@', '+require("test-framework");'
    ));
    assert.equal(invoke(intoTests), null);
    assert.equal(state(intoTests).deniedImports, undefined);
    const intoProduction = input(ws, patch(
      '*** Update File: tests/old.test.js', '*** Move to: new.js', '@@', '+require("axios");'
    ));
    assert.match(denyReason(invoke(intoProduction)), /axios/);
  });

  test('moved Python imports resolve local modules at the destination', (t) => {
    const ws = workspace(t, {
      'requirements.txt': '', 'old.py': 'value = 1\n', 'client/localpkg.py': 'value = 2\n',
      'client/source.py': 'value = 1\n',
    });
    const local = input(ws, patch(
      '*** Update File: old.py', '*** Move to: client/new.py', '@@', '+import localpkg'
    ));
    assert.equal(invoke(local), null);
    const external = input(ws, patch(
      '*** Update File: client/source.py', '*** Move to: new.py', '@@', '+import localpkg'
    ));
    assert.match(denyReason(invoke(external)), /localpkg/);
  });

  test('moving a manifest to a nonmanifest does not gate its added text as dependencies', (t) => {
    const ws = workspace(t, { 'requirements.txt': 'requests\n' });
    const data = input(ws, patch(
      '*** Update File: requirements.txt', '*** Move to: archive.txt', '@@', '+httpx'
    ));
    assert.equal(invoke(data), null);
    assert.equal(state(data).deniedImports, undefined);
    assert.equal(state(data).turn, undefined);
  });

  test('moving over an existing manifest compares against the destination baseline', (t) => {
    const ws = workspace(t, { 'incoming.txt': 'httpx\n', 'requirements.txt': 'requests\n' });
    const data = input(ws, patch(
      '*** Update File: incoming.txt', '*** Move to: requirements.txt', '@@', ' httpx'
    ));
    assert.match(denyReason(invoke(data)), /new python dependency.*httpx/);
    assert.equal(state(data).deniedImports['python:httpx'], true);
    assert.equal(state(data).turn, undefined);
    assert.equal(invoke(data), null);
    assert.equal(fs.readFileSync(path.join(ws, 'requirements.txt'), 'utf8'), 'requests\n');
    assert.equal(fs.readFileSync(path.join(ws, 'incoming.txt'), 'utf8'), 'httpx\n');
  });

  test('moving to an absent manifest preserves its greenfield exemption', (t) => {
    const ws = workspace(t, { 'requirements.txt': 'requests\n' });
    const data = input(ws, patch(
      '*** Update File: requirements.txt', '*** Move to: client/requirements.txt', '@@', '+httpx'
    ));
    assert.equal(invoke(data), null);
    assert.equal(state(data).deniedImports, undefined);
    assert.equal(state(data).turn, undefined);
    assert.equal(fs.existsSync(path.join(ws, 'client')), false);
  });

  test('updating an existing empty manifest gates its first dependency without spending a file', (t) => {
    const ws = workspace(t, { 'requirements.txt': '' });
    const data = input(ws, patch('*** Update File: requirements.txt', '@@', '+requests'));
    assert.match(denyReason(invoke(data)), /new python dependency.*requests/);
    assert.equal(state(data).deniedImports['python:requests'], true);
    assert.equal(state(data).turn, undefined);
    assert.equal(invoke(data), null);
    assert.equal(fs.readFileSync(path.join(ws, 'requirements.txt'), 'utf8'), '');
  });

  test('manifest CRLF hunks detect new names and ignore version-only changes', (t) => {
    const ws = workspace(t, { 'package.json': '{\r\n  "dependencies": {"lodash": "^4"}\r\n}\r\n' });
    const version = input(ws, patch('*** Update File: package.json', '@@',
      '-  "dependencies": {"lodash": "^4"}', '+  "dependencies": {"lodash": "^5"}'));
    assert.equal(invoke(version), null);
    const fresh = input(ws, patch('*** Update File: package.json', '@@',
      '-  "dependencies": {"lodash": "^4"}', '+  "dependencies": {"lodash": "^4", "axios": "^1"}'));
    assert.match(denyReason(invoke(fresh)), /axios/);
    assert.equal(invoke(fresh), null);
  });

  test('Python manifest hunks use existing dependency guard policy', (t) => {
    const ws = workspace(t, { 'pyproject.toml': '[project]\nname = "demo"\ndependencies = ["requests"]\n' });
    const data = input(ws, patch('*** Update File: pyproject.toml', '@@',
      '-dependencies = ["requests"]', '+dependencies = ["requests", "httpx"]'));
    assert.match(denyReason(invoke(data)), /new python dependency.*httpx/);
    assert.equal(invoke(data), null);
  });

  test('existing Add targets are overwrites and default budget counts only production files', (t) => {
    const ws = workspace(t, { 'existing.js': 'old\n' });
    const data = input(ws, patch(
      '*** Add File: existing.js', '+new',
      '*** Add File: source.js', '+const a = 1;',
      '*** Add File: tests/source.test.js', '+test();',
      '*** Add File: docs/readme.md', '+# Docs',
      '*** Add File: config.json', '+{}',
      '*** Add File: assets/icon.svg', '+<svg/>'
    ));
    assert.equal(invoke(data), null);
    assert.equal(state(data).turn.count, 1);
    assert.deepEqual(state(data).turn.kinds, { production: 1, test: 1, docs: 1, config: 1, asset: 1 });
  });

  test('explicit raw budget counts every added file and new turn resets the meter', (t) => {
    const ws = workspace(t);
    const data = input(ws, patch(
      '*** Add File: docs/a.md', '+# A',
      '*** Add File: docs/b.md', '+# B'
    ));
    assert.match(denyReason(invoke(data, { RAZOR_FILE_BUDGET: '1' })), /new file #2/);
    assert.equal(state(data).turn.count, 2);
    assert.equal(invoke(data, { RAZOR_FILE_BUDGET: '1' }), null);
    assert.equal(state(data).turn.count, 2);
    const next = { ...data, turn_id: 'turn-b', tool_input: { command: patch('*** Add File: docs/a.md', '+# A') } };
    assert.equal(invoke(next, { RAZOR_FILE_BUDGET: '1' }), null);
    assert.equal(state(data).turn.count, 1);
    assert.equal(state(data).turn.turnKey, 'turn-b');
  });

  test('malformed or unpreviewable compound patch stays silent without any ledger charge', (t) => {
    const ws = workspace(t, { 'package.json': '{}', 'old.js': 'old\nold\n' });
    for (const command of [
      patch('*** Add File: a.js', '+require("axios");', '*** Update File: old.js', '@@', '-old', '+new'),
      patch('*** Add File: a.js', '+require("axios");', '*** Update File: absent.js', '@@', '+new'),
      patch('*** Add File: a.js', 'require("axios");'),
    ]) {
      const data = input(ws, command);
      assert.equal(invoke(data, { RAZOR_FILE_BUDGET: '1' }), null);
      assert.equal(state(data).turn, undefined);
      assert.equal(state(data).deniedImports, undefined);
    }
  });

  test('settings continue to control native import, manifest and file gates', (t) => {
    const ws = workspace(t, { 'package.json': '{}\n' });
    const data = input(ws, patch(
      '*** Add File: a.js', '+require("axios");',
      '*** Update File: package.json', '@@', '-{}', '+{"dependencies":{"got":"*"}}'
    ));
    assert.equal(invoke(data, { RAZOR_IMPORT_GUARD: 'off', RAZOR_MANIFEST_GUARD: 'off', RAZOR_FILE_BUDGET: '0' }), null);
    assert.equal(state(data).deniedImports, undefined);
    assert.equal(state(data).turn, undefined);
  });
});
