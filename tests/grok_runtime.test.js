'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SPAWN_TIMEOUT_MS } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const worlds = [];

function world() {
  const cwd = fs.mkdtempSync(path.join(ROOT, 'contract-ws-grok-'));
  const dataDir = path.join(cwd, '.state');
  fs.mkdirSync(dataDir);
  worlds.push(cwd);
  return { cwd, dataDir };
}

after(() => {
  for (const cwd of worlds) fs.rmSync(cwd, { recursive: true, force: true });
});

function envFor(w, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(RAZOR_|PLUGIN_|CLAUDE_PLUGIN_|GROK_|GIT_)/.test(k)));
  return {
    ...env,
    RAZOR_GIT_TIMEOUT_MS: '10000',
    CLAUDE_PLUGIN_DATA: w.dataDir,
    ...extra,
  };
}

function run(w, script, payload, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'hooks', script)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
    env: envFor(w, extraEnv),
    cwd: w.cwd,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout;
}

function reason(stdout) {
  if (!stdout.trim()) return null;
  const parsed = JSON.parse(stdout);
  const out = parsed.hookSpecificOutput;
  if (!out || out.permissionDecision !== 'deny') return null;
  return out.permissionDecisionReason;
}

function state(w, id) {
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

// CamelCase only: the shape in Grok's hook guide. The runner also copies a
// few snake_case aliases; these payloads leave them out so the adapter cannot
// pass by depending on that copy.
function grok(w, toolName, toolInput, extra = {}) {
  return {
    hookEventName: 'pre_tool_use',
    hook_event_name: 'PreToolUse',
    sessionId: extra.sessionId || 'grok-fixture',
    cwd: w.cwd,
    workspaceRoot: w.cwd,
    promptId: extra.promptId || 'turn-1',
    toolName,
    toolInput,
    toolUseId: 'tu-1',
    toolInputTruncated: false,
    subagentId: extra.subagentId,
  };
}

function claude(w, toolName, toolInput, extra = {}) {
  return {
    session_id: extra.sessionId || 'claude-fixture',
    cwd: w.cwd,
    hook_event_name: 'PreToolUse',
    prompt_id: extra.promptId || 'turn-1',
    tool_name: toolName,
    tool_input: toolInput,
    agent_id: extra.agentId,
  };
}

const GROK_ENV = { GROK_HOOK_EVENT: 'pre_tool_use' };

function denies(w, scriptPayload, env) {
  return reason(run(w, 'pre-tool-use.js', scriptPayload, env));
}

// The first call denies on both hosts and the retry of that same call does not.
function sameDecision(w, claudePayload, grokPayload, pattern, env = {}) {
  const claudeReason = denies(w, claudePayload, env);
  const grokReason = denies(w, grokPayload, { ...env, ...GROK_ENV });
  assert.match(claudeReason, pattern);
  assert.match(grokReason, pattern);
  assert.equal(denies(w, claudePayload, env), null);
  assert.equal(denies(w, grokPayload, { ...env, ...GROK_ENV }), null);
}

const PKG = JSON.stringify({ name: 'ws', dependencies: { express: '^4.19.2' } }, null, 2);

test('a Grok install, manifest edit, import and new file deny exactly where Claude does', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'package.json'), PKG);

  sameDecision(
    w,
    claude(w, 'Bash', { command: 'npm i left-pad' }, { sessionId: 'claude-install' }),
    grok(w, 'run_terminal_command', { command: 'npm i left-pad' }, { sessionId: 'grok-install' }),
    /left-pad/
  );

  const oldDep = '"express": "^4.19.2"';
  const newDep = '"express": "^4.19.2",\n    "left-pad": "^1.3.0"';
  const manifest = path.join(w.cwd, 'package.json');
  sameDecision(
    w,
    claude(w, 'Edit', { file_path: manifest, old_string: oldDep, new_string: newDep }, { sessionId: 'claude-manifest' }),
    grok(w, 'search_replace', { file_path: manifest, old_string: oldDep, new_string: newDep }, { sessionId: 'grok-manifest' }),
    /left-pad/
  );
  assert.match(
    denies(w, grok(w, 'search_replace', {
      file_path: manifest, old_string: oldDep, new_string: newDep,
    }, { sessionId: 'grok-manifest-name' }), GROK_ENV) || '',
    /this search_replace/
  );

  const source = "const axios = require('axios');\n";
  sameDecision(
    w,
    claude(w, 'Write', { file_path: path.join(w.cwd, 'a.js'), content: source }, { sessionId: 'claude-import' }),
    grok(w, 'write', { file_path: path.join(w.cwd, 'b.js'), content: source }, { sessionId: 'grok-import' }),
    /axios/
  );

  const budget = { RAZOR_FILE_BUDGET: '1' };
  const fresh = (n) => path.join(w.cwd, 'new-' + n + '.js');
  const claudeTurn = { promptId: 'turn-budget', sessionId: 'claude-budget' };
  const grokTurn = { promptId: 'turn-budget', sessionId: 'grok-budget' };
  assert.equal(denies(w, claude(w, 'Write', { file_path: fresh('c1'), content: 'export const x = 1;\n' }, claudeTurn), budget), null);
  assert.match(denies(w, claude(w, 'Write', { file_path: fresh('c2'), content: 'export const y = 1;\n' }, claudeTurn), budget), /new file #2/);
  assert.equal(denies(w, grok(w, 'write', { file_path: fresh('g1'), content: 'export const x = 1;\n' }, grokTurn), { ...budget, ...GROK_ENV }), null);
  assert.match(
    denies(w, grok(w, 'search_replace', { file_path: fresh('g2'), old_string: '', new_string: 'export const y = 1;\n' }, grokTurn), { ...budget, ...GROK_ENV }),
    /new file #2/
  );
  assert.equal(
    denies(w, grok(w, 'search_replace', { file_path: fresh('g3'), old_string: '', new_string: 'export const z = 1;\n' }, grokTurn), { ...budget, ...GROK_ENV }),
    null
  );
});

