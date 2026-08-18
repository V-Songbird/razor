'use strict';

// Contract suite: canonical hook payloads in, exact emitted bytes out.
//
// Every other test asserts on a parsed field. This one asserts on the wire:
// each scenario pipes one fixture payload to one hook as a child process and
// compares stdout to a golden file byte for byte. An empty golden means the
// hook must emit nothing at all.
//
// It catches the class of bug a parsed assertion cannot see — a changed
// envelope key, a lost raw-stdout channel, a stray newline, a silently
// reworded deny — and it is the file to copy when porting razor to another
// host: the goldens ARE the port's acceptance criteria.
//
// Regenerate after an intentional wording change:
//   node tests/contract.test.js --update
// then read the diff. A golden that changed without a deliberate reason is
// the bug, not the test.

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');
const FIXTURES = path.join(__dirname, 'contract', 'fixtures');
const GOLDEN = path.join(__dirname, 'contract', 'golden');

const SESSION = 'contract-session';

// ---- fixture worlds -------------------------------------------------------

// Worlds live inside the plugin root, never under the system temp dir: the
// file meter deliberately exempts temp paths as scratch, so a fixture project
// built there could never exercise the new-file budget at all. Same convention
// as the dispatcher suite's workspace, and gitignored for the same reason.
const WORKSPACES = [];

function tmpDir(tag) {
  const dir = fs.mkdtempSync(path.join(__dirname, '..', `contract-ws-${tag}-`));
  WORKSPACES.push(dir);
  return dir;
}

function cleanWorkspaces() {
  for (const dir of WORKSPACES.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// A plain directory: no manifest, no git. SessionStart and the toggle need
// nothing more, and the absence of git keeps the ledger snapshot out of the
// picture entirely.
function emptyWorld() {
  return { cwd: tmpDir('empty') };
}

// A node project with one declared dependency and one source file, which is
// what every dependency gate needs to have an opinion at all.
function nodeProjectWorld() {
  const cwd = tmpDir('project');
  writeFile(cwd, 'package.json', JSON.stringify({ name: 'fixture', version: '1.0.0', dependencies: { express: '^4.19.2' } }, null, 2) + '\n');
  writeFile(cwd, 'src/app.js', "const express = require('express');\nmodule.exports = express;\n");
  return { cwd };
}

function git(dir, ...args) {
  return spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir,
    encoding: 'utf-8',
  });
}

