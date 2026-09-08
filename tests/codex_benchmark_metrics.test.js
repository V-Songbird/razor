'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseEvents, scoreCell, summarize } = require('../benchmarks/runner/codex-metrics.js');
const { RAZOR_TASKS } = require('../benchmarks/runner/tasks.js');
const { codeStats, gitSnapshot, gitDiffStats } = require('../benchmarks/runner/metrics.js');

const jsonl = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
function fixture(t, taskId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-codex-metrics-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('razor-codex-metrics-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  if (taskId) {
    for (const [name, source] of Object.entries(RAZOR_TASKS[taskId].seed || {})) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), source);
    }
  }
  return dir;
}

test('native events retain final text, deduplicate commands, and use the last cumulative usage', () => {
  const parsed = parseEvents(jsonl(
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'node check.js', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'node check.js', status: 'completed', exit_code: 0 } },
    { type: 'item.completed', item: { id: 'msg-1', type: 'agent_message', text: 'First response' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 30, reasoning_output_tokens: 20 } },
    { type: 'item.completed', item: { id: 'msg-2', type: 'agent_message', text: '12' } },
    { type: 'turn.completed', usage: { input_tokens: 130, cached_input_tokens: 60, output_tokens: 40, output_tokens_details: { reasoning_tokens: 25 } } },
  ));
  assert.equal(parsed.threadId, 'thread-1');
  assert.equal(parsed.lastMessage, '12');
  assert.equal(parsed.completedTurns, 2);
  assert.deepEqual(parsed.usage, { input_tokens: 130, cached_input_tokens: 60, output_tokens: 40, reasoning_output_tokens: 25 });
  assert.equal(parsed.commands.length, 1);
  assert.equal(parsed.commands[0].exit_code, 0);
  assert.deepEqual(parsed.errors, []);
});

test('counts absent from the latest cumulative snapshot stay unknown despite earlier measurements', () => {
  const empty = parseEvents(' \r\n');
  assert.equal(empty.completedTurns, 0);
  assert.equal(empty.lastMessage, null);
  assert.deepEqual(empty.usage, { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null });
  const parsed = parseEvents(jsonl(
    { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0 } },
    { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 10 } },
  ));
  assert.deepEqual(parsed.usage, { input_tokens: 30, cached_input_tokens: null, output_tokens: 10, reasoning_output_tokens: null });
});

test('errors and interrupted commands remain visible without an invented completed turn', () => {
  const parsed = parseEvents(jsonl(
    { type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'node work.js', status: 'in_progress' } },
    { type: 'error', message: 'Connection closed' },
    { type: 'turn.failed', error: { message: 'Rate limit reached' } },
  ));
  assert.equal(parsed.completedTurns, 0);
  assert.deepEqual(parsed.errors, ['Connection closed', 'Rate limit reached']);
  assert.equal(parsed.commands[0].status, 'in_progress');
});

test('malformed or truncated events fail clearly even after a completed turn', () => {
  assert.throws(() => parseEvents('{"type":"turn.completed"}\n{"secret":"unterminated'), /Malformed Codex JSONL at line 2; stream may be incomplete/);
  assert.throws(() => parseEvents('null'), /Invalid Codex event at JSONL line 1/);
  assert.throws(() => parseEvents(jsonl({ type: 'turn.completed', usage: { input_tokens: -1 } })), /Invalid Codex input_tokens/);
  assert.throws(() => parseEvents(jsonl({ type: 'thread.started' })), /Missing Codex thread_id/);
  assert.throws(() => parseEvents(jsonl({ type: 'thread.started', thread_id: 'a' }, { type: 'thread.started', thread_id: 'b' })), /Multiple Codex threads/);
});

test('native response scoring uses only disposable compatibility JSON and meta LOC is zero', async (t) => {
  const dir = fixture(t, 'oh-question');
  const score = await scoreCell('oh-question', dir, [{ lastMessage: '12' }]);
  assert.equal(score.correct, 1);
  assert.equal(score.safe, 1);
  assert.equal(score.total_loc, 0);
  assert.equal(score.files, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '_claude.json'), 'utf8')), { result: '12' });
  assert.equal(fs.existsSync(path.join(dir, '_claude.stream.jsonl')), false);
});

