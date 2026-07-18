'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { auditProject, knipAvailable, formatReport } = require('../scripts/unused-deps');

function makeNodeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-unused-node-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'ws',
    version: '1.0.0',
    dependencies: { express: '^4.19.2', lodash: '^4.17.21', chalk: '^5.3.0' },
    devDependencies: { eslint: '^9.0.0' },
    scripts: { lint: 'eslint .' },
  }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.js'), "const express = require('express');\nmodule.exports = express;\n");
  fs.mkdirSync(path.join(dir, 'tests'));
  // A dep imported only from a test file must still count as used.
  fs.writeFileSync(path.join(dir, 'tests', 'app.test.js'), "const chalk = require('chalk');\n");
  fs.writeFileSync(path.join(dir, '.eslintrc.json'), JSON.stringify({ extends: [] }));
  return dir;
}

function makePythonWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-unused-py-'));
  fs.writeFileSync(
    path.join(dir, 'requirements.txt'),
    'requests==2.31.0\npython-dotenv==1.0.0\nflask==3.0.0\nblack==24.0.0\n',
  );
  fs.writeFileSync(path.join(dir, 'main.py'), 'import requests\nimport dotenv\n');
  fs.writeFileSync(path.join(dir, 'tox.ini'), '[testenv]\ndeps = black\n');
  return dir;
}

describe('unused-deps: node ecosystem bucketing', () => {
  test('used (src + test-file), unused, and scripts-referenced possibly-used', () => {
    const result = auditProject(makeNodeWorkspace());
    const node = result.ecosystems.find((e) => e.eco === 'node');
    assert.ok(node);
    assert.deepStrictEqual(node.unused.map((u) => u.dep), ['lodash']);
    assert.deepStrictEqual(node.possiblyUsed.map((u) => u.dep), ['eslint']);
    assert.strictEqual(result.usedCount, 2); // express (src) + chalk (test-only)
  });
});

describe('unused-deps: python ecosystem bucketing', () => {
  test('unused and config-referenced possibly-used', () => {
    const result = auditProject(makePythonWorkspace());
    const python = result.ecosystems.find((e) => e.eco === 'python');
    assert.ok(python);
    assert.deepStrictEqual(python.unused.map((u) => u.dep), ['flask']);
    assert.deepStrictEqual(python.possiblyUsed.map((u) => u.dep), ['black']);
  });

  test('suppressing-direction normalization: python-dotenv counts as used when imported as dotenv', () => {
    const result = auditProject(makePythonWorkspace());
    const python = result.ecosystems.find((e) => e.eco === 'python');
    const flagged = [...python.unused, ...python.possiblyUsed].map((u) => u.dep);
    assert.ok(!flagged.includes('python-dotenv'));
  });
});

function makeTsWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-unused-ts-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'ts-ws',
    version: '1.0.0',
    dependencies: { express: '^4.19.2', lodash: '^4.17.21', '@types/lodash': '^4.17.0' },
    devDependencies: { typescript: '^5.5.0', '@types/node': '^20.0.0', '@types/better-sqlite3': '^7.6.0' },
  }));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), "import express from 'express';\nexport default express;\n");
  return dir;
}

describe('unused-deps: TypeScript toolchain classification', () => {
  test('devDependency + @types/* + known toolchain route to possibly-used with reason; runtime dep stays Unused', () => {
    const result = auditProject(makeTsWorkspace());
    const node = result.ecosystems.find((e) => e.eco === 'node');
    assert.ok(node);
    assert.deepStrictEqual(node.unused.map((u) => u.dep), ['lodash']);
    assert.strictEqual(node.unused[0].reason, undefined);

    const byDep = Object.fromEntries(node.possiblyUsed.map((u) => [u.dep, u.reason]));
    assert.strictEqual(byDep['typescript'], 'toolchain - consumed by tsc/build, not imported');
    assert.strictEqual(byDep['@types/node'], 'type definitions - consumed by tsc');
    assert.strictEqual(byDep['@types/better-sqlite3'], 'type definitions - consumed by tsc');
  });

  test('@types/* declared under regular dependencies still routes to possibly-used (rule independent of devDependency check)', () => {
    const result = auditProject(makeTsWorkspace());
    const node = result.ecosystems.find((e) => e.eco === 'node');
    const typesLodash = node.possiblyUsed.find((u) => u.dep === '@types/lodash');
    assert.ok(typesLodash, '@types/lodash (a regular dependency) should be in possiblyUsed');
    assert.strictEqual(typesLodash.reason, 'type definitions - consumed by tsc');
  });
});

describe('unused-deps: CLI', () => {
  test('prints per-bucket lines, verdict, and known-limits footer', () => {
    const r = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'unused-deps.js'), makeNodeWorkspace()], {
      encoding: 'utf-8',
    });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /Unused \(1\) — high confidence/);
    assert.match(r.stdout, /lodash: no import found in \d+ source files scanned/);
    assert.match(r.stdout, /Needs a resolver-grade check \(1\)/);
    assert.match(r.stdout, /Verdict: 2 used, 1 unused, 1 need a resolver-grade check\./);
    assert.match(r.stdout, /Known limits:/);
    assert.match(r.stdout, /peerDependencies/);
  });

  test('no supported manifest reports cleanly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-unused-empty-'));
    const r = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'unused-deps.js'), dir], { encoding: 'utf-8' });
    assert.strictEqual(r.status, 0);
    assert.match(r.stdout, /No supported manifest found/);
  });
});

function installFakeKnip(dir) {
  const knipDir = path.join(dir, 'node_modules', 'knip');
  fs.mkdirSync(knipDir, { recursive: true });
  fs.writeFileSync(path.join(knipDir, 'package.json'), JSON.stringify({ name: 'knip', version: '5.0.0' }));
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
    // A knip install anywhere is irrelevant to a python-only project — no
    // node_modules exists here at all, so detection must stay false and
    // silent rather than erroring.
    const report = formatReport(dir, auditProject(dir));
    assert.doesNotMatch(report, /knip/i);
  });
});
