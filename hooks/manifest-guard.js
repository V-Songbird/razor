'use strict';

// Gate (Write|Edit, via pre-tool-use.js) — soft gate on dependencies entering
// through the manifest itself.
//
// The dep guard watches install commands and the import guard watches code,
// but a dependency can also arrive by editing package.json or
// requirements.txt directly — on some models that's the dominant path, and
// it reaches the project without either gate speaking. This gate watches
// that moment: a Write/Edit whose result adds a NEW name to the manifest's
// dependency sections is denied once with the reuse-first reason; re-issuing
// the same call passes. The reconsideration ledger is shared with the dep
// and import guards — one nudge per dependency however it enters.
//
// Bounded on purpose:
//   - package.json (dependencies + devDependencies) and requirements.txt
//     only; other manifests are covered when their install is attempted,
//   - fires only when the manifest already exists on disk (creating a fresh
//     manifest is scaffolding a project, not sneaking a dependency in),
//   - version bumps of existing entries never fire — only new names count,
//   - Edits are simulated against the on-disk content (old_string →
//     new_string), so fragments are judged by the file they would produce;
//     anything unparseable stays silent — never a false deny.

const fs = require('fs');
const path = require('path');
const { settingOff } = require('./razor-lib');
const { installedDeps, PROVENANCE, retryContract } = require('./dep-guard');

// null = unparseable (caller stays silent), Set otherwise.
function jsonDepNames(text) {
  try {
    const pkg = JSON.parse(text);
    return new Set(
      Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }).map((n) => n.toLowerCase())
    );
  } catch {
    return null;
  }
}

function reqDepNames(text) {
  const names = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('-')) continue;
    const name = t.split(/[<>=!~;\[\s@(]/)[0].trim();
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

const GUARDED = {
  'package.json': { eco: 'node', manager: 'npm', extract: jsonDepNames },
  'requirements.txt': { eco: 'python', manager: 'pip', extract: reqDepNames },
};

const LIST_CAP = 30;

function denyReason(tool, names, eco, manifestName, deps) {
  const what = names.map((n) => `\`${n}\``).join(', ');
  const head = `razor: this ${tool} to ${manifestName} adds a new ${eco} dependency (${what}) without an install. `;
  const tail = PROVENANCE + 'If nothing covers it, ' + retryContract(tool);
  if (deps && deps.length) {
    const sorted = [...new Set(deps)].sort((a, b) => a.localeCompare(b));
    const shown = sorted.slice(0, LIST_CAP).join(', ') + (sorted.length > LIST_CAP ? ', …' : '');
    return head
      + `Already installed (${sorted.length}): ${shown}. `
      + 'Rungs 3-5 — check the stdlib, the platform, and those first, even when the user names the library. '
      + tail;
  }
  return head
    + 'Rungs 3-5 — check the stdlib, the platform, and already-installed deps first, even when the user names the library. '
    + tail;
}

// The resulting manifest content this tool call would produce, or null when
// the call cannot land as written (the Edit would fail anyway).
function simulate(toolName, input, existing) {
  if (toolName === 'Write') return input.content || null;
  const oldStr = input.old_string;
  const newStr = input.new_string;
  if (!oldStr || newStr === undefined || !existing.includes(oldStr)) return null;
  return input.replace_all ? existing.split(oldStr).join(newStr) : existing.replace(oldStr, newStr);
}

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (settingOff('MANIFEST_GUARD')) return null;
  if (data.tool_name !== 'Write' && data.tool_name !== 'Edit') return null;

  const input = data.tool_input || {};
  const filePath = input.file_path;
  if (!filePath || /node_modules/.test(filePath)) return null;
  const spec = GUARDED[path.basename(filePath).toLowerCase()];
  if (!spec) return null;

  let existing;
  try {
    existing = fs.readFileSync(path.resolve(filePath), 'utf-8');
  } catch {
    return null; // no manifest on disk — greenfield scaffolding stays ungated
  }

  const resulting = simulate(data.tool_name, input, existing);
  if (!resulting) return null;

  const before = spec.extract(existing);
  const after = spec.extract(resulting);
  if (!before || !after) return null; // unparseable side — stay silent

  const fresh = [...after].filter((n) => !before.has(n)).sort();
  if (!fresh.length) return null;

  state.deniedImports = state.deniedImports || {};
  const unseen = fresh.filter((n) => !state.deniedImports[`${spec.eco}:${n}`]);
  if (!unseen.length) return null; // all already reconsidered — pass silently
  for (const n of unseen) state.deniedImports[`${spec.eco}:${n}`] = true;

  const deps = installedDeps(spec.manager, path.dirname(path.resolve(filePath)));
  return denyReason(data.tool_name, unseen, spec.eco, path.basename(filePath), deps);
}

module.exports = { check, jsonDepNames, reqDepNames, simulate, GUARDED };
