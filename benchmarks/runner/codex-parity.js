#!/usr/bin/env node
'use strict';

// Functional native-host probes, separate from the exploratory A/B benchmark.
// Only derived assertions/metrics survive; each probe owns and removes its home.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  options, removeOwned, setupHome, writeShims, runTurn,
  traceSummary, readTrace, sumUsage, installEvidence, checkpoint,
} = require('./codex-run');
const { gitSnapshot, pkgAddAttempts } = require('./metrics');

const ROOT = path.resolve(__dirname, '../..');
const PACKAGE = '{"name":"razor-parity-fixture","private":true,"dependencies":{}}\n';
const packageSeed = { 'package.json': PACKAGE };
const addPatch = (files) => '*** Begin Patch\n' + Object.entries(files).map(([name, text]) =>
  '*** Add File: ' + name + '\n' + text.trimEnd().split('\n').map(line => '+' + line).join('\n')).join('\n') + '\n*** End Patch';
const importFile = (name) => "const dependency = require('" + name + "');\nmodule.exports = dependency;\n";
const PATCH_INSTRUCTION = 'This is an explicitly requested disposable native-tool fixture, and the full exact version is required. ' +
  'Use your apply_patch tool to apply the exact patch below. Do not replace it with shell writes or simplify the fixture. ' +
  'If a Razor checkpoint denies the patch, retry that identical patch once; verifying the retry is part of the task. ' +
  'Do not install packages, execute fixture code, run tests, start a server, or edit any other file. After success reply PARITY_DONE.\n\n';
const patchPrompt = (patch) => PATCH_INSTRUCTION + patch;
const importFiles = { 'import-probe.js': importFile('razor-parity-external') };
const manyFiles = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['part-' + (i + 1) + '.js', 'module.exports = ' + (i + 1) + ';\n']));
const toggleFiles = Object.fromEntries(['active', 'off', 'still-off', 'on'].map(stage =>
  [stage + '.js', importFile('razor-parity-' + stage)]));
const ledgerBase = "'use strict';\n";
const ledgerResult = ledgerBase + Array.from({ length: 12 }, (_, i) => 'exports.value' + (i + 1) + ' = ' + (i + 1) + ';\n').join('');
const ledgerPatch = '*** Begin Patch\n*** Update File: ledger.js\n@@\n ' + ledgerBase +
  ledgerResult.slice(ledgerBase.length).trimEnd().split('\n').map(line => '+' + line).join('\n') + '\n*** End Patch';
const ledgerPrompts = [patchPrompt(ledgerPatch) + '\nAll twelve separate exported values are required. ' +
  'If an automated end-of-turn ledger requests reconsideration, acknowledge once and retain the exact fixture.',
  'Keep the twelve required exported values exactly as they are. Do not edit or run anything. Reply LEDGER_RESUME_DONE.'];

const CASES = {
  import: { arms: ['baseline', 'razor'], seed: packageSeed, files: importFiles,
    prompts: [patchPrompt(addPatch(importFiles))], denials: [1] },
  manifest: { arms: ['baseline', 'razor'], seed: packageSeed,
    files: { 'package.json': '{"name":"razor-parity-fixture","private":true,"dependencies":{"razor-parity-external":"1.0.0"}}\n' },
    prompts: [patchPrompt('*** Begin Patch\n*** Update File: package.json\n@@\n-' + PACKAGE.trimEnd() +
      '\n+{"name":"razor-parity-fixture","private":true,"dependencies":{"razor-parity-external":"1.0.0"}}\n*** End Patch')], denials: [1] },
  files: { arms: ['baseline', 'razor'], seed: packageSeed, files: manyFiles,
    prompts: [patchPrompt(addPatch(manyFiles))], denials: [1] },
  toggle: { arms: ['razor'], seed: packageSeed, files: toggleFiles,
    prompts: Object.entries(toggleFiles).map(([name, text], i) =>
      (i === 1 ? '/razor off\n' : i === 3 ? '/razor on\n' : '') + patchPrompt(addPatch({ [name]: text }))),
    denials: [1, 0, 0, 1], offStates: [false, true, true, false] },
  'ledger-positive': { arms: ['razor'], seed: { ...packageSeed, 'ledger.js': ledgerBase },
    files: { 'ledger.js': ledgerResult }, prompts: ledgerPrompts, denials: [0, 0],
    git: true, extraEnv: { RAZOR_LEDGER_LOC: '5' }, continuations: 1 },
  'ledger-negative': { arms: ['razor'], seed: { ...packageSeed, 'ledger.js': ledgerBase },
    files: { 'ledger.js': ledgerResult }, prompts: ledgerPrompts, denials: [0, 0],
    git: true, extraEnv: { RAZOR_LEDGER_LOC: '20' }, continuations: 0 },
  subagent: { arms: ['razor'], seed: packageSeed, files: { 'writer.js': 'module.exports = 42;\n' },
    enableFeatures: ['multi_agent'], denials: [0],
    prompts: ['Use native agent tools for two independent tasks. Spawn exactly one code-writing agent with agent_type="default" and exactly one reader with agent_type="explorer". Set those agent_type arguments explicitly. ' +
      'Do not specify or override either child model or reasoning effort: they must inherit this session. ' +
      'The default writer owns only writer.js in this project and must create it with apply_patch containing exactly `module.exports = 42;` plus a newline. ' +
      'Tell the writer it is not alone and must not change any other files. The explorer must only read package.json and report its name; it must not write. ' +
      'While they work, independently verify that the package name is razor-parity-fixture by reading package.json. ' +
      'Wait for both children to finish and close them before replying SUBAGENT_DONE. Do not create writer.js yourself. ' +
      'Nobody should install dependencies, execute code, run tests, or start a server.'] },
};

