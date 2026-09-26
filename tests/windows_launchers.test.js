'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { SPAWN_TIMEOUT_MS } = require('./helpers');
const { build, main } = require('../scripts/build-windows-launchers');

const ROOT = path.resolve(__dirname, '..');
const read = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const handlers = (file) => Object.values(read(file).hooks).flat().flatMap((group) => group.hooks);
const CODEX = read('hooks/codex-hooks.json').hooks;

test('Claude Code hooks run in exec form with no commandWindows', () => {
  for (const handler of handlers('hooks/hooks.json')) {
    assert.equal(handler.command, 'node', JSON.stringify(handler));
    assert.match(handler.args[0], /^\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/[\w-]+\.js$/);
    assert.equal(handler.commandWindows, undefined, JSON.stringify(handler));
  }
});

test('each Codex commandWindows is the encoded launcher source and changes no policy', () => {
  main();
  const source = fs.readFileSync(path.join(ROOT, 'hooks/windows-launcher.ps1'), 'utf8');
  const command = build(source, 'Stop');
  const decoded = Buffer.from(command.split(' ').at(-1), 'base64').toString('utf16le');
  assert.equal(decoded, source.replace(/\r\n/g, '\n').replaceAll('__RAZOR_EVENT__', 'Stop'));
  assert.doesNotMatch(command + decoded, /ExecutionPolicy/);
});

// Codex on Windows may start commandWindows from cmd.exe or from a PowerShell
// parent. A preload records the event and the stdin each launch hands to
// codex-hook.js, which proves the hook ran with its input under that parent.
const PARENTS = {
  'cmd.exe': (command) => ['cmd.exe', ['/d', '/s', '/c', `"${command}"`], { windowsVerbatimArguments: true }],
  'powershell.exe': (command) => ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}],
  'pwsh.exe': (command) => ['pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {}],
};
const onPath = (exe) => (process.env.PATH || '').split(path.delimiter).some((dir) => fs.existsSync(path.join(dir, exe)));
const temp = fs.mkdtempSync(path.join(ROOT, 'contract-ws-windows-launchers-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

for (const [parent, spawnArgs] of Object.entries(PARENTS)) {
  test(`every Codex hook runs through its Windows launcher under ${parent}`, { skip: process.platform !== 'win32' || !onPath(parent) }, () => {
    const log = path.join(temp, parent + '.log');
    const preload = path.join(temp, 'log-hook.cjs');
    fs.writeFileSync(preload, 'require("fs").appendFileSync(' + JSON.stringify(log) +
      ', JSON.stringify({ event: process.argv[2], input: require("fs").readFileSync(0, "utf8") }) + "\\n");\n');
    const env = { ...process.env, PLUGIN_ROOT: ROOT, NODE_OPTIONS: '--require "' + preload.replace(/\\/g, '/') + '"' };
    const events = Object.entries(CODEX).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((handler) => [event, handler])));
    for (const [event, handler] of events) {
      const [file, args, options] = spawnArgs(handler.commandWindows);
      const r = spawnSync(file, args, {
        ...options, env, input: JSON.stringify({ hook_event_name: event }), encoding: 'utf8', windowsHide: true,
        timeout: Math.max(120000, SPAWN_TIMEOUT_MS),
      });
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stderr, '');
    }
    const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(runs, events.map(([event]) => ({ event, input: JSON.stringify({ hook_event_name: event }) })));
  });
}

test('the Windows launcher falls back to fnm when Node is not on PATH', { skip: process.platform !== 'win32' }, (t) => {
  if (!onPath('fnm.exe')) return t.skip('fnm is not installed on this runner');
  const paths = (process.env.PATH || '').split(path.delimiter);
  const env = { ...process.env, PLUGIN_ROOT: ROOT };
  env.PATH = paths.filter((dir) => !['node.exe', 'node.cmd', 'node.bat'].some((exe) => fs.existsSync(path.join(dir, exe)))).join(path.delimiter);
  delete env.FNM_MULTISHELL_PATH;
  assert.notEqual(spawnSync('where.exe', ['/q', 'node'], { env }).status, 0, 'Node is still on the fixture PATH');
  const [file, args, options] = PARENTS['powershell.exe'](CODEX.SessionStart[0].hooks[0].commandWindows);
  const r = spawnSync(file, args, {
    ...options, env, encoding: 'utf8', windowsHide: true, timeout: Math.max(120000, SPAWN_TIMEOUT_MS),
    input: JSON.stringify({ session_id: 'launcher', hook_event_name: 'SessionStart', cwd: temp, source: 'startup' }),
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAZOR ACTIVE/);
});
