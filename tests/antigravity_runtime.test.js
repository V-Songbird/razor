'use strict';

// Antigravity's contract, driven the way that host drives it: one process per
// event, the call nested under `toolCall` with PascalCase arguments, and one
// JSON answer per run. Fixture worlds live inside the plugin root because the
// file meter exempts the system temp directory, and each world gets its own
// temp directory so the state files razor keeps there never cross tests.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SPAWN_TIMEOUT_MS } = require('./helpers');

const ROOT = path.resolve(__dirname, '..');
const WRAPPER = path.join(ROOT, 'hooks/antigravity-hook.js');
const GOLDEN = path.join(__dirname, 'contract/golden');
const SESSION = 'agy-fixture';
const worlds = [];

function world() {
  const cwd = fs.mkdtempSync(path.join(ROOT, 'contract-ws-antigravity-'));
  const tmp = path.join(cwd, '.tmp');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.tmp/\n');
  worlds.push(cwd);
  return { cwd, tmp };
}

after(() => {
  for (const cwd of worlds) fs.rmSync(cwd, { recursive: true, force: true });
});

// The larger git budget matches helpers.js: a loaded machine cannot drop the
// build check's baseline.
function envFor(w, extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    !/^(RAZOR_|PLUGIN_|CLAUDE_PLUGIN_|GIT_)/.test(k)));
  return { ...env, RAZOR_GIT_TIMEOUT_MS: '10000', TMPDIR: w.tmp, TEMP: w.tmp, TMP: w.tmp, ...extra };
}

function run(w, event, payload = {}, extraEnv = {}, raw) {
  const data = { conversationId: SESSION, workspacePaths: [w.cwd], ...payload };
  const result = spawnSync(process.execPath, [WRAPPER, event], {
    input: raw === undefined ? JSON.stringify(data) : raw,
    encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: envFor(w, extraEnv),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return result.stdout ? JSON.parse(result.stdout) : '';
}

const call = (name, args, extra = {}) => ({ toolCall: { name, args }, stepIdx: 1, ...extra });

// A deny names the tool the call used, and no sentence names Claude Code's
// Write or Edit, which this host does not have.
function assertToolNamed(reason, tool) {
  assert.match(reason, new RegExp(`\\bthis ${tool}\\b`));
  assert.doesNotMatch(reason, /\bWrite\b|\bEdit\b/);
}

function stateFile(w, id = SESSION) {
  return path.join(w.tmp, 'razor-antigravity', 'razor-' + id + '.json');
}

function state(w, id = SESSION) {
  return JSON.parse(fs.readFileSync(stateFile(w, id), 'utf8'));
}

function git(w, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=Razor fixture', '-c', 'user.email=fixture@example.test', ...args], {
    cwd: w.cwd, env: envFor(w), encoding: 'utf8',
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function nodeProject(w, deps = { express: '^4.19.2' }) {
  fs.writeFileSync(path.join(w.cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: deps }, null, 2) + '\n');
  fs.mkdirSync(path.join(w.cwd, 'src'));
  fs.writeFileSync(path.join(w.cwd, 'src', 'app.js'), "const express = require('express');\nmodule.exports = express;\n");
}

// An injected message reaches only the model call it rides, so every call of
// every turn carries both; the ledger baseline stays the first call's.
test('every model call carries the ladder and the drift note, and only the first takes the ledger baseline', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  const ladder = fs.readFileSync(path.join(GOLDEN, 'session-start-startup.txt'), 'utf8');
  const both = (answer) => {
    assert.equal(answer.injectSteps.length, 2);
    assert.equal(answer.injectSteps[0].ephemeralMessage, ladder);
    assert.match(answer.injectSteps[1].ephemeralMessage, /^Stay on the task/);
  };
  both(run(w, 'PreInvocation', { invocationNum: 0 }));
  const baseline = state(w).ledger;
  assert.equal(baseline.baseInsertions, 0);
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'later\n'.repeat(5));
  both(run(w, 'PreInvocation', { invocationNum: 1 }));
  assert.deepEqual(run(w, 'Stop', { executionNum: 0, fullyIdle: true }), {});
  both(run(w, 'PreInvocation', { invocationNum: 0 }));
  both(run(w, 'PreInvocation', { invocationNum: 1 }));
  assert.deepEqual(state(w).ledger, baseline);
  assert.equal(state(w).antigravityTurn, 2);
  const noNote = run(w, 'PreInvocation', { invocationNum: 2 }, { RAZOR_DRIFT_NOTE: 'off' });
  assert.deepEqual(noNote.injectSteps.map((s) => s.ephemeralMessage), [ladder]);
});

