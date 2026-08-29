'use strict';

// Gate (Bash|PowerShell, via pre-tool-use.js) — soft gate on new-dependency
// installs.
//
// The first attempt to install a named package is denied with the
// reuse-first reason (rungs 3–5); re-running the same install passes. One
// forced reconsideration per dependency, never a hard block, and razor
// never *grants* permission — on the pass path it stays silent so the
// user's normal permission flow still applies.
//
// Only project-dependency managers are guarded. Lockfile restores
// (`npm install` bare, `npm ci`, `pip install -r ...`, `poetry install`)
// and system package managers (apt, brew, winget) are out of scope.

const fs = require('fs');
const path = require('path');
const { settingOff } = require('./razor-lib');

// manager → subcommands that add a named package
const ADD_SUBCOMMANDS = {
  npm: ['install', 'i', 'add'],
  pnpm: ['install', 'i', 'add'],
  yarn: ['add'],
  bun: ['add', 'install', 'i'],
  pip: ['install'],
  pip3: ['install'],
  pipenv: ['install'],
  poetry: ['add'],
  uv: ['add'],
  cargo: ['add'],
  go: ['get'],
  composer: ['require'],
  gem: ['install'],
};

// pip args that mean "restore/develop", not "add a new dependency"
const PIP_RESTORE_FLAGS = new Set(['-r', '--requirement', '-e', '--editable']);

// Flags that take their value as the NEXT token. Left alone, that value is
// read as a package name and the deny reason invents a dependency nobody
// asked for. Only the separated form needs this — `--flag=value` is one
// token and already skipped as a flag.
const VALUE_FLAGS = new Set([
  '-t', '--target', '-i', '--index-url', '--extra-index-url', '-f', '--find-links',
  '-c', '--constraint', '--python', '--prefix', '--registry', '--tag',
  '-w', '--workspace', '--features', '--manifest-path',
  '--group', '--filter', '--branch', '--rev',
]);

// A local path or a URL is a location, not a name from a registry. Denying
// one names a package that does not exist, and the suppressing direction is
// the safe one: a missed nudge costs nothing, a false deny costs a turn.
function isLocationSpec(a) {
  return (
    /^\.{1,2}[\\/]/.test(a) || a === './...' || a.startsWith('/') || a.startsWith('~/')
    || /^[A-Za-z]:[\\/]/.test(a) || a.includes('://') || a.startsWith('file:')
  );
}

// Flags, `.`, locations, and shell redirects are not package names. A bare
// redirect operator (`>`, `2>`) also consumes the following token — its
// target. Quotes come off first: the shell strips them before the manager
// ever sees the token, and a version spec must be quoted in a real shell
// (`pip install 'flask>=2.1'`), so `'flask>=2.1'` and `flask>=2.1` are
// the same package.
function packageArgs(args) {
  const out = [];
  let skipNext = false;
  for (const raw of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const a = raw.replace(/^['"]+|['"]+$/g, '');
    if (!a || a === '.') continue;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) skipNext = true;
      continue;
    }
    const redirect = a.match(/^\d*(?:>>?|<<?|&>>?)(.*)$/);
    if (redirect) {
      if (!redirect[1]) skipNext = true;
      continue;
    }
    if (isLocationSpec(a)) continue;
    out.push(a);
  }
  return out;
}

// Parse one shell segment; returns {manager, packages} when it adds a new
// named dependency, null otherwise.
function parseSegment(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  // Wrapper prefixes (`sudo pip …`, `env PIP_X=1 pip …`, `command pip …`)
  // resolve to the same install; strip them so the manager is what's judged.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) || ['sudo', 'env', 'command'].includes(tokens[0]))) {
    tokens.shift();
  }
  if (!tokens.length) return null;

  let cmd = tokens.shift().toLowerCase().replace(/\.(exe|cmd)$/, '');

  // python -m pip install …  →  pip install …
  if ((cmd === 'python' || cmd === 'python3' || cmd === 'py') && tokens[0] === '-m' && /^pip3?$/.test(tokens[1] || '')) {
    cmd = tokens[1];
    tokens.splice(0, 2);
  }
  // uv pip install …  →  pip install …
  if (cmd === 'uv' && tokens[0] === 'pip') {
    cmd = 'pip';
    tokens.shift();
  }
  // yarn global add …  →  yarn add …
  if (cmd === 'yarn' && tokens[0] === 'global') tokens.shift();

  // dotnet add [proj] package Name
  if (cmd === 'dotnet' && tokens[0] === 'add') {
    const idx = tokens.indexOf('package');
    if (idx !== -1 && tokens[idx + 1]) return { manager: 'dotnet', packages: [tokens[idx + 1]] };
    return null;
  }

  const subs = ADD_SUBCOMMANDS[cmd];
  if (!subs) return null;
  const sub = (tokens.shift() || '').toLowerCase();
  if (!subs.includes(sub)) return null;

  if (/^pip3?$/.test(cmd) && tokens.some((t) => PIP_RESTORE_FLAGS.has(t))) return null;

  const packages = packageArgs(tokens);
  if (!packages.length) return null; // bare install = lockfile restore
  // `pip install --upgrade pip` upgrades the tool, it does not add a project
  // dependency. Same for any manager asked to install only itself.
  if (packages.length === 1 && packages[0].toLowerCase() === cmd) return null;
  return { manager: cmd, packages };
}

