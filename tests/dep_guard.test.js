'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');
const { parseInstallCommand, parseInstallCommands, check, depKey, packageName } = require('../hooks/dep-guard');
const { readState } = require('../hooks/razor-lib');

// A chained command used to be checkpointed for its first install alone, and
// the retry that cleared that one carried the rest in unexamined.
describe('unit: every install on the line', () => {
  const CHAINED = 'npm install axios && npm install lodash';

  test('parseInstallCommands returns each install, in order', () => {
    const hits = parseInstallCommands(CHAINED);
    assert.deepStrictEqual(hits.map((h) => h.packages), [['axios'], ['lodash']]);
  });

  test('parseInstallCommand still answers with the first one', () => {
    assert.deepStrictEqual(parseInstallCommand(CHAINED).packages, ['axios']);
  });

  test('each package is checkpointed once, then the command passes', () => {
    const state = {};
    const data = { tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command: CHAINED } };
    assert.match(check(data, state), /axios/);
    assert.match(check(data, state), /lodash/);
    assert.strictEqual(check(data, state), null);
  });
});

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
    ['env PIP_NO_CACHE_DIR=1 pip install requests', 'pip', ['requests']],
    ['command pip install requests', 'pip', ['requests']],
    ['cd api && npm i express', 'npm', ['express']],
    ['git pull; pip install requests', 'pip', ['requests']],
    // shell redirects are not package names
    ['cargo add serde 2>&1', 'cargo', ['serde']],
    ['npm install lodash > install.log 2>&1', 'npm', ['lodash']],
    ['pip install requests 2>$null', 'pip', ['requests']],
    ['npm i axios >> build.log', 'npm', ['axios']],
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
    'npm install > build.log', // bare restore, redirect target is not a package
    'npm install 2>&1',
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

  test('packageName strips version specs and extras, keeps npm scopes', () => {
    assert.strictEqual(packageName('axios@^1.8'), 'axios');
    assert.strictEqual(packageName('@scope/pkg@2.0.0'), '@scope/pkg');
    assert.strictEqual(packageName('@scope/pkg'), '@scope/pkg');
    assert.strictEqual(packageName('flask==2.0'), 'flask');
    assert.strictEqual(packageName('requests[socks]>=2.28'), 'requests');
    assert.strictEqual(packageName('github.com/gorilla/mux@v1.8.0'), 'github.com/gorilla/mux');
    assert.strictEqual(packageName('serde'), 'serde');
  });

  test('a versioned spec and the bare name share one decision', () => {
    assert.strictEqual(
      depKey(parseInstallCommand('npm i axios@^1.8')),
      depKey(parseInstallCommand('npm install axios'))
    );
    assert.strictEqual(
      depKey(parseInstallCommand('pip install flask==2.0')),
      depKey(parseInstallCommand('pip install Flask'))
    );
  });

  test('shell quotes come off the token, and separators fold into one identity', () => {
    assert.deepStrictEqual(parseInstallCommand("pip install 'flask>=2.1'").packages, ['flask>=2.1']);
    assert.deepStrictEqual(parseInstallCommand('npm install "axios@^1.9"').packages, ['axios@^1.9']);
    assert.strictEqual(
      depKey(parseInstallCommand("pip install 'flask>=2.1'")),
      depKey(parseInstallCommand('pip install flask'))
    );
    assert.strictEqual(
      depKey(parseInstallCommand('pip install python_dotenv')),
      depKey(parseInstallCommand('pip install python-dotenv'))
    );
  });
});

// A shell's -c command is a command line of its own. The whole wrapper read
// as one command that installs nothing, and the chaining split cut inside its
// quotes, so `bash -c "npm install axios; echo done"` went unseen.
describe('installs wrapped in sh -c, bash -c or zsh -c', () => {
  const cases = [
    ['bash -c "npm install axios"', [['axios']]],
    ["sh -c 'pip install requests'", [['requests']]],
    ['bash -c "npm install axios; echo done"', [['axios']]],
    ['zsh -lc "cd app; npm install axios && npm install lodash"', [['axios'], ['lodash']]],
    ['bash -c "pip install \\"flask>=2.1\\""', [['flask>=2.1']]],
    ['sudo bash -c "npm i -g serve" > install.log 2>&1', [['serve']]],
    ['bash -c "npm run build; echo done"', []],
    ["sh -c 'git status'", []],
  ];
  for (const [command, packages] of cases) {
    test(`${command} → ${JSON.stringify(packages)}`, () => {
      assert.deepStrictEqual(parseInstallCommands(command).map((h) => h.packages), packages);
    });
  }

  const call = (command) => ({ session_id: freshSession(), tool_name: 'Bash', tool_input: { command } });

  test('bash -c "npm install axios" is denied once, and the exact retry passes', () => {
    const wrapped = call('bash -c "npm install axios"');
    const first = hookOutput(runHook('pre-tool-use.js', wrapped));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /'axios' adds a new npm dependency/);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', wrapped)), null);
  });

  test('a -c command that installs nothing stays silent', () => {
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', call('bash -c "npm run build; echo done"'))), null);
  });
});

