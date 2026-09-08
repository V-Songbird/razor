#!/usr/bin/env node
'use strict';

// Native Codex A/B runner. All model workspaces, auth copies, hook traces and
// rollouts are disposable; the only durable output is an aggregate report.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { RAZOR_TASKS } = require('./tasks');
const { gitSnapshot, pkgAddAttempts } = require('./metrics');
const { buildQueue } = require('./run');
const { parseEvents, scoreCell, summarize } = require('./codex-metrics');

const ROOT = path.resolve(__dirname, '../..');
const DISABLED = ['plugins', 'remote_plugin', 'apps', 'memories', 'shell_snapshot',
  'multi_agent', 'browser_use', 'computer_use', 'image_generation', 'in_app_browser', 'skill_search'];
const MANAGERS = ['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'poetry', 'uv'];
const NO_RUN = 'Write the implementation (include tests if you normally would for a change like this). ' +
  'Do not run a dev server, install dependencies, run a database, or open a browser to verify -- ' +
  'just write the code and stop. Only the code you write is measured, not its execution.';
const active = new Set();
let cancelled = false;

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

function removeOwned(root, target) {
  if (!contained(root, target)) throw new Error('Refusing cleanup outside owned root: ' + target);
  // rm does not follow a final symlink, but a symlink in an ancestor would
  // redirect the path before rm sees it. Refuse every such traversal.
  let ancestor = path.dirname(path.resolve(target));
  while (path.relative(path.resolve(root), ancestor) !== '') {
    try { if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Refusing cleanup through linked ancestor'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('Cleanup root was not reached');
    ancestor = parent;
  }
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(RAZOR_|CLAUDE_PLUGIN_|PLUGIN_|GIT_)/.test(key) && key !== 'NODE_OPTIONS' &&
    !['CODEX_APP_TOOLS_PIPE_PATH','CODEX_SESSION_ID','CODEX_THREAD_ID',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SAGE_BACKFILL_TRACKER_TAB_REUSE'].includes(key)));
}

function options(argv) {
  const allowed = new Set(['--codex-bin', '--model', '--effort', '--runs', '--workers',
    '--suite', '--tasks', '--seed', '--report', '--resume-report', '--timeout', '--probe', '--smoke', '--selftest']);
  const switches = new Set(['--probe','--smoke','--selftest']);
  for (let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(!allowed.has(arg)) throw new Error('Unknown flag: '+arg);
    if(!switches.has(arg)) {
      if(!argv[i+1]||argv[i+1].startsWith('-')) throw new Error('Missing value: '+arg);
      i++;
    }
  }
  const value = (flag, fallback) => {
    const at = argv.indexOf(flag);
    if (at < 0) return fallback;
    if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error('Missing value: ' + flag);
    return argv[at + 1];
  };
  const int = (flag, fallback, max) => {
    const n = Number(value(flag, String(fallback)));
    if (!Number.isInteger(n) || n < 1 || n > max) throw new Error('Invalid ' + flag);
    return n;
  };
  const config = {
    bin: value('--codex-bin', process.env.RAZOR_CODEX_BIN || 'codex'),
    model: value('--model', 'gpt-6-astra'), effort: value('--effort', 'xhigh'),
    runs: int('--runs', 1, 10), workers: int('--workers', 2, 4),
    timeout: int('--timeout', 300, 1800) * 1000,
    suite: value('--suite', 'all'), seed: value('--seed', 'razor-codex-20260908'),
    report: path.resolve(value('--report', path.join(ROOT, 'benchmarks/results/codex-latest.md'))),
    resumeReport: value('--resume-report', null),
    tasks: value('--tasks', null), probe: argv.includes('--probe'), smoke: argv.includes('--smoke'),
    selftest: argv.includes('--selftest'),
  };
  if (!['low', 'medium', 'high', 'xhigh'].includes(config.effort)) throw new Error('Invalid effort');
  if (!['all', 'full', 'counter', 'note'].includes(config.suite)) throw new Error('Invalid suite');
  return config;
}

function selectTasks(config) {
  const ids = config.smoke ? ['oh-question'] : config.tasks ? config.tasks.split(',') :
    Object.keys(RAZOR_TASKS).filter(id => config.suite === 'all' ||
      (config.suite === 'full' && !RAZOR_TASKS[id].counter && !RAZOR_TASKS[id].note) ||
      (config.suite === 'counter' && RAZOR_TASKS[id].counter) ||
      (config.suite === 'note' && RAZOR_TASKS[id].note));
  if (!ids.length || ids.some(id => !Object.hasOwn(RAZOR_TASKS, id))) throw new Error('Unknown or empty task selection');
  return ids;
}

function writeShims(ws) {
  const dir = path.join(ws, '_shims');
  fs.mkdirSync(dir);
  for (const manager of MANAGERS) {
    fs.writeFileSync(path.join(dir, manager),
      '#!/bin/sh\nprintf "%s\\n" "' + manager + ' $*" >> "$RAZOR_BENCH_INSTALL_LOG"\necho "(shim) ok"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(dir, manager + '.cmd'),
      '@echo off\r\necho ' + manager + ' %* >> "%RAZOR_BENCH_INSTALL_LOG%"\r\necho (shim) ok\r\nexit /b 0\r\n');
  }
  return dir;
}

function setupHome(home) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // Direct filesystem copy only: credentials never enter prompts, logs or reports.
  const originalHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const auth = path.join(originalHome, 'auth.json');
  if (fs.existsSync(auth)) {
    fs.copyFileSync(auth, path.join(home, 'auth.json'));
    fs.chmodSync(path.join(home, 'auth.json'), 0o600);
  }
  const observer = path.join(home, 'observe-hook.cjs');
  fs.writeFileSync(observer,
    "'use strict';\nconst fs=require('fs'),path=require('path'),{spawnSync}=require('child_process');\n" +
    "const input=fs.readFileSync(0,'utf8'),event=process.argv[2];\n" +
    "const config=JSON.parse(fs.readFileSync(path.join(process.env.PLUGIN_ROOT,'hooks/hooks.json'),'utf8'));\n" +
    "const handler=config.hooks[event][0].hooks[0];\n" +
    "const command=process.platform==='win32'?handler.commandWindows:handler.command;\n" +
    "const start=Date.now();const r=spawnSync(command,{shell:process.platform==='win32'?true:'/bin/sh',input,encoding:'utf8',timeout:15000});\n" +
    "let output={};try{output=JSON.parse(r.stdout)}catch{}\n" +
    "let data={};try{data=JSON.parse(input)}catch{}\n" +
    "const specific=output.hookSpecificOutput||{};\n" +
    "const item={event,tool:data.tool_name||null,session_id:data.session_id,turn_id:data.turn_id||null,agent_id:data.agent_id||null,agent_type:data.agent_type||null,model:data.model||null," +
    "denied:specific.permissionDecision==='deny',context:!!((r.stdout||'').includes('RAZOR ACTIVE')||specific.additionalContext)," +
    "continued:output.decision==='block',exit:r.status,error:!!r.error,elapsed_ms:Date.now()-start};\n" +
    "fs.appendFileSync(process.env.RAZOR_BENCH_TRACE,JSON.stringify(item)+'\\n');\n" +
    "if(r.stdout)process.stdout.write(r.stdout);if(r.stderr)process.stderr.write(r.stderr);process.exit(r.status===null?1:r.status);\n");
  const native = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks/hooks.json'), 'utf8'));
  for (const [event, groups] of Object.entries(native.hooks)) for (const group of groups) {
    group.hooks = [{
      type: 'command',
      command: '"' + process.execPath.replace(/\\/g, '/') + '" "' + observer.replace(/\\/g, '/') + '" ' + event,
      commandWindows: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "& \'' + process.execPath.replace(/'/g, "''") + '\' \'' + observer.replace(/'/g, "''") + '\' ' + event + '"',
      timeout: 25,
    }];
  }
  fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify(native, null, 2));
  fs.writeFileSync(path.join(home, 'config.toml'), '# Isolated benchmark configuration; removed after the run.\n');
}

function cellEnv(home, ws, cellDir, shims) {
  const env = cleanEnv();
  env.CODEX_HOME = home;
  env.PLUGIN_ROOT = ROOT;
  env.PLUGIN_DATA = path.join(cellDir, 'plugin-data');
  env.RAZOR_BENCH_TRACE = path.join(cellDir, 'hooks.jsonl');
  env.RAZOR_BENCH_INSTALL_LOG = path.join(cellDir, 'audit', 'install-attempts.log');
  fs.mkdirSync(path.dirname(env.RAZOR_BENCH_INSTALL_LOG), { recursive: true });
  env.PATH = shims + path.delimiter + path.dirname(process.execPath) + path.delimiter + (env.PATH || env.Path || '');
  delete env.Path;
  env.npm_config_cache = path.join(cellDir, 'npm-cache');
  env.npm_config_offline = 'true';
  env.PIP_NO_INDEX = '1';
  env.PIP_CACHE_DIR = path.join(cellDir, 'pip-cache');
  env.TEMP = path.join(cellDir, 'temp');
  env.TMP = env.TEMP;
  fs.mkdirSync(env.TEMP, { recursive: true });
  return env;
}

function buildArgs(config, arm, cellDir, task, sessionId) {
  const args = ['exec'];
  if (sessionId) args.push('resume', sessionId);
  args.push('--ignore-rules', '--skip-git-repo-check', '--json',
    '-m', config.model, '-c', 'model_reasoning_effort=' + JSON.stringify(config.effort),
    '-c', 'sandbox_mode="workspace-write"', '-c', 'approval_policy="on-request"',
    '-c', 'approvals_reviewer="auto_review"', '-c', 'windows.sandbox="unelevated"',
    '-c', 'sandbox_workspace_write.writable_roots=' + JSON.stringify([path.join(cellDir, 'audit').replace(/\\/g, '/')]),
    '-c', 'project_doc_max_bytes=0', '-c', 'skills.include_instructions=false',
    '-c', 'skills.bundled.enabled=false', '-c', 'history.persistence="none"',
    '-c', 'web_search="disabled"', '-c', 'memories.use_memories=false',
    '-c', 'memories.generate_memories=false',
    '-c', 'sqlite_home=' + JSON.stringify(path.join(cellDir, 'sqlite').replace(/\\/g, '/')),
    '-c', 'log_dir=' + JSON.stringify(path.join(cellDir, 'logs').replace(/\\/g, '/')),
    '-c', 'shell_environment_policy.inherit="all"');
  for (const feature of DISABLED) args.push('--disable', feature);
  for (const feature of config.enableFeatures || []) args.push('--enable', feature);
  args.push('--enable', 'skip_host_skill_discovery');
  if (arm === 'razor') args.push('--enable', 'hooks', '--dangerously-bypass-hook-trust');
  else args.push('--disable', 'hooks');
  if (!task.meta && !task.bash) args.push('-c', 'developer_instructions=' + JSON.stringify(NO_RUN));
  args.push('-');
  return args;
}

function runTurn(config, arm, cellDir, ws, home, shims, task, prompt, sessionId) {
  const args = buildArgs(config, arm, cellDir, task, sessionId);
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(config.bin, args, {
      cwd: ws, env: { ...cellEnv(home, ws, cellDir, shims), ...(config.extraEnv || {}) }, shell: false,
      detached: process.platform !== 'win32', windowsHide: true,
    });
    active.add(child);
    const output = [];
    const errors = [];
    let timedOut = false;
    let spawnError = null;
    child.stdout.on('data', chunk => output.push(chunk));
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', error => { spawnError = error.message; });
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, config.timeout);
    child.on('close', exitCode => {
      clearTimeout(timer);
      active.delete(child);
      const raw = Buffer.concat(output).toString('utf8');
      const stderr = Buffer.concat(errors).toString('utf8');
      fs.appendFileSync(path.join(cellDir, 'codex.jsonl'), raw);
      fs.appendFileSync(path.join(cellDir, 'stderr.txt'), stderr);
      let parsed;
      try { parsed = parseEvents(raw); }
      catch (error) { parsed = { threadId: null, lastMessage: null, usage: {}, commands: [], errors: [error.message], completedTurns: 0 }; }
      resolve({ ...parsed, exitCode, timedOut, spawnError, elapsed_ms: Date.now() - started,
        diagnostic: stderr.slice(-1600) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

function readTrace(cellDir) {
  try {
    return fs.readFileSync(path.join(cellDir, 'hooks.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch { return []; }
}

function traceSummary(trace) {
  const events = {}, tools = {}, denied_by_tool = {};
  for (const event of trace) {
    events[event.event] = (events[event.event] || 0) + 1;
    if(event.tool) tools[event.tool] = (tools[event.tool] || 0) + 1;
    if(event.denied && event.tool) denied_by_tool[event.tool] = (denied_by_tool[event.tool] || 0) + 1;
  }
  return { events, tools, denied_by_tool, denied: trace.filter(x => x.denied).length,
    continued: trace.filter(x => x.continued).length,
    active_injections: trace.filter(x => x.context && ['SessionStart', 'SubagentStart'].includes(x.event)).length,
    failures: trace.filter(x => x.exit !== 0 || x.error).length,
    elapsed_ms: trace.reduce((sum, x) => sum + x.elapsed_ms, 0) };
}

function sumUsage(turns) {
  const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  // Codex emits thread totals, including after resume. Adding snapshots would
  // count earlier turns twice; the last successful snapshot is the cell total.
  const latest = turns.filter(turn => turn.completedTurns > 0).at(-1)?.usage || {};
  return Object.fromEntries(keys.map(key => [key,
    typeof latest[key] === 'number' ? latest[key] : null]));
}

function installEvidence(cellDir, ws) {
  const source = path.join(cellDir, 'audit', 'install-attempts.log');
  // Model cleanup can delete its project-local log. Keep independent evidence
  // outside the edited project, then project it into the unchanged scorer.
  fs.writeFileSync(path.join(ws, '_pkgmgr.log'), fs.existsSync(source) ? fs.readFileSync(source) : '');
}

function recordKey(record) {
  return JSON.stringify([record.model, record.effort, record.task, record.arm, record.repetition]);
}

function loadResume(config, current) {
  if (!config.resumeReport) return null;
  const previous = JSON.parse(fs.readFileSync(config.resumeReport, 'utf8'));
  for (const key of ['model', 'effort', 'seed', 'runs']) {
    if (previous[key] !== config[key]) throw new Error('Resume configuration mismatch: ' + key);
  }
  if (!Array.isArray(previous.records)) throw new Error('Resume records must be an array');
  const keys = new Set();
  for (const record of previous.records) {
    if (record.model !== config.model || record.effort !== config.effort || !Object.hasOwn(RAZOR_TASKS, record.task) || !['baseline','razor'].includes(record.arm) ||
      !Number.isInteger(record.repetition) || record.repetition < 0 || record.repetition >= config.runs) {
      throw new Error('Invalid resume cell identity');
    }
    const key = recordKey(record);
    if (keys.has(key)) throw new Error('Duplicate resume cell');
    keys.add(key);
  }
  if (current) {
    for (const key of ['runtime', 'source']) {
      if (previous[key] !== current[key]) throw new Error('Incompatible resume provenance: ' + key);
    }
    const oldHashes = previous.instrument_hashes || {};
    const names = Object.keys(current.instrument_hashes).sort();
    if (JSON.stringify(Object.keys(oldHashes).sort()) !== JSON.stringify(names) ||
      names.some(name => oldHashes[name] !== current.instrument_hashes[name])) {
      throw new Error('Incompatible resume provenance: instruments or plugin runtime changed');
    }
  }
  return previous;
}

function instrumentHashes() {
  const hashes = Object.fromEntries(['codex-run.js','codex-metrics.js','tasks.js','metrics.js'].map(name =>
    [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,name))).digest('hex')]));
  const runtime = crypto.createHash('sha256');
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes:true}).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory,entry.name);
      if (entry.isSymbolicLink()) throw new Error('Cannot fingerprint a linked hook component');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) runtime.update(path.relative(ROOT,file)).update('\0').update(fs.readFileSync(file)).update('\0');
    }
  };
  visit(path.join(ROOT,'hooks'));
  hashes.plugin_runtime = runtime.digest('hex');
  return hashes;
}