// razor: parses the command exactly as the model issued it. hush's
// preserve-exit-code.js rewrites Bash/PowerShell commands via updatedInput
// under bypassPermissions/HUSH_WRAP=1, but PreToolUse hooks from separate
// plugins don't chain — each one gets the same original tool_input, never a
// sibling's rewrite (verified live 2026-07-14). No unwrap step needed here.
// Scan a whole command line (split on shell chaining) for a dependency add.
function parseInstallCommands(command) {
  const hits = [];
  for (const segment of String(command || '').split(/&&|\|\||;|\|/)) {
    const hit = parseSegment(segment);
    if (hit) hits.push(hit);
  }
  return hits;
}

// The first install in the line. Kept for callers that want one answer.
function parseInstallCommand(command) {
  return parseInstallCommands(command)[0] || null;
}

// One decision per package however the spec is written: `axios`,
// `axios@^1.8`, `flask==2.0`, and `requests[socks]` all name the same
// dependency. Cut at the first version/extras marker; a non-leading `@`
// starts a version (a leading one is an npm scope).
function packageName(token) {
  const t = String(token || '');
  const at = t.indexOf('@', 1);
  const spec = t.search(/[=<>!~[]/);
  const end = Math.min(at === -1 ? t.length : at, spec === -1 ? t.length : spec);
  return t.slice(0, end) || t;
}

// One ledger identity per dependency: case- and separator-insensitive
// (pip treats `python-dotenv` and `python_dotenv` as one package; folding
// on every ecosystem can only suppress a nudge, never falsely deny).
function ledgerName(name) {
  return String(name).toLowerCase().replace(/-/g, '_');
}

function depKey(hit) {
  return `${hit.manager}:${hit.packages.map((p) => ledgerName(packageName(p))).sort().join(',')}`;
}

// Manifest-name match in the suppressing direction only (`python_dotenv` ≙
// `python-dotenv`) — missing a nudge is acceptable, a false deny is not.
function isDeclaredIn(name, deps) {
  const norm = (s) => String(s).toLowerCase().replace(/-/g, '_');
  const n = norm(name);
  return (deps || []).some((d) => norm(d) === n);
}

// ---- evidence: what's already installed, from the project manifest ----
//
// Line-scan extraction for TOML/Gemfile/csproj on purpose — pulling in a
// parser to police dependency additions would be rung-5 irony.
// razor: naive section scanning, real parsers if extraction ever misleads.

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf-8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

function specName(spec) {
  return spec.split(/[<>=!~;\[\s@(]/)[0].trim();
}

// Every section that names a package declares it. Optional and peer entries
// are in the manifest exactly as much as a plain dependency is, so leaving
// them out denied ordinary imports as new dependencies and printed an
// "Already declared" list that omitted the very package being imported. The
// python reader has always counted [project.optional-dependencies]; this is
// the same rule.
function readNodeDeps(dir) {
  const text = readText(path.join(dir, 'package.json'));
  if (text === null) return null;
  try {
    const pkg = JSON.parse(text);
    return Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
      ...pkg.optionalDependencies,
      ...pkg.peerDependencies,
    });
  } catch {
    return null;
  }
}

// Declared names in a pyproject.toml's own text. Split out from the reader
// below so the manifest guard can judge an edit by the file it would produce,
// exactly as it already does for package.json and requirements.txt.
//
// Line-scan state machine: PEP 621 dependency arrays (which may span lines and
// contain "]" inside extras like flask[async]) plus poetry dependency tables.
// Bracket counting survives quoted extras because their brackets are balanced.
function pyprojectDepNames(text) {
  const names = new Set();
  let section = '';
  let arrayDepth = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (arrayDepth === 0) {
      const header = line.match(/^\s*\[(.+)\]\s*$/);
      if (header) {
        section = header[1];
        continue;
      }
    }
    if (/^tool\.poetry(\.group\.[^.\]]+)?\.(dev-)?dependencies$/.test(section)) {
      const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      if (kv && kv[1].toLowerCase() !== 'python') names.add(kv[1].toLowerCase());
      continue;
    }
    const startsArray =
      (section === 'project' && /^\s*dependencies\s*=\s*\[/.test(line)) ||
      ((section === 'project.optional-dependencies' || section === 'dependency-groups') &&
        /^\s*[A-Za-z0-9_.-]+\s*=\s*\[/.test(line));
    if (arrayDepth > 0 || startsArray) {
      // A PEP 735 group can pull in another group by name; that name is not
      // a package, so quoting it must not declare a phantom dependency.
      if (/include-group/.test(line)) {
        arrayDepth += (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;
        if (arrayDepth < 0) arrayDepth = 0;
        continue;
      }
      for (const q of line.matchAll(/["']([^"']+)["']/g)) {
        const name = specName(q[1]);
        if (name) names.add(name.toLowerCase());
      }
      arrayDepth += (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;
      if (arrayDepth < 0) arrayDepth = 0;
    }
  }
  return names;
}

// Names declared by one requirements file, following `-r other.txt` and
// `--requirement other.txt` includes: a dependency pinned in an included file
// is just as declared as one written inline. Depth- and cycle-bounded.
function requirementsNames(file, names, seen) {
  const resolved = path.resolve(file);
  if (seen.has(resolved) || seen.size > 16) return;
  seen.add(resolved);
  const text = readText(resolved);
  if (text === null) return;
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const include = t.match(/^(?:-r|--requirement)[=\s]+(\S+)/);
    if (include) {
      requirementsNames(path.join(path.dirname(resolved), include[1]), names, seen);
      continue;
    }
    if (t.startsWith('-')) continue;
    const name = specName(t);
    if (name) names.add(name);
  }
}

function readPythonDeps(dir) {
  const names = new Set();
  const toml = readText(path.join(dir, 'pyproject.toml'));
  if (toml !== null) for (const n of pyprojectDepNames(toml)) names.add(n);
  if (names.size) return [...names];
  const reqPath = path.join(dir, 'requirements.txt');
  if (readText(reqPath) !== null) {
    requirementsNames(reqPath, names, new Set());
    return [...names];
  }
  return toml !== null ? [] : null;
}

function readCargoDeps(dir) {
  const toml = readText(path.join(dir, 'Cargo.toml'));
  if (toml === null) return null;
  const names = new Set();
  let inDeps = false;
  for (const line of toml.split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      const h = header[1];
      const table = h.match(/^(?:workspace\.)?(?:dev-|build-)?dependencies(?:\.(.+))?$/);
      inDeps = Boolean(table && !table[1]);
      if (table && table[1]) names.add(table[1]); // [dependencies.foo] form
      continue;
    }
    if (!inDeps) continue;
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (kv) names.add(kv[1]);
  }
  return [...names];
}

function readGoDeps(dir) {
  const mod = readText(path.join(dir, 'go.mod'));
  if (mod === null) return null;
  const names = new Set();
  let inBlock = false;
  for (const line of mod.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && t.startsWith(')')) {
      inBlock = false;
      continue;
    }
    const single = t.match(/^require\s+(\S+)\s+v/);
    if (single) names.add(single[1]);
    else if (inBlock) {
      const entry = t.match(/^(\S+)\s+v/);
      if (entry) names.add(entry[1]);
    }
  }
  return [...names];
}