function successful(turn) {
  return turn && turn.exitCode === 0 && !turn.timedOut && !turn.spawnError &&
    Array.isArray(turn.errors) && turn.errors.length === 0 && turn.completedTurns > 0 && !!turn.threadId;
}

// Pure assertion surface for offline tests. It deliberately requires native
// event evidence as well as the resulting files; output text alone cannot pass.
function evaluateCase(caseId, arm, evidence, model = 'gpt-5.6-sol') {
  const spec = CASES[caseId];
  if (!spec || !spec.arms.includes(arm)) throw new Error('Unknown parity case/arm');
  const { turns = [], traces = [], files = {}, offStates = [], childModels = {}, installAttempts = 0 } = evidence;
  const allTrace = traces.flat();
  const hooks = traceSummary(allTrace);
  const checks = {
    all_turns_completed: turns.length === spec.prompts.length && turns.every(successful),
    native_resume_same_session: turns.length > 0 && new Set(turns.map(turn => turn.threadId)).size === 1,
    all_files_exact: Object.entries(spec.files).every(([name, content]) => files[name]?.replace(/\r\n/g, '\n') === content),
    no_package_execution: installAttempts === 0,
    hooks_clean: hooks.failures === 0,
    native_activation: arm === 'baseline' ? allTrace.length === 0 : hooks.active_injections > 0,
  };
  if (arm === 'razor') {
    checks.expected_patch_denials = traces.length === spec.denials.length && traces.every((trace, i) =>
      trace.filter(event => event.denied).length === spec.denials[i]);
    checks.native_patch_attempted = caseId === 'subagent' || traces.every((trace, i) =>
      (spec.git && i > 0) || trace.filter(event => event.event === 'PreToolUse' && event.tool === 'apply_patch').length >= spec.denials[i] + 1);
  }
  if (spec.offStates) checks.toggle_persists_and_rearms = JSON.stringify(offStates) === JSON.stringify(spec.offStates);
  if (spec.git) {
    checks.ledger_continuation_count = hooks.continued === spec.continuations;
    checks.ledger_does_not_repeat_after_resume = traces.length === 2 &&
      traces[0].filter(event => event.continued).length === spec.continuations && !traces[1].some(event => event.continued);
    checks.stop_lifecycle_observed = (hooks.events.Stop || 0) >= spec.prompts.length + spec.continuations;
  }
  if (caseId === 'subagent') {
    const starts = allTrace.filter(event => event.event === 'SubagentStart');
    const writer = starts.find(event => event.agent_type && !['explore', 'explorer'].includes(event.agent_type.toLowerCase()));
    const explorer = starts.find(event => ['explore', 'explorer'].includes(String(event.agent_type).toLowerCase()));
    // The native hook's model comes from the child's own TurnContext. Some
    // runtimes do not persist child rollouts, so use that startup observation
    // rather than accepting a model's self-report or assuming the parent.
    const modelsFor = event => childModels[event?.agent_id]?.length ? childModels[event.agent_id] :
      (typeof event?.model === 'string' ? [event.model] : []);
    checks.writer_context_and_identity = !!(writer?.context && writer.agent_id);
    checks.explorer_receives_no_ladder = !!(explorer?.agent_id && !explorer.context);
    checks.distinct_child_identities = !!(writer?.agent_id && explorer?.agent_id && writer.agent_id !== explorer.agent_id);
    checks.writer_edits_observed = !!writer && allTrace.some(event => event.event === 'PreToolUse' && event.tool === 'apply_patch' &&
      [event.agent_id, event.session_id].includes(writer.agent_id));
    checks.child_models_inherited = !!(writer && explorer && [writer, explorer].every(event =>
      modelsFor(event).length > 0 && modelsFor(event).every(name => name === model)));
  }
  const children = caseId === 'subagent' ? allTrace.filter(event => event.event === 'SubagentStart').map(event => ({
    role: event.agent_type || null,
    received_context: event.context,
    models: childModels[event.agent_id]?.length ? childModels[event.agent_id] : (event.model ? [event.model] : []),
    model_evidence: childModels[event.agent_id]?.length ? 'native_rollout' : (event.model ? 'native_subagent_start' : 'unavailable'),
    authored_patch: allTrace.some(item => item.event === 'PreToolUse' && item.tool === 'apply_patch' &&
      [item.agent_id, item.session_id].includes(event.agent_id)),
  })) : undefined;
  return { passed: Object.values(checks).every(Boolean), checks, hooks, children };
}