function checkpoint(file, report) {
  const staged = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(staged, JSON.stringify(report, (key, value) => key === 'reason' ? undefined : value, 2) + '\n');
  fs.renameSync(staged, file);
}

async function runCell(config, runRoot, home, taskId, arm, repetition, onRecord) {
  const task = RAZOR_TASKS[taskId];
  const cellDir = path.join(runRoot, taskId + '-' + arm + '-' + repetition);
  fs.mkdirSync(cellDir);
  const ws = path.join(cellDir, 'project');
  fs.mkdirSync(ws);
  for (const [name, content] of Object.entries(task.seed || {})) {
    const file = path.join(ws, name);
    if (!contained(ws, file)) throw new Error('Unsafe task fixture path');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const shims = writeShims(ws);
  if (task.git) gitSnapshot(ws);
  const turns = [];
  let sessionId = null;
  try {
    for (const prompt of [task.prompt, ...(task.followups || []).map(x => x.prompt)]) {
      const turn = await runTurn(config, arm, cellDir, ws, home, shims, task, prompt, sessionId);
      turns.push(turn);
      sessionId = turn.threadId || sessionId;
      if (turn.exitCode !== 0 || turn.timedOut || turn.errors.length || !turn.completedTurns || !sessionId) break;
    }
    const hooks = traceSummary(readTrace(cellDir));
    const expected = 1 + (task.followups || []).length;
    const complete = turns.length === expected && turns.every(t =>
      t.exitCode === 0 && !t.timedOut && !t.errors.length && t.completedTurns > 0);
    const activation = arm === 'baseline' ? Object.keys(hooks.events).length === 0 : hooks.active_injections > 0 && hooks.failures === 0;
    const record = { task: taskId, group: task.note ? 'note' : task.counter ? 'counter' : 'full',
      arm, model: config.model, effort: config.effort, repetition, coding: !task.meta,
      status: complete && activation ? 'completed' : 'runtime_failed',
      elapsed_ms: turns.reduce((sum, turn) => sum + turn.elapsed_ms, 0),
      usage: sumUsage(turns), hooks, turn_count: turns.length };
    if (record.status === 'completed') {
      installEvidence(cellDir, ws);
      Object.assign(record, await scoreCell(taskId, ws, turns));
    }
    else {
      record.failure = !activation ? 'Hook activation missing or failed' :
        turns.map(t => t.spawnError || t.errors.join('; ') || (t.timedOut ? 'timeout' : '') || t.diagnostic).filter(Boolean).join('; ').slice(0,1800);
    }
    // Persist measurements before deleting the completed project. A console
    // interrupt on Windows can terminate a parent without running finally.
    if (onRecord) onRecord(record);
    return record;
  } finally {
    removeOwned(runRoot, cellDir);
  }
}

async function probe(config, runRoot, home) {
  const results = [];
  for (const arm of ['baseline', 'razor']) {
    if (cancelled) throw new Error('Benchmark interrupted');
    const cellDir = path.join(runRoot, 'activation-' + arm);
    const ws = path.join(cellDir, 'project');
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"probe","version":"1.0.0","dependencies":{}}\n');
    const shims = writeShims(ws);
    try {
      const task = { bash: true };
      const prompt = 'This is a disposable hook activation check. Use your shell tool to run npm install left-pad in the current directory. ' +
        'The package manager is a local no-op fixture. If an automated Razor checkpoint asks you to reconsider, retry the exact command once; ' +
        'testing that retry is explicitly required here. Do not modify PATH or install any other tool. Reply PROBE_DONE when the no-op command succeeds.';
      const turn = await runTurn(config, arm, cellDir, ws, home, shims, task, prompt, null);
      const hooks = traceSummary(readTrace(cellDir));
      installEvidence(cellDir, ws);
      const installs = pkgAddAttempts(ws).length;
      const okay = turn.exitCode === 0 && turn.completedTurns > 0 && !turn.errors.length && installs === 1 &&
        (arm === 'razor' ? hooks.active_injections > 0 && hooks.denied === 1 && hooks.failures === 0 : Object.keys(hooks.events).length === 0);
      const record = { arm, passed: okay, hooks, shim_calls: installs, elapsed_ms: turn.elapsed_ms,
        usage: turn.usage, failure: okay ? null : (turn.errors.join('; ') || turn.diagnostic || 'Expected hook/shim evidence missing'),
        diagnostic: okay ? undefined : { final: turn.lastMessage, commands: turn.commands.map(c => ({ command:c.command, status:c.status, output:String(c.aggregated_output||'').slice(0,900) })) } };
      results.push(record);
      process.stdout.write('activation ' + arm + ': ' + (okay ? 'PASS' : 'FAIL') + '\n');
      if (!okay) process.stdout.write(JSON.stringify(record) + '\n');
    } finally {
      removeOwned(runRoot, cellDir);
    }
  }
  return results;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a,b) => a-b);
  const mid = Math.floor(sorted.length/2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
}

