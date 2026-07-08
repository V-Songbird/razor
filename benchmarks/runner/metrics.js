'use strict';
// Self-contained instruments: LOC counting, git diffing, new-dependency
// detection, transcript extraction. All generic (line counting, git plumbing,
// import scanning) — no plugin logic — so this harness imports nothing outside
// its own folder.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The harness is Node-native and every task delivers JavaScript; the LOC
// instruments only ever see the .js an agent writes (plus the odd web asset).
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.html', '.css']);

// Node core modules — importing one of these is never a "new dependency".
const NODE_BUILTINS = new Set([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto',
  'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2', 'https', 'module',
  'net', 'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url',
  'util', 'v8', 'vm', 'worker_threads', 'zlib', 'async_hooks', 'diagnostics_channel',
  'fs/promises', 'stream/promises', 'timers/promises', 'util/types', 'test',
]);

// --- LOC counting ---------------------------------------------------------------

function isTest(relPath) {
  const parts = relPath.split(/[\\/]/);
  const name = parts[parts.length - 1].toLowerCase();
  return (name.startsWith('test_') || name.endsWith('.test.js') || name.endsWith('.spec.js')
    || name.endsWith('_test.js')
    || parts.slice(0, -1).some((p) => p.toLowerCase() === 'test' || p.toLowerCase() === 'tests'));
}

const COMMENT_RE = /^(\/\/|\*|\/\*|\*\/|#)/;

function countLines(text, withComments) {
  let n = 0;
  for (const ln of text.split(/\r?\n/)) {
    const s = ln.trim();
    if (!s) continue;
    if (!withComments && COMMENT_RE.test(s)) continue;
    n++;
  }
  return n;
}

// Split a produced .js file at the first TOP-LEVEL self-check marker (a
// `require.main === module` guard or a demo()/selfcheck() function) through end
// of file. On a surgical task that delivers ONE function, an in-file self-check
// is a runnable check, not source bloat, so it's split off here and counted as
// test LOC instead of penalising the arm that wrote it.
const SELFCHECK_RE = /^(if\s*\(\s*require\.main\s*===\s*module\s*\)|(async\s+)?function\s+(_?demo|_?selfcheck|_?check|_?smoke|smoke)\b|const\s+(_?demo|_?selfcheck)\b)/;

function selfcheckSplit(text) {
  const lines = text.split(/\r?\n/);
  const cnt = (seq) => {
    let t = 0, c = 0;
    for (const ln of seq) {
      const s = ln.trim();
      if (!s) continue;
      t++;
      if (!COMMENT_RE.test(s)) c++;
    }
    return [t, c];
  };
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln[0] !== ' ' && ln[0] !== '\t' && SELFCHECK_RE.test(ln)) { start = i; break; }
  }
  if (start === null) {
    const [t, c] = cnt(lines);
    return { total: t, code: c, scTotal: 0, scCode: 0 };
  }
  const [t, c] = cnt(lines.slice(0, start));
  const [st, sc] = cnt(lines.slice(start));
  return { total: t, code: c, scTotal: st, scCode: sc };
}

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

function readFixtureSet(workdir) {
  const fm = path.join(workdir, '_fixture_files.json');
  if (!fs.existsSync(fm)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(fm, 'utf8'))); } catch { return new Set(); }
}

// LOC over code-extension source files only. total_loc counts every non-blank
// line including comments (the bloat a vibe baseline actually produces); src_loc
// is code-only. Tests tracked separately, never as bloat. selfcheckAsTest
// (surgical tasks): an in-file self-check is reclassified from source to test.
function codeStats(workdir, selfcheckAsTest = false) {
  const fixture = readFixtureSet(workdir);
  const rels = walk(workdir).filter((rel) => {
    const name = rel.split('/').pop();
    return CODE_EXT.has(path.extname(name)) && !name.startsWith('.') && !name.startsWith('_')
      && !fixture.has(rel);
  });
  const read = (rel) => {
    try { return fs.readFileSync(path.join(workdir, rel), 'utf8'); } catch { return ''; }
  };
  const src = rels.filter((r) => !isTest(r));
  const tst = rels.filter((r) => isTest(r));
  let testLoc = tst.reduce((n, r) => n + countLines(read(r), true), 0);
  if (selfcheckAsTest) {
    let total = 0, code = 0, scTest = 0;
    for (const r of src) {
      const { total: t, code: c, scTotal: st } = selfcheckSplit(read(r));
      total += t; code += c; scTest += st;
    }
    return { files: rels.length, src_files: src.length, total_loc: total, src_loc: code,
      test_files: tst.length, test_loc: testLoc + scTest };
  }
  return {
    files: rels.length, src_files: src.length,
    total_loc: src.reduce((n, r) => n + countLines(read(r), true), 0),
    src_loc: src.reduce((n, r) => n + countLines(read(r), false), 0),
    test_files: tst.length, test_loc: testLoc,
  };
}

// --- git plumbing ---------------------------------------------------------------

function git(workdir, ...args) {
  return spawnSync('git', args, { cwd: workdir, encoding: 'utf8' });
}