test('an undeclared install is denied once and allowed on the exact retry; a declared one passes', () => {
  const w = world();
  nodeProject(w);
  const install = (pkg) => call('run_command', { CommandLine: `npm install ${pkg}`, Cwd: w.cwd });
  const deny = run(w, 'PreToolUse', install('left-pad'));
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /left-pad/);
  assert.match(deny.reason, /express/);
  assert.match(deny.reason, /automated checkpoint/);
  assert.deepEqual(run(w, 'PreToolUse', install('left-pad')), { decision: 'allow' });
  assert.deepEqual(run(w, 'PreToolUse', install('express')), { decision: 'allow' });
  assert.ok(state(w).deniedDeps);
});

test('file tools translate: a new import is caught in a write and in a multi-chunk edit, and a manifest edit too', () => {
  const w = world();
  nodeProject(w);
  const pad = call('write_to_file', {
    TargetFile: path.join(w.cwd, 'src', 'pad.js'), CodeContent: "const pad = require('left-pad');\n",
  });
  const write = run(w, 'PreToolUse', pad);
  assert.equal(write.decision, 'deny');
  assert.match(write.reason, /left-pad/);
  assert.match(write.reason, /new node dependency/);
  assert.match(write.reason, /in this write_to_file adds/);
  assertToolNamed(write.reason, 'write_to_file');
  assert.deepEqual(run(w, 'PreToolUse', pad), { decision: 'allow' });
  const edit = run(w, 'PreToolUse', call('multi_replace_file_content', {
    TargetFile: path.join(w.cwd, 'src', 'app.js'),
    ReplacementChunks: [
      { TargetContent: 'module.exports = express;', ReplacementContent: "const axios = require('axios');\nmodule.exports = express;" },
    ],
  }));
  assert.equal(edit.decision, 'deny');
  assert.match(edit.reason, /axios/);
  assert.match(edit.reason, /in this multi_replace_file_content adds/);
  assertToolNamed(edit.reason, 'multi_replace_file_content');
  const manifest = run(w, 'PreToolUse', call('replace_file_content', {
    TargetFile: path.join(w.cwd, 'package.json'),
    TargetContent: '"express": "^4.19.2"',
    ReplacementContent: '"express": "^4.19.2",\n    "lodash": "^4.17.21"',
  }));
  assert.equal(manifest.decision, 'deny');
  assert.match(manifest.reason, /lodash/);
  assert.match(manifest.reason, /this replace_file_content to package\.json/);
  assertToolNamed(manifest.reason, 'replace_file_content');
  assert.deepEqual(run(w, 'PreToolUse', call('view_file', { AbsolutePath: path.join(w.cwd, 'src', 'app.js') })), { decision: 'allow' });
});

test('a manifest edit in chunks is judged by the whole file it would produce: denied once, allowed on the identical retry', () => {
  const w = world();
  nodeProject(w);
  const edit = (chunks) => run(w, 'PreToolUse', call('multi_replace_file_content', {
    TargetFile: path.join(w.cwd, 'package.json'), ReplacementChunks: chunks,
  }));
  const twoChunks = [
    { TargetContent: '"version": "1.0.0"', ReplacementContent: '"version": "1.1.0"' },
    { TargetContent: '"express": "^4.19.2"', ReplacementContent: '"express": "^4.19.2",\n    "lodash": "^4.17.21"' },
  ];
  const deny = edit(twoChunks);
  assert.equal(deny.decision, 'deny');
  assert.match(deny.reason, /lodash/);
  assert.deepEqual(edit(twoChunks), { decision: 'allow' });
  const single = edit([{ TargetContent: '"express": "^4.19.2"', ReplacementContent: '"express": "^4.19.2",\n    "axios": "^1.7.2"' }]);
  assert.equal(single.decision, 'deny');
  assert.match(single.reason, /axios/);
});

