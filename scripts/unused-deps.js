#!/usr/bin/env node
'use strict';

// Report-only audit: manifest dependencies that no source file imports.
// razor's write-time gates (dep-guard/import-guard) prevent NEW dependencies;
// this is the reverse query on EXISTING ones — declared but never imported.
// Reuses razor's own manifest readers and import extractors (never copies
// them) so the audit and the gates can never silently disagree.
//
// Three buckets, and which one a dependency lands in depends on what could
// actually be checked:
//
//   confirmed — a resolver-grade check ran and found nothing: no import, no
//               command shipped, and no installed package peer-requires it.
//   likely    — nothing references it, but no resolver was available, so
//               nothing PROVED it. Never called high confidence.
//   unknown   — something references it, or only a resolver can settle it.
//
// The resolver here is the project's own installed tree: a package's manifest
// says whether it ships a command, and every other installed manifest says
// whether it needs this one as a peer. Those are the two classes grep is
// blind to, and reading them changes no file.
//
// Never edits any file. The user decides what to remove.

const fs = require('fs');
const path = require('path');
const { readNodeDeps, readPythonDeps } = require('../hooks/dep-guard');
const {
  jsImportRoots,
  jsTypeImportRoots,
  pyImportRoots,
  isDeclared,
  ecosystemOf,
} = require('../hooks/import-guard');

const MANIFEST_NAME = { node: 'package.json', python: 'requirements.txt / pyproject.toml' };

// Generated/vendored dirs never hold source worth scanning — same doctrine
// as the gates (grandfather what's already there, don't chase build output).
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.turbo',
  'vendor', '.tox', '.eggs', 'egg-info',
]);

// Single-file component and doc formats carry JS/TS imports inside them. The
// gates skip them (they can't judge a partial payload); the audit must not —
// a dependency imported only from a .vue file is used, not unused.
const COMPONENT_EXT = /\.(vue|svelte|astro|mdx)$/i;

function fileEcosystem(filePath) {
  return ecosystemOf(filePath) || (COMPONENT_EXT.test(filePath) ? 'node' : null);
}

function walkSourceFiles(dir) {
  const files = [];
  (function recurse(d) {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
        recurse(full);
      } else if (e.isFile()) {
        // Test files count: a test-only import still counts as used.
        if (fileEcosystem(full)) files.push(full);
      }
    }
  })(dir);
  return files;
}

// Root config files whose content mentions a CLI/plugin dep that is invoked,
// not imported (eslint plugins, babel presets, build-tool configs). Scanned
// as separate files, never the manifest itself, so a dep can't match its own
// declaration line.
const CONFIG_FILES = {
  node: [
    '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml',
    'eslint.config.js', 'eslint.config.mjs',
    'babel.config.js', 'babel.config.json', '.babelrc', '.babelrc.js', '.babelrc.json',
    'webpack.config.js', 'webpack.config.ts', 'vite.config.js', 'vite.config.ts',
    'jest.config.js', 'jest.config.ts', 'jest.config.json', 'rollup.config.js',
    'postcss.config.js', 'tailwind.config.js', '.prettierrc', '.prettierrc.js',
    '.prettierrc.json', 'next.config.js', 'tsconfig.json', 'nuxt.config.ts',
    'svelte.config.js', 'astro.config.mjs', 'vitest.config.ts',
  ],
  python: ['tox.ini', 'setup.cfg', 'pytest.ini', '.flake8', 'mypy.ini', 'noxfile.py', 'Makefile'],
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function packageJsonScripts(projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json'));
  return pkg ? Object.values(pkg.scripts || {}).join('\n') : '';
}

// devDependencies alone (readNodeDeps merges every dependency section, losing
// the distinction this classification needs). Audit-specific read, kept local
// — dep-guard's manifest reader stays untouched.
function packageJsonDevDeps(projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json'));
  return new Set(Object.keys((pkg && pkg.devDependencies) || {}));
}

// Packages declared ONLY as peers. A peer requirement is a contract with
// whoever installs this package, not weight this project carries: the normal
// case is that no local file imports it, so auditing one for deadness would
// manufacture false positives. Declared in another section too? Then it is a
// real dependency here and gets audited like any other.
function packageJsonPeerOnlyDeps(projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json')) || {};
  const carried = new Set(
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies })
  );
  return new Set(Object.keys(pkg.peerDependencies || {}).filter((n) => !carried.has(n)));
}

// TypeScript toolchain deps are consumed by tsc/build, never imported by
// source — a bare "unused" verdict on them is a false positive.
const KNOWN_TOOLCHAIN = new Set(['typescript', 'ts-node', 'tsx']);