function readChildModels(home) {
  const result = {};
  const visit = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(file); continue; }
      if (!entry.name.endsWith('.jsonl')) continue;
      let session = null;
      const models = new Set();
      for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'session_meta') session = item.payload?.thread_id || item.payload?.id;
        if (item.type === 'turn_context' && typeof item.payload?.model === 'string') models.add(item.payload.model);
      }
      if (session) result[session] = [...new Set([...(result[session] || []), ...models])];
    }
  };
  visit(path.join(home, 'sessions'));
  return result;
}

function stateOff(cellDir, sessionId) {
  const name = 'razor-' + String(sessionId).replace(/[^a-zA-Z0-9-]/g, '_') + '.json';
  try { return JSON.parse(fs.readFileSync(path.join(cellDir, 'plugin-data', name), 'utf8')).off === true; }
  catch { return null; }
}

async function runCase(config, runRoot, caseId, arm, onRecord) {
  const spec = CASES[caseId];
  const tempParent = os.tmpdir();
  const cellDir = path.join(runRoot, caseId + '-' + arm);
  let home;
  const record = { case: caseId, arm, model: config.model, effort: config.effort,
    status: 'runtime_failed', cleanup_verified: false };
  const turns = [], traces = [], offStates = [];
  try {
    fs.mkdirSync(cellDir);
    home = fs.mkdtempSync(path.join(tempParent, 'razor-codex-parity-home-'));
    setupHome(home);
    if (caseId === 'subagent') {
      // Codex hides the agent_type selector when its custom role map is empty,
      // even though the builtin explorer resolver exists. Expose it only in
      // this disposable probe; the builtin role still inherits model/effort.
      fs.appendFileSync(path.join(home, 'config.toml'), '\n[agents.explorer]\ndescription = "Read-only explorer for this activation probe."\n');
    }
    const ws = path.join(cellDir, 'project');
    fs.mkdirSync(ws);
    for (const [name, content] of Object.entries(spec.seed)) fs.writeFileSync(path.join(ws, name), content);
    const shims = writeShims(ws);
    if (spec.git) {
      gitSnapshot(ws);
      if (spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: ws, stdio: 'ignore' }).status !== 0) throw new Error('Git fixture baseline failed');
    }
    const cellConfig = { ...config, enableFeatures: spec.enableFeatures,
      extraEnv: { ...config.extraEnv, ...spec.extraEnv } };
    let sessionId = null, offset = 0;
    for (const prompt of spec.prompts) {
      if (config.shouldStop?.()) throw new Error('Parity run interrupted');
      const turn = await runTurn(cellConfig, arm, cellDir, ws, home, shims, { bash: true }, prompt, sessionId);
      turns.push(turn);
      const trace = readTrace(cellDir);
      traces.push(trace.slice(offset));
      offset = trace.length;
      sessionId = turn.threadId || sessionId;
      offStates.push(stateOff(cellDir, sessionId));
      if (!successful(turn)) break;
    }
    const files = Object.fromEntries(Object.keys(spec.files).map(name => {
      try { return [name, fs.readFileSync(path.join(ws, name), 'utf8')]; }
      catch { return [name, null]; }
    }));
    installEvidence(cellDir, ws);
    Object.assign(record, evaluateCase(caseId, arm, { turns, traces, files, offStates,
      childModels: readChildModels(home), installAttempts: pkgAddAttempts(ws).length }, config.model));
    record.status = turns.length === spec.prompts.length && turns.every(successful) ? 'completed' : 'runtime_failed';
    record.turn_count = turns.length;
    record.usage = sumUsage(turns);
    record.elapsed_ms = turns.reduce((sum, turn) => sum + turn.elapsed_ms, 0);
  } catch (error) {
    record.passed = false;
    record.failure = error.code || error.message;
  } finally {
    // Preserve the derived result before destroying source/transcripts.
    try { onRecord(record); }
    finally {
      const failures = [];
      for (const [parent, target] of [[tempParent, home], [runRoot, cellDir]]) {
        if (!target) continue;
        try { removeOwned(parent, target); } catch (error) { failures.push(error.code || 'cleanup_refused'); }
      }
      record.cleanup_verified = (!home || !fs.existsSync(home)) && !fs.existsSync(cellDir);
      if (failures.length) { record.cleanup_failures = failures; record.passed = false; }
      onRecord(record);
    }
  }
  return record;
}