function readComposerDeps(dir) {
  const text = readText(path.join(dir, 'composer.json'));
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return Object.keys({ ...j.require, ...j['require-dev'] }).filter(
      (n) => n !== 'php' && !n.startsWith('ext-')
    );
  } catch {
    return null;
  }
}

function readGemDeps(dir) {
  const text = readText(path.join(dir, 'Gemfile'));
  if (text === null) return null;
  const names = [];
  for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) names.push(m[1]);
  return names;
}

function readDotnetDeps(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(cs|fs)proj$/.test(f));
  } catch {
    return null;
  }
  if (!files.length) return null;
  const names = new Set();
  for (const f of files) {
    const text = readText(path.join(dir, f));
    if (text === null) continue;
    for (const m of text.matchAll(/PackageReference\s+Include="([^"]+)"/g)) names.add(m[1]);
  }
  return [...names];
}

const READERS = {
  npm: readNodeDeps,
  pnpm: readNodeDeps,
  yarn: readNodeDeps,
  bun: readNodeDeps,
  pip: readPythonDeps,
  pip3: readPythonDeps,
  pipenv: readPythonDeps,
  poetry: readPythonDeps,
  uv: readPythonDeps,
  cargo: readCargoDeps,
  go: readGoDeps,
  composer: readComposerDeps,
  gem: readGemDeps,
  dotnet: readDotnetDeps,
};