function nodeToolchainReason(dep, devDeps) {
  if (dep.startsWith('@types/')) return 'type definitions - consumed by tsc';
  if (KNOWN_TOOLCHAIN.has(dep)) return 'toolchain - consumed by tsc/build, not imported';
  if (devDeps.has(dep)) return 'devDependency - usually toolchain';
  return null;
}

// Dependencies the project has already declared it does not want audited.
// Reads the resolver's own ignore list rather than inventing a razor-specific
// config file — a project that already answered this question answered it.
function configuredIgnores(projectDir) {
  const out = new Set();
  const take = (value) => {
    if (Array.isArray(value)) for (const n of value) out.add(String(n));
  };
  const pkg = readJson(path.join(projectDir, 'package.json'));
  if (pkg && pkg.knip) take(pkg.knip.ignoreDependencies);
  for (const name of ['knip.json', 'knip.jsonc', '.knip.json']) {
    try {
      const raw = fs.readFileSync(path.join(projectDir, name), 'utf-8').replace(/^\s*\/\/[^\n]*$/gm, '');
      take(JSON.parse(raw).ignoreDependencies);
    } catch {
      /* absent or unparseable — no ignores from it */
    }
  }
  return out;
}

// The installed tree, read as evidence. Null when nothing is installed, and
// that null is the difference between "confirmed" and "likely": with no
// installed manifests to read, command and peer usage stay unchecked.
function installedEvidence(projectDir) {
  const root = path.join(projectDir, 'node_modules');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const names = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    if (e.name.startsWith('@')) {
      try {
        for (const s of fs.readdirSync(path.join(root, e.name), { withFileTypes: true })) {
          if (s.isDirectory()) names.push(`${e.name}/${s.name}`);
        }
      } catch {
        /* unreadable scope dir */
      }
    } else {
      names.push(e.name);
    }
  }
  if (!names.length) return null;

  const bins = new Set();
  const peeredBy = new Map();
  for (const name of names) {
    const pkg = readJson(path.join(root, ...name.split('/'), 'package.json'));
    if (!pkg) continue;
    if (pkg.bin) bins.add(name);
    for (const peer of Object.keys(pkg.peerDependencies || {})) {
      if (!peeredBy.has(peer)) peeredBy.set(peer, []);
      peeredBy.get(peer).push(name);
    }
  }
  return { bins, peeredBy, installedCount: names.length };
}

// Detect whether knip — the resolver-grade dead-dependency tool — is
// installed for the target project or resolvable from it (npm/pnpm/yarn
// hoisting all satisfy require.resolve). Detection only: razor never
// executes, installs, or depends on knip itself.
function knipAvailable(projectDir) {
  try {
    require.resolve('knip/package.json', { paths: [projectDir] });
    return true;
  } catch {
    return false;
  }
}

function configFilesText(eco, projectDir) {
  let text = '';
  for (const name of CONFIG_FILES[eco] || []) {
    try {
      text += '\n' + fs.readFileSync(path.join(projectDir, name), 'utf-8');
    } catch { /* not present */ }
  }
  return text;
}

// Over-matching here (a substring hit that isn't a real reference) means one
// dep lands in "unknown" instead of "unused" — the safe direction, same
// suppressing-direction doctrine as the import-root normalization.
function mentionedOutsideImports(dep, haystack) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `\b` only anchors beside a word character, and a scoped name starts with
  // "@" — so a leading `\b` can never match one, and every scoped dependency
  // mentioned in a script or config would read as unmentioned.
  const left = /^\w/.test(dep) ? '\\b' : '(?<![\\w@/-])';
  return new RegExp(`${left}${escaped}\\b`, 'i').test(haystack);
}

