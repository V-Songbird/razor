'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  auditProject,
  knipAvailable,
  formatReport,
  workspaceDirs,
  configuredIgnores,
  mentionedOutsideImports,
} = require('../scripts/unused-deps');
const { readPythonDeps } = require('../hooks/dep-guard');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, typeof content === 'string' ? content : JSON.stringify(content));
  return full;
}

// Fakes an installed package so the audit has a tree to read as evidence.
function installPackage(dir, name, manifest) {
  write(dir, path.join('node_modules', ...name.split('/'), 'package.json'), {
    name,
    version: '1.0.0',
    ...manifest,
  });
}

function makeNodeWorkspace() {
  const dir = tmp('razor-unused-node-');
  write(dir, 'package.json', {
    name: 'ws',
    version: '1.0.0',
    dependencies: { express: '^4.19.2', lodash: '^4.17.21', chalk: '^5.3.0' },
    devDependencies: { eslint: '^9.0.0' },
    scripts: { lint: 'eslint .' },
  });
  write(dir, 'src/app.js', "const express = require('express');\nmodule.exports = express;\n");
  // A dep imported only from a test file must still count as used.
  write(dir, 'tests/app.test.js', "const chalk = require('chalk');\n");
  write(dir, '.eslintrc.json', { extends: [] });
  return dir;
}

function makePythonWorkspace() {
  const dir = tmp('razor-unused-py-');
  write(dir, 'requirements.txt', 'requests==2.31.0\npython-dotenv==1.0.0\nflask==3.0.0\nblack==24.0.0\n');
  write(dir, 'main.py', 'import requests\nimport dotenv\n');
  write(dir, 'tox.ini', '[testenv]\ndeps = black\n');
  return dir;
}

const node = (result) => result.ecosystems.find((e) => e.eco === 'node');
const python = (result) => result.ecosystems.find((e) => e.eco === 'python');
const names = (bucket) => bucket.map((entry) => entry.dep);

describe('unused-deps: node ecosystem bucketing', () => {
  test('with nothing installed, an unreferenced dep is only LIKELY unused', () => {
    const result = auditProject(makeNodeWorkspace());
    const eco = node(result);
    assert.strictEqual(eco.resolved, false);
    assert.deepStrictEqual(names(eco.confirmed), []);
    assert.deepStrictEqual(names(eco.likely), ['lodash']);
    assert.deepStrictEqual(names(eco.unknown), ['eslint']);
    assert.match(eco.likely[0].evidence, /nothing is installed/);
    assert.strictEqual(result.usedCount, 2); // express (src) + chalk (test-only)
  });

  test('with an installed tree to read, the same dep becomes CONFIRMED unused', () => {
    const dir = makeNodeWorkspace();
    installPackage(dir, 'express', {});
    const eco = node(auditProject(dir));
    assert.strictEqual(eco.resolved, true);
    assert.deepStrictEqual(names(eco.confirmed), ['lodash']);
    assert.match(eco.confirmed[0].evidence, /peer-requires it/);
  });

  test('a dep another installed package peer-requires is never called unused', () => {
    const dir = makeNodeWorkspace();
    installPackage(dir, 'express', {});
    installPackage(dir, 'some-plugin', { peerDependencies: { lodash: '^4' } });
    const eco = node(auditProject(dir));
    assert.deepStrictEqual(names(eco.confirmed), []);
    const entry = eco.unknown.find((u) => u.dep === 'lodash');
    assert.ok(entry, 'lodash should be unknown, not unused');
    assert.match(entry.evidence, /satisfies a peer dependency of some-plugin/);
  });

  test('a dep whose installed copy ships a command is never called unused', () => {
    const dir = makeNodeWorkspace();
    installPackage(dir, 'lodash', { bin: { lodash: './cli.js' } });
    const eco = node(auditProject(dir));
    assert.deepStrictEqual(names(eco.confirmed), []);
    assert.match(eco.unknown.find((u) => u.dep === 'lodash').evidence, /ships a command/);
  });

  test('a type-only import counts as usage', () => {
    const dir = makeNodeWorkspace();
    write(dir, 'src/types.ts', "import type { Debounced } from 'lodash';\nexport type X = Debounced;\n");
    const eco = node(auditProject(dir));
    assert.ok(!names(eco.confirmed).concat(names(eco.likely)).includes('lodash'));
  });

  test('an import from a single-file component counts as usage', () => {
    const dir = makeNodeWorkspace();
    write(dir, 'src/Card.vue', "<script>\nimport _ from 'lodash';\nexport default {};\n</script>\n");
    const eco = node(auditProject(dir));
    assert.ok(!names(eco.confirmed).concat(names(eco.likely)).includes('lodash'));
  });
});