// Walk up from cwd to the nearest manifest for this ecosystem; the declared
// dependency names become evidence in the deny reason. Null = no evidence.
// razor: nearest-to-cwd resolution; per-subpackage targeting if monorepos bite.
function installedDeps(manager, startDir) {
  const reader = READERS[manager];
  if (!reader || !startDir) return null;
  let dir = path.resolve(startDir);
  for (let i = 0; i < 12; i++) {
    const found = reader(dir);
    if (found && found.length) return found;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const LIST_CAP = 30;

// The retry contract is spelled out as the base prompt's own "adjustment":
// the harness tells the model a denied call means the user declined and to
// adjust rather than retry verbatim — so the reason declares its automated
// provenance and frames the unchanged re-run AS the correct adjustment.
const PROVENANCE = "This is razor's automated checkpoint, not the user declining. ";

function retryContract(what) {
  return (
    `the correct adjustment is to re-issue the exact same ${what} — ` +
    'razor asks once and the retry passes; nothing here needs the user.'
  );
}

// One deny body for all three dependency gates; only the head sentence
// differs. The list is what the manifest declares — evidence, not a claim
// about what's physically installed.
function evidenceReason(head, deps, what) {
  if (deps && deps.length) {
    const sorted = [...new Set(deps)].sort((a, b) => a.localeCompare(b));
    const shown = sorted.slice(0, LIST_CAP).join(', ') + (sorted.length > LIST_CAP ? ', …' : '');
    return (
      head +
      `Already declared (${sorted.length}): ${shown}. ` +
      'Rungs 3-5 — check the stdlib, the platform, and those first, even when the user names the library. ' +
      PROVENANCE +
      'If nothing covers it, ' +
      retryContract(what)
    );
  }
  return (
    head +
    'Rungs 3-5 — check the stdlib, the platform, and already-declared deps first, even when the user names the library. ' +
    PROVENANCE +
    'If nothing covers it, ' +
    retryContract(what)
  );
}

function denyReason(hit, deps) {
  return evidenceReason(`razor: '${hit.packages.join(' ')}' adds a new ${hit.manager} dependency. `, deps, 'command');
}

// Ecosystem of a manager, for the reconsideration ledger shared with the
// manifest and import guards — one nudge per dependency however it enters.
const MANAGER_ECO = {
  npm: 'node', pnpm: 'node', yarn: 'node', bun: 'node',
  pip: 'python', pip3: 'python', pipenv: 'python', poetry: 'python', uv: 'python',
};

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (settingOff('DEP_GUARD')) return null;
  if (data.tool_name !== 'Bash' && data.tool_name !== 'PowerShell') return null;

  // Every install on the line, not just the first. A chained command that
  // installs two packages used to be checkpointed for the first one alone,
  // and the retry that cleared it carried the second in unexamined -- one
  // nudge, two dependencies. Each install now gets its own one-time
  // checkpoint, and the first one still owing a nudge is the one that answers.
  for (const hit of parseInstallCommands(data.tool_input && data.tool_input.command)) {
    const reason = checkHit(hit, data, state);
    if (reason) return reason;
  }
  return null;
}

function checkHit(hit, data, state) {
  const names = hit.packages.map(packageName);
  const deps = installedDeps(hit.manager, data.cwd);
  // Installing what the manifest already declares is a restore, not an
  // addition — never checkpointed.
  if (deps && names.every((n) => isDeclaredIn(n, deps))) return null;

  const key = depKey(hit);
  if (state.deniedDeps && state.deniedDeps[key]) return null; // already reconsidered — normal permission flow applies
  const eco = MANAGER_ECO[hit.manager];
  if (eco && state.deniedImports
      && names.every((n) => state.deniedImports[`${eco}:${ledgerName(n)}`])) {
    return null; // every package already reconsidered via a manifest edit or import
  }

  state.deniedDeps = state.deniedDeps || {};
  state.deniedDeps[key] = true;
  if (eco) {
    state.deniedImports = state.deniedImports || {};
    for (const n of names) state.deniedImports[`${eco}:${ledgerName(n)}`] = true;
  }
  return denyReason(hit, deps);
}

module.exports = {
  check, parseInstallCommand, parseInstallCommands, depKey, packageName, ledgerName, installedDeps, denyReason, evidenceReason, PROVENANCE, retryContract,
  // The two readers scripts/unused-deps.js consumes — it reuses them so the
  // audit and the gates can never silently disagree. The other ecosystems'
  // readers stay internal; nothing outside this file has ever called them.
  readNodeDeps, readPythonDeps, pyprojectDepNames,
};