test('the internal shell id, hashline edits and a snake_case alias deny too', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'package.json'), PKG);
  assert.match(
    denies(w, grok(w, 'run_terminal_cmd', { command: 'npm i left-pad' }), GROK_ENV),
    /left-pad/
  );

  const added = JSON.stringify({ name: 'ws', dependencies: { express: '^4.19.2', 'left-pad': '^1.3.0' } }, null, 2);
  assert.match(denies(w, grok(w, 'hashline_edit', {
    file_path: path.join(w.cwd, 'package.json'),
    edits: [{ op: 'write', content: added }],
  }, { sessionId: 'grok-hashline-manifest' }), GROK_ENV), /left-pad/);

  assert.match(denies(w, grok(w, 'hashline_edit', {
    file_path: path.join(w.cwd, 'c.js'),
    edits: [{ op: 'replace', anchor: '1:ab:cd', content: "const axios = require('axios');\n" }],
  }, { sessionId: 'grok-hashline-import' }), GROK_ENV), /axios/);

  const aliased = {
    session_id: 'grok-alias',
    cwd: w.cwd,
    hook_event_name: 'PreToolUse',
    prompt_id: 'turn-1',
    tool_name: 'run_terminal_command',
    tool_input: { command: 'npm i left-pad' },
  };
  assert.match(denies(w, aliased, GROK_ENV), /left-pad/);
});

test('a Grok payload without GROK_HOOK_EVENT is not translated, and a Claude payload still is', () => {
  const w = world();
  const install = grok(w, 'run_terminal_command', { command: 'npm i left-pad' });
  assert.equal(denies(w, install, {}), null);
  assert.match(denies(w, install, GROK_ENV), /left-pad/);
  assert.match(
    denies(w, claude(w, 'Bash', { command: 'npm i left-pad' }), {}),
    /left-pad/
  );
  assert.match(
    denies(w, claude(w, 'Bash', { command: 'npm i left-pad' }, { sessionId: 'claude-under-grok' }), GROK_ENV),
    /left-pad/
  );
  assert.equal(denies(w, grok(w, 'read_file', { file_path: path.join(w.cwd, 'a.js') }), GROK_ENV), null);
});

