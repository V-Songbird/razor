'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CASES, evaluateCase, parseArgs, readChildModels } = require('../benchmarks/runner/codex-parity');

const event = (event, more = {}) => ({ event, exit: 0, error: false, elapsed_ms: 1,
  context: false, denied: false, continued: false, ...more });
const goodTurn = () => ({ exitCode: 0, timedOut: false, spawnError: null, errors: [],
  completedTurns: 1, threadId: 'same-parent', usage: { input_tokens: 100, output_tokens: 20 } });
function evidence(caseId, arm = 'razor') {
  const spec = CASES[caseId];
  const traces = spec.prompts.map((prompt, i) => arm === 'baseline' ? [] : [
    event('SessionStart', { context: i === 0 }),
    ...Array.from({ length: spec.denials[i] }, () => event('PreToolUse', { tool: 'apply_patch', denied: true })),
    event('PreToolUse', { tool: 'apply_patch' }),
    ...(spec.git && i === 0 && spec.continuations ? [event('Stop', { continued: true })] : []),
    event('Stop'),
  ]);
  return { turns: spec.prompts.map(goodTurn), traces, files: { ...spec.files },
    offStates: spec.offStates ? [...spec.offStates] : [], installAttempts: 0 };
}

test('parity CLI defaults to the authorized model and refuses unknown or duplicate cases', () => {
  const config = parseArgs([]);
  assert.equal(config.model, 'gpt-5.6-sol');
  assert.equal(config.effort, 'high');
  assert.deepEqual(config.cases, Object.keys(CASES));
  assert.deepEqual(parseArgs(['--cases', 'import,files']).cases, ['import', 'files']);
  for (const argv of [['--cases', '../outside'], ['--cases', 'import,import'], ['--dry-run'],
    ['--cases'], ['-h'], ['--report', 'report.md'], ['--effort', 'unknown']]) {
    assert.throws(() => parseArgs(argv));
  }
});

test('guard probes require one native checkpoint and a successful patch retry only in Razor', () => {
  for (const caseId of ['import', 'manifest', 'files']) {
    for (const arm of CASES[caseId].arms) assert.equal(evaluateCase(caseId, arm, evidence(caseId, arm)).passed, true, caseId + '/' + arm);
    const noDenial = evidence(caseId);
    noDenial.traces[0] = noDenial.traces[0].filter(item => !item.denied);
    assert.equal(evaluateCase(caseId, 'razor', noDenial).checks.expected_patch_denials, false);
    const repeated = evidence(caseId);
    repeated.traces[0].push(event('PreToolUse', { tool: 'apply_patch', denied: true }));
    assert.equal(evaluateCase(caseId, 'razor', repeated).passed, false);
  }
});

test('file presence, fabricated final text, and hooks alone cannot pass a native guard probe', () => {
  const sample = evidence('import');
  sample.turns[0].lastMessage = 'PARITY_DONE';
  sample.turns[0].completedTurns = 0;
  assert.equal(evaluateCase('import', 'razor', sample).passed, false);
  sample.turns[0] = goodTurn();
  sample.files['import-probe.js'] = 'module.exports = 42;\n';
  assert.equal(evaluateCase('import', 'razor', sample).checks.all_files_exact, false);
  sample.files = { ...CASES.import.files };
  sample.installAttempts = 1;
  assert.equal(evaluateCase('import', 'razor', sample).checks.no_package_execution, false);
  sample.installAttempts = 0;
  sample.traces[0][0].exit = 1;
  assert.equal(evaluateCase('import', 'razor', sample).checks.hooks_clean, false);
});

test('baseline must have no native hook events at all', () => {
  const sample = evidence('manifest', 'baseline');
  sample.traces[0].push(event('SessionStart'));
  assert.equal(evaluateCase('manifest', 'baseline', sample).checks.native_activation, false);
});

test('toggle requires persistent native session identity, off across resume, and fresh on denial', () => {
  const sample = evidence('toggle');
  assert.equal(evaluateCase('toggle', 'razor', sample).passed, true);
  sample.turns[2].threadId = 'new-session';
  assert.equal(evaluateCase('toggle', 'razor', sample).checks.native_resume_same_session, false);
  sample.turns[2].threadId = 'same-parent';
  sample.offStates[2] = false;
  assert.equal(evaluateCase('toggle', 'razor', sample).checks.toggle_persists_and_rearms, false);
  sample.offStates[2] = true;
  sample.traces[3] = sample.traces[3].filter(item => !item.denied);
  assert.equal(evaluateCase('toggle', 'razor', sample).checks.expected_patch_denials, false);
});

