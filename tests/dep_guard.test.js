'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { parseInstallCommand, depKey } = require('../hooks/dep-guard');

describe('unit: parseInstallCommand', () => {
  const adds = [
    ['npm install lodash', 'npm', ['lodash']],
    ['npm i lodash', 'npm', ['lodash']],
    ['npm install --save-dev jest', 'npm', ['jest']],
    ['pnpm add -D typescript', 'pnpm', ['typescript']],
    ['yarn add axios', 'yarn', ['axios']],
    ['yarn global add serve', 'yarn', ['serve']],
    ['bun add zod', 'bun', ['zod']],
    ['pip install requests', 'pip', ['requests']],
    ['pip3 install requests flask', 'pip3', ['requests', 'flask']],
    ['python -m pip install numpy', 'pip', ['numpy']],
    ['uv pip install httpx', 'pip', ['httpx']],
    ['uv add httpx', 'uv', ['httpx']],
    ['poetry add pydantic', 'poetry', ['pydantic']],
    ['pipenv install django', 'pipenv', ['django']],
    ['cargo add serde', 'cargo', ['serde']],
    ['go get github.com/gorilla/mux', 'go', ['github.com/gorilla/mux']],
    ['composer require monolog/monolog', 'composer', ['monolog/monolog']],
    ['gem install rails', 'gem', ['rails']],
    ['dotnet add package Newtonsoft.Json', 'dotnet', ['Newtonsoft.Json']],
    ['dotnet add MyProj.csproj package Serilog', 'dotnet', ['Serilog']],
    ['sudo npm install -g http-server', 'npm', ['http-server']],
    ['cd api && npm i express', 'npm', ['express']],
    ['git pull; pip install requests', 'pip', ['requests']],
  ];
  for (const [cmd, manager, packages] of adds) {
    test(`add: ${cmd}`, () => {
      assert.deepStrictEqual(parseInstallCommand(cmd), { manager, packages });
    });
  }

  const passes = [
    'npm install', // lockfile restore
    'npm ci',
    'pnpm install',
    'yarn install',
    'bun install',
    'pip install -r requirements.txt',
    'pip install -e .',
    'pip install .',
    'poetry install',
    'pipenv install',
    'dotnet restore',
    'dotnet add reference ../Other.csproj',
    'git status',
    'npm run build',
    'npm test',
    'apt install jq', // system managers out of scope
    'brew install ripgrep',
    'winget install nodejs',
    'echo "npm is great"',
  ];
  for (const cmd of passes) {
    test(`pass: ${cmd}`, () => {
      assert.strictEqual(parseInstallCommand(cmd), null);
    });
  }

  test('depKey is order- and case-insensitive', () => {
    const a = depKey(parseInstallCommand('pip install Flask requests'));
    const b = depKey(parseInstallCommand('pip install requests flask'));
    assert.strictEqual(a, b);
  });
});

describe('integration: soft gate', () => {
  const input = (sessionId, command) => ({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command },
  });

  test('first install denied with reason, identical retry passes', () => {
    const session = freshSession();
    const first = hookOutput(runHook('dep-guard.js', input(session, 'npm install lodash')));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /razor:/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /lodash/);

    const retry = hookOutput(runHook('dep-guard.js', input(session, 'npm install lodash')));
    assert.strictEqual(retry, null);
  });

  test('reworded retry with same packages passes too', () => {
    const session = freshSession();
    runHook('dep-guard.js', input(session, 'npm i lodash'));
    const retry = hookOutput(runHook('dep-guard.js', input(session, 'npm install --save lodash')));
    assert.strictEqual(retry, null);
  });

  test('a different package is a fresh gate', () => {
    const session = freshSession();
    runHook('dep-guard.js', input(session, 'npm i lodash'));
    const other = hookOutput(runHook('dep-guard.js', input(session, 'npm i axios')));
    assert.strictEqual(other.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('non-install commands stay silent', () => {
    assert.strictEqual(hookOutput(runHook('dep-guard.js', input(freshSession(), 'git status'))), null);
  });

  test('RAZOR_DEP_GUARD=off disables the gate', () => {
    const r = runHook('dep-guard.js', input(freshSession(), 'npm i lodash'), { RAZOR_DEP_GUARD: 'off' });
    assert.strictEqual(hookOutput(r), null);
  });

  test('RAZOR_DISABLE=1 disables the gate', () => {
    const r = runHook('dep-guard.js', input(freshSession(), 'npm i lodash'), { RAZOR_DISABLE: '1' });
    assert.strictEqual(hookOutput(r), null);
  });
});