test('Grok ignores Claude install options, isolates a subagent and keeps its own data dir', () => {
  const w = world();
  const grokData = path.join(w.cwd, 'grok-data');
  fs.mkdirSync(grokData);
  const env = { ...GROK_ENV, GROK_PLUGIN_DATA: grokData, CLAUDE_PLUGIN_OPTION_DEP_GUARD: 'false' };
  const call = grok(w, 'run_terminal_command', { command: 'npm i left-pad' }, { sessionId: 'grok-opts' });
  assert.match(denies(w, call, env), /left-pad/);
  assert.equal(denies(w, call, env), null);
  assert.ok(fs.existsSync(path.join(grokData, 'razor-grok-opts.json')));
  assert.equal(fs.readdirSync(w.dataDir).length, 0);

  const budget = { ...GROK_ENV, RAZOR_FILE_BUDGET: '1' };
  const file = (n) => ({ file_path: path.join(w.cwd, 'iso-' + n + '.js'), content: 'export const x = 1;\n' });
  assert.equal(denies(w, grok(w, 'write', file(1), { sessionId: 'grok-iso' }), budget), null);
  assert.equal(denies(w, grok(w, 'write', file(2), { sessionId: 'grok-iso', subagentId: 'child' }), budget), null);
  assert.match(denies(w, grok(w, 'write', file(3), { sessionId: 'grok-iso' }), budget), /new file #2/);
  assert.match(denies(w, grok(w, 'write', file(4), { sessionId: 'grok-iso', subagentId: 'child' }), budget), /new file #2/);
});

test('Grok Stop asks on end_turn, stays quiet on session teardown, and a continuation does not ask again', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  fs.writeFileSync(path.join(w.cwd, '.gitignore'), '.state/\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  const start = {
    hookEventName: 'session_start',
    hook_event_name: 'SessionStart',
    sessionId: 'grok-stop',
    cwd: w.cwd,
    source: 'startup',
  };
  assert.match(run(w, 'session-start.js', start, { GROK_HOOK_EVENT: 'session_start' }), /RAZOR ACTIVE/);
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'new\n'.repeat(600));
  const stop = (extra) => run(w, 'build-ledger.js', {
    hookEventName: 'stop',
    hook_event_name: 'Stop',
    sessionId: 'grok-stop',
    cwd: w.cwd,
    reason: 'end_turn',
    stopHookActive: false,
    ...extra,
  }, { GROK_HOOK_EVENT: 'stop' });
  assert.equal(stop({ reason: 'shutdown' }), '');
  assert.equal(state(w, 'grok-stop').ledger.fired, false);
  const asked = JSON.parse(stop({}));
  assert.match(asked.hookSpecificOutput.additionalContext, /\+600 \/ -0 LOC/);
  assert.equal(state(w, 'grok-stop').ledger.fired, true);
  assert.equal(stop({ stopHookActive: true }), '');
});

test('razor off still disables the guards when Grok discards the confirmation', () => {
  const w = world();
  const prompt = {
    hookEventName: 'user_prompt_submit',
    hook_event_name: 'UserPromptSubmit',
    sessionId: 'grok-toggle',
    cwd: w.cwd,
    prompt: 'razor off',
  };
  assert.match(run(w, 'mode-toggle.js', prompt, { GROK_HOOK_EVENT: 'user_prompt_submit' }), /RAZOR OFF/);
  assert.equal(state(w, 'grok-toggle').off, true);
  assert.equal(
    denies(w, grok(w, 'run_terminal_command', { command: 'npm i left-pad' }, { sessionId: 'grok-toggle' }), GROK_ENV),
    null
  );
});

test('the PreToolUse matcher stays on Claude tool names and the command is one string', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const group = config.hooks.PreToolUse[0];
  assert.equal(group.matcher, '^(Bash|PowerShell|Edit|Write)$');
  for (const event of Object.values(config.hooks)) {
    for (const entry of event) {
      for (const hook of entry.hooks) {
        assert.equal(hook.args, undefined);
        assert.match(hook.command, /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.js"$/);
        assert.equal(typeof hook.timeout, 'number');
      }
    }
  }
});

test('the shipped command launches from a path with spaces for Claude and for Grok', () => {
  const w = world();
  const copy = path.join(w.cwd, 'plugin with spaces');
  fs.cpSync(path.join(ROOT, 'hooks'), path.join(copy, 'hooks'), { recursive: true });
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  const command = config.hooks.SessionStart[0].hooks[0].command.replaceAll('${CLAUDE_PLUGIN_ROOT}', copy);
  const launch = (payload, extra) => spawnSync(command, {
    shell: true,
    input: JSON.stringify(payload),
    cwd: w.cwd,
    env: envFor(w, extra),
    encoding: 'utf8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  const claudeRun = launch({ session_id: 'launcher', hook_event_name: 'SessionStart', cwd: w.cwd, source: 'startup' });
  assert.ifError(claudeRun.error);
  assert.equal(claudeRun.status, 0, claudeRun.stderr);
  assert.match(claudeRun.stdout, /RAZOR ACTIVE/);
  const grokRun = launch({
    hookEventName: 'session_start',
    hook_event_name: 'SessionStart',
    sessionId: 'launcher-grok',
    cwd: w.cwd,
    source: 'startup',
  }, { GROK_HOOK_EVENT: 'session_start' });
  assert.ifError(grokRun.error);
  assert.equal(grokRun.status, 0, grokRun.stderr);
  assert.match(grokRun.stdout, /RAZOR ACTIVE/);
});