test('ledger positive fires once and stays silent after resume; negative never continues', () => {
  for (const caseId of ['ledger-positive', 'ledger-negative']) {
    const sample = evidence(caseId);
    assert.equal(evaluateCase(caseId, 'razor', sample).passed, true, caseId);
    sample.traces[1].push(event('Stop', { continued: true }));
    const result = evaluateCase(caseId, 'razor', sample);
    assert.equal(result.checks.ledger_continuation_count, false);
    assert.equal(result.checks.ledger_does_not_repeat_after_resume, false);
  }
});

test('writer requires child injection, distinct identity, observed edit and inherited model; explorer stays silent', () => {
  const sample = evidence('subagent');
  sample.traces[0].push(
    event('SubagentStart', { agent_id: 'writer-child', agent_type: 'default', context: true }),
    event('SubagentStart', { agent_id: 'explorer-child', agent_type: 'explorer' }),
    event('PreToolUse', { agent_id: 'writer-child', tool: 'apply_patch' }),
  );
  sample.childModels = { 'writer-child': ['gpt-5.6-sol'], 'explorer-child': ['gpt-5.6-sol'] };
  assert.equal(evaluateCase('subagent', 'razor', sample).passed, true);
  sample.childModels['writer-child'] = ['other-model'];
  assert.equal(evaluateCase('subagent', 'razor', sample).checks.child_models_inherited, false);
  sample.childModels['writer-child'] = ['gpt-5.6-sol'];
  sample.traces[0].find(item => item.agent_type === 'explorer').context = true;
  assert.equal(evaluateCase('subagent', 'razor', sample).checks.explorer_receives_no_ladder, false);
  sample.traces[0].find(item => item.agent_type === 'explorer').context = false;
  sample.traces[0] = sample.traces[0].filter(item => !(item.event === 'PreToolUse' && item.agent_id));
  assert.equal(evaluateCase('subagent', 'razor', sample).checks.writer_edits_observed, false);
});

test('native SubagentStart model identifies children when their rollouts are unavailable', () => {
  const sample = evidence('subagent');
  sample.traces[0].push(
    event('SubagentStart', { agent_id: 'writer-child', agent_type: 'default', context: true, model: 'gpt-5.6-sol' }),
    event('SubagentStart', { agent_id: 'explorer-child', agent_type: 'explorer', model: 'gpt-5.6-sol' }),
    event('PreToolUse', { agent_id: 'writer-child', tool: 'apply_patch' }),
  );
  sample.childModels = {};
  const result = evaluateCase('subagent', 'razor', sample);
  assert.equal(result.passed, true);
  assert.ok(result.children.every(child => child.model_evidence === 'native_subagent_start'));
  sample.traces[0].find(item => item.agent_type === 'explorer').model = 'different-model';
  assert.equal(evaluateCase('subagent', 'razor', sample).checks.child_models_inherited, false);
});

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'razor-codex-parity-test-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), parent);
    assert.ok(path.basename(dir).startsWith('razor-codex-parity-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test('model evidence comes from disposable native rollout metadata and tolerates incomplete lines', (t) => {
  const home = fixture(t);
  const dir = path.join(home, 'sessions', 'day');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'child.jsonl'), [
    { type: 'session_meta', payload: { id: 'parent-session', thread_id: 'child' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
    { type: 'turn_context', payload: { model: 'gpt-5.6-sol' } },
  ].map(item => JSON.stringify(item)).join('\n') + '\n{"incomplete":');
  assert.deepEqual(readChildModels(home), { child: ['gpt-5.6-sol'] });
});

test('offline process failure checkpoints derived failures and cleans every probe home and project', (t) => {
  const dir = fixture(t);
  const sourceHome = path.join(dir, 'empty-source-home');
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(sourceHome);
  fs.mkdirSync(temp);
  const report = path.join(dir, 'result.json');
  const env = { ...process.env, CODEX_HOME: sourceHome, TEMP: temp, TMP: temp, TMPDIR: temp };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../benchmarks/runner/codex-parity.js'),
    '--codex-bin', process.execPath, '--cases', 'import', '--report', report], {
    env, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2, result.stderr);
  const saved = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.equal(saved.records.length, 2);
  assert.ok(saved.records.every(record => record.passed === false && record.status === 'runtime_failed' && record.cleanup_verified));
  assert.equal(saved.cleanup_verified, true);
  assert.equal(JSON.stringify(saved).includes('lastMessage'), false);
  assert.equal(JSON.stringify(saved).includes('auth.json'), false);
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.deepEqual(fs.readdirSync(sourceHome), []);
});
