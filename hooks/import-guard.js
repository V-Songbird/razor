'use strict';

// Gate (Write|Edit, via pre-tool-use.js) — soft gate on new dependencies
// entering as code.
//
// Agents rarely run `npm install axios`; they write
// `const axios = require('axios')` and move on — the install is a later or
// human step, so a Bash-side gate never sees the moment the dependency is
// actually chosen. This gate watches that moment: a Write/Edit whose payload
// imports a package that is neither a builtin, a local file, nor declared in
// the project manifest is denied once with the reuse-first reason (rungs
// 3-5); re-issuing the same tool call passes. Deny-once per package, never a
// hard block, silent on the pass path.
//
// Bounded on purpose:
//   - fires ONLY when an ecosystem manifest exists up-tree (greenfield code
//     with no declared-deps baseline stays ungated),
//   - counts only imports the payload ADDS (anything the file already
//     imports on disk is grandfathered),
//   - JS/TS and Python only; other ecosystems are covered by the Bash-side
//     dep-guard when an install is attempted,
//   - test files are exempt (a test-framework import in a test is
//     convention, not a shipped dependency).
//
// Known limit: name extraction is regex, not AST (a parser to police
// dependency additions would be rung-5 irony), so exotic import forms may
// slip through — the ladder still covers those in prompt-space.

const fs = require('fs');
const path = require('path');
const { settingOff } = require('./razor-lib');
const { installedDeps, evidenceReason, ledgerName } = require('./dep-guard');

// Node core modules — importing one is never a new dependency.
const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console',
  'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns', 'domain',
  'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net',
  'os', 'path', 'perf_hooks', 'process', 'punycode', 'querystring',
  'readline', 'repl', 'stream', 'string_decoder', 'test', 'timers', 'tls',
  'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi',
  'worker_threads', 'zlib',
]);

// Python stdlib top-level names (3.9+ common surface; additions are cheap).
const PY_STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit',
  'base64', 'bdb', 'binascii', 'bisect', 'builtins', 'bz2', 'calendar',
  'cmath', 'cmd', 'code', 'codecs', 'collections', 'colorsys',
  'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy',
  'copyreg', 'cProfile', 'csv', 'ctypes', 'curses', 'dataclasses',
  'datetime', 'dbm', 'decimal', 'difflib', 'dis', 'doctest', 'email',
  'encodings', 'ensurepip', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp',
  'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc',
  'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'grp', 'gzip',
  'hashlib', 'heapq', 'hmac', 'html', 'http', 'idlelib', 'imaplib', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache',
  'locale', 'logging', 'lzma', 'mailbox', 'marshal', 'math', 'mimetypes',
  'mmap', 'msvcrt', 'multiprocessing', 'netrc', 'ntpath', 'numbers',
  'operator', 'os',
  'pathlib', 'pdb', 'pickle', 'pickletools', 'pkgutil', 'platform',
  'plistlib', 'poplib', 'posixpath', 'pprint', 'profile', 'pstats', 'pty',
  'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random',
  're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched',
  'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal',
  'site', 'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable',
  'sys', 'sysconfig', 'syslog', 'tarfile', 'tempfile', 'termios', 'test',
  'textwrap', 'threading', 'time', 'timeit', 'token', 'tokenize', 'tomllib',
  'tkinter', 'trace', 'traceback', 'tracemalloc', 'tty', 'turtle',
  'turtledemo', 'types', 'typing',
  'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings', 'wave',
  'weakref', 'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xml',
  'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

const JS_EXT = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/i;
const PY_EXT = /\.py$/i;

function ecosystemOf(filePath) {
  if (JS_EXT.test(filePath)) return 'node';
  if (PY_EXT.test(filePath)) return 'python';
  return null;
}

// Same convention as the benchmark scorers and common runners: test files
// never gate.
// One pattern over the whole JS/TS extension family, so a `.test.tsx` or a
// `.spec.mjs` is exempt for the same reason a `.test.js` is.
const TEST_SUFFIX = /[._](test|spec)\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;

function isTestFile(filePath) {
  const parts = String(filePath).split(/[\\/]/);
  const name = (parts[parts.length - 1] || '').toLowerCase();
  return (
    name.startsWith('test_') || name.endsWith('_test.py') || TEST_SUFFIX.test(name)
    || parts.some((p) => /^(test|tests|__tests__)$/i.test(p))
  );
}