// One directory's declared deps against one directory's source. Shared by the
// root project and by every workspace package, so a workspace is audited
// against its own manifest and its own files, never the root's.
function auditDir(projectDir) {
  const ecosystems = [];
  const nodeDeps = readNodeDeps(projectDir);
  if (nodeDeps !== null) {
    const peerOnly = packageJsonPeerOnlyDeps(projectDir);
    ecosystems.push({ eco: 'node', deps: nodeDeps.filter((d) => !peerOnly.has(d)) });
  }
  const pythonDeps = readPythonDeps(projectDir);
  if (pythonDeps !== null) ecosystems.push({ eco: 'python', deps: pythonDeps });
  if (!ecosystems.length) return { ecosystems: [], usedCount: 0 };

  const files = walkSourceFiles(projectDir);
  const importsByEco = { node: new Set(), python: new Set() };
  const scannedByEco = { node: 0, python: 0 };
  for (const file of files) {
    const eco = fileEcosystem(file);
    scannedByEco[eco] += 1;
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    if (eco === 'node') {
      for (const root of jsImportRoots(text)) importsByEco.node.add(root);
      // A type-only import is real usage even though it ships nothing.
      for (const root of jsTypeImportRoots(text)) importsByEco.node.add(root);
    } else {
      for (const root of pyImportRoots(text)) importsByEco.python.add(root);
    }
  }

  const outsideText = {
    node: packageJsonScripts(projectDir) + configFilesText('node', projectDir),
    python: configFilesText('python', projectDir),
  };
  const ignores = configuredIgnores(projectDir);

  const result = { ecosystems: [], usedCount: 0 };
  for (const { eco, deps } of ecosystems) {
    const roots = [...importsByEco[eco]];
    const scanned = scannedByEco[eco];
    const devDeps = eco === 'node' ? packageJsonDevDeps(projectDir) : null;
    const evidence = eco === 'node' ? installedEvidence(projectDir) : null;
    const confirmed = [];
    const likely = [];
    const unknown = [];
    let ignored = 0;

    for (const dep of [...deps].sort((a, b) => a.localeCompare(b))) {
      if (ignores.has(dep)) {
        ignored += 1;
        continue;
      }
      if (roots.some((root) => isDeclared(root, [dep]))) {
        result.usedCount += 1;
        continue;
      }

      const reasons = [];
      const toolchain = devDeps && nodeToolchainReason(dep, devDeps);
      if (toolchain) reasons.push(toolchain);
      if (mentionedOutsideImports(dep, outsideText[eco])) reasons.push('named in a script or config file');
      if (evidence && evidence.bins.has(dep)) {
        reasons.push('the installed copy ships a command, so it may be run rather than imported');
      }
      if (evidence && evidence.peeredBy.has(dep)) {
        const by = evidence.peeredBy.get(dep).slice(0, 3).join(', ');
        reasons.push(`satisfies a peer dependency of ${by}`);
      }

      const seen = `no import found in ${scanned} source files scanned`;
      if (reasons.length) {
        unknown.push({ dep, scanned, reason: reasons[0], evidence: `${seen}; ${reasons.join('; ')}` });
      } else if (evidence) {
        confirmed.push({
          dep,
          scanned,
          evidence: `${seen}; ships no command, and none of the ${evidence.installedCount} installed packages peer-requires it`,
        });
      } else {
        likely.push({
          dep,
          scanned,
          evidence:
            eco === 'node'
              ? `${seen}; nothing is installed, so command and peer usage could not be checked`
              : `${seen}; no package metadata was available to check console-script or extras usage`,
        });
      }
    }

    result.ecosystems.push({
      eco,
      manifest: MANIFEST_NAME[eco],
      declaredCount: deps.length,
      scanned,
      resolved: Boolean(evidence),
      ignored,
      confirmed,
      likely,
      unknown,
      // knip is JS/TS-only (ISC-licensed resolver: oxc AST + manifest
      // peer/bin/types metadata) — only worth checking for the node
      // ecosystem, and only costs a require.resolve when it does.
      knipAvailable: eco === 'node' ? knipAvailable(projectDir) : false,
    });
  }
  return result;
}

// npm/yarn/pnpm workspace patterns, expanded without a glob dependency:
// a `*` segment is one directory level, which is the only form in practice.
function expandPattern(base, parts, out) {
  if (!parts.length) {
    out.add(base);
    return;
  }
  const [head, ...rest] = parts;
  if (head === '*' || head === '**') {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      expandPattern(path.join(base, e.name), head === '**' ? parts : rest, out);
    }
    if (head === '**') expandPattern(base, rest, out);
    return;
  }
  expandPattern(path.join(base, head), rest, out);
}

function workspaceDirs(projectDir) {
  const pkg = readJson(path.join(projectDir, 'package.json'));
  const patterns = Array.isArray(pkg && pkg.workspaces)
    ? pkg.workspaces
    : (pkg && pkg.workspaces && pkg.workspaces.packages) || null;
  if (!Array.isArray(patterns)) return [];
  const dirs = new Set();
  for (const pattern of patterns) {
    expandPattern(projectDir, String(pattern).split('/').filter(Boolean), dirs);
  }
  return [...dirs]
    .filter((d) => d !== projectDir && fs.existsSync(path.join(d, 'package.json')))
    .sort();
}