test('multi-turn note scorers retain original drift and false-alarm verdicts', async (t) => {
  const dir = fixture(t, 'note-drift');
  const turns = JSON.parse(RAZOR_TASKS['note-drift'].good).map(({ final }) => ({ lastMessage: final }));
  const drift = await scoreCell('note-drift', dir, turns);
  assert.equal(drift.correct, 1);
  assert.equal(drift.safe, 1);
  const steady = await scoreCell('note-steady', dir, turns);
  assert.equal(steady.correct, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '_finals.json'), 'utf8')), turns.map((turn) => ({ final: turn.lastMessage })));
});

test('source and self-check LOC are measured before scorer mutations', async (t) => {
  const dir = fixture(t, 'reuse-scan');
  const task = RAZOR_TASKS['reuse-scan'];
  fs.writeFileSync(path.join(dir, task.file), task.good + '\nif (require.main === module) {\n console.log("selfcheck");\n}\n');
  fs.writeFileSync(path.join(dir, '_instrument.js'), 'throw new Error("not delivered");\n');
  fs.writeFileSync(path.join(dir, '_pkgmgr.log'), 'npm install left-pad\nnpm test\n');
  const expected = codeStats(dir, true);
  const original = task.score;
  task.score = async () => {
    fs.writeFileSync(path.join(dir, 'scorer-fixture.js'), 'module.exports = 1;\n');
    fs.appendFileSync(path.join(dir, '_pkgmgr.log'), 'npm install scorer-only\n');
    return { correct: 1, safe: 1, reason: 'fixture' };
  };
  try {
    const scored = await scoreCell('reuse-scan', dir, []);
    for (const [field, value] of Object.entries(expected)) assert.equal(scored[field], value, field);
    assert.ok(scored.test_loc > 0);
    assert.equal(scored.install_attempts, 1);
    assert.ok(codeStats(dir, true).files > scored.files);
    assert.ok(scored.behavior.changed_source_files.includes(task.file));
    assert.equal(scored.behavior.added_source_files.includes('scorer-fixture.js'), false);
    assert.equal(scored.behavior.added_source_files.includes('_instrument.js'), false);
    assert.equal(scored.behavior.primary.present, true);
  } finally { task.score = original; }
});

test('git task LOC uses seeded diff and real dotenv scorer remains compatible', async (t) => {
  const dir = fixture(t, 'dep-dotenv');
  const task = RAZOR_TASKS['dep-dotenv'];
  gitSnapshot(dir);
  fs.writeFileSync(path.join(dir, task.file), task.good);
  const expected = gitDiffStats(dir);
  const scored = await scoreCell('dep-dotenv', dir, []);
  assert.equal(scored.correct, 1, scored.reason);
  assert.equal(scored.safe, 1, scored.reason);
  assert.equal(scored.total_loc, expected.total_loc);
  assert.equal(scored.new_files, 0);
  assert.equal(scored.install_attempts, 0);
});

