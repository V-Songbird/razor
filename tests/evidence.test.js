'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { installedDeps, denyReason, parseInstallCommand } = require('../hooks/dep-guard');
const { shouldFire } = require('../hooks/build-ledger');
const { readState, writeState } = require('../hooks/razor-lib');

function fixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-fx-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

describe('unit: installedDeps manifest readers', () => {
  test('package.json: dependencies + devDependencies', () => {
    const dir = fixtureDir({
      'package.json': JSON.stringify({
        dependencies: { lodash: '^4', axios: '^1' },
        devDependencies: { jest: '^29' },
      }),
    });
    assert.deepStrictEqual(installedDeps('npm', dir).sort(), ['axios', 'jest', 'lodash']);
    assert.deepStrictEqual(installedDeps('pnpm', dir).sort(), ['axios', 'jest', 'lodash']);
  });

  test('walks up from a nested subdirectory', () => {
    const dir = fixtureDir({ 'package.json': JSON.stringify({ dependencies: { zod: '^3' } }) });
    const nested = path.join(dir, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    assert.deepStrictEqual(installedDeps('yarn', nested), ['zod']);
  });

  test('pyproject.toml PEP 621 arrays, specifiers stripped', () => {
    const dir = fixtureDir({
      'pyproject.toml': [
        '[project]',
        'dependencies = ["requests>=2.28", "flask[async]==2.3", "pydantic ~=2.0"]',
        '',
        '[project.optional-dependencies]',
        'test = ["pytest>=7"]',
      ].join('\n'),
    });
    assert.deepStrictEqual(installedDeps('pip', dir).sort(), ['flask', 'pydantic', 'pytest', 'requests']);
  });

  test('pyproject.toml poetry tables, python entry excluded', () => {
    const dir = fixtureDir({
      'pyproject.toml': [
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'httpx = "^0.27"',
        '',
        '[tool.poetry.group.dev.dependencies]',
        'ruff = "*"',
        '',
        '[build-system]',
        'requires = ["poetry-core"]',
      ].join('\n'),
    });
    // build-system requires is tooling, not installed deps — excluded
    assert.deepStrictEqual(installedDeps('poetry', dir).sort(), ['httpx', 'ruff']);
  });

  test('requirements.txt fallback, comments and flags skipped', () => {
    const dir = fixtureDir({
      'requirements.txt': '# deps\nrequests==2.31\n-r other.txt\nflask>=2\n\n',
    });
    assert.deepStrictEqual(installedDeps('pip', dir).sort(), ['flask', 'requests']);
  });

  test('Cargo.toml sections incl. [dependencies.foo] form', () => {
    const dir = fixtureDir({
      'Cargo.toml': [
        '[package]',
        'name = "app"',
        '',
        '[dependencies]',
        'serde = { version = "1", features = ["derive"] }',
        'tokio = "1"',
        '',
        '[dependencies.clap]',
        'version = "4"',
        '',
        '[dev-dependencies]',
        'insta = "1"',
      ].join('\n'),
    });
    assert.deepStrictEqual(installedDeps('cargo', dir).sort(), ['clap', 'insta', 'serde', 'tokio']);
  });

  test('go.mod require block and single-line require', () => {
    const dir = fixtureDir({
      'go.mod': [
        'module example.com/app',
        '',
        'go 1.22',
        '',
        'require github.com/single/dep v1.0.0',
        '',
        'require (',
        '\tgithub.com/gorilla/mux v1.8.0',
        '\tgolang.org/x/sync v0.7.0 // indirect',
        ')',
      ].join('\n'),
    });
    assert.deepStrictEqual(
      installedDeps('go', dir).sort(),
      ['github.com/gorilla/mux', 'github.com/single/dep', 'golang.org/x/sync']
    );
  });

  test('composer.json excludes php and ext-*', () => {
    const dir = fixtureDir({
      'composer.json': JSON.stringify({
        require: { php: '>=8.1', 'ext-json': '*', 'monolog/monolog': '^3' },
        'require-dev': { 'phpunit/phpunit': '^10' },
      }),
    });
    assert.deepStrictEqual(installedDeps('composer', dir).sort(), ['monolog/monolog', 'phpunit/phpunit']);
  });

  test('Gemfile gem lines', () => {
    const dir = fixtureDir({
      Gemfile: "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\ngem \"puma\"\n",
    });
    assert.deepStrictEqual(installedDeps('gem', dir).sort(), ['puma', 'rails']);
  });

  test('csproj PackageReference entries', () => {
    const dir = fixtureDir({
      'App.csproj':
        '<Project><ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13" />' +
        '<PackageReference Include="Serilog" Version="3" /></ItemGroup></Project>',
    });
    assert.deepStrictEqual(installedDeps('dotnet', dir).sort(), ['Newtonsoft.Json', 'Serilog']);
  });

  test('no manifest anywhere → null', () => {
    const dir = fixtureDir({});
    assert.strictEqual(installedDeps('cargo', dir), null);
    assert.strictEqual(installedDeps('npm', undefined), null);
  });
});

describe('unit: denyReason', () => {
  const hit = parseInstallCommand('npm i dayjs');

  test('with evidence: lists installed deps with count', () => {
    const reason = denyReason(hit, ['lodash', 'axios', 'date-fns']);
    assert.match(reason, /Already installed \(3\): axios, date-fns, lodash\./);
    assert.match(reason, /dayjs/);
  });

  test('list is capped with ellipsis', () => {
    const many = Array.from({ length: 40 }, (_, i) => `pkg-${String(i).padStart(2, '0')}`);
    const reason = denyReason(hit, many);
    assert.match(reason, /Already installed \(40\):/);
    assert.match(reason, /…/);
    assert.ok(!reason.includes('pkg-35')); // beyond the cap of 30
  });

  test('without evidence: generic rungs wording', () => {
    assert.match(denyReason(hit, null), /Rungs 3-5/);
    assert.match(denyReason(hit, []), /Rungs 3-5/);
  });
});

describe('integration: evidence-carrying deny', () => {
  test('deny reason includes the manifest deps when cwd has one', () => {
    const dir = fixtureDir({
      'package.json': JSON.stringify({ dependencies: { 'date-fns': '^3', lodash: '^4' } }),
    });
    const out = hookOutput(
      runHook('dep-guard.js', {
        session_id: freshSession(),
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'npm i dayjs' },
      })
    );
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Already installed \(2\): date-fns, lodash/);
  });

  test('deny falls back to generic wording without a manifest', () => {
    const dir = fixtureDir({});
    const out = hookOutput(
      runHook('dep-guard.js', {
        session_id: freshSession(),
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'cargo add serde' },
      })
    );
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Rungs 3-5/);
  });

  // Regression case from the razor-vs-ponytail benchmark (dep-toml task, 2026-07-06):
  // a stdlib-only task (TOML parsing) where the competing plugin's agent added a new
  // dependency anyway (a tomli fallback for pre-3.11 Pythons the task never asked to
  // support). The gate must still catch a pip install of that exact package.
  test('catches a stdlib-covered pip install (tomli fallback) with evidence', () => {
    const dir = fixtureDir({ 'requirements.txt': 'flask==3.0.3\nrequests==2.32.3\nrich==13.7.1\n' });
    const out = hookOutput(
      runHook('dep-guard.js', {
        session_id: freshSession(),
        cwd: dir,
        tool_name: 'Bash',
        tool_input: { command: 'pip install tomli' },
      })
    );
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /Already installed \(3\): flask, requests, rich/);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /tomli/);
  });
});

