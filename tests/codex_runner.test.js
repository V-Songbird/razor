'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { options, selectTasks, contained, removeOwned, buildArgs, reportText, sumUsage, loadResume, checkpoint } = require('../benchmarks/runner/codex-run');
const { RAZOR_TASKS } = require('../benchmarks/runner/tasks');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'razor-codex-runner-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('razor-codex-runner-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('native runner accepts explicit paired model settings and refuses unknown live-run flags', () => {
  const config = options(['--model', 'gpt-5.6-sol', '--effort', 'high', '--runs', '2', '--workers', '3', '--timeout', '60']);
  assert.equal(config.model, 'gpt-5.6-sol');
  assert.equal(config.effort, 'high');
  assert.equal(config.runs, 2);
  assert.equal(config.workers, 3);
  assert.equal(config.timeout, 60000);
  for (const flag of ['--dry-run', '--rescore', '--models', '--not-a-flag', '-m', 'unexpected-position']) {
    assert.throws(() => options([flag]), /Unknown flag:/);
  }
  for (const flag of ['--model', '--effort', '--runs', '--report']) {
    assert.throws(() => options([flag]), /Missing value:/);
    assert.throws(() => options([flag, '--probe']), /Missing value:/);
  }
  for (const args of [['--runs', '0'], ['--runs', '11'], ['--workers', '5'], ['--workers', '1.5'],
    ['--timeout', '0'], ['--timeout', '1801'], ['--effort', 'unknown'], ['--suite', 'unknown']]) {
    assert.throws(() => options(args), /Invalid/);
  }
});

test('resumed native usage uses the last cumulative snapshot, not the sum', () => {
  const turns = [
    { completedTurns: 1, usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } },
    { completedTurns: 1, usage: { input_tokens: 130, cached_input_tokens: 80, output_tokens: 15 } },
  ];
  assert.deepEqual(sumUsage(turns), { input_tokens: 130, cached_input_tokens: 80, output_tokens: 15, reasoning_output_tokens: null });
  turns.push({ completedTurns: 0, usage: {} });
  assert.equal(sumUsage(turns).input_tokens, 130);
});

test('durable resume validates model settings and unique completed cell identities', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'checkpoint.json');
  const config = options(['--model','gpt-5.6-sol','--effort','high','--runs','2','--resume-report',file]);
  const record = {model:config.model,effort:config.effort,task:'dep-slug',arm:'razor',repetition:0,status:'completed',correct:1,safe:1,reason:'discard this output'};
  const report = {model:config.model,effort:config.effort,seed:config.seed,runs:config.runs,records:[record]};
  checkpoint(file, report);
  assert.equal(loadResume(config).records.length,1);
  assert.equal(fs.readFileSync(file,'utf8').includes('discard this output'),false);
  assert.equal(fs.existsSync(file+'.tmp'),false);
  checkpoint(file, {...report, model:'different-model'});
  assert.throws(()=>loadResume(config),/configuration mismatch/);
  checkpoint(file, {...report, records:[record,record]});
  assert.throws(()=>loadResume(config),/Duplicate resume cell/);
  checkpoint(file, {...report, records:[{...record,task:'constructor'}]});
  assert.throws(()=>loadResume(config),/Invalid resume cell/);
  checkpoint(file, {...report, records:[{...record,effort:'low'}]});
  assert.throws(()=>loadResume(config),/Invalid resume cell/);
  const current = {runtime:'codex-cli 0.153.4',source:'fixed-source',instrument_hashes:{runner:'a',plugin_runtime:'b'}};
  checkpoint(file, {...report,...current});
  assert.equal(loadResume(config,current).records.length,1);
  for (const changed of [{runtime:'different-runtime'}, {source:'different-source'}, {instrument_hashes:{runner:'a',plugin_runtime:'changed'}}]) {
    checkpoint(file, {...report,...current,...changed});
    assert.throws(()=>loadResume(config,current),/Incompatible resume provenance/);
  }
});

test('task selection keeps original suite boundaries and rejects unknown fixture paths', () => {
  for (const suite of ['full', 'counter', 'note']) {
    const ids = selectTasks(options(['--suite', suite]));
    assert.ok(ids.length > 0);
    for (const id of ids) {
      const task = RAZOR_TASKS[id];
      assert.equal(task.note ? 'note' : task.counter ? 'counter' : 'full', suite);
    }
  }
  assert.deepEqual(selectTasks(options(['--tasks', 'oh-question'])), ['oh-question']);
  assert.throws(() => selectTasks(options(['--tasks', '../outside'])), /Unknown or empty task selection/);
});

test('both arms receive the same model, effort, sandbox and task instruction', () => {
  const config = options(['--model', 'gpt-5.6-sol', '--effort', 'high']);
  const root = path.join(os.tmpdir(), 'codex-args-only');
  const baseline = buildArgs(config, 'baseline', root, {});
  const razor = buildArgs(config, 'razor', root, {});
  const removeHookFlags = (args) => args.filter((value, index) => {
    if (value === '--dangerously-bypass-hook-trust' || value === 'hooks') return false;
    return !(['--enable', '--disable'].includes(value) && args[index + 1] === 'hooks');
  });
  assert.deepEqual(removeHookFlags(baseline), removeHookFlags(razor));
  assert.equal(razor[razor.indexOf('-m') + 1], 'gpt-5.6-sol');
  assert.ok(razor.includes('model_reasoning_effort="high"'));
  assert.ok(razor.includes('sandbox_mode="workspace-write"'));
  assert.ok(razor.some((arg) => arg.startsWith('developer_instructions=')));
  assert.equal(razor.includes('--dangerously-bypass-approvals-and-sandbox'), false);
});