test('summaries exclude runtime failures, preserve unknowns, and never add cached tokens twice', () => {
  const groups = summarize([
    { model: 'codex', arm: 'baseline', status: 'completed', correct: 1, safe: 1, elapsed_ms: 100, total_loc: 0,
      usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 10, reasoning_output_tokens: null } },
    { model: 'codex', arm: 'baseline', status: 'completed', correct: 0, safe: 1, elapsed_ms: 200, total_loc: 10,
      usage: { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 } },
    { model: 'codex', arm: 'baseline', status: 'runtime_error', correct: 0, safe: 0, elapsed_ms: 9000,
      total_loc: 999, usage: { input_tokens: 9999, output_tokens: 9999 } },
    { model: 'codex', arm: 'razor', status: 'runtime_error' },
  ]);
  assert.equal(groups.length, 2);
  const baseline = groups[0];
  assert.equal(baseline.total, 3);
  assert.equal(baseline.valid, 2);
  assert.equal(baseline.runtime_failures, 1);
  assert.equal(baseline.task_failures, 1);
  assert.equal(baseline.correctness_rate, 0.5);
  assert.equal(baseline.safety_rate, 1);
  assert.equal(baseline.elapsed_ms_sum, 300);
  assert.equal(baseline.elapsed_ms_mean, 150);
  assert.equal(baseline.total_tokens_sum, 330);
  assert.equal(baseline.total_loc_mean, 5);
  assert.equal(baseline.reasoning_output_tokens_sum, null);
  assert.equal(baseline.reasoning_output_tokens_observed, 0);
  assert.equal(groups[1].correctness_rate, null);
  assert.equal(groups[1].total_tokens_sum, null);
});
test('paired fingerprints distinguish textual changes without retaining generated source', async (t) => {
  const left = fixture(t, 'oh-typo');
  const right = fixture(t, 'oh-typo');
  fs.writeFileSync(path.join(left, 'main.js'), 'console.log("Hello, world");\n');
  fs.writeFileSync(path.join(right, 'main.js'), 'console.log( "Hello, world" );\n');
  const a = (await scoreCell('oh-typo', left, [])).behavior;
  const b = (await scoreCell('oh-typo', right, [])).behavior;
  assert.notEqual(a.primary.sha256, b.primary.sha256);
  assert.equal(a.primary.whitespace_stripped_sha256, b.primary.whitespace_stripped_sha256);
  assert.equal(a.primary.fingerprint_kind, 'textual_only');
  assert.deepEqual(a.changed_source_files, ['main.js']);
  assert.equal(JSON.stringify(a).includes('Hello, world'), false);
  fs.writeFileSync(path.join(right, 'main.js'), 'console.log("Hello, universe");\n');
  const changed = (await scoreCell('oh-typo', right, [])).behavior;
  assert.notEqual(a.primary.whitespace_stripped_sha256, changed.primary.whitespace_stripped_sha256);
  fs.unlinkSync(path.join(right, 'main.js'));
  const removed = (await scoreCell('oh-typo', right, [])).behavior;
  assert.deepEqual(removed.removed_source_files, ['main.js']);
  assert.equal(removed.primary.present, false);
  assert.equal(removed.primary.sha256, null);
});

test('behavior identifies API markers and additions across every dependency section', async (t) => {
  const dir = fixture(t, 'oh-typo');
  fs.writeFileSync(path.join(dir, 'extra.js'), "const axios = require('axios');\nmodule.exports = (q) => Object.fromEntries(new URLSearchParams(q));\n");
  fs.writeFileSync(path.join(dir, 'extra.test.js'), "require('test-only-dep');\n");
  fs.writeFileSync(path.join(dir, '_instrument.js'), "require('instrument-only-dep');\n");
  const manifest = {
    dependencies: { axios: '1' }, devDependencies: { testkit: '2' },
    optionalDependencies: { optional: '3' }, peerDependencies: { peer: '4' },
    bundledDependencies: ['bundled'], bundleDependencies: ['bundle-alias'],
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const behavior = (await scoreCell('oh-typo', dir, [])).behavior;
  assert.deepEqual(behavior.added_source_files, ['extra.js']);
  assert.deepEqual(behavior.api_markers, ['URLSearchParams', 'Object.fromEntries']);
  assert.deepEqual(behavior.new_import_dependencies, ['axios']);
  assert.equal(behavior.added_manifest_dependency_count, 6);
  assert.equal(behavior.manifest_status, 'parsed');
  assert.deepEqual(new Set(behavior.added_manifest_dependencies.map((dep) => dep.section)), new Set(Object.keys(manifest)));
  fs.writeFileSync(path.join(dir, 'package.json'), '{');
  const unknown = (await scoreCell('oh-typo', dir, [])).behavior;
  assert.equal(unknown.manifest_status, 'unparseable');
  assert.equal(unknown.added_manifest_dependency_count, null);
});

test('seeded approved imports and manifest dependencies are not reported as additions', async (t) => {
  const dir = fixture(t, 'need-installed-dep');
  const task = RAZOR_TASKS['need-installed-dep'];
  fs.writeFileSync(path.join(dir, task.file), task.good);
  const scored = await scoreCell('need-installed-dep', dir, []);
  assert.equal(scored.correct, 1, scored.reason);
  assert.deepEqual(scored.behavior.new_import_dependencies, []);
  assert.deepEqual(scored.behavior.added_manifest_dependencies, []);
  assert.deepEqual(scored.behavior.changed_source_files, ['titles.js']);
});
test('an entirely missing last usage snapshot does not reuse older thread counts', () => {
  const parsed = parseEvents(jsonl(
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 5 } },
    { type: 'turn.completed' },
  ));
  assert.equal(parsed.completedTurns, 2);
  assert.deepEqual(parsed.usage, { input_tokens: null, cached_input_tokens: null, output_tokens: null, reasoning_output_tokens: null });
});