// A shell runs every line of a command, so an install on a later line is an
// install. A quoted line break, a continued line and a here-document's body
// start no command.
describe('installs on every line of a multi-line command', () => {
  const cases = [
    ['cd app\nnpm install axios', [['axios']]],
    ['echo start\npip install requests', [['requests']]],
    ['cd app\r\nnpm install axios\r\n', [['axios']]],
    ['git commit -m "line one\nnpm install axios"', []],
    ["echo 'line one\nnpm install axios'", []],
    ['npm install \\\n  axios', [['axios']]],
    ["cat > setup.sh <<'EOF'\nnpm install express\nEOF\nnpm install axios", [['axios']]],
    ['bash -c "cd app\nnpm install axios"', [['axios']]],
  ];
  for (const [command, packages] of cases) {
    test(`${JSON.stringify(command)} → ${JSON.stringify(packages)}`, () => {
      assert.deepStrictEqual(parseInstallCommands(command).map((h) => h.packages), packages);
    });
  }

  for (const [command, pkg] of [['cd app\nnpm install axios', 'axios'], ['echo start\npip install requests', 'requests']]) {
    test(`${JSON.stringify(command)} is denied once naming ${pkg}, and the exact retry passes`, () => {
      const call = { session_id: freshSession(), tool_name: 'Bash', tool_input: { command } };
      const first = hookOutput(runHook('pre-tool-use.js', call));
      assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(first.hookSpecificOutput.permissionDecisionReason, new RegExp(`'${pkg}' adds a new`));
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', call)), null);
    });
  }
});

// Quoted text is not a command line: a commit message or a node -e script that
// mentions an install used to be split at its ';' and denied. The quoted
// command PowerShell or cmd runs is one, and is parsed as one.
describe('quoted text, and commands run by PowerShell or cmd', () => {
  const cases = [
    ['git commit -m "fix; npm install y"', []],
    ["node -e \"const x = 1; console.log('npm install axios')\"", []],
    ['pwsh -Command "cd app; npm i x"', [['x']]],
    ['powershell -NoProfile -ExecutionPolicy Bypass -Command "npm install x"', [['x']]],
    ['pwsh -Command npm install x', [['x']]],
    ['cmd /c "cd app && npm i x"', [['x']]],
    ['cmd.exe /s /c "npm install a && npm install b"', [['a'], ['b']]],
    ['cmd /c npm install x', [['x']]],
    ['pwsh -Command "Get-ChildItem"; npm install z', [['z']]],
  ];
  for (const [command, packages] of cases) {
    test(`${command} → ${JSON.stringify(packages)}`, () => {
      assert.deepStrictEqual(parseInstallCommands(command).map((h) => h.packages), packages);
    });
  }

  for (const command of ['pwsh -Command "cd app; npm i x"', 'cmd /c "cd app && npm i x"']) {
    test(`${command} is denied once naming x, and the exact retry passes`, () => {
      const call = { session_id: freshSession(), tool_name: 'Bash', tool_input: { command } };
      const first = hookOutput(runHook('pre-tool-use.js', call));
      assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
      assert.match(first.hookSpecificOutput.permissionDecisionReason, /'x' adds a new npm dependency/);
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', call)), null);
    });
  }

  test('a commit message that mentions an install stays silent', () => {
    const call = { session_id: freshSession(), tool_name: 'Bash', tool_input: { command: 'git commit -m "fix; npm install y"' } };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', call)), null);
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
    const first = hookOutput(runHook('pre-tool-use.js', input(session, 'npm install lodash')));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /razor:/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /lodash/);

    const retry = hookOutput(runHook('pre-tool-use.js', input(session, 'npm install lodash')));
    assert.strictEqual(retry, null);
  });

  test('reworded retry with same packages passes too', () => {
    const session = freshSession();
    runHook('pre-tool-use.js', input(session, 'npm i lodash'));
    const retry = hookOutput(runHook('pre-tool-use.js', input(session, 'npm install --save lodash')));
    assert.strictEqual(retry, null);
  });

  test('a different package is a fresh gate', () => {
    const session = freshSession();
    runHook('pre-tool-use.js', input(session, 'npm i lodash'));
    const other = hookOutput(runHook('pre-tool-use.js', input(session, 'npm i axios')));
    assert.strictEqual(other.hookSpecificOutput.permissionDecision, 'deny');
  });

  test('non-install commands stay silent', () => {
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(freshSession(), 'git status'))), null);
  });

  // Both words are members of every plain object, so a bare lookup in the
  // subcommand table would find them.
  for (const command of ['constructor add left-pad', '__proto__ install left-pad', 'Constructor.exe add x']) {
    test(`a command named after an object member gets no decision: ${command}`, () => {
      assert.strictEqual(check({ tool_name: 'Bash', cwd: os.tmpdir(), tool_input: { command } }, {}), null);
      assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(freshSession(), command))), null);
    });
  }

  test('installing an already-declared dependency never checkpoints', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-dg-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4' } }));
    const withCwd = { ...input(freshSession(), 'npm install lodash'), cwd: dir };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', withCwd)), null);

    const py = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-dg-'));
    fs.writeFileSync(path.join(py, 'requirements.txt'), 'python-dotenv==1.0\nflask>=2.0\n');
    const pyCwd = { ...input(freshSession(), 'pip install python_dotenv'), cwd: py };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', pyCwd)), null);
    // the realistic shell spelling of a spec'd reinstall: quoted
    const quoted = { ...input(freshSession(), "pip install 'flask>=2.1'"), cwd: py };
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', quoted)), null);
  });

  test('the hyphen and underscore spellings of a pip package share one nudge', () => {
    const session = freshSession();
    const first = hookOutput(runHook('pre-tool-use.js', input(session, 'pip install python_dotenv')));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'pip install python-dotenv'))), null);
  });

  test('a versioned install denied once passes on the bare-name retry, ledger key normalized', () => {
    const session = freshSession();
    const first = hookOutput(runHook('pre-tool-use.js', input(session, 'npm i axios@^1.8')));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(readState(session).deniedImports['node:axios'], true);
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', input(session, 'npm install axios'))), null);
  });

  test('RAZOR_DEP_GUARD=off disables the gate', () => {
    const r = runHook('pre-tool-use.js', input(freshSession(), 'npm i lodash'), { RAZOR_DEP_GUARD: 'off' });
    assert.strictEqual(hookOutput(r), null);
  });

  test('RAZOR_DISABLE=1 disables the gate', () => {
    const r = runHook('pre-tool-use.js', input(freshSession(), 'npm i lodash'), { RAZOR_DISABLE: '1' });
    assert.strictEqual(hookOutput(r), null);
  });
});