test('cleanup removes only a strict descendant and preserves a sibling project', (t) => {
  const dir = fixture(t);
  const owned = path.join(dir, 'owned');
  const child = path.join(owned, 'session');
  const sibling = path.join(dir, 'owned-sibling');
  fs.mkdirSync(child, { recursive: true });
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'keep.txt'), 'preserve');
  assert.equal(contained(owned, child), true);
  for (const target of [owned, dir, sibling, path.join(owned, '..', 'owned-sibling')]) {
    assert.equal(contained(owned, target), false);
    assert.throws(() => removeOwned(owned, target), /Refusing cleanup/);
  }
  removeOwned(owned, child);
  assert.equal(fs.existsSync(child), false);
  assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'preserve');
});

test('cleanup refuses a junction ancestor that would reach outside the owned root', (t) => {
  const dir = fixture(t);
  const owned = path.join(dir, 'owned');
  const outside = path.join(dir, 'outside');
  const victim = path.join(outside, 'project');
  fs.mkdirSync(owned);
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'preserve');
  const junction = path.join(owned, 'link');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const traversed = path.join(junction, 'project');
  assert.throws(() => removeOwned(owned, traversed), /Refusing cleanup/);
  assert.equal(fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8'), 'preserve');
});

function record(task, arm, overrides = {}) {
  return { task, arm, group: 'full', model: 'gpt-5.6-sol', effort:'high', repetition: 0,
    status: 'completed', correct: 1, safe: 1, total_loc: arm === 'razor' ? 50 : 100,
    elapsed_ms: arm === 'razor' ? 500 : 1000,
    usage: { input_tokens: arm === 'razor' ? 500 : 1000, cached_input_tokens: 0,
      output_tokens: arm === 'razor' ? 50 : 100 }, hooks: { denied: 0 }, ...overrides };
}

test('efficiency reports include only jointly passing pairs of the same task, repetition and model', () => {
  const records = [
    record('pass', 'baseline'), record('pass', 'razor'),
    record('wrong', 'baseline'), record('wrong', 'razor', { correct: 0, total_loc: 1 }),
    record('unsafe', 'baseline', { safe: 0 }), record('unsafe', 'razor', { total_loc: 1 }),
    record('different-effort', 'baseline'), record('different-effort', 'razor', { effort:'low', total_loc: 1 }),
    record('failed', 'baseline', { status: 'runtime_failed' }), record('failed', 'razor', { total_loc: 1 }),
    record('repetition', 'baseline'), record('repetition', 'razor', { repetition: 1, total_loc: 1 }),
    record('other-task', 'baseline'), record('missing-baseline', 'razor', { total_loc: 1 }),
    record('model', 'baseline'), record('model', 'razor', { model: 'other-model', total_loc: 1 }),
  ];
  const output = reportText({ model: 'gpt-5.6-sol', effort: 'high', runtime: 'fixture',
    source: 'fixture', seed: 'fixture', probes: [], records, cleanup_verified: true });
  for (const metric of ['LOC', 'Elapsed time', 'Input tokens', 'Output tokens']) {
    assert.ok(output.includes('- ' + metric + ': median Razor/baseline 0.500 (1 pairs).'), metric);
  }
  assert.match(output, /failed \| 1 \| baseline \| runtime_failed/);
});

test('a failed native process leaves no session homes or projects and reports failure truthfully', (t) => {
  const dir = fixture(t);
  const sourceHome = path.join(dir, 'empty-source-home');
  const isolatedTemp = path.join(dir, 'temp');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(isolatedTemp);
  const report = path.join(dir, 'failure.md');
  const runner = path.resolve(__dirname, '../benchmarks/runner/codex-run.js');
  // Node can satisfy --version but rejects Codex exec arguments. This invokes no
  // model and cannot copy real credentials: the only source home is empty.
  const env = { ...process.env, CODEX_HOME: sourceHome, TEMP: isolatedTemp, TMP: isolatedTemp, TMPDIR: isolatedTemp };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [runner, '--codex-bin', process.execPath,
    '--probe', '--model', 'gpt-5.6-sol', '--effort', 'high', '--report', report], {
    env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Activation probe failed/);
  const runRoot = result.stdout.match(/^run root: (.+)\r?$/m)?.[1].trim();
  assert.ok(runRoot, result.stdout);
  assert.equal(fs.existsSync(runRoot), false);
  assert.deepEqual(fs.readdirSync(isolatedTemp), []);
  assert.deepEqual(fs.readdirSync(sourceHome), []);
  const saved = JSON.parse(fs.readFileSync(report.replace(/\.md$/, '.json'), 'utf8'));
  assert.equal(saved.cleanup_verified, true);
  assert.match(saved.error, /Activation probe failed/);
  assert.deepEqual(saved.records, []);
  assert.equal(saved.probes.length, 2);
  assert.ok(saved.probes.every((probe) => probe.passed === false));
  assert.match(fs.readFileSync(report, 'utf8'), /Cleanup verified: true/);
});