test('latest complete snapshot supplies previously missing metrics and survives later failed turns', () => {
  const parsed = parseEvents(jsonl(
    { type: 'turn.completed' },
    { type: 'turn.completed', usage: { input_tokens: 130, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 } },
    { type: 'turn.failed', error: { message: 'Later turn failed' } },
  ));
  assert.deepEqual(parsed.usage, { input_tokens: 130, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0 });
  assert.equal(parsed.completedTurns, 2);
  assert.deepEqual(parsed.errors, ['Later turn failed']);
});
test('note scoring reads visible file-link labels and does not mistake fixture paths for drift', async (t) => {
  const dir = fixture(t, 'note-drift');
  const turns = [
    { lastMessage: String.raw`Added bytes in [formatters.js](D:\bench\note-drift-baseline-0\project\formatters.js).` },
    { lastMessage: 'Added parseCsv in [csv.js](<D:/bench/note-drift-baseline-0/project (copy)/csv.js>).' },
  ];
  const baseline = await scoreCell('note-drift', dir, turns);
  assert.equal(baseline.correct, 0, baseline.reason);
  assert.equal(baseline.safe, 1, baseline.reason);
  const finals = JSON.parse(fs.readFileSync(path.join(dir, '_finals.json'), 'utf8'));
  assert.deepEqual(finals, [{ final: 'Added bytes in formatters.js.' }, { final: 'Added parseCsv in csv.js.' }]);
  const steady = await scoreCell('note-steady', dir, turns);
  assert.equal(steady.correct, 1, steady.reason);
  assert.equal(steady.safe, 1, steady.reason);
});

test('rendered note scoring preserves the real second-turn Razor note after normalizing file links', async (t) => {
  const dir = fixture(t, 'note-drift');
  const turns = [
    { lastMessage: String.raw`Added bytes in [formatters.js](D:\bench\note-drift-razor-0\project\formatters.js).` },
    { lastMessage: 'Created [csv.js](/tmp/note-drift-razor-0/project/csv.js).\n\nThis session has moved off its original task; a fresh session would keep this one focused.' },
  ];
  const razor = await scoreCell('note-drift', dir, turns);
  assert.equal(razor.correct, 1, razor.reason);
  assert.equal(razor.safe, 1, razor.reason);
  const finals = JSON.parse(fs.readFileSync(path.join(dir, '_finals.json'), 'utf8'));
  assert.match(finals[1].final, /fresh session/);
  assert.equal(finals[1].final.includes('note-drift-razor-0'), false);
});

test('visible drift labels and narrative remain observable to the unchanged scorer', async (t) => {
  const dir = fixture(t, 'note-drift');
  const scored = await scoreCell('note-drift', dir, [
    { lastMessage: 'See [drift warning](D:/bench/note-drift/project/formatters.js).' },
    { lastMessage: 'Created csv.js. This has drifted outside the original task.' },
  ]);
  assert.equal(scored.correct, 1, scored.reason);
  assert.equal(scored.safe, 0, scored.reason);
});