function parseArgs(argv) {
  const allowed = new Set(['--codex-bin', '--model', '--effort', '--timeout', '--report', '--cases']);
  let cases = Object.keys(CASES);
  const forwarded = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i])) throw new Error('Unknown parity flag: ' + argv[i]);
    if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error('Missing value: ' + argv[i]);
    if (argv[i] === '--cases') cases = argv[i + 1].split(',');
    else forwarded.push(argv[i], argv[i + 1]);
  }
  if (!cases.length || cases.some(id => !Object.hasOwn(CASES, id)) || new Set(cases).size !== cases.length) throw new Error('Unknown or duplicate parity case');
  if (!forwarded.includes('--model')) forwarded.push('--model', 'gpt-5.6-sol');
  if (!forwarded.includes('--effort')) forwarded.push('--effort', 'high');
  if (!forwarded.includes('--report')) forwarded.push('--report', path.join(ROOT, 'benchmarks/results/codex-parity-latest.json'));
  const config = options(forwarded);
  if (!config.report.endsWith('.json')) throw new Error('Parity report must use .json');
  return { ...config, cases };
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node codex-parity.js --codex-bin <exe> --model gpt-5.6-sol --effort high --report <report.json>\nOptional --cases import,manifest,files,toggle,ledger-positive,ledger-negative,subagent\n');
    return 0;
  }
  const config = parseArgs(argv);
  const runtime = spawnSync(config.bin, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (runtime.status !== 0) throw new Error('Cannot execute Codex binary');
  const parent = path.join(ROOT, 'benchmarks/runs');
  let runRoot, stopped = false;
  const report = { model: config.model, effort: config.effort, runtime: runtime.stdout.trim(),
    source: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
    records: [], cleanup_verified: false };
  const save = (record) => {
    if (record) {
      const index = report.records.findIndex(item => item.case === record.case && item.arm === record.arm);
      if (index < 0) report.records.push(record); else report.records[index] = record;
    }
    checkpoint(config.report, report);
  };
  const onSignal = () => { stopped = true; };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    fs.mkdirSync(parent, { recursive: true });
    runRoot = fs.mkdtempSync(path.join(parent, 'codex-parity-'));
    for (const caseId of config.cases) for (const arm of CASES[caseId].arms) {
      if (stopped) throw new Error('Parity run interrupted');
      process.stdout.write('parity start: ' + caseId + ' / ' + arm + '\n');
      const record = await runCase({ ...config, shouldStop: () => stopped }, runRoot, caseId, arm, save);
      process.stdout.write('parity done: ' + caseId + ' / ' + arm + ' ' + (record.passed ? 'PASS' : 'FAIL') + '\n');
      if (!record.cleanup_verified) throw new Error('Parity case cleanup failed');
    }
  } catch (error) {
    report.error = error.code || error.message;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { if (runRoot) removeOwned(parent, runRoot); }
    catch (error) { report.cleanup_error = error.code || 'cleanup_refused'; }
    report.cleanup_verified = (!runRoot || !fs.existsSync(runRoot)) && report.records.every(record => record.cleanup_verified);
    save();
  }
  process.stdout.write('parity report: ' + config.report + '\ncleanup: ' + report.cleanup_verified + '\n');
  return report.error || !report.cleanup_verified ? 1 : report.records.every(record => record.passed) ? 0 : 2;
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
module.exports = { CASES, evaluateCase, parseArgs, readChildModels, main };