describe('unused-deps: configured ignores', () => {
  test("the project's own ignore list drops a dep from every bucket", () => {
    const dir = makeNodeWorkspace();
    write(dir, 'knip.json', { ignoreDependencies: ['lodash'] });
    assert.deepStrictEqual([...configuredIgnores(dir)], ['lodash']);
    const eco = node(auditProject(dir));
    assert.deepStrictEqual(names(eco.likely), []);
    assert.strictEqual(eco.ignored, 1);
  });

  test('the ignore list is also read from package.json', () => {
    const dir = makeNodeWorkspace();
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'));
    pkg.knip = { ignoreDependencies: ['lodash'] };
    write(dir, 'package.json', pkg);
    assert.deepStrictEqual([...configuredIgnores(dir)], ['lodash']);
  });
});

describe('unused-deps: workspaces', () => {
  function makeMonorepo() {
    const dir = tmp('razor-unused-mono-');
    write(dir, 'package.json', {
      name: 'mono',
      version: '1.0.0',
      workspaces: ['packages/*'],
      dependencies: { chalk: '^5.3.0' },
    });
    write(dir, 'index.js', "require('chalk');\n");
    write(dir, 'packages/api/package.json', { name: 'api', dependencies: { express: '^4.19.2' } });
    write(dir, 'packages/api/index.js', "require('express');\n");
    write(dir, 'packages/web/package.json', { name: 'web', dependencies: { lodash: '^4.17.21' } });
    write(dir, 'packages/web/index.js', "console.log('nothing imported');\n");
    return dir;
  }

  test('workspace packages are found from the root manifest', () => {
    const dir = makeMonorepo();
    assert.deepStrictEqual(
      workspaceDirs(dir).map((d) => path.basename(d)),
      ['api', 'web'],
    );
  });

  test('each package is audited against its own manifest and its own files', () => {
    const result = auditProject(makeMonorepo());
    const byPackage = Object.fromEntries(result.workspaces.map((w) => [path.basename(w.dir), w]));
    assert.deepStrictEqual(names(node(byPackage.api).likely), []);
    assert.deepStrictEqual(names(node(byPackage.web).likely), ['lodash']);
  });

  test("the root audit never charges a workspace package's dependency to the root", () => {
    const result = auditProject(makeMonorepo());
    const rootEco = node(result);
    assert.deepStrictEqual(names(rootEco.likely), []);
    assert.match(formatReport(makeMonorepo(), result), /# workspace: packages[\\/]web/);
  });
});

describe('unused-deps: python ecosystem bucketing', () => {
  test('python is never confirmed — no resolver read its metadata', () => {
    const result = auditProject(makePythonWorkspace());
    const eco = python(result);
    assert.strictEqual(eco.resolved, false);
    assert.deepStrictEqual(names(eco.confirmed), []);
    assert.deepStrictEqual(names(eco.likely), ['flask']);
    assert.deepStrictEqual(names(eco.unknown), ['black']);
  });

  test('suppressing-direction normalization: python-dotenv counts as used when imported as dotenv', () => {
    const eco = python(auditProject(makePythonWorkspace()));
    const flagged = [...eco.confirmed, ...eco.likely, ...eco.unknown].map((u) => u.dep);
    assert.ok(!flagged.includes('python-dotenv'));
  });

  test('a requirements file that includes another declares both files\' dependencies', () => {
    const dir = tmp('razor-unused-req-');
    write(dir, 'requirements.txt', '-r requirements-dev.txt\nrequests==2.31.0\n');
    write(dir, 'requirements-dev.txt', 'pytest==8.0.0\n');
    assert.deepStrictEqual(readPythonDeps(dir).sort(), ['pytest', 'requests']);
  });

  test('PEP 735 dependency groups are declared, and an include-group name is not a package', () => {
    const dir = tmp('razor-unused-groups-');
    write(
      dir,
      'pyproject.toml',
      '[project]\nname = "x"\ndependencies = ["requests"]\n\n' +
        '[dependency-groups]\ntest = ["pytest", "coverage"]\nall = [{include-group = "test"}]\n',
    );
    const deps = readPythonDeps(dir).sort();
    assert.deepStrictEqual(deps, ['coverage', 'pytest', 'requests']);
  });
});

function makeTsWorkspace() {
  const dir = tmp('razor-unused-ts-');
  write(dir, 'package.json', {
    name: 'ts-ws',
    version: '1.0.0',
    dependencies: { express: '^4.19.2', lodash: '^4.17.21', '@types/lodash': '^4.17.0' },
    devDependencies: { typescript: '^5.5.0', '@types/node': '^20.0.0', '@types/better-sqlite3': '^7.6.0' },
  });
  write(dir, 'src/app.ts', "import express from 'express';\nexport default express;\n");
  return dir;
}

describe('unused-deps: TypeScript toolchain classification', () => {
  test('devDependency + @types/* + known toolchain route to unknown with a reason', () => {
    const eco = node(auditProject(makeTsWorkspace()));
    assert.deepStrictEqual(names(eco.likely), ['lodash']);
    assert.strictEqual(eco.likely[0].reason, undefined);

    const byDep = Object.fromEntries(eco.unknown.map((u) => [u.dep, u.reason]));
    assert.strictEqual(byDep['typescript'], 'toolchain - consumed by tsc/build, not imported');
    assert.strictEqual(byDep['@types/node'], 'type definitions - consumed by tsc');
    assert.strictEqual(byDep['@types/better-sqlite3'], 'type definitions - consumed by tsc');
  });

  test('@types/* declared under regular dependencies still routes to unknown', () => {
    const eco = node(auditProject(makeTsWorkspace()));
    const typesLodash = eco.unknown.find((u) => u.dep === '@types/lodash');
    assert.ok(typesLodash, '@types/lodash (a regular dependency) should be unknown');
    assert.strictEqual(typesLodash.reason, 'type definitions - consumed by tsc');
  });
});

describe('unused-deps: CLI', () => {
  const run = (dir) =>
    spawnSync('node', [path.join(__dirname, '..', 'scripts', 'unused-deps.js'), dir], { encoding: 'utf-8' });

  test('prints per-bucket lines, verdict, and known-limits footer', () => {
    const r = run(makeNodeWorkspace());
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Likely unused \(1\) — nothing references them, and nothing could prove it:/);
    assert.match(r.stdout, /lodash: no import found in \d+ source files scanned/);
    assert.match(r.stdout, /Unknown \(1\)/);
    assert.match(r.stdout, /Verdict: 2 used, 0 confirmed unused, 1 likely unused, 1 unknown\./);
    assert.match(r.stdout, /Known limits:/);
  });

  test('never claims high confidence for a result no resolver proved', () => {
    const r = run(makeNodeWorkspace());
    assert.doesNotMatch(r.stdout, /high confidence/i);
  });

  test('no supported manifest reports cleanly', () => {
    const r = run(tmp('razor-unused-empty-'));
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /No supported manifest found/);
  });
});

