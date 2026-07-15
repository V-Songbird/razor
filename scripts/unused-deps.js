#!/usr/bin/env node
'use strict';

// Report-only audit: manifest dependencies that no source file imports.
// razor's write-time gates (dep-guard/import-guard) prevent NEW dependencies;
// this is the reverse query on EXISTING ones — declared but never imported.
// Reuses razor's own manifest readers and import extractors (never copies
// them) so the audit and the gates can never silently disagree.
//
// Never edits any file. The user decides what to remove.

const fs = require('fs');
const path = require('path');
const { readNodeDeps, readPythonDeps } = require('../hooks/dep-guard');
const { jsImportRoots, pyImportRoots, isDeclared, ecosystemOf } = require('../hooks/import-guard');

const MANIFEST_NAME = { node: 'package.json', python: 'requirements.txt / pyproject.toml' };
const EXTRACT = { node: jsImportRoots, python: pyImportRoots };

// Generated/vendored dirs never hold source worth scanning — same doctrine
// as the gates (grandfather what's already there, don't chase build output).
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', '.turbo',
  'vendor', '.tox', '.eggs', 'egg-info',
]);

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
        if (ecosystemOf(full)) files.push(full);
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
    'babel.config.js', 'babel.config.json', '.babelrc', '.babelrc.js', '.babelrc.json',
    'webpack.config.js', 'webpack.config.ts', 'vite.config.js', 'vite.config.ts',
    'jest.config.js', 'jest.config.ts', 'jest.config.json', 'rollup.config.js',
    'postcss.config.js', 'tailwind.config.js', '.prettierrc', '.prettierrc.js',
    '.prettierrc.json', 'next.config.js', 'tsconfig.json',
  ],
  python: ['tox.ini', 'setup.cfg', 'pytest.ini', '.flake8', 'mypy.ini'],
};

function packageJsonScripts(projectDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    return Object.values(pkg.scripts || {}).join('\n');
  } catch {
    return '';
  }
}

// devDependencies alone (readNodeDeps merges deps+devDeps, losing the
// distinction this classification needs). Audit-specific read, kept local —
// dep-guard's manifest reader stays untouched.
function packageJsonDevDeps(projectDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, 'package.json'), 'utf-8'));
    return new Set(Object.keys(pkg.devDependencies || {}));
  } catch {
    return new Set();
  }
}

// TypeScript toolchain deps are consumed by tsc/build, never imported by
// source — a bare "Unused" verdict on them is a false positive. Routed to
// "possibly used" instead, same suppressing-direction doctrine as the rest
// of this audit.
const KNOWN_TOOLCHAIN = new Set(['typescript', 'ts-node', 'tsx']);

function nodeToolchainReason(dep, devDeps) {
  if (dep.startsWith('@types/')) return 'type definitions - consumed by tsc';
  if (KNOWN_TOOLCHAIN.has(dep)) return 'toolchain - consumed by tsc/build, not imported';
  if (devDeps.has(dep)) return 'devDependency - usually toolchain';
  return null;
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
// dep reported "possibly used" instead of "unused" — the safe direction,
// same suppressing-direction doctrine as the import-root normalization.
function mentionedOutsideImports(dep, haystack) {
  const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
}

// Core audit: given a project directory, which declared deps have no
// matching import root, split into "unused" and "possibly used outside
// imports" (scripts/config mentions).
function auditProject(projectDir) {
  const ecosystems = [];
  const nodeDeps = readNodeDeps(projectDir);
  if (nodeDeps !== null) ecosystems.push({ eco: 'node', deps: nodeDeps });
  const pythonDeps = readPythonDeps(projectDir);
  if (pythonDeps !== null) ecosystems.push({ eco: 'python', deps: pythonDeps });

  const files = walkSourceFiles(projectDir);
  const importsByEco = { node: new Set(), python: new Set() };
  const scannedByEco = { node: 0, python: 0 };
  for (const file of files) {
    const eco = ecosystemOf(file);
    scannedByEco[eco] += 1;
    let text;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    for (const root of EXTRACT[eco](text)) importsByEco[eco].add(root);
  }

  const outsideText = {
    node: packageJsonScripts(projectDir) + configFilesText('node', projectDir),
    python: configFilesText('python', projectDir),
  };

  const result = { ecosystems: [], usedCount: 0 };
  for (const { eco, deps } of ecosystems) {
    const roots = [...importsByEco[eco]];
    const scanned = scannedByEco[eco];
    const devDeps = eco === 'node' ? packageJsonDevDeps(projectDir) : null;
    const unused = [];
    const possiblyUsed = [];
    for (const dep of [...deps].sort((a, b) => a.localeCompare(b))) {
      const used = roots.some((root) => isDeclared(root, [dep]));
      if (used) {
        result.usedCount += 1;
        continue;
      }
      const entry = { dep, scanned };
      const toolchainReason = devDeps && nodeToolchainReason(dep, devDeps);
      if (toolchainReason) {
        entry.reason = toolchainReason;
        possiblyUsed.push(entry);
      } else if (mentionedOutsideImports(dep, outsideText[eco])) {
        possiblyUsed.push(entry);
      } else {
        unused.push(entry);
      }
    }
    result.ecosystems.push({
      eco, manifest: MANIFEST_NAME[eco], declaredCount: deps.length, scanned, unused, possiblyUsed,
    });
  }
  return result;
}

const KNOWN_LIMITS =
  'Known limits: static import scanning cannot see dynamic import(variable) calls, ' +
  'runtime require-by-string, or CLI tools/plugins invoked via npx/exec without ever ' +
  'being imported. Treat "possibly used" entries as needing a manual check, not confirmed usage.';

function formatReport(projectDir, result) {
  const lines = [`razor:unused audit — ${projectDir}`, ''];
  if (!result.ecosystems.length) {
    lines.push('No supported manifest found (package.json, requirements.txt, pyproject.toml).');
    return lines.join('\n');
  }

  let totalUnused = 0;
  let totalPossible = 0;
  for (const eco of result.ecosystems) {
    lines.push(`## ${eco.eco} (${eco.manifest})`);
    if (eco.unused.length) {
      lines.push(`Unused (${eco.unused.length}):`);
      for (const { dep, scanned } of eco.unused) {
        lines.push(`  ${dep}: no import found in ${scanned} source files scanned`);
      }
    } else {
      lines.push('Unused: none');
    }
    if (eco.possiblyUsed.length) {
      lines.push(`Possibly used outside imports (${eco.possiblyUsed.length}) — check before removing:`);
      for (const { dep, scanned, reason } of eco.possiblyUsed) {
        const suffix = reason ? ` (${reason})` : '';
        lines.push(`  ${dep}${suffix}: no import found in ${scanned} source files scanned`);
      }
    }
    lines.push('');
    totalUnused += eco.unused.length;
    totalPossible += eco.possiblyUsed.length;
  }

  lines.push(
    `Verdict: ${result.usedCount} used, ${totalUnused} unused, ${totalPossible} possibly used outside imports.`,
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
  const result = auditProject(projectDir);
  console.log(formatReport(projectDir, result));
}

if (require.main === module) main();

module.exports = { auditProject, formatReport, walkSourceFiles, mentionedOutsideImports };