// A target with LF lines is looked for in a CRLF manifest's LF view, as the
// manifest check does for a single edit.
test('a manifest edit in chunks with LF lines is judged the same on a CRLF file as on an LF one', () => {
  for (const eol of ['\n', '\r\n']) {
    const w = world();
    nodeProject(w);
    const manifest = path.join(w.cwd, 'package.json');
    fs.writeFileSync(manifest, fs.readFileSync(manifest, 'utf8').replace(/\n/g, eol));
    const chunks = [
      { TargetContent: '"version": "1.0.0"', ReplacementContent: '"version": "1.1.0"' },
      { TargetContent: '"express": "^4.19.2"\n  }', ReplacementContent: '"express": "^4.19.2",\n    "lodash": "^4.17.21"\n  }' },
    ];
    const edit = () => run(w, 'PreToolUse', call('multi_replace_file_content', { TargetFile: manifest, ReplacementChunks: chunks }));
    const deny = edit();
    assert.equal(deny.decision, 'deny', JSON.stringify(eol));
    assert.match(deny.reason, /this multi_replace_file_content to package\.json adds a new node dependency \(`lodash`\)/);
    assert.deepEqual(edit(), { decision: 'allow' });
  }
});

test('a code edit keeps its chunks joined, so an import in a chunk that does not match the file is still caught', () => {
  const w = world();
  nodeProject(w);
  const edit = run(w, 'PreToolUse', call('multi_replace_file_content', {
    TargetFile: path.join(w.cwd, 'src', 'app.js'),
    ReplacementChunks: [
      { TargetContent: 'module.exports = express;', ReplacementContent: 'module.exports = express();' },
      { TargetContent: 'const absent = 1;', ReplacementContent: "const chalk = require('chalk');" },
    ],
  }));
  assert.equal(edit.decision, 'deny');
  assert.match(edit.reason, /chalk/);
});

test('a manifest edit that cannot be previewed stays silent and never throws', () => {
  const w = world();
  nodeProject(w, { express: '^4.19.2', cors: '^4.19.2' });
  const edit = (file, chunks) => run(w, 'PreToolUse', call('multi_replace_file_content', { TargetFile: file, ReplacementChunks: chunks }));
  const add = (name) => ({ TargetContent: '"express": "^4.19.2"', ReplacementContent: `"express": "^4.19.2",\n    "${name}": "^1.0.0"` });
  const manifest = path.join(w.cwd, 'package.json');
  // Each call would add a dependency if its whole file were previewed.
  assert.deepEqual(edit(manifest, [add('lodash'), { TargetContent: '"private": true', ReplacementContent: '"private": false' }]), { decision: 'allow' });
  assert.deepEqual(edit(manifest, [add('chalk'), { TargetContent: '"^4.19.2"', ReplacementContent: '"^4.21.0"' }]), { decision: 'allow' });
  fs.mkdirSync(path.join(w.cwd, 'folder', 'package.json'), { recursive: true });
  assert.deepEqual(edit(path.join(w.cwd, 'folder', 'package.json'), [add('dayjs')]), { decision: 'allow' });
  assert.deepEqual(edit(path.join(w.cwd, 'absent', 'package.json'), [add('dayjs')]), { decision: 'allow' });
  assert.deepEqual(edit(undefined, [add('dayjs')]), { decision: 'allow' });
  assert.deepEqual(state(w).deniedImports || {}, {});
});

// AllowMultiple lets the host replace every match of a target. With it, a
// repeated target is judged by the file every replacement would produce;
// without it, the host refuses the edit, so there is nothing to ask about.
test('AllowMultiple decides a manifest edit whose target repeats, on both edit tools', () => {
  const repeated = { TargetContent: '"^4.19.2"', ReplacementContent: '"^4.19.2",\n    "dayjs": "^1.11.0"' };
  const tools = {
    replace_file_content: (file, allowMultiple) => ({ TargetFile: file, ...repeated, AllowMultiple: allowMultiple }),
    multi_replace_file_content: (file, allowMultiple) => ({
      TargetFile: file,
      ReplacementChunks: [
        { TargetContent: '"version": "1.0.0"', ReplacementContent: '"version": "1.1.0"', AllowMultiple: false },
        { ...repeated, AllowMultiple: allowMultiple },
      ],
    }),
  };
  for (const [tool, args] of Object.entries(tools)) {
    const w = world();
    nodeProject(w, { express: '^4.19.2', cors: '^4.19.2' });
    const edit = (allowMultiple) => run(w, 'PreToolUse', call(tool, args(path.join(w.cwd, 'package.json'), allowMultiple)));
    assert.deepEqual(edit(false), { decision: 'allow' }, tool);
    const deny = edit(true);
    assert.equal(deny.decision, 'deny', tool);
    assert.match(deny.reason, /adds a new node dependency \(`dayjs`\)/);
    assertToolNamed(deny.reason, tool);
    assert.deepEqual(edit(true), { decision: 'allow' }, tool);
  }
});