// ---- build ledger ----

function gitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-git-'));
  const g = (...args) =>
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      cwd: dir,
      encoding: 'utf-8',
    });
  g('init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  const sha = g('rev-parse', 'HEAD').stdout.trim();
  return { dir, sha };
}

describe('unit: shouldFire', () => {
  test('insertion-heavy growth fires; refactors and small diffs do not', () => {
    assert.strictEqual(shouldFire({ insertions: 800, deletions: 10, newFiles: 2 }, 500, 8), true);
    assert.strictEqual(shouldFire({ insertions: 800, deletions: 400, newFiles: 2 }, 500, 8), false);
    assert.strictEqual(shouldFire({ insertions: 100, deletions: 0, newFiles: 2 }, 500, 8), false);
    assert.strictEqual(shouldFire({ insertions: 0, deletions: 0, newFiles: 9 }, 500, 8), true);
  });
});

describe('integration: build ledger', () => {
  test('session-start snapshots the git baseline', () => {
    const { dir, sha } = gitRepo();
    const session = freshSession();
    const r = runHook('session-start.js', { session_id: session, cwd: dir, hook_event_name: 'SessionStart' });
    assert.match(r.stdout, /RAZOR ACTIVE/);
    const state = readState(session);
    assert.strictEqual(state.ledger.baseSha, sha);
    assert.strictEqual(state.ledger.fired, false);
  });

  test('fires once on sprawl, then stays silent', () => {
    const { dir, sha } = gitRepo();
    const session = freshSession();
    writeState(session, { ledger: { baseSha: sha, baseUntracked: 0, fired: false } });

    // sprawl: 600 added lines in a tracked file + several new untracked files
    fs.appendFileSync(path.join(dir, 'a.txt'), Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n'));
    for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(dir, `new${i}.js`), '// x\n');

    const input = { session_id: session, cwd: dir, hook_event_name: 'Stop' };
    const first = hookOutput(runHook('build-ledger.js', input));
    assert.match(first.hookSpecificOutput.additionalContext, /razor ledger: \+600 \/ -0 LOC, 9 new files/);

    assert.strictEqual(hookOutput(runHook('build-ledger.js', input)), null); // fired already
  });

  test('silent on a well-behaved session', () => {
    const { dir, sha } = gitRepo();
    const session = freshSession();
    writeState(session, { ledger: { baseSha: sha, baseUntracked: 0, fired: false } });
    fs.appendFileSync(path.join(dir, 'a.txt'), 'two\nthree\n');
    const out = hookOutput(runHook('build-ledger.js', { session_id: session, cwd: dir }));
    assert.strictEqual(out, null);
  });

  test('silent outside a git repo and under RAZOR_LEDGER=off', () => {
    const dir = fixtureDir({});
    const session = freshSession();
    writeState(session, { ledger: { baseSha: 'deadbeef', baseUntracked: 0, fired: false } });
    assert.strictEqual(hookOutput(runHook('build-ledger.js', { session_id: session, cwd: dir })), null);

    const { dir: repo, sha } = gitRepo();
    const s2 = freshSession();
    writeState(s2, { ledger: { baseSha: sha, baseUntracked: 0, fired: false } });
    for (let i = 0; i < 9; i++) fs.writeFileSync(path.join(repo, `n${i}.js`), '// x\n');
    const r = runHook('build-ledger.js', { session_id: s2, cwd: repo }, { RAZOR_LEDGER: 'off' });
    assert.strictEqual(hookOutput(r), null);
  });

  test('untracked baseline is subtracted', () => {
    const { dir, sha } = gitRepo();
    fs.writeFileSync(path.join(dir, 'pre-existing.js'), '// was here\n');
    const session = freshSession();
    writeState(session, { ledger: { baseSha: sha, baseUntracked: 1, fired: false } });
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(dir, `n${i}.js`), '// x\n');
    // 9 untracked total - 1 baseline = 8 new → not > 8, stays silent
    assert.strictEqual(hookOutput(runHook('build-ledger.js', { session_id: session, cwd: dir })), null);
  });
});