function installFakeKnip(dir) {
  installPackage(dir, 'knip', {});
}

describe('unused-deps: knip detection', () => {
  test('knipAvailable is false when knip is not installed in the target project', () => {
    assert.strictEqual(knipAvailable(makeNodeWorkspace()), false);
  });

  test('knipAvailable is true when knip is resolvable from the target project node_modules', () => {
    const dir = makeNodeWorkspace();
    installFakeKnip(dir);
    assert.strictEqual(knipAvailable(dir), true);
  });

  test('report escalates to knip by name only when it is detected, never suggesting installation', () => {
    const dir = makeNodeWorkspace();
    const withoutKnip = formatReport(dir, auditProject(dir));
    assert.doesNotMatch(withoutKnip, /knip/i);

    installFakeKnip(dir);
    const withKnip = formatReport(dir, auditProject(dir));
    assert.match(withKnip, /knip is available in this project/);
    assert.match(withKnip, /npx knip/);
    // Never tells the user to add knip as a dependency — only to run it.
    assert.doesNotMatch(withKnip, /install knip/i);
    assert.doesNotMatch(withKnip, /npm install knip|add knip/i);
  });

  test('python ecosystem never gets a knip escalation (JS\\/TS-only tool)', () => {
    const dir = makePythonWorkspace();
    assert.doesNotMatch(formatReport(dir, auditProject(dir)), /knip/i);
  });
});