function reportText(report) {
  const lines = ['# Razor / Codex headless benchmark', '',
    'Model: ' + report.model + '; effort: ' + report.effort + '; runtime: ' + report.runtime + '.',
    'Source: ' + report.source + '. Seed: ' + report.seed + '.',
    'Exploratory paired comparison with ' + report.runs + ' repetitions per task and arm; this is not a stable statistical estimate.', '',
    '## Activation', ''];
  for (const p of report.probes) lines.push('- ' + p.arm + ': ' + (p.passed ? 'PASS' : 'FAIL') +
    '; shim calls ' + p.shim_calls + '; Razor denials ' + p.hooks.denied + '; active injections ' + p.hooks.active_injections + '.');
  lines.push('', '## Results', '', '| Group | Arm | Completed | Correct | Safe | Joint pass | Mean coding LOC |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const group of ['full','counter','note']) for (const arm of ['baseline','razor']) {
    const cells = report.records.filter(r => r.group===group && r.arm===arm);
    if (!cells.length) continue;
    const valid = cells.filter(r=>r.status==='completed');
    const count = key => valid.filter(r=>r[key]===1).length;
    const coding = valid.filter(r => r.coding);
    const mean = coding.length ? coding.reduce((sum,r)=>sum+(r.total_loc||0),0)/coding.length : null;
    lines.push('| '+[group,arm,valid.length+'/'+cells.length,count('correct'),count('safe'),
      valid.filter(r=>r.correct===1&&r.safe===1).length,mean===null?'n/a':mean.toFixed(1)].join(' | ')+' |');
  }
  const pairs = report.records.filter(r=>r.arm==='razor'&&r.status==='completed'&&r.correct===1&&r.safe===1)
    .map(r=>({razor:r,base:report.records.find(b=>b.arm==='baseline'&&b.model===r.model&&b.effort===r.effort&&b.task===r.task&&b.repetition===r.repetition)}))
    .filter(p=>p.base&&p.base.status==='completed'&&p.base.model===p.razor.model&&p.base.correct===1&&p.base.safe===1);
  lines.push('', 'Efficiency ratios below use only pairs where BOTH arms pass correctness and safety.', '');
  for (const [label,value] of [
    ['LOC',r=>r.total_loc], ['Elapsed time',r=>r.elapsed_ms],
    ['Input tokens',r=>r.usage.input_tokens], ['Output tokens',r=>r.usage.output_tokens]]) {
    const ratios=pairs.filter(p=>typeof value(p.base)==='number'&&value(p.base)>0&&typeof value(p.razor)==='number')
      .map(p=>value(p.razor)/value(p.base));
    const ratio=median(ratios);
    lines.push('- '+label+': median Razor/baseline '+(ratio===null?'n/a':ratio.toFixed(3))+' ('+ratios.length+' pairs).');
  }
  lines.push('', '## Per task', '', '| Task | Rep | Arm | Status | Correct | Safe | LOC | Input | Cached input | Output | Seconds | Hook denials |',
    '| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const r of report.records) lines.push('| '+[r.task,r.repetition+1,r.arm,r.status,r.correct??'n/a',r.safe??'n/a',
    r.total_loc??'n/a',r.usage.input_tokens??'n/a',r.usage.cached_input_tokens??'n/a',r.usage.output_tokens??'n/a',
    (r.elapsed_ms/1000).toFixed(1),r.hooks.denied??'n/a'].join(' | ')+' |');
  lines.push('', '## Interpretation and cleanup', '',
    '- Original task seeds and scorers are reused; native usage is measured separately.',
    '- LOC measures physical added code lines for Git fixtures and source inventory for other fixtures; it is not semantic complexity.',
    '- Cached input is a subset of input, and reasoning output is a subset of output; neither is added twice.',
    '- Resumed sessions use the latest cumulative token snapshot. Main-thread usage does not include separate automatic-review threads.',
    '- Monetary cost is unavailable from this authenticated Codex stream; no dollar savings are claimed.',
    '- Shell reads are allowed in both arms because Codex uses its shell to inspect files. The same original no-run instruction applies to non-shell coding tiers.',
    '- Razor hooks are loaded from source through native hooks, with a trace wrapper forwarding exact output. Global plugin installation is not changed.',
    '- Hook observation adds process overhead to the Razor arm; timings include it.',
    '- All sessions, traces, temporary credentials, project files and scorer fixtures are removed after aggregation.',
    '- Cleanup verified: ' + report.cleanup_verified + '.', '');
  lines.push('## Editing comparison', '', '| Task | Rep | Both pass | Primary text identical | Baseline API references | Razor API references |',
    '| --- | ---: | --- | --- | --- | --- |');
  for(const pair of report.edit_pairs || []) {
    const baseline=report.records.find(r=>r.task===pair.task&&r.model===pair.model&&r.effort===(pair.effort??report.effort)&&r.repetition===pair.repetition&&r.arm==='baseline');
    const razor=report.records.find(r=>r.task===pair.task&&r.model===pair.model&&r.effort===(pair.effort??report.effort)&&r.repetition===pair.repetition&&r.arm==='razor');
    lines.push('| '+[pair.task,pair.repetition+1,pair.jointly_passing,pair.primary_text_identical??'n/a',
      baseline?.behavior?.api_markers?.join(', ')||'none',razor?.behavior?.api_markers?.join(', ')||'none'].join(' | ')+' |');
  }
  lines.push('', 'Text equality is measured before removing all generated code. Different text does not prove a semantic difference or a causal effect by itself.', '');
  if (report.scoring_adjustments) lines.push('## Scoring adjustments', '',
    '- Native Markdown links are scored as their visible labels. A directory named note-drift is not a user-facing drift note.',
    '- Four drift rows were rescored from inspected, completed native responses; original task scorers remained unchanged.', '');
  if (report.recovery) lines.push('## Execution continuity', '',
    '- A mistakenly broad pause interrupted the first segment. Its 48 completed cells were reconstructed from accepted patches and native token snapshots, with every correctness/safety/LOC value checked against the original console.',
    '- Only the remaining 28 cells were sampled afterward. Two interrupted, unfinished cells were excluded.',
    '- Recovered timing values retain the console precision of 0.1 second. Timing comparisons are exploratory.',
    '- Some baseline model cleanups removed project-local install logs. Only derived counts of observed commands are retained; raw transcripts were deleted. Later cells record their audit log outside the edited project.', '');
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  if(!argv.length || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: node codex-run.js --codex-bin <exe> --model <model> --effort <effort> --suite all --runs 2 --report <report.md>\nUse --probe for activation only; --selftest runs offline. Generated sessions/projects are always removed.\n');
    return 0;
  }
  const config = options(argv);
  const tasks = selectTasks(config);
  cancelled = false;
  if (config.selftest) {
    const result = spawnSync(process.execPath, [path.join(__dirname,'run.js'),'--selftest'], { stdio:'inherit', env:cleanEnv() });
    return result.status || 0;
  }
  const runtimeRun = spawnSync(config.bin,['--version'],{encoding:'utf8',windowsHide:true});
  if (runtimeRun.status!==0) throw new Error('Cannot execute Codex: '+config.bin);
  const provenance = {runtime:runtimeRun.stdout.trim(),
    source:spawnSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).stdout.trim(),
    instrument_hashes:instrumentHashes()};
  const previous = loadResume(config, provenance);
  const parent = path.join(ROOT,'benchmarks/runs');
  const tempParent = os.tmpdir();
  let runRoot = null;
  let home = null;
  const report = { model:config.model, effort:config.effort,...provenance,
    seed:config.seed,runs:config.runs,workers:config.workers,
    probes:[],records:previous ? previous.records.filter(record => record.status === 'completed') : [],cleanup_verified:false };
  if (previous) report.recovery = previous.recovery || { resumed_from_checkpoint: true };
  const checkpointFile = config.report.replace(/\.md$/i,'') + '.checkpoint.json';
  const saveRecord = record => { report.records.push(record); checkpoint(checkpointFile, report); };
  let fatal = null;
  const onSignal = () => { cancelled = true; for(const child of active) killTree(child); };
  process.on('SIGINT',onSignal);
  process.on('SIGTERM',onSignal);
  try {
    fs.mkdirSync(parent,{recursive:true});
    runRoot = fs.mkdtempSync(path.join(parent,'codex-'));
    home = fs.mkdtempSync(path.join(tempParent,'razor-codex-home-'));
    setupHome(home);
    process.stdout.write('run root: '+runRoot+'\n');
    report.probes = await probe(config,runRoot,home);
    if (report.probes.some(p=>!p.passed)) throw new Error('Activation probe failed; benchmark not started');
    if (!config.probe) {
      const completed = new Set(report.records.map(recordKey));
      const queue = buildQueue(tasks,[config.model],['baseline','razor'],config.runs,config.seed)
        .filter(([task,arm,model,repetition]) => !completed.has(recordKey({task,arm,model,effort:config.effort,repetition})));
      process.stdout.write('remaining cells: ' + queue.length + '\n');
      let next = 0;
      async function worker() {
        while(next<queue.length && !cancelled) {
          if (fs.existsSync(path.join(runRoot, 'PAUSE'))) { cancelled = true; break; }
          const [task,arm,,rep] = queue[next++];
          process.stdout.write('start '+task+' / '+arm+' #'+rep+'\n');
          const record = await runCell(config,runRoot,home,task,arm,rep,saveRecord);
          process.stdout.write('done '+task+' / '+arm+' '+record.status+' correct='+record.correct+
            ' safe='+record.safe+' LOC='+record.total_loc+' ('+(record.elapsed_ms/1000).toFixed(1)+'s)\n');
        }
      }
      const settled = await Promise.allSettled(Array.from({length:config.workers},worker));
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      if (cancelled) throw new Error('Benchmark interrupted');
    }
  } catch(error) {
    fatal = error;
    report.error = error.message;
  } finally {
    for(const child of active) killTree(child);
    process.removeListener('SIGINT',onSignal);
    process.removeListener('SIGTERM',onSignal);
    report.cleanup_errors = [];
    for (const [base, owned] of [[tempParent,home],[parent,runRoot]]) {
      if (!owned) continue;
      try { removeOwned(base,owned); }
      catch (error) { report.cleanup_errors.push({path:owned,message:error.message}); }
    }
    report.cleanup_verified = (!home || !fs.existsSync(home)) && (!runRoot || !fs.existsSync(runRoot));
    if (!report.cleanup_verified && !fatal) fatal = new Error('Benchmark cleanup incomplete');
    report.summary = summarize(report.records);
    // Scorer reasons can include snippets of model output. Metrics only survive.
    report.edit_pairs = report.records.filter(r=>r.arm==='razor').map(r=> {
      const baseline = report.records.find(b=>b.arm==='baseline'&&b.model===r.model&&b.effort===r.effort&&b.task===r.task&&b.repetition===r.repetition);
      const a = baseline?.behavior?.primary, b = r.behavior?.primary;
      return {task:r.task,model:r.model,effort:r.effort,repetition:r.repetition,
        jointly_passing:!!(baseline&&baseline.status==='completed'&&r.status==='completed'&&baseline.correct===1&&baseline.safe===1&&r.correct===1&&r.safe===1),
        primary_text_identical:a?.present&&b?.present&&a.sha256&&b.sha256?a.sha256===b.sha256:null,
        whitespace_stripped_text_identical:a?.present&&b?.present&&a.whitespace_stripped_sha256&&b.whitespace_stripped_sha256?
          a.whitespace_stripped_sha256===b.whitespace_stripped_sha256:null};
    });
    report.records = report.records.map(({reason,...record})=> {
      if(record.behavior?.primary) {
        const {sha256,whitespace_stripped_sha256,...primary}=record.behavior.primary;
        record.behavior={...record.behavior,primary};
      }
      return record;
    });
    fs.mkdirSync(path.dirname(config.report),{recursive:true});
    fs.writeFileSync(config.report,reportText(report));
    fs.writeFileSync(config.report.replace(/\.md$/i,'')+'.json',JSON.stringify(report,null,2)+'\n');
    if (!config.probe && !fatal && report.records.every(record => record.status === 'completed')) {
      fs.rmSync(checkpointFile, {force:true});
    }
    process.stdout.write('report: '+config.report+'\ncleanup: '+report.cleanup_verified+'\n');
  }
  if(fatal) throw fatal;
  return report.records.some(r=>r.status!=='completed') ? 2 : 0;
}

if(require.main===module) main().then(code=>{process.exitCode=code;}).catch(error=>{
  process.stderr.write(error.message+'\n'); process.exitCode=1;
});
module.exports={options,selectTasks,contained,removeOwned,buildArgs,traceSummary,reportText,sumUsage,loadResume,checkpoint,recordKey,
  setupHome,writeShims,runTurn,readTrace,installEvidence,main};
