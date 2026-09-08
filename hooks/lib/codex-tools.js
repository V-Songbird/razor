'use strict';

// Codex PreToolUse exposes apply_patch as tool_input.command. Preview its
// text in memory so the existing Write/Edit gates keep their own policies.
// Grammar: https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/parser.rs
// This is deliberately narrower than Codex's fuzzy patch matching: a missing,
// ambiguous, remote, overlapping or unreadable target means no gate decision.
// No patch, shell command or filesystem write is executed here.

const fs = require('fs');
const path = require('path');
const { ecosystemOf, newImports } = require('../import-guard');

function parsePatch(command) {
  if (typeof command !== 'string' || command.includes('\0')) return null;
  const lines = command.trim().split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch' || lines[lines.length - 1] !== '*** End Patch') return null;
  const files = [];
  let current = null;
  let chunk = null;
  const validUpdate = () => !current || current.kind !== 'Update' || (
    current.chunks.length > 0 && chunk && (chunk.before.length > 0 || chunk.after.length > 0)
  );

  for (const line of lines.slice(1, -1)) {
    const header = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (header) {
      if (!validUpdate()) return null;
      current = { kind: header[1], file: header[2], chunks: [], added: [] };
      files.push(current);
      chunk = null;
      continue;
    }
    if (!current) return null;
    if (current.kind === 'Add') {
      if (!line.startsWith('+')) return null;
      current.added.push(line.slice(1));
      continue;
    }
    if (current.kind === 'Delete') return null;
    if (line.startsWith('*** Move to: ') && !chunk && !current.move) {
      current.move = line.slice('*** Move to: '.length);
      continue;
    }
    if (line === '@@' || line.startsWith('@@ ')) {
      if (chunk && !chunk.before.length && !chunk.after.length) return null;
      chunk = { anchor: line === '@@' ? null : line.slice(3), before: [], after: [], eof: false };
      current.chunks.push(chunk);
      continue;
    }
    if (chunk && chunk.eof) {
      if (!line.trim()) continue;
      return null;
    }
    if (line === '*** End of File') {
      if (!chunk || (!chunk.before.length && !chunk.after.length)) return null;
      chunk.eof = true;
      continue;
    }
    if (line !== '' && !/^[ +\-]/.test(line)) return null;
    if (!chunk) {
      chunk = { anchor: null, before: [], after: [], eof: false };
      current.chunks.push(chunk);
    }
    const marker = line[0] || ' ';
    const text = line.slice(1);
    if (marker !== '+') chunk.before.push(text);
    if (marker !== '-') chunk.after.push(text);
  }
  return validUpdate() ? files : null;
}

// A unique exact match is evidence that the preview refers to the intended
// lines. Codex also accepts fuzzy matches; these stay silent here.
function locate(lines, expected, start, eof) {
  let found = -1;
  const first = eof ? lines.length - expected.length : start;
  for (let i = Math.max(start, first); i <= lines.length - expected.length; i++) {
    if (eof && i !== first) break;
    if (expected.every((line, offset) => line === lines[i + offset])) {
      if (found !== -1) return null;
      found = i;
    }
  }
  return found === -1 ? null : found;
}

function previewUpdate(existing, chunks) {
  if (typeof existing !== 'string' || /\0|\uFFFD|\r(?!\n)/.test(existing)) return null;
  // Line ending bytes do not change dependency names. Use a logical LF view
  // for both CRLF and LF files, without ever writing it back to disk.
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const replacements = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null) {
      const anchor = locate(lines, [chunk.anchor], cursor, false);
      if (anchor === null) return null;
      cursor = anchor + 1;
    }
    let before = chunk.before;
    let after = chunk.after;
    // Codex's addition-only chunks append at the end, including when an
    // @@ anchor was supplied; they are not insertions after that anchor.
    let at = before.length ? locate(lines, before, cursor, chunk.eof) : lines.length;
    if (at === null && before[before.length - 1] === '') {
      before = before.slice(0, -1);
      if (after[after.length - 1] === '') after = after.slice(0, -1);
      if (!before.length) return null;
      at = locate(lines, before, cursor, chunk.eof);
    }
    if (at === null) return null;
    replacements.push({ at, length: before.length, after });
    cursor = at + before.length;
  }
  // Resolve chunks against the original file, then rebuild once; later @@
  // contexts must never accidentally match text inserted by an earlier one.
  const result = [];
  let copied = 0;
  for (const replacement of replacements) {
    if (replacement.at < copied) return null;
    result.push(...lines.slice(copied, replacement.at), ...replacement.after);
    copied = replacement.at + replacement.length;
  }
  result.push(...lines.slice(copied));
  return result.length ? result.join('\n') + '\n' : '';
}

