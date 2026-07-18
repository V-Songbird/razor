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

// Flags, `.`, and shell redirects are not package names. A bare redirect
// operator (`>`, `2>`) also consumes the following token — its target.
function packageArgs(args) {
  const out = [];
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!a || a === '.' || a.startsWith('-')) continue;
    const redirect = a.match(/^\d*(?:>>?|<<?|&>>?)(.*)$/);
    if (redirect) {
      if (!redirect[1]) skipNext = true;
      continue;
    }
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
  return { manager: cmd, packages };
}

// razor: parses the command exactly as the model issued it. hush's
// preserve-exit-code.js rewrites Bash/PowerShell commands via updatedInput
// under bypassPermissions/HUSH_WRAP=1, but PreToolUse hooks from separate
// plugins don't chain — each one gets the same original tool_input, never a
// sibling's rewrite (verified live 2026-07-14). No unwrap step needed here.
// Scan a whole command line (split on shell chaining) for a dependency add.
function parseInstallCommand(command) {
  for (const segment of String(command || '').split(/&&|\|\||;|\|/)) {
    const hit = parseSegment(segment);
    if (hit) return hit;
  }
  return null;
}

function depKey(hit) {
  return `${hit.manager}:${hit.packages.map((p) => p.toLowerCase()).sort().join(',')}`;
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

function readNodeDeps(dir) {
  const text = readText(path.join(dir, 'package.json'));
  if (text === null) return null;
  try {
    const pkg = JSON.parse(text);
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  } catch {
    return null;
  }
}

function readPythonDeps(dir) {
  const names = new Set();
  const toml = readText(path.join(dir, 'pyproject.toml'));
  if (toml !== null) {
    // Line-scan state machine: PEP 621 dependency arrays (which may span
    // lines and contain "]" inside extras like flask[async]) plus poetry
    // dependency tables. Bracket counting survives quoted extras because
    // their brackets are balanced.
    let section = '';
    let arrayDepth = 0;
    for (const line of toml.split(/\r?\n/)) {
      if (arrayDepth === 0) {
        const header = line.match(/^\s*\[(.+)\]\s*$/);
        if (header) {
          section = header[1];
          continue;
        }
      }
      if (/^tool\.poetry(\.group\.[^.\]]+)?\.(dev-)?dependencies$/.test(section)) {
        const kv = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
        if (kv && kv[1].toLowerCase() !== 'python') names.add(kv[1]);
        continue;
      }
      const startsArray =
        (section === 'project' && /^\s*dependencies\s*=\s*\[/.test(line)) ||
        (section === 'project.optional-dependencies' && /^\s*[A-Za-z0-9_.-]+\s*=\s*\[/.test(line));
      if (arrayDepth > 0 || startsArray) {
        for (const q of line.matchAll(/["']([^"']+)["']/g)) {
          const name = specName(q[1]);
          if (name) names.add(name);
        }
        arrayDepth += (line.match(/\[/g) || []).length - (line.match(/\]/g) || []).length;
        if (arrayDepth < 0) arrayDepth = 0;
      }
    }
  }
  if (names.size) return [...names];
  const req = readText(path.join(dir, 'requirements.txt'));
  if (req !== null) {
    for (const line of req.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('-')) continue;
      const name = specName(t);
      if (name) names.add(name);
    }
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

function denyReason(hit, deps) {
  const head = `razor: '${hit.packages.join(' ')}' adds a new ${hit.manager} dependency. `;
  if (deps && deps.length) {
    const sorted = [...new Set(deps)].sort((a, b) => a.localeCompare(b));
    const shown = sorted.slice(0, LIST_CAP).join(', ') + (sorted.length > LIST_CAP ? ', …' : '');
    return (
      head +
      `Already installed (${sorted.length}): ${shown}. ` +
      PROVENANCE +
      'If none of these, the stdlib, or the platform covers it, ' +
      retryContract('command')
    );
  }
  return (
    head +
    'Rungs 3-5 — check the stdlib, the platform, and already-installed deps first. ' +
    PROVENANCE +
    'If nothing covers it, ' +
    retryContract('command')
  );
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

  const hit = parseInstallCommand(data.tool_input && data.tool_input.command);
  if (!hit) return null;

  const key = depKey(hit);
  if (state.deniedDeps && state.deniedDeps[key]) return null; // already reconsidered — normal permission flow applies
  const eco = MANAGER_ECO[hit.manager];
  if (eco && state.deniedImports
      && hit.packages.every((p) => state.deniedImports[`${eco}:${p.toLowerCase()}`])) {
    return null; // every package already reconsidered via a manifest edit or import
  }

  state.deniedDeps = state.deniedDeps || {};
  state.deniedDeps[key] = true;
  if (eco) {
    state.deniedImports = state.deniedImports || {};
    for (const p of hit.packages) state.deniedImports[`${eco}:${p.toLowerCase()}`] = true;
  }
  return denyReason(hit, installedDeps(hit.manager, data.cwd));
}

module.exports = {
  check, parseInstallCommand, depKey, installedDeps, denyReason, PROVENANCE, retryContract,
  // razor: exported for scripts/unused-deps.js (reuse the manifest readers,
  // never copy them) — behavior-neutral, no logic change.
  readNodeDeps, readPythonDeps, readCargoDeps, readGoDeps, readComposerDeps, readGemDeps, readDotnetDeps, READERS,
};