describe('locations, flag values, and self-upgrades are not dependencies', () => {
  const cases = [
    ['npm install ./local-lib', 'a relative path'],
    ['npm install ../sibling', 'a parent-relative path'],
    ['npm install file:../lib', 'a file: spec'],
    ['npm install https://example.com/pkg.tgz', 'a URL archive'],
    ['go get ./...', "go's own package wildcard"],
    ['pip install --upgrade pip', 'pip upgrading itself'],
    ['npm install --prefix /tmp/app', 'a flag value that is a path'],
  ];
  for (const [command, why] of cases) {
    test(`no install parsed from ${why}: ${command}`, () => {
      assert.strictEqual(parseInstallCommand(command), null);
    });
  }

  test('a flag value is never reported as the package', () => {
    const hit = parseInstallCommand('npm install --tag next axios');
    assert.deepStrictEqual(hit && hit.packages, ['axios']);
  });

  test('a real package alongside a path is still caught', () => {
    const hit = parseInstallCommand('pip install -t ./vendor requests');
    assert.deepStrictEqual(hit && hit.packages, ['requests']);
  });

  // -p names the workspace member being edited, not something being added.
  test('a workspace selector is never reported as the package', () => {
    assert.deepStrictEqual(parseInstallCommand('cargo add -p mycrate serde').packages, ['serde']);
    assert.deepStrictEqual(parseInstallCommand('cargo add --package mycrate serde').packages, ['serde']);
  });
});

describe('PowerShell is gated exactly like Bash', () => {
  test('an install issued through PowerShell is denied once, and the retry passes', () => {
    const call = {
      session_id: freshSession(),
      tool_name: 'PowerShell',
      tool_input: { command: 'npm install axios' },
    };
    const out = hookOutput(runHook('pre-tool-use.js', call));
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /axios/);
    assert.strictEqual(runHook('pre-tool-use.js', call).stdout.trim(), '');
  });

  test('an ordinary PowerShell command is never gated', () => {
    const r = runHook('pre-tool-use.js', {
      session_id: freshSession(),
      tool_name: 'PowerShell',
      tool_input: { command: 'Get-ChildItem -Recurse' },
    });
    assert.strictEqual(r.stdout.trim(), '');
  });
});