describe('scoped names are visible outside imports', () => {
  test('a scoped dep named in an npm script is not reported unused', () => {
    assert.strictEqual(mentionedOutsideImports('@scope/cli', 'node_modules/.bin/x && @scope/cli build'), true);
  });

  test('a scoped dep named in a config file is not reported unused', () => {
    assert.strictEqual(mentionedOutsideImports('@eslint/js', 'plugins: ["@eslint/js"]'), true);
  });

  test('an unmentioned scoped dep still reads as unmentioned', () => {
    assert.strictEqual(mentionedOutsideImports('@scope/cli', 'nothing here'), false);
  });

  test('a longer scoped name does not match a shorter one', () => {
    assert.strictEqual(mentionedOutsideImports('@scope/cli', 'run @other/cli'), false);
  });

  test('plain names still match as before', () => {
    assert.strictEqual(mentionedOutsideImports('eslint', 'eslint --fix'), true);
    assert.strictEqual(mentionedOutsideImports('eslint', 'eslintrc-ish'), false);
  });
});

describe('unused-deps: optional and peer sections', () => {
  // The audit reads the same manifest sections the gates do. Optional deps are
  // real weight this project carries, so they are audited; a peer-only entry is
  // a contract with whoever installs this package, and the normal case is that
  // no local file imports it, so calling it unused would be a false positive.
  test('an optional dependency is audited, a peer-only one is left alone', () => {
    const dir = tmp('razor-unused-opt-');
    write(dir, 'package.json', {
      name: 'ws',
      version: '1.0.0',
      dependencies: { express: '^4.19.2' },
      optionalDependencies: { sharp: '^0.33.4', 'sqlite-vec': '^0.1.0' },
      peerDependencies: { react: '^18.3.1' },
    });
    write(dir, 'src/app.js', "const express = require('express');\nconst sharp = require('sharp');\n");
    const result = auditProject(dir);
    const eco = node(result);
    assert.strictEqual(eco.declaredCount, 3);
    assert.strictEqual(result.usedCount, 2);
    assert.deepStrictEqual(names(eco.likely), ['sqlite-vec']);
    const every = names(eco.likely).concat(names(eco.confirmed), names(eco.unknown));
    assert.ok(!every.includes('react'), 'a peer-only dependency is never bucketed');
  });

  test('a package declared as both a peer and a dependency is still audited', () => {
    const dir = tmp('razor-unused-peerdep-');
    write(dir, 'package.json', {
      name: 'ws',
      version: '1.0.0',
      dependencies: { react: '^18.3.1' },
      peerDependencies: { react: '^18.3.1' },
    });
    write(dir, 'src/app.js', 'module.exports = 1;\n');
    const eco = node(auditProject(dir));
    assert.deepStrictEqual(names(eco.likely), ['react']);
  });
});