// Commit the seeded repo so we can diff exactly what the agent changes.
function gitSnapshot(workdir) {
  git(workdir, 'init', '-q');
  git(workdir, 'add', '-A');
  git(workdir, '-c', 'user.email=bench@local', '-c', 'user.name=bench',
    'commit', '-q', '-m', 'base', '--no-verify');
}

const SKIP_DIFF = ['-lock', '.lock', '.gen.ts', 'lock.json', 'routeTree.gen'];

// Added lines (incl comments) of code files the agent created OR modified vs the
// seeded base — the delivered-code metric, matching the '+N' a PR/diff shows.
// Tests counted separately; lockfiles/generated files skipped.
function gitDiffStats(workdir) {
  git(workdir, 'add', '-A');
  const out = git(workdir, 'diff', '--cached', '--numstat', 'HEAD').stdout || '';
  let loc = 0, files = 0, testLoc = 0, testFiles = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length !== 3) continue;
    const [added, , p] = parts;
    if (added === '-') continue;
    if (!CODE_EXT.has(path.extname(p))) continue;
    if (SKIP_DIFF.some((k) => p.includes(k)) || p.includes('node_modules')) continue;
    const n = parseInt(added, 10) || 0;
    if (isTest(p)) { testLoc += n; testFiles++; } else { loc += n; files++; }
  }
  return { files, src_files: files, total_loc: loc, src_loc: loc,
    test_files: testFiles, test_loc: testLoc };
}

function gitNewFiles(workdir) {
  git(workdir, 'add', '-A');
  const out = git(workdir, 'diff', '--cached', '--name-status', 'HEAD').stdout || '';
  let n = 0;
  for (const line of out.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 2 || parts[0] !== 'A') continue;
    const p = parts[parts.length - 1];
    const name = p.split('/').pop();
    if (CODE_EXT.has(path.extname(name)) && !name.startsWith('_') && !name.startsWith('.')) n++;
  }
  return n;
}

// --- new-dependency detection (the D-tier ground truth) -------------------------

// Top-level require()/import specifiers in produced .js files that are neither a
// Node builtin, a local file, nor a seeded dependency. Test files are exempt: a
// test-framework import in a test is convention, not a shipped dependency.
function jsNewDeps(workdir, allowed = new Set()) {
  const hits = new Set();
  const pat = /(?:require\(\s*|from\s+|import\s+)['"]([^'"]+)['"]/g;
  for (const rel of walk(workdir)) {
    if (!rel.endsWith('.js') && !rel.endsWith('.mjs') && !rel.endsWith('.cjs')) continue;
    const name = rel.split('/').pop();
    if (rel.split('/').includes('_shims') || name.startsWith('_') || isTest(rel)) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(workdir, rel), 'utf8'); } catch { continue; }
    let m;
    pat.lastIndex = 0;
    while ((m = pat.exec(text)) !== null) {
      const spec = m[1];
      if (spec.startsWith('.') || spec.startsWith('/')) continue;
      const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
      const root = bare.startsWith('@') ? bare.split('/').slice(0, 2).join('/') : bare.split('/')[0];
      if (NODE_BUILTINS.has(root) || NODE_BUILTINS.has(bare) || allowed.has(root)) continue;
      hits.add(root);
    }
  }
  return [...hits].sort();
}

const ADD_PAT = /^(?:npm|pnpm)\s+(?:install|i|add)\s+(?!-)|^yarn\s+add\s+|^pip3?\s+install\s+(?!-r)(?!-)|^poetry\s+add\s+|^uv\s+(?:add|pip\s+install)\s+/;

// Package-add commands that reached the shims (razor's deny happens BEFORE the
// shim, so a razor-arm agent that backs off after the deny leaves this log empty).
function pkgAddAttempts(workdir) {
  const log = path.join(workdir, '_pkgmgr.log');
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => ADD_PAT.test(l));
}

// LOC of fenced code blocks in a chat answer: [total incl comments, code-only].
function chatCodeLoc(text) {
  let total = 0, code = 0;
  const re = /```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text || '')) !== null) {
    for (const ln of m[1].split(/\r?\n/)) {
      const s = ln.trim();
      if (!s) continue;
      total++;
      if (!COMMENT_RE.test(s)) code++;
    }
  }
  return [total, code];
}

// --- transcript extraction ------------------------------------------------------

// stream-json -> final result event written as _claude.json, plus the raw stream
// text for marker counting.
function extractResult(workdir) {
  const stream = path.join(workdir, '_claude.stream.jsonl');
  const raw = fs.existsSync(stream) ? fs.readFileSync(stream, 'utf8') : '';
  let result = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try { ev = JSON.parse(t); } catch { continue; }
    if (ev.type === 'result') result = ev;
  }
  if (result !== null) {
    fs.writeFileSync(path.join(workdir, '_claude.json'), JSON.stringify(result, null, 2));
  }
  return raw;
}

module.exports = {
  CODE_EXT, NODE_BUILTINS,
  isTest, countLines, selfcheckSplit, codeStats,
  git, gitSnapshot, gitDiffStats, gitNewFiles,
  jsNewDeps, pkgAddAttempts, chatCodeLoc, extractResult,
};