// The import guard reads only the incoming text, never whether the target is
// unique, so a repeated target never hid an import from it.
test('a code edit that sets AllowMultiple on a repeated target is still checked for imports', () => {
  const w = world();
  nodeProject(w);
  const edit = run(w, 'PreToolUse', call('replace_file_content', {
    TargetFile: path.join(w.cwd, 'src', 'app.js'),
    TargetContent: '\n', ReplacementContent: "\nconst chalk = require('chalk');\n", AllowMultiple: true,
  }));
  assert.equal(edit.decision, 'deny');
  assert.match(edit.reason, /chalk/);
});

// The host numbers a user turn's model calls from 0 and keeps counting after a
// Stop continues the model, and a turn it ends on a denied command fires no
// Stop, so the call numbered 0 is what starts a turn.
test('the new-file budget counts one user turn: a Stop continuation stays in it, and a turn without a Stop still ends', () => {
  const w = world();
  nodeProject(w);
  const write = (n) => run(w, 'PreToolUse', call('write_to_file', {
    TargetFile: path.join(w.cwd, 'src', `new-${n}.js`), CodeContent: 'export const x = 1;\n',
  }), { RAZOR_FILE_BUDGET: '1' });
  run(w, 'PreInvocation', { invocationNum: 0 });
  assert.deepEqual(write(1), { decision: 'allow' });
  assert.deepEqual(run(w, 'Stop', { executionNum: 0, fullyIdle: true }), {});
  run(w, 'PreInvocation', { invocationNum: 1 });
  const over = write(2);
  assert.equal(over.decision, 'deny');
  assert.match(over.reason, /new file #2/);
  assert.doesNotMatch(over.reason, /\bWrite\b|\bEdit\b/);
  assert.deepEqual(write(3), { decision: 'allow' });
  assert.equal(state(w).turn.turnKey, '1');
  const next = run(w, 'PreInvocation', { invocationNum: 0 });
  assert.match(next.injectSteps.at(-1).ephemeralMessage, /^Stay on the task/);
  assert.deepEqual(write(4), { decision: 'allow' });
  assert.equal(write(5).decision, 'deny');
  assert.equal(state(w).turn.turnKey, '2');
});

test('the build check asks for one more turn once per conversation', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'preexisting\n'.repeat(30));
  run(w, 'PreInvocation', { invocationNum: 0 });
  assert.equal(state(w).ledger.baseInsertions, 30);
  assert.deepEqual(run(w, 'Stop', { executionNum: 0, fullyIdle: true }), {});
  run(w, 'PreInvocation', { invocationNum: 0 });
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'new\n'.repeat(600));
  const stop = run(w, 'Stop', { executionNum: 1, fullyIdle: true });
  assert.equal(stop.decision, 'continue');
  assert.match(stop.reason, /\+600 \/ -0 LOC/);
  assert.match(stop.reason, /fires once per session/);
  assert.equal(state(w).ledger.fired, true);
  // The call answering the build check keeps the ladder but not the drift note,
  // beside which the model took that question for a later request; the next
  // user turn has both.
  const ladder = fs.readFileSync(path.join(GOLDEN, 'session-start-startup.txt'), 'utf8');
  const answering = run(w, 'PreInvocation', { invocationNum: 1 });
  assert.deepEqual(answering.injectSteps.map((s) => s.ephemeralMessage), [ladder]);
  assert.deepEqual(run(w, 'Stop', { executionNum: 2, fullyIdle: true }), {});
  assert.equal(state(w).antigravityTurn, 2);
  const next = run(w, 'PreInvocation', { invocationNum: 0 });
  assert.match(next.injectSteps.at(-1).ephemeralMessage, /^Stay on the task/);
});

test('the build check stays quiet when its once-per-session mark cannot be saved', () => {
  const w = world();
  fs.writeFileSync(path.join(w.cwd, 'a.js'), 'base\n');
  git(w, 'init', '-q');
  git(w, 'add', '.');
  git(w, 'commit', '-qm', 'fixture baseline');
  run(w, 'PreInvocation', { invocationNum: 0 });
  fs.appendFileSync(path.join(w.cwd, 'a.js'), 'new\n'.repeat(600));
  // Refuse only the state writer in this child: the same fail-open path as a
  // read-only state file, on every test platform.
  const preload = path.join(w.cwd, 'refuse-state.cjs');
  fs.writeFileSync(preload,
    'require(' + JSON.stringify(path.join(ROOT, 'hooks/lib/safe-write.js')) +
    ').safeWriteFileSync = () => { throw new Error("fixture: state is read-only"); };\n');
  const env = { NODE_OPTIONS: '--require "' + preload.replace(/\\/g, '/') + '"' };
  assert.deepEqual(run(w, 'Stop', { executionNum: 0, fullyIdle: true }, env), {});
  assert.equal(state(w).ledger.fired, false);
});