// Core audit. The root project's own ecosystems stay on `ecosystems`; each
// workspace package is audited independently and reported under `workspaces`,
// because a dependency unused by the root may be the point of a package.
function auditProject(projectDir) {
  const root = auditDir(projectDir);
  const result = { ecosystems: root.ecosystems, usedCount: root.usedCount, workspaces: [] };
  for (const dir of workspaceDirs(projectDir)) {
    const ws = auditDir(dir);
    if (!ws.ecosystems.length) continue;
    result.usedCount += ws.usedCount;
    result.workspaces.push({ dir, relative: path.relative(projectDir, dir) || dir, ecosystems: ws.ecosystems });
  }
  return result;
}

const KNOWN_LIMITS =
  'Known limits: static scanning cannot see dynamic import(variable) calls or ' +
  'runtime require-by-string, and a python distribution whose import name differs from its ' +
  'name beyond the common aliases can read as unimported. "Confirmed unused" means the ' +
  'installed tree was read and found no command and no peer relationship either — it is not ' +
  'a promise that no runtime string references the package. "Likely unused" means nothing ' +
  'referenced it and nothing could prove it: treat those as leads, not verdicts. Nothing ' +
  'here edits a manifest; removing a dependency is always your call.';

// knip is JS/TS-only and resolves what this audit still cannot: transitive
// import graphs, config-only plugin loading, and entry-point reachability.
// Named only when detected in the target project — razor never suggests
// installing it.
function knipEscalationLine() {
  return (
    '  Escalation: knip is available in this project and resolves entry-point reachability, ' +
    'config-only plugin loading, and @types pairing precisely — run `npx knip` for a ' +
    'definitive verdict on the node entries above (razor never runs it automatically).'
  );
}

function ecoLines(eco) {
  const lines = [`## ${eco.eco} (${eco.manifest})`];
  if (eco.confirmed.length) {
    lines.push(`Confirmed unused (${eco.confirmed.length}) — the installed tree was read and nothing references them:`);
    for (const { dep, evidence } of eco.confirmed) lines.push(`  ${dep}: ${evidence}`);
  }
  if (eco.likely.length) {
    lines.push(`Likely unused (${eco.likely.length}) — nothing references them, and nothing could prove it:`);
    for (const { dep, evidence } of eco.likely) lines.push(`  ${dep}: ${evidence}`);
  }
  if (eco.unknown.length) {
    lines.push(`Unknown (${eco.unknown.length}) — something references them, or only a resolver can settle it:`);
    for (const { dep, evidence } of eco.unknown) lines.push(`  ${dep}: ${evidence}`);
  }
  if (!eco.confirmed.length && !eco.likely.length && !eco.unknown.length) {
    lines.push('Every declared dependency is imported somewhere.');
  }
  if (eco.ignored) lines.push(`(${eco.ignored} ignored by this project's own configuration)`);
  if (eco.eco === 'node' && eco.knipAvailable && (eco.confirmed.length || eco.likely.length || eco.unknown.length)) {
    lines.push(knipEscalationLine());
  }
  return lines;
}

function formatReport(projectDir, result) {
  const lines = [`razor:unused audit — ${projectDir}`, ''];
  if (!result.ecosystems.length && !(result.workspaces || []).length) {
    lines.push('No supported manifest found (package.json, requirements.txt, pyproject.toml).');
    return lines.join('\n');
  }

  const totals = { confirmed: 0, likely: 0, unknown: 0 };
  const tally = (eco) => {
    totals.confirmed += eco.confirmed.length;
    totals.likely += eco.likely.length;
    totals.unknown += eco.unknown.length;
  };

  for (const eco of result.ecosystems) {
    lines.push(...ecoLines(eco), '');
    tally(eco);
  }
  for (const ws of result.workspaces || []) {
    lines.push(`# workspace: ${ws.relative}`);
    for (const eco of ws.ecosystems) {
      lines.push(...ecoLines(eco), '');
      tally(eco);
    }
  }

  lines.push(
    `Verdict: ${result.usedCount} used, ${totals.confirmed} confirmed unused, ` +
      `${totals.likely} likely unused, ${totals.unknown} unknown.`,
  );
  lines.push('');
  lines.push(KNOWN_LIMITS);
  return lines.join('\n');
}

function main() {
  const projectDir = path.resolve(process.argv[2] || '.');
  if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
    console.error(`Usage: unused-deps.js <projectDir> — not a directory: ${projectDir}`);
    process.exit(1);
  }
  console.log(formatReport(projectDir, auditProject(projectDir)));
}

if (require.main === module) main();

module.exports = {
  auditProject,
  auditDir,
  formatReport,
  walkSourceFiles,
  workspaceDirs,
  configuredIgnores,
  installedEvidence,
  mentionedOutsideImports,
  knipAvailable,
};
