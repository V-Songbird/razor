'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { safeWriteFileSync } = require('../hooks/lib/safe-write');
const { gcStateFiles } = require('../hooks/razor-lib');

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

describe('safeWriteFileSync: an ancestor is a link too', () => {
  // Only the final directory used to be tested for being a link, so a
  // symlinked ANCESTOR redirected the write with nothing looking at it.
  test('refuses a dir whose ancestor resolves outside tmpdir/home (win32 branch)', () => {
    const dir = tmpDir();
    const target = path.join(dir, 'a.json');
    const outside = path.join('C:' + path.sep, 'nonexistent-outside-root', 'evil');
    const origRealpath = fs.realpathSync;
    const origStat = fs.statSync;
    const origGetuid = process.getuid;
    delete process.getuid;
    // The dir itself is NOT a link here -- an ancestor of it is, which is what
    // realpath resolves and lstat on the last segment never saw.
    fs.realpathSync = (p, ...rest) => (p === dir ? outside : origRealpath(p, ...rest));
    fs.statSync = (p, ...rest) => (p === outside ? { isDirectory: () => true } : origStat(p, ...rest));
    try {
      assert.throws(() => safeWriteFileSync(target, 'x'), /outside trusted roots/);
    } finally {
      fs.realpathSync = origRealpath;
      fs.statSync = origStat;
      if (origGetuid) process.getuid = origGetuid;
    }
  });
});

describe('safeWriteFileSync: the harness state dir is a trusted root', () => {
  // razor writes state wherever CLAUDE_PLUGIN_DATA points (harness.stateDir).
  // While only tmpdir and homedir were trusted, a state dir outside both --
  // a junction, another drive -- made every write throw. The callers swallow
  // that, so the whole plugin went quiet with nothing to see.
  function withWin32Roots(pluginData, run) {
    const os = require('os');
    const origTmp = os.tmpdir;
    const origHome = os.homedir;
    const origGetuid = process.getuid;
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    // Force the no-uid (win32) branch, and move the two default roots away so
    // only CLAUDE_PLUGIN_DATA can vouch for the target.
    delete process.getuid;
    os.tmpdir = () => 'Q:' + path.sep + 'no-tmp';
    os.homedir = () => 'Q:' + path.sep + 'no-home';
    if (pluginData === null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = pluginData;
    try {
      return run();
    } finally {
      os.tmpdir = origTmp;
      os.homedir = origHome;
      if (origGetuid) process.getuid = origGetuid;
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
    }
  }

  // The dir resolves somewhere else, which is the only branch that consults
  // the roots at all. Both paths are real, so the write itself is real too.
  function linkTo(dir, linked) {
    const orig = fs.realpathSync;
    fs.realpathSync = (p, ...rest) => (p === dir ? linked : orig(p, ...rest));
    return () => {
      fs.realpathSync = orig;
    };
  }

  test('refuses a resolved dir that no root vouches for', () => {
    const dir = tmpDir();
    const linked = tmpDir();
    const restore = linkTo(dir, linked);
    try {
      withWin32Roots(null, () => {
        assert.throws(() => safeWriteFileSync(path.join(dir, 'a.json'), 'x'), /outside trusted roots/);
      });
    } finally {
      restore();
    }
  });

  test('accepts it once CLAUDE_PLUGIN_DATA covers it, trailing separator and all', () => {
    const dir = tmpDir();
    const linked = tmpDir();
    const restore = linkTo(dir, linked);
    try {
      withWin32Roots(path.dirname(linked).toUpperCase() + path.sep, () => {
        safeWriteFileSync(path.join(dir, 'a.json'), '{"off":true}');
      });
      assert.strictEqual(fs.readFileSync(path.join(linked, 'a.json'), 'utf-8'), '{"off":true}');
      assert.deepStrictEqual(tmpLeftovers(linked), []);
    } finally {
      restore();
    }
  });
});

describe('gcStateFiles: abandoned scratch files', () => {
  // safe-write's own `.razor-<id>.json.<pid>.<hex>.tmp`, left by a process
  // killed mid-write, lives in the state directory and matched nothing the
  // sweep looked for.
  test('sweeps a stale temp file and leaves a fresh one', () => {
    const dir = tmpDir();
    const prev = process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_PLUGIN_DATA = dir;
    const stale = path.join(dir, '.razor-abc.json.1234.deadbeef.tmp');
    const fresh = path.join(dir, '.razor-def.json.1234.feedface.tmp');
    const keep = path.join(dir, 'razor-abc.json');
    for (const f of [stale, fresh, keep]) fs.writeFileSync(f, '{}');
    const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
    fs.utimesSync(stale, old / 1000, old / 1000);
    try {
      gcStateFiles();
      assert.strictEqual(fs.existsSync(stale), false, 'a month-old scratch file is abandoned');
      assert.strictEqual(fs.existsSync(fresh), true, 'a fresh one may be a live write');
      assert.strictEqual(fs.existsSync(keep), true);
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
      else process.env.CLAUDE_PLUGIN_DATA = prev;
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