function gitWorld(tag) {
  const cwd = tmpDir(tag);
  git(cwd, 'init', '-q');
  writeFile(cwd, 'a.txt', 'one\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'base');
  const sha = git(cwd, 'rev-parse', 'HEAD').stdout.trim();
  assert.match(sha, /^[0-9a-f]{7,40}$/, 'git fixture did not produce a commit');
  return { cwd, sha };
}

// A session that grew by 600 insertion-only lines and nine new files: the
// ledger's own definition of sprawl, pinned to exact numbers so the emitted
// text is deterministic.
function sprawlWorld() {
  const world = gitWorld('sprawl');
  fs.appendFileSync(path.join(world.cwd, 'a.txt'), 'x\n'.repeat(600));
  for (let i = 0; i < 9; i++) writeFile(world.cwd, `new${i}.js`, '// new\n');
  world.state = { ledger: { baseSha: world.sha, baseUntrackedFiles: [], fired: false } };
  return world;
}

function quietWorld() {
  const world = gitWorld('quiet');
  fs.appendFileSync(path.join(world.cwd, 'a.txt'), 'two\nthree\n');
  world.state = { ledger: { baseSha: world.sha, baseUntrackedFiles: [], fired: false } };
  return world;
}

// Four production files already written this turn, so the fixture payload is
// the fifth — the one the budget denies — without needing four prior runs.
function fourFilesInWorld() {
  const world = nodeProjectWorld();
  world.state = { turn: { turnKey: 'fixed-turn', count: 4, fired: false, kinds: { production: 4 } } };
  return world;
}

// ---- scenarios ------------------------------------------------------------

const SCENARIOS = [
  {
    name: 'session-start-startup',
    hook: 'session-start.js',
    world: emptyWorld,
    // The whole product: the ladder, as raw stdout, with no envelope.
    must: ['RAZOR ACTIVE', '1. Not genuinely needed? Skip it, say so in one line. (YAGNI)'],
    mustNot: ['hookSpecificOutput'],
  },
  {
    name: 'subagent-start-general',
    hook: 'subagent-start.js',
    world: emptyWorld,
    // Raw stdout is dropped for this event — the envelope is mandatory.
    must: ['"hookEventName":"SubagentStart"', '"additionalContext":"RAZOR ACTIVE'],
  },
  {
    name: 'subagent-start-explore',
    hook: 'subagent-start.js',
    world: emptyWorld,
    silent: true,
  },
  {
    name: 'pretooluse-bash-install-new',
    hook: 'pre-tool-use.js',
    world: nodeProjectWorld,
    must: ['"permissionDecision":"deny"', 'left-pad', 'express'],
  },
  {
    name: 'pretooluse-bash-install-declared',
    hook: 'pre-tool-use.js',
    world: nodeProjectWorld,
    silent: true,
  },
  {
    name: 'pretooluse-edit-new-import',
    hook: 'pre-tool-use.js',
    world: nodeProjectWorld,
    must: ['"permissionDecision":"deny"', 'left-pad', 'package.json'],
  },
  {
    name: 'pretooluse-write-within-budget',
    hook: 'pre-tool-use.js',
    world: nodeProjectWorld,
    silent: true,
  },
  {
    name: 'pretooluse-write-over-budget',
    hook: 'pre-tool-use.js',
    world: fourFilesInWorld,
    must: ['"permissionDecision":"deny"', 'new production file #5', 'Rung 2'],
  },
  {
    name: 'pretooluse-manifest-edit-adds-dep',
    hook: 'pre-tool-use.js',
    world: nodeProjectWorld,
    must: ['"permissionDecision":"deny"', 'left-pad'],
  },
  {
    name: 'userpromptsubmit-off',
    hook: 'mode-toggle.js',
    world: emptyWorld,
    must: ['RAZOR OFF'],
    mustNot: ['hookSpecificOutput', 'RAZOR ACTIVE'],
  },
  {
    name: 'userpromptsubmit-on',
    hook: 'mode-toggle.js',
    world: emptyWorld,
    must: ['RAZOR ACTIVE'],
    mustNot: ['hookSpecificOutput'],
  },
  {
    name: 'stop-ledger-fires',
    hook: 'build-ledger.js',
    world: sprawlWorld,
    must: ['"hookEventName":"Stop"', '+600 / -0 LOC', '9 new files'],
  },
  {
    name: 'stop-ledger-quiet',
    hook: 'build-ledger.js',
    world: quietWorld,
    silent: true,
  },
];

// ---- runner ---------------------------------------------------------------

function loadFixture(name, world) {
  const raw = fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf-8');
  // Fixtures are checked in verbatim; only the paths that cannot be known
  // until the world exists are substituted.
  const filled = raw
    .split('{{CWD}}').join(world.cwd.replace(/\\/g, '\\\\'))
    .split('{{SESSION}}').join(SESSION);
  return JSON.parse(filled);
}

// A hook must behave the same for every user, so the child sees no ambient
// RAZOR_* or CLAUDE_PLUGIN_* from the developer's own shell.
function childEnv(dataDir, extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(RAZOR_|CLAUDE_PLUGIN_)/.test(k)) continue;
    env[k] = v;
  }
  env.CLAUDE_PLUGIN_DATA = dataDir;
  return { ...env, ...(extra || {}) };
}

function runScenario(scenario) {
  const world = scenario.world();
  const dataDir = tmpDir('state');
  if (world.state) {
    fs.writeFileSync(path.join(dataDir, `razor-${SESSION}.json`), JSON.stringify(world.state));
  }
  const result = spawnSync('node', [path.join(HOOKS_DIR, scenario.hook)], {
    input: JSON.stringify(loadFixture(scenario.name, world)),
    encoding: 'utf-8',
    timeout: 30000,
    env: childEnv(dataDir, scenario.env),
  });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw new Error(`${scenario.hook} exited ${result.status}: ${result.stderr || '(no stderr)'}`);
  }
  return result.stdout;
}

function goldenPath(name) {
  return path.join(GOLDEN, `${name}.txt`);
}

if (process.argv.includes('--update')) {
  fs.mkdirSync(GOLDEN, { recursive: true });
  for (const scenario of SCENARIOS) {
    fs.writeFileSync(goldenPath(scenario.name), runScenario(scenario));
    process.stdout.write(`updated ${scenario.name}\n`);
  }
  cleanWorkspaces();
} else {
  describe('contract: exact emitted bytes per hook event', () => {
    after(cleanWorkspaces);
    for (const scenario of SCENARIOS) {
      test(scenario.name, () => {
        const actual = runScenario(scenario);
        const expected = fs.readFileSync(goldenPath(scenario.name), 'utf-8');
        assert.strictEqual(
          actual,
          expected,
          `emitted bytes drifted from tests/contract/golden/${scenario.name}.txt — ` +
            'if the change was deliberate, rerun with --update and read the diff',
        );
        // A golden regenerated from the code proves stability, never meaning.
        // These literals are what the scenario is FOR, asserted independently.
        if (scenario.silent) assert.strictEqual(actual, '', 'this scenario must emit nothing');
        for (const needle of scenario.must || []) assert.ok(actual.includes(needle), `missing: ${needle}`);
        for (const needle of scenario.mustNot || []) assert.ok(!actual.includes(needle), `must not contain: ${needle}`);
      });
    }
  });
}

module.exports = { SCENARIOS };