// The package a specifier belongs to, or null when it can never be one
// (relative, absolute, subpath-imports, or a runtime builtin).
function specRoot(spec) {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return null;
  // `@/x` and `~/x` are the path-alias forms nearly every modern TS/JS setup
  // configures for its OWN source (tsconfig paths, Vite, Next, Remix, Nuxt).
  // Neither can name a package: an npm scope needs a name after the `@`, and
  // `~` is not a legal package name. Read as roots they became `@/components`
  // and `~`, and every internal import in such a project was denied as an
  // undeclared dependency. A missed nudge costs nothing; a false deny costs a
  // turn, and this one fired on ordinary local code.
  if (spec === '~' || spec.startsWith('~/') || spec.startsWith('@/')) return null;
  // A node:/bun: prefix can only resolve a runtime builtin, never a package.
  if (/^(node|bun):/.test(spec)) return null;
  const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
  if (!root || NODE_BUILTINS.has(root) || NODE_BUILTINS.has(spec)) return null;
  return root;
}

// Roots imported for their TYPES only. The gate deliberately ignores these —
// a type-only import ships nothing — but the unused audit must not: tsc
// consumes them, so the dependency is genuinely used.
function jsTypeImportRoots(text) {
  const roots = new Set();
  const src = String(text || '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const pat = /\b(?:import|export)\s+type\b[^'"\n]*?from\s+['"]([^'"\n]+)['"]/g;
  let m;
  while ((m = pat.exec(src)) !== null) {
    const root = specRoot(m[1]);
    if (root) roots.add(root);
  }
  return roots;
}

// Top-level module roots imported by a chunk of JS/TS source.
function jsImportRoots(text) {
  const roots = new Set();
  const src = String(text || '');
  // Specifiers never span a line — the \n bound keeps a mangled statement
  // from swallowing the source lines after it into a "package name".
  const pats = [
    /require\s*\(\s*['"]([^'"\n]+)['"]/g,               // require('x')
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]/g,              // import('x')
    /\bimport\s+[^'";]*?from\s+['"]([^'"\n]+)['"]/g,    // import a from 'x'
    /\bexport\s+[^'";]*?from\s+['"]([^'"\n]+)['"]/g,    // export {a} from 'x'
    /\bimport\s+['"]([^'"\n]+)['"]/g,                   // import 'x'
  ];
  // Comments never import, and type-only imports/re-exports never ship:
  // strip both before matching. Block comments count only from a line
  // start and line comments only after whitespace, so a `/*` in a glob
  // string or the `//` in a URL specifier never starts a strip.
  const stripped = src
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
    .replace(/\b(import|export)\s+type\b[^;\n]*;?/g, '');
  for (const pat of pats) {
    let m;
    while ((m = pat.exec(stripped)) !== null) {
      const root = specRoot(m[1]);
      if (root) roots.add(root);
    }
  }
  return roots;
}

// Top-level module roots imported by a chunk of Python source.
function pyImportRoots(text) {
  const roots = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const im = line.match(/^\s*import\s+(.+)/);
    if (im) {
      for (const part of im[1].split(',')) {
        const root = part.trim().split(/\s+as\s+/)[0].split('.')[0].trim();
        if (root && /^[A-Za-z_][A-Za-z0-9_]*$/.test(root) && !PY_STDLIB.has(root)) roots.add(root);
      }
      continue;
    }
    const fm = line.match(/^\s*from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/);
    if (fm) {
      const root = fm[1].split('.')[0];
      if (!PY_STDLIB.has(root)) roots.add(root);
    }
  }
  return roots;
}

// A declared dependency name can differ from its import name (python-dotenv
// -> dotenv, pyyaml -> yaml). Normalize in the SUPPRESSING direction only —
// over-matching here means one missed nudge, never a false deny.
// razor: a static alias list for the common odd pairs; full metadata-derived
// mapping if these ever prove insufficient.
const KNOWN_IMPORT_NAMES = {
  pillow: 'pil',
  beautifulsoup4: 'bs4',
  'opencv-python': 'cv2',
  'scikit-learn': 'sklearn',
  pymupdf: 'fitz',
  grpcio: 'grpc',
  protobuf: 'google',
  dnspython: 'dns',
  attrs: 'attr',
};

function declaredNameForms(name) {
  const n = String(name).toLowerCase();
  // A wheel-flavour suffix is packaging, not a name: psycopg2-binary and
  // psycopg2 import identically, and only the flavour reaches the manifest.
  const forms = new Set([
    n, n.replace(/-/g, '_'), n.replace(/^python-/, ''), n.replace(/^py/, ''), n.replace(/-binary$/, ''),
  ]);
  if (KNOWN_IMPORT_NAMES[n]) forms.add(KNOWN_IMPORT_NAMES[n]);
  return forms;
}

function isDeclared(root, deps) {
  const r = root.toLowerCase();
  const rUnderscore = r.replace(/-/g, '_');
  for (const d of deps || []) {
    const forms = declaredNameForms(d);
    if (forms.has(r) || forms.has(rUnderscore)) return true;
  }
  return false;
}

// Nearest manifest up-tree for this ecosystem; null when none (greenfield —
// the gate stays silent without a declared-deps baseline to check against).
const MANIFESTS = { node: ['package.json'], python: ['pyproject.toml', 'requirements.txt'] };

function findManifest(eco, startDir) {
  if (!startDir) return null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    for (const name of MANIFESTS[eco]) {
      try {
        if (fs.existsSync(path.join(dir, name))) return { dir, name };
      } catch { /* unreadable dir — keep walking */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// A python absolute import of the project's own package carries no ./
// marker, so only the disk can tell it from an external dependency: a
// module or package by that name beside the file, at the manifest root,
// or under its src/ layout is local, never a new dependency.
function isLocalPyModule(root, dirs) {
  for (const base of dirs) {
    try {
      if (fs.existsSync(path.join(base, root)) || fs.existsSync(path.join(base, `${root}.py`))) return true;
    } catch { /* unreadable — keep checking */ }
  }
  return false;
}

// New external roots this payload introduces: imports in the incoming text
// that are neither declared in the manifest nor already imported by the
// file's current on-disk content.
function newImports(eco, incomingText, existingText, deps) {
  const extract = eco === 'node' ? jsImportRoots : pyImportRoots;
  const incoming = extract(incomingText);
  if (!incoming.size) return [];
  const existing = extract(existingText);
  return [...incoming].filter((r) => !existing.has(r) && !isDeclared(r, deps)).sort();
}

function denyReason(tool, roots, eco, manifestName, deps) {
  const what = roots.map((r) => `\`${r}\``).join(', ');
  return evidenceReason(
    `razor: importing ${what} in this ${tool} adds a new ${eco} dependency — not in ${manifestName}. `,
    deps,
    tool
  );
}

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (settingOff('IMPORT_GUARD')) return null;
  if (data.tool_name !== 'Write' && data.tool_name !== 'Edit') return null;

  const input = data.tool_input || {};
  const filePath = input.file_path;
  if (!filePath || /node_modules/.test(filePath) || isTestFile(filePath)) return null;
  const eco = ecosystemOf(filePath);
  if (!eco) return null;

  const incoming = data.tool_name === 'Write' ? input.content : input.new_string;
  if (!incoming) return null;

  const fileDir = path.dirname(path.resolve(filePath));
  const manifest = findManifest(eco, fileDir);
  if (!manifest) return null; // greenfield: no declared-deps baseline, stay silent

  // Full current on-disk content (the gate runs before the write lands), so
  // anything the file already imports — via any earlier edit — never re-fires.
  let existing = '';
  try { existing = fs.readFileSync(path.resolve(filePath), 'utf-8'); } catch { /* new file */ }

  const deps = installedDeps(eco === 'node' ? 'npm' : 'pip', fileDir);
  let fresh = newImports(eco, incoming, existing, deps);
  if (eco === 'python') {
    const local = [fileDir, manifest.dir, path.join(manifest.dir, 'src')];
    fresh = fresh.filter((r) => !isLocalPyModule(r, local));
  }
  if (!fresh.length) return null;

  state.deniedImports = state.deniedImports || {};
  const unseen = fresh.filter((r) => !state.deniedImports[`${eco}:${ledgerName(r)}`]);
  if (!unseen.length) return null; // all already reconsidered — pass silently

  for (const r of unseen) state.deniedImports[`${eco}:${ledgerName(r)}`] = true;
  return denyReason(data.tool_name, unseen, eco, manifest.name, deps);
}

module.exports = { check, jsImportRoots, jsTypeImportRoots, pyImportRoots, newImports, isDeclared, isLocalPyModule, isTestFile, ecosystemOf, findManifest };