function resolveFile(file, cwd) {
  if (!file || file !== file.trim() || /\0|[\r\n]/.test(file)) return null;
  // URI/remote targets have no trustworthy local baseline. Drive letters
  // remain ordinary native Windows paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return null;
  return path.resolve(cwd, file);
}

// Existing path components must describe a possible file target. A missing
// parent directory is fine; a file standing in for a directory is not.
function isFileTarget(file) {
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) return false;
  let parent = path.dirname(file);
  while (!fs.existsSync(parent)) {
    const next = path.dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  return fs.statSync(parent).isDirectory();
}

function pathKey(file) {
  return process.platform === 'win32' ? file.toLowerCase() : file;
}

// Import extraction keeps the original source as its baseline, while the
// existing gate needs the destination path for declared deps, local Python
// modules and test exemptions. These are in-memory gate inputs, not edits.
function moveViews(data, destination, existing, resulting) {
  const eco = ecosystemOf(destination);
  const roots = eco ? newImports(eco, resulting, existing, []) : [];
  const imports = roots.map((root) => eco === 'node'
    ? 'require(' + JSON.stringify(root) + ');'
    : 'import ' + root).join('\n');
  return {
    manifest: {
      ...data, tool_name: 'Write',
      tool_input: { file_path: destination, content: resulting },
    },
    import: {
      ...data, tool_name: 'Edit',
      tool_input: { file_path: destination, old_string: '', new_string: imports },
    },
  };
}

function toToolCalls(data) {
  if (!data || data.tool_name !== 'apply_patch') return data ? [data] : [];
  const files = parsePatch(data.tool_input && data.tool_input.command);
  if (!files) return [];
  const cwd = typeof data.cwd === 'string' && data.cwd ? data.cwd : process.cwd();
  const occupied = new Set();
  const calls = [];
  try {
    for (const file of files) {
      const source = resolveFile(file.file, cwd);
      const destination = file.move ? resolveFile(file.move, cwd) : null;
      if (!source || (file.move && (!destination || !isFileTarget(destination)))) return [];
      for (const target of [source, destination].filter(Boolean)) {
        const key = pathKey(target);
        if (occupied.has(key)) return [];
        occupied.add(key);
      }
      if (file.kind === 'Delete') {
        if (!fs.statSync(source).isFile()) return [];
        continue;
      }
      if (file.kind === 'Add') {
        if (!isFileTarget(source)) return [];
        calls.push({
          ...data,
          tool_name: 'Write',
          razor_gate_views: null,
          tool_input: { file_path: source, content: file.added.length ? file.added.join('\n') + '\n' : '' },
        });
        continue;
      }
      if (!fs.statSync(source).isFile()) return [];
      const existing = fs.readFileSync(source, 'utf8');
      const resulting = previewUpdate(existing, file.chunks);
      if (resulting === null) return [];
      // An empty old_string is invalid to the existing Edit simulator. A
      // Write preview to the existing source handles an empty manifest and
      // still cannot count as a new file.
      calls.push({
        ...data,
        tool_name: existing ? 'Edit' : 'Write',
        tool_input: existing
          ? { file_path: source, old_string: existing, new_string: resulting }
          : { file_path: source, content: resulting },
        razor_gate_views: destination ? moveViews(data, destination, existing, resulting) : null,
      });
    }
  } catch {
    return []; // The complete patch must be previewable before any gate books it.
  }
  return calls;
}

function nativeReason(reason) {
  if (!reason) return reason;
  return reason
    .replace(/this (Write|Edit)\b/g, 'this apply_patch')
    .replace(/exact same (Write|Edit)\b/g, 'exact same apply_patch');
}

module.exports = { toToolCalls, nativeReason, parsePatch, previewUpdate, pathKey };
