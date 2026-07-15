'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeWriteFileSync } = require('../hooks/razor-lib');

const dirs = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-safewrite-'));
  dirs.push(d);
  return d;
}

// No leftover `.<name>.<pid>.<hex>.tmp` siblings after a write.
function tmpLeftovers(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

describe('safeWriteFileSync: normal writes', () => {
  test('round-trips content to a new file', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    safeWriteFileSync(target, '{"off":true}');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"off":true}');
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });

  test('overwrites an existing file, leaving no stray temp file', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    safeWriteFileSync(target, '{"n":1}');
    safeWriteFileSync(target, '{"n":2}');
    assert.strictEqual(fs.readFileSync(target, 'utf-8'), '{"n":2}');
    assert.deepStrictEqual(fs.readdirSync(dir), ['a.json']);
  });
});

describe('safeWriteFileSync: symlink refusal', () => {
  // Creating real symlinks needs elevated privilege on this Windows box, so
  // the symlink itself is stubbed via fs.lstatSync — safe-write only ever
  // branches on isSymbolicLink(), so this exercises the real refusal path.
  test('refuses a target that lstat reports as a symlink', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'link.json');
    const origLstat = fs.lstatSync;
    fs.lstatSync = (p, ...rest) =>
      p === target ? { isSymbolicLink: () => true, isDirectory: () => false } : origLstat(p, ...rest);
    try {
      assert.throws(() => safeWriteFileSync(target, 'malicious'), /symlink/);
    } finally {
      fs.lstatSync = origLstat;
    }
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });

  test('refuses a symlinked parent dir that resolves outside tmpdir/home (win32 branch)', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    const outside = path.join('C:\\', 'nonexistent-outside-root', 'evil');
    const origLstat = fs.lstatSync;
    const origRealpath = fs.realpathSync;
    const origStat = fs.statSync;
    const origGetuid = process.getuid;
    // Force the no-uid (win32) path regardless of the host platform.
    delete process.getuid;
    fs.lstatSync = (p, ...rest) => (p === dir ? { isSymbolicLink: () => true } : origLstat(p, ...rest));
    fs.realpathSync = (p, ...rest) => (p === dir ? outside : origRealpath(p, ...rest));
    fs.statSync = (p, ...rest) => (p === outside ? { isDirectory: () => true } : origStat(p, ...rest));
    try {
      assert.throws(() => safeWriteFileSync(target, 'x'), /outside trusted roots/);
    } finally {
      fs.lstatSync = origLstat;
      fs.realpathSync = origRealpath;
      fs.statSync = origStat;
      if (origGetuid) process.getuid = origGetuid;
    }
  });
});

describe('safeWriteFileSync: failure cleanup', () => {
  test('cleans up the temp file when rename fails (target is a directory)', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'targetdir');
    fs.mkdirSync(target);
    assert.throws(() => safeWriteFileSync(target, 'x'));
    assert.deepStrictEqual(tmpLeftovers(dir), []);
  });
});
