'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'hooks/codex-hook.js');
const GOLDEN = path.join(__dirname, 'contract/golden');
const worlds = [];

function world() {
  const cwd = fs.mkdtempSync(path.join(ROOT, 'contract-ws-codex-runtime-'));
  const dataDir = path.join(cwd, '.state');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.state/\n');
  worlds.push(cwd);
  return { cwd, dataDir };
}

after(() => {
  for (const cwd of worlds) fs.rmSync(cwd, { recursive: true, force: true });
});

function envFor(w, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(RAZOR_|PLUGIN_|CLAUDE_PLUGIN_|GIT_)/.test(k)));
  return { ...env, PLUGIN_ROOT: ROOT, PLUGIN_DATA: w.dataDir, ...extra };
}

function run(w, event, payload = {}, extraEnv = {}, raw) {
  const data = { session_id: 'codex-fixture', cwd: w.cwd, hook_event_name: event, ...payload };
  const result = spawnSync(process.execPath, [WRAPPER, event], {
    input: raw === undefined ? JSON.stringify(data) : raw,
    encoding: 'utf8', timeout: 30000, env: envFor(w, extraEnv),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function state(w, id = 'codex-fixture') {
  return JSON.parse(fs.readFileSync(path.join(w.dataDir, 'razor-' + id + '.json'), 'utf8'));
}

function git(w, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Razor fixture', '-c', 'user.email=fixture@example.test', ...args], {
    cwd: w.cwd, env: envFor(w), encoding: 'utf8',
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('Codex lifecycle preserves original ladder and toggle bytes', () => {
  const w = world();
  const original = name => fs.readFileSync(path.join(GOLDEN, name + '.txt'), 'utf8');
  assert.equal(run(w, 'SessionStart', { source: 'startup' }), original('session-start-startup'));
  assert.equal(run(w, 'SubagentStart', { agent_type: 'worker', agent_id: 'worker-a' }), original('subagent-start-general'));
  assert.equal(run(w, 'SubagentStart', { agent_type: 'explorer', agent_id: 'read-a' }), '');
  assert.match(run(w, 'UserPromptSubmit', { prompt: 'continue the task', turn_id: 't1' }), /^Stay on the task/);
  assert.equal(run(w, 'UserPromptSubmit', { prompt: 'razor off', turn_id: 't2' }), original('userpromptsubmit-off'));
  assert.equal(state(w).off, true);
  assert.equal(run(w, 'SessionStart', { source: 'compact' }), '');
  assert.equal(run(w, 'SubagentStart', { agent_type: 'worker', agent_id: 'worker-b' }), '');
  assert.equal(run(w, 'PreToolUse', {
    turn_id: 't2', agent_id: 'worker-b', tool_name: 'Bash', tool_input: { command: 'npm i left-pad' },
  }), '');
  assert.equal(run(w, 'UserPromptSubmit', { prompt: 'razor on', turn_id: 't3' }), original('userpromptsubmit-on'));
  assert.equal(state(w).off, false);
  assert.equal(run(w, 'SessionStart', { source: 'resume' }), original('session-start-startup'));
});

test('Codex agent overrides, drift switch, and kill switch keep their semantics', () => {
  const w = world();
  assert.match(run(w, 'SubagentStart', { agent_type: 'explorer' }, { RAZOR_AGENT_INJECT: 'explorer' }), /RAZOR ACTIVE/);
  assert.equal(run(w, 'SubagentStart', { agent_type: 'custom:reader' }, { RAZOR_AGENT_SKIP: 'reader' }), '');
  assert.equal(run(w, 'UserPromptSubmit', { prompt: 'hello' }, { RAZOR_DRIFT_NOTE: 'off' }), '');
  for (const event of ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) {
    assert.equal(run(w, event, { prompt: 'razor on', tool_name: 'Bash', tool_input: { command: 'npm i left-pad' } },
      { RAZOR_DISABLE: '1' }), '');
  }
  assert.deepEqual(fs.readdirSync(w.dataDir), []);
});

test('Codex ignores Claude install options and writes only native state', () => {
  const w = world();
  const legacyDir = path.join(w.cwd, 'claude-state');
  fs.mkdirSync(legacyDir);
  const extra = { CLAUDE_PLUGIN_OPTION_DEP_GUARD: 'false', CLAUDE_PLUGIN_DATA: legacyDir };
  const data = { turn_id: 't1', tool_name: 'Bash', tool_input: { command: 'npm i left-pad' } };
  const deny = JSON.parse(run(w, 'PreToolUse', data, extra)).hookSpecificOutput;
  assert.equal(deny.permissionDecision, 'deny');
  assert.match(deny.permissionDecisionReason, /automated checkpoint/);
  assert.equal(run(w, 'PreToolUse', data, extra), '');
  assert.ok(state(w).deniedDeps);
  assert.deepEqual(fs.readdirSync(legacyDir), []);
  assert.equal(run(w, 'PreToolUse', { ...data, tool_input: { command: 'npm i another-package' } },
    { RAZOR_DEP_GUARD: 'off' }), '');
});

test('Codex native turn id and agent id isolate budgets without transcript parsing', () => {
  const w = world();
  const write = (turn, agent, n) => run(w, 'PreToolUse', {
    turn_id: turn, prompt_id: 'legacy-id-does-not-control-codex',
    agent_id: agent, tool_name: 'Write',
    tool_input: { file_path: path.join(w.cwd, 'new-' + n + '.js'), content: 'export const x = 1;\n' },
    transcript_path: path.join(w.cwd, 'missing-private-transcript.jsonl'),
  }, { RAZOR_FILE_BUDGET: '1' });
  assert.equal(write('t1', undefined, 1), '');
  assert.equal(write('t1', 'child', 2), '');
  assert.equal(JSON.parse(write('t1', undefined, 3)).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(write('t1', undefined, 4), '');
  assert.equal(write('t2', undefined, 5), '');
  assert.equal(state(w).turn.turnKey, 't2');
  assert.equal(state(w, 'codex-fixture--child').turn.turnKey, 't1');
});

test('Codex ledger excludes baseline dirt, survives resume, and requests one Stop continuation', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'preexisting\n'.repeat(30));
  run(w, 'SessionStart', { source: 'startup' });
  const baseline = state(w).ledger;
  assert.equal(baseline.baseInsertions, 30);
  assert.equal(run(w, 'Stop', { turn_id: 't1' }), '');
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'new\n'.repeat(600));
  run(w, 'SessionStart', { source: 'compact' });
  assert.deepEqual(state(w).ledger, baseline);
  const stop = JSON.parse(run(w, 'Stop', { turn_id: 't1', stop_hook_active: false }));
  assert.equal(stop.decision, 'block');
  assert.match(stop.reason, /\+600 \/ -0 LOC/);
  assert.match(stop.reason, /fires once per session/);
  assert.equal(state(w).ledger.fired, true);
  assert.equal(run(w, 'Stop', { turn_id: 'continuation', stop_hook_active: true }), '');
  run(w, 'SessionStart', { source: 'resume' });
  assert.equal(run(w, 'Stop', { turn_id: 't2' }), '');
});

test('Codex malformed inputs and mismatched events stay silent and cannot write shared unknown state', () => {
  const w = world();
  for (const raw of ['', '{', 'null', '[]', 'true', '42', '{}', '{"session_id":"s","hook_event_name":"Stop"}']) {
    assert.equal(run(w, 'SessionStart', {}, {}, raw), '');
  }
  assert.equal(run(w, 'UnknownEvent'), '');
  assert.deepEqual(fs.readdirSync(w.dataDir), []);
});

test('the shipped hook command launches from a path with spaces using native plugin variables', () => {
  const w = world();
  const copy = path.join(w.cwd, 'plugin with spaces');
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(copy, 'hooks'), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const hook = config.hooks.SessionStart[0].hooks[0];
  const command = process.platform === 'win32' ? hook.commandWindows : hook.command;
  assert.equal(typeof command, 'string');
  assert.equal(hook.args, undefined);
  const r = spawnSync(command, {
    shell: process.platform === 'win32' ? true : '/bin/sh',
    input: JSON.stringify({ session_id: 'launcher', hook_event_name: 'SessionStart', cwd: w.cwd }),
    cwd: w.cwd, env: envFor(w, { PLUGIN_ROOT: copy }), encoding: 'utf8', timeout: 30000,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.stdout.trim(), fs.readFileSync(path.join(GOLDEN, 'session-start-startup.txt'), 'utf8').trim());
});
test('Codex never loops a Stop continuation when state writes fail', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  run(w, 'SessionStart', { source: 'startup' });
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'new\n'.repeat(600));
  // Refuse only the state writer in this child. This exercises the same
  // fail-open path as a read-only state file, on every test platform.
  const preload = path.join(w.cwd, 'refuse-state.cjs');
  fs.writeFileSync(preload,
    'require(' + JSON.stringify(path.join(ROOT, 'hooks/lib/safe-write.js')) +
    ').safeWriteFileSync = () => { throw new Error("fixture: state is read-only"); };\n');
  const env = { NODE_OPTIONS: '--require "' + preload.replace(/\\/g, '/') + '"' };
  assert.equal(JSON.parse(run(w, 'Stop', { turn_id: 't1', stop_hook_active: false }, env)).decision, 'block');
  assert.equal(state(w).ledger.fired, false);
  assert.equal(run(w, 'Stop', { turn_id: 'continuation', stop_hook_active: true }, env), '');
  assert.equal(state(w).ledger.fired, false);
});