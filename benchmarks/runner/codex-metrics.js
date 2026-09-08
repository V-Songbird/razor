'use strict';

// Native codex exec JSONL and the unchanged benchmark's scoring instruments.
// Parser results are transient: durable reports should store scores and counts,
// never commands, model messages, or raw session events.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RAZOR_TASKS, JS_ALLOWED } = require('./tasks.js');
const { CODE_EXT, isTest, codeStats, gitDiffStats, gitNewFiles, selfcheckSplit, pkgAddAttempts, jsNewDeps } = require('./metrics.js');

const TOKEN_FIELDS = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
const STAT_FIELDS = ['files', 'src_files', 'total_loc', 'src_loc', 'test_files', 'test_loc', 'new_files'];

function tokenCount(value, field, line) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid Codex ${field} at JSONL line ${line}`);
  }
  return value;
}

function parseEvents(rawJSONL) {
  if (typeof rawJSONL !== 'string') throw new TypeError('Codex JSONL must be a string');
  const parsed = {
    threadId: null, lastMessage: null,
    usage: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, null])),
    commands: [], errors: [], completedTurns: 0,
  };
  let lastUsage = null;
  const commands = new Map();
  for (const [index, raw] of rawJSONL.split(/\r?\n/).entries()) {
    if (!raw.trim()) continue;
    const line = index + 1;
    let event;
    try { event = JSON.parse(raw); }
    catch { throw new Error(`Malformed Codex JSONL at line ${line}; stream may be incomplete`); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new Error(`Invalid Codex event at JSONL line ${line}`);
    }
    if (event.type === 'thread.started') {
      if (typeof event.thread_id !== 'string' || !event.thread_id) {
        throw new Error(`Missing Codex thread_id at JSONL line ${line}`);
      }
      if (parsed.threadId !== null && parsed.threadId !== event.thread_id) {
        throw new Error(`Multiple Codex threads in one JSONL stream at line ${line}`);
      }
      parsed.threadId = event.thread_id;
    } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (typeof event.item.text !== 'string') throw new Error(`Invalid Codex agent message at JSONL line ${line}`);
      parsed.lastMessage = event.item.text;
    } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type)
        && event.item?.type === 'command_execution') {
      // Keep the last version of an item, including a command interrupted before
      // completion. Codex emits started/updated/completed with the same item id.
      const item = event.item;
      commands.set(item.id ?? `line-${line}`, { ...item });
    } else if (event.type === 'turn.completed') {
      const usage = event.usage || {};
      const counts = {};
      for (const field of TOKEN_FIELDS) {
        const value = field === 'reasoning_output_tokens'
          ? usage[field] ?? usage.output_tokens_details?.reasoning_tokens
          : usage[field];
        counts[field] = tokenCount(value, field, line);
      }
      lastUsage = counts;
      parsed.completedTurns++;
    } else if (event.type === 'error' || event.type === 'turn.failed') {
      parsed.errors.push(event.message || event.error?.message || `Codex ${event.type}`);
    }
  }
  parsed.commands = [...commands.values()];
  // Native turn.completed emits cumulative thread totals, including restored
  // usage after resume. Summing snapshots double-counts earlier turns. The last
  // successful snapshot is authoritative; missing latest counts stay unknown.
  if (lastUsage !== null) parsed.usage = lastUsage;
  return parsed;
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  'bundledDependencies', 'bundleDependencies'];
const API_PATTERNS = [
  ['URLSearchParams', /\bURLSearchParams\b/], ['randomUUID', /\brandomUUID\s*\(/],
  ['fetch', /\bfetch\s*\(/], ['JSON.parse', /\bJSON\s*\.\s*parse\s*\(/],
  ['JSON.stringify', /\bJSON\s*\.\s*stringify\s*\(/],
  ['http.request', /\bhttp\s*\.\s*request\s*\(/], ['https.request', /\bhttps\s*\.\s*request\s*\(/],
  ['http.get', /\bhttp\s*\.\s*get\s*\(/], ['https.get', /\bhttps\s*\.\s*get\s*\(/],
  ['readFileSync', /\breadFileSync\s*\(/], ['writeFileSync', /\bwriteFileSync\s*\(/],
  ['setTimeout', /\bsetTimeout\s*\(/], ['Object.fromEntries', /\bObject\s*\.\s*fromEntries\s*\(/],
];

function sourceFile(name) {
  return CODE_EXT.has(path.extname(name)) && !isTest(name)
    && !name.split('/').some((part) => part.startsWith('.') || part.startsWith('_') || part === 'node_modules');
}

function sourceContents(workdir, dir = workdir, contents = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name.startsWith('_') || entry.name === 'node_modules') continue;
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceContents(workdir, filename, contents);
    else if (entry.isFile()) {
      const relative = path.relative(workdir, filename).replace(/\\/g, '/');
      if (sourceFile(relative)) contents.set(relative, fs.readFileSync(filename, 'utf8'));
    }
  }
  return contents;
}

function manifestEntries(raw) {
  const manifest = JSON.parse(raw);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('Invalid package manifest');
  return DEP_SECTIONS.flatMap((section) => {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') return [];
    return Array.isArray(deps)
      ? deps.map((name) => ({ section, name, version: null }))
      : Object.entries(deps).map(([name, version]) => ({ section, name, version }));
  });
}

function editBehavior(task, workdir) {
  const before = new Map(Object.entries(task.seed || {}).filter(([name]) => sourceFile(name)));
  const after = sourceContents(workdir);
  const changed = [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)).sort();
  const added = [...after.keys()].filter((name) => !before.has(name)).sort();
  const removed = [...before.keys()].filter((name) => !after.has(name)).sort();
  const primaryName = task.file && sourceFile(task.file) ? task.file : null;
  const primaryText = primaryName === null ? null : after.get(primaryName);
  const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
  // These are textual fingerprints only. Removing whitespace also changes
  // strings, templates, and significant separators; equality is NOT semantic.
  const primary = primaryName === null ? null : {
    path: primaryName, present: primaryText !== undefined, fingerprint_kind: 'textual_only',
    sha256: primaryText === undefined ? null : hash(primaryText),
    whitespace_stripped_sha256: primaryText === undefined ? null : hash(primaryText.replace(/\s+/g, '')),
  };
  const editedText = [...changed, ...added].map((name) => after.get(name)).join('\n');
  const seededDeps = manifestEntries(task.seed?.['package.json'] || '{}');
  const seededKeys = new Set(seededDeps.map(({ section, name }) => `${section}:${name}`));
  const manifestPath = path.join(workdir, 'package.json');
  let manifestStatus = 'absent';
  let addedDeps = [];
  if (fs.existsSync(manifestPath)) {
    try {
      addedDeps = manifestEntries(fs.readFileSync(manifestPath, 'utf8'))
        .filter(({ section, name }) => !seededKeys.has(`${section}:${name}`))
        .sort((a, b) => `${a.section}:${a.name}`.localeCompare(`${b.section}:${b.name}`));
      manifestStatus = 'parsed';
    } catch { manifestStatus = 'unparseable'; addedDeps = null; }
  }
  return {
    changed_source_files: changed, added_source_files: added, removed_source_files: removed,
    primary,
    // Lexical markers are evidence for inspection, not proof of an API call.
    api_markers: API_PATTERNS.filter(([, pattern]) => pattern.test(editedText)).map(([name]) => name),
    new_import_dependencies: jsNewDeps(workdir, new Set([...JS_ALLOWED, ...seededDeps.map(({ name }) => name)])),
    manifest_status: manifestStatus,
    added_manifest_dependencies: addedDeps,
    added_manifest_dependency_count: addedDeps === null ? null : addedDeps.length,
  };
}

function renderedFinalText(text) {
  // Score the visible prose in native Codex Markdown file links. Disposable
  // absolute destinations can contain task ids such as note-drift, which are
  // not a note the user sees. Keep labels and all narrative wording unchanged.
  return text.replace(/(?<!!)\[([^\]\r\n]*)\]\((?:<(?:[A-Za-z]:[\\/]|\/|file:\/\/)[^>\r\n]*>|(?:[A-Za-z]:[\\/]|\/|file:\/\/)(?:[^()\r\n]|\([^()\r\n]*\))*)\)/gi, '$1');
}

async function scoreCell(taskId, workdir, turns) {
  const task = RAZOR_TASKS[taskId];
  if (!task) throw new Error(`Unknown benchmark task: ${taskId}`);
  if (!Array.isArray(turns)) throw new TypeError('Codex score turns must be an array');
  let stats;
  if (task.meta) {
    stats = Object.fromEntries(STAT_FIELDS.map((field) => [field, 0]));
  } else if (task.git) {
    stats = gitDiffStats(workdir);
    stats.new_files = gitNewFiles(workdir);
    if (task.file) {
      try {
        const { scTotal, scRaw } = selfcheckSplit(fs.readFileSync(path.join(workdir, task.file), 'utf8'));
        if (scRaw) {
          stats.total_loc = Math.max(0, stats.total_loc - scRaw);
          stats.src_loc = Math.max(0, stats.src_loc - scRaw);
          stats.test_loc += scTotal;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // The original task scorer owns the missing-primary-file verdict.
      }
    }
  } else {
    stats = codeStats(workdir, true);
    stats.new_files = stats.src_files || 0;
  }
  const install_attempts = pkgAddAttempts(workdir).length;
  const behavior = editBehavior(task, workdir);
  // These legacy filenames are scorer compatibility fixtures, not Claude
  // sessions. They contain only the required JSON in the disposable project.
  // Measure files before scorers can create fixtures or modify the workspace.
  if (taskId === 'oh-question') {
    fs.writeFileSync(path.join(workdir, '_claude.json'), JSON.stringify({ result: turns.at(-1)?.lastMessage ?? '' }));
  }
  if (task.note) {
    fs.writeFileSync(path.join(workdir, '_finals.json'), JSON.stringify(turns.map((turn) => ({ final: renderedFinalText(turn.lastMessage ?? '') }))));
  }
  const verdict = await task.score(workdir);
  return { ...verdict, ...stats, install_attempts, behavior };
}

function summarize(records) {
  const groups = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.model, record.effort, record.arm]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map((rows) => {
    const completed = rows.filter((row) => row.status === 'completed');
    const valid = completed.filter((row) => [0, 1].includes(row.correct) && [0, 1].includes(row.safe));
    const correct = valid.filter((row) => row.correct === 1).length;
    const safe = valid.filter((row) => row.safe === 1).length;
    const summary = {
      model: rows[0].model, effort: rows[0].effort ?? null, arm: rows[0].arm, total: rows.length,
      completed: completed.length, valid: valid.length,
      runtime_failures: rows.length - completed.length,
      invalid_scores: completed.length - valid.length,
      task_failures: valid.filter((row) => row.correct !== 1 || row.safe !== 1).length,
      correctness_failures: valid.length - correct, safety_failures: valid.length - safe,
      correct, safe,
      correctness_rate: valid.length ? correct / valid.length : null,
      safety_rate: valid.length ? safe / valid.length : null,
    };
    const metrics = ['elapsed_ms', ...TOKEN_FIELDS, 'total_tokens', ...STAT_FIELDS, 'install_attempts'];
    for (const metric of metrics) {
      const values = valid.map((row) => {
        if (metric === 'total_tokens') {
          const usage = row.usage || {};
          return Number.isFinite(usage.input_tokens) && Number.isFinite(usage.output_tokens)
            ? usage.input_tokens + usage.output_tokens : null;
        }
        return TOKEN_FIELDS.includes(metric) ? row.usage?.[metric] : row[metric];
      }).filter((value) => Number.isFinite(value) && value >= 0);
      summary[`${metric}_observed`] = values.length;
      summary[`${metric}_sum`] = values.length ? values.reduce((sum, value) => sum + value, 0) : null;
      summary[`${metric}_mean`] = values.length ? summary[`${metric}_sum`] / values.length : null;
    }
    return summary;
  });
}

module.exports = { parseEvents, scoreCell, summarize };