test('malformed input, a missing conversation and the kill switch answer without keeping state', () => {
  const w = world();
  for (const raw of ['', '{', 'null', '[]', 'true', '42', '{}', '{"workspacePaths":["x"]}']) {
    assert.deepEqual(run(w, 'PreToolUse', {}, {}, raw), { decision: 'allow' });
    assert.deepEqual(run(w, 'PreInvocation', {}, {}, raw), {});
    assert.deepEqual(run(w, 'Stop', {}, {}, raw), {});
  }
  assert.equal(run(w, 'UnknownEvent'), '');
  const off = { RAZOR_DISABLE: '1' };
  assert.deepEqual(run(w, 'PreInvocation', { invocationNum: 0 }, off), {});
  assert.deepEqual(run(w, 'PreToolUse', call('run_command', { CommandLine: 'npm i left-pad', Cwd: w.cwd }), off), { decision: 'allow' });
  assert.deepEqual(run(w, 'Stop', { executionNum: 0, fullyIdle: true }, off), {});
  const dir = path.join(w.tmp, 'razor-antigravity');
  assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0);
});

test('a file tool whose TargetFile is not a string gets the normal answer', () => {
  const w = world();
  nodeProject(w);
  for (const TargetFile of [42, ['package.json']]) {
    assert.deepEqual(run(w, 'PreToolUse', call('write_to_file', { TargetFile, CodeContent: 'x' })), { decision: 'allow' });
    assert.deepEqual(run(w, 'PreToolUse', call('replace_file_content', { TargetFile, TargetContent: 'a', ReplacementContent: 'b' })), { decision: 'allow' });
    assert.deepEqual(run(w, 'PreToolUse', call('multi_replace_file_content', {
      TargetFile, ReplacementChunks: [{ TargetContent: 'a', ReplacementContent: 'b' }],
    })), { decision: 'allow' });
  }
});

test('the shipped hook command runs from the plugin directory with the payload on stdin', () => {
  const w = world();
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks.json'), 'utf8'));
  const hook = config.razor.PreToolUse[0].hooks[0];
  const r = spawnSync(hook.command, {
    shell: true, cwd: ROOT, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env: envFor(w),
    input: JSON.stringify(call('run_command', { CommandLine: 'echo hi', Cwd: w.cwd }, { conversationId: 'launcher', workspacePaths: [w.cwd] })),
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), { decision: 'allow' });
});

test('the Antigravity manifest and registration agree with the other hosts', () => {
  const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const claude = read('.claude-plugin/plugin.json');
  const root = read('plugin.json');
  assert.equal(root.name, 'razor');
  assert.equal(root.version, claude.version);
  assert.equal(root.$schema, undefined, 'a root $schema selects a portable loader that drops hooks on Codex');
  assert.deepEqual({ name: root.author.name, email: root.author.email }, { name: claude.author.name, email: claude.author.email });
  const hooks = read('hooks.json');
  assert.deepEqual(Object.keys(hooks), ['razor']);
  assert.deepEqual(Object.keys(hooks.razor).sort(), ['PreInvocation', 'PreToolUse', 'Stop']);
  // Antigravity's parser takes PreToolUse and PostToolUse as matcher groups
  // and every other event as a flat list of handlers; one wrapped handler
  // there fails the whole file, and no razor hook runs.
  for (const [event, entries] of Object.entries(hooks.razor)) {
    const grouped = event === 'PreToolUse' || event === 'PostToolUse';
    const handlers = grouped ? entries.flatMap((group) => (assert.equal(typeof group.matcher, 'string', event), group.hooks)) : entries;
    for (const hook of handlers) {
      assert.equal(hook.type, 'command', `${event} handlers carry type and command directly`);
      assert.equal(hook.command, `node ./hooks/antigravity-hook.js ${event}`);
      assert.ok(Number.isInteger(hook.timeout) && hook.timeout > 0, 'timeouts are whole seconds');
    }
  }
  for (const tool of ['run_command', 'write_to_file', 'replace_file_content', 'multi_replace_file_content']) {
    assert.match(tool, new RegExp(hooks.razor.PreToolUse[0].matcher));
  }
  assert.ok(fs.existsSync(WRAPPER));
});
