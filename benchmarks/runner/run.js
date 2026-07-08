#!/usr/bin/env node
'use strict';
// razor agentic benchmark — reproduce the README numbers yourself.
//
// Every cell is a real headless Claude Code session (`claude -p`) in an isolated,
// throwaway workspace, with exactly one plugin loaded via --plugin-dir (or none
// for the baseline). The user's globally-installed plugins are excluded from
// every cell via --setting-sources project,local, so nothing but the arm under
// test is active. Each cell is scored on the files the session leaves behind plus
// the CLI's own usage JSON (cost/tokens/duration). Produced code is scored by
// spawning `node` — never by requiring it in-process.
//
// Two arms ship by default:
//   baseline  no plugin — the fair agent baseline
//   razor     the razor plugin in this repo (../, or env RAZOR_DIR)
// Bring your own third arm with --rival-dir <path-to-a-plugin>.
//
//   node runner/run.js --selftest        # prove every instrument, no API spend. Run first.
//   node runner/run.js --smoke           # 1 cheap task x each arm x 1, verifies activation
//   node runner/run.js --default         # the default sweep (small, ~$1-3 on haiku)
//   node runner/run.js --full --runs 3   # every task, more reps
//   node runner/run.js --task dep-slug,oh-question --arms baseline,razor --runs 2
//   node runner/run.js --default --rival-dir /path/to/some/other/plugin
//   node runner/run.js --rescore <run-dir>   # recompute metrics offline, no API
//   node runner/report.js <run-dir>          # tables + SVG charts -> report.md

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { RAZOR_TASKS } = require('./tasks.js');
const {
  codeStats, gitSnapshot, gitDiffStats, gitNewFiles, pkgAddAttempts, chatCodeLoc, extractResult,
} = require('./metrics.js');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..'); // razor/benchmarks
// The razor plugin dir. This harness lives at razor/benchmarks/runner/, so the
// plugin is two levels up (razor/). Resolve it there or honour RAZOR_DIR — never
// a machine-specific absolute path.
const RAZOR_DIR = process.env.RAZOR_DIR ? path.resolve(process.env.RAZOR_DIR) : path.resolve(ROOT, '..');

const TASKS = RAZOR_TASKS;

// Arms: baseline + razor always, plus an optional user-supplied rival.
const ARM_DIRS = { razor: RAZOR_DIR };
const MODELS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-4-8' };

// A small default subset across the tiers so a curious run is cheap; --full runs everything.
const DEFAULT_TASKS = ['dep-slug', 'dep-querystring', 'reuse-scan', 'sprawl-todo', 'oh-question', 'oh-typo'];
const FULL_TASKS = Object.keys(TASKS);

// Cells run in a scratch dir OUTSIDE this repo's git tree, on purpose. A cell is
// a real Claude session with bypassPermissions; if it sat inside your project's
// working tree, an auto-commit (or a stray `git` the agent runs) could sweep
// files into your repo. Keeping every workspace under the system temp dir means a
// sandboxed session can never touch your project. Override with RAZOR_BENCH_RUNS.
const RUNS_DIR = process.env.RAZOR_BENCH_RUNS
  ? path.resolve(process.env.RAZOR_BENCH_RUNS)
  : path.join(os.tmpdir(), 'razor-bench');
const CELL_TIMEOUT_MS = 300000;

// Never let a cell's agent reach for version control or spawn subagents —
// belt-and-suspenders on top of the out-of-tree workspace.
const GUARD_TOOLS = ['Agent', 'Task', 'ScheduleWakeup', 'CronCreate', 'RemoteTrigger'];

// razor's deny/inject markers, counted in the raw stream to show gate behavior.
const MARKERS = {
  razor_dep_denies: 'adds a new ',       // dep-guard deny reason
  razor_file_denies: 'razor: new file #', // file-meter deny reason
  razor_ledger: 'razor ledger:',          // build-ledger question
};

const SHIM_MANAGERS = ['npm', 'pnpm', 'yarn', 'pip', 'pip3', 'poetry', 'uv'];

// Added to every arm's system prompt, identically, on the Bash-disallowed code
// tiers. We measure code PRODUCTION, not execution: agents write the
// implementation and stop, so a flailing verify loop can't inflate tokens/time.
const NO_RUN = 'Write the implementation (include tests if you normally would for a change like '
  + 'this). Do not run a dev server, install dependencies, run a database, or open a browser to '
  + 'verify -- just write the code and stop. Only the code you write is measured, not its execution.';

// --- CLI args ---------------------------------------------------------------
const argv = process.argv.slice(2);
function has(name) { return argv.includes(`--${name}`); }
function flag(name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
}

// --- claude resolution + arg quoting ---------------------------------------
// Resolve the claude binary so we can spawn with shell:false where possible
// (args with spaces — NO_RUN, plugin paths — survive intact). On Windows claude
// is a .cmd, which needs a shell; there we build a quoted command line instead.
function whichClaude() {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch { /* skip */ }
    }
  }
  return null;
}
const CLAUDE = whichClaude();
const CLAUDE_NEEDS_SHELL = CLAUDE ? /\.(cmd|bat)$/i.test(CLAUDE) : true;

function quoteArg(a) {
  if (/[\s"^&|<>()]/.test(a)) return '"' + String(a).replace(/"/g, '\\"') + '"';
  return a;
}

let _claudeVersion = null;
function claudeVersion() {
  if (_claudeVersion !== null) return _claudeVersion;
  try {
    const bin = CLAUDE || 'claude';
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', shell: CLAUDE_NEEDS_SHELL });
    _claudeVersion = (r.stdout || '').trim() || 'unknown';
  } catch { _claudeVersion = 'unknown'; }
  return _claudeVersion;
}

// --- cell environment + shims ----------------------------------------------

// Package managers become no-ops that log the call: installs are observed, never
// executed. razor's PreToolUse deny fires BEFORE the shim, so a razor-arm agent
// that backs off after the deny leaves the log empty; one that retries is logged.
function writeShims(ws) {
  const d = path.join(ws, '_shims');
  fs.mkdirSync(d, { recursive: true });
  for (const name of SHIM_MANAGERS) {
    const sh = path.join(d, name);
    fs.writeFileSync(sh,
      '#!/bin/sh\n'
      + `echo "${name} $*" >> "$(dirname "$0")/../_pkgmgr.log"\n`
      + 'echo "(shim) ok"\nexit 0\n');
    try { fs.chmodSync(sh, 0o755); } catch { /* windows */ }
    fs.writeFileSync(path.join(d, `${name}.cmd`),
      '@echo off\r\n'
      + `echo ${name} %* >> "%~dp0..\\_pkgmgr.log"\r\n`
      + 'echo (shim) ok\r\n');
  }
  return d;
}

function cellEnv(shimDir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(RAZOR_|HUSH_)/.test(k)) continue; // don't leak this session's plugin config
    env[k] = v;
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (shimDir) env.PATH = shimDir + path.delimiter + (env.PATH || '');
  return env;
}

// --- scoring ----------------------------------------------------------------

async function scoreCell(taskId, arm, model, ws) {
  const task = TASKS[taskId];
  const raw = extractResult(ws);
  const meta = {};
  let resultText = '';
  const cj = path.join(ws, '_claude.json');
  if (fs.existsSync(cj)) {
    try {
      const j = JSON.parse(fs.readFileSync(cj, 'utf8'));
      const u = j.usage || {};
      meta.cost = j.total_cost_usd;
      meta.duration_ms = j.duration_ms;
      meta.turns = j.num_turns;
      meta.denials = (j.permission_denials || []).length;
      meta.out_tokens = u.output_tokens;
      meta.in_tokens = u.input_tokens;
      meta.cache_tokens = (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      resultText = j.result || '';
      if (j.is_error || j.api_error_status) {
        return { task: taskId, arm, model,
          error: `api_error ${j.api_error_status}: ${String(resultText).slice(0, 120)}` };
      }
    } catch { resultText = ''; }
  }
  for (const [key, marker] of Object.entries(MARKERS)) {
    meta[key] = raw.split(marker).length - 1;
  }
  meta.install_attempts = pkgAddAttempts(ws).length;

  const surgical = !task.open && !task.fixture && !task.meta;
  let stats;
  if (task.meta) {
    stats = { files: 0, src_files: 0, total_loc: 0, src_loc: 0, test_files: 0, test_loc: 0, new_files: 0 };
  } else if (task.fixture || task.git) {
    stats = gitDiffStats(ws);
    stats.new_files = gitNewFiles(ws);
  } else {
    stats = codeStats(ws, surgical);
    stats.new_files = stats.src_files || 0;
  }
  if (task.open && stats.total_loc === 0 && resultText) {
    const [t, c] = chatCodeLoc(resultText);
    stats = { ...stats, total_loc: t, src_loc: c, src_files: t ? 1 : 0 };
  }

  let sc;
  if (task.fixture) {
    sc = { correct: stats.total_loc > 0 ? 1 : 0, safe: 1, reason: 'git-diff' };
  } else {
    sc = await task.score(ws);
  }
  return { task: taskId, arm, model, ...sc, ...stats, ...meta };
}

// --- cell execution ---------------------------------------------------------

function buildArgs(task, arm, model) {
  const args = ['-p', '--model', MODELS[model] || model,
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json', '--verbose',
    '--setting-sources', 'project,local', '--strict-mcp-config'];
  if (!task.bash) {
    args.push('--disallowedTools', ['Bash', 'PowerShell', ...GUARD_TOOLS].join(','));
  } else {
    // Bash-allowed tiers still can't touch git or subagents.
    args.push('--disallowedTools', ['Bash(git*)', 'PowerShell(git*)', ...GUARD_TOOLS].join(','));
  }
  if (arm !== 'baseline') args.push('--plugin-dir', ARM_DIRS[arm]);
  // NO_RUN (identical for every arm) only on the Bash-disallowed code tiers.
  if (!task.meta && !task.bash) args.push('--append-system-prompt', NO_RUN);
  return args;
}

function spawnClaude(args, opts) {
  const bin = CLAUDE || 'claude';
  if (CLAUDE_NEEDS_SHELL) {
    // Windows .cmd needs a shell; pre-quote every arg so spaces (NO_RUN, paths)
    // survive the cmd.exe join.
    const cmdline = [bin, ...args].map(quoteArg).join(' ');
    return spawn(cmdline, { ...opts, shell: true });
  }
  return spawn(bin, args, { ...opts, shell: false });
}

function killTree(child) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch { /* already gone */ }
}

function runCell(taskId, arm, model, ws) {
  const task = TASKS[taskId];
  for (const [fn, content] of Object.entries(task.seed || {})) {
    fs.writeFileSync(path.join(ws, fn), content);
  }
  const shimDir = task.shims ? writeShims(ws) : null;
  if (task.git || task.fixture) gitSnapshot(ws);

  if (!CLAUDE) throw new Error('claude CLI not found on PATH');
  const args = buildArgs(task, arm, model);

  return new Promise((resolve) => {
    const outPath = path.join(ws, '_claude.stream.jsonl');
    const errPath = path.join(ws, '_claude.stderr.txt');
    const child = spawnClaude(args, { cwd: ws, env: cellEnv(shimDir) });
    const outFd = fs.createWriteStream(outPath);
    const errChunks = [];
    child.stdout.on('data', (d) => outFd.write(d));
    child.stderr.on('data', (d) => errChunks.push(d));
    child.stdin.write(task.prompt);
    child.stdin.end();

    let killed = false;
    const killer = setTimeout(() => { killed = true; killTree(child); }, CELL_TIMEOUT_MS);

    child.on('close', () => {
      clearTimeout(killer);
      outFd.end();
      let stderr = Buffer.concat(errChunks).toString('utf8');
      if (killed) stderr += `\n[KILLED after ${CELL_TIMEOUT_MS / 1000}s timeout]`;
      fs.writeFileSync(errPath, stderr);
      outFd.on('finish', () => {
        scoreCell(taskId, arm, model, ws)
          .then(resolve)
          .catch((e) => resolve({ task: taskId, arm, model, error: String(e).slice(0, 200) }));
      });
    });
  });
}

// --- selftest ---------------------------------------------------------------
// good ref must pass, bad ref must be caught, for every closed task — before spend.
async function selftest() {
  let failures = 0;
  for (const [tid, task] of Object.entries(TASKS)) {
    if (task.open || task.fixture) continue;
    const axis = task.axis || 'safe';
    for (const kind of ['good', 'bad']) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-selftest-'));
      try {
        for (const [fn, content] of Object.entries(task.seed || {})) {
          fs.writeFileSync(path.join(d, fn), content);
        }
        fs.writeFileSync(path.join(d, task.file), task[kind]);
        const r = await task.score(d);
        const okCell = kind === 'good'
          ? (r.correct === 1 && r.safe === 1)
          : (r[axis] === 0);
        console.log(`${okCell ? 'ok ' : 'XX '} ${tid.padEnd(16)} ${kind.padEnd(4)} `
          + `correct=${r.correct} safe=${r.safe} axis=${axis}  ${String(r.reason).slice(0, 70)}`);
        if (!okCell) failures++;
      } finally {
        fs.rmSync(d, { recursive: true, force: true });
      }
    }
  }
  for (const [arm, d] of Object.entries(ARM_DIRS)) {
    const okArm = fs.existsSync(path.join(d, '.claude-plugin', 'plugin.json'));
    console.log(`${okArm ? 'ok ' : 'XX '} plugin-dir     ${arm}: ${d}`);
    if (!okArm) failures++;
  }
  console.log(`\nselftest: ${failures ? `${failures} BROKEN` : 'all instruments valid'}`);
  return failures;
}

// --- aggregation + table ----------------------------------------------------

function median(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
function mean(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
const round = (x, d = 0) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

function aggregate(results) {
  const groups = new Map();
  for (const r of results) {
    if ('error' in r && !('correct' in r)) continue;
    const k = `${r.task}\u0000${r.arm}\u0000${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const rows = [];
  const medOf = (cells, key) => round(median(cells.map((c) => c[key])), 2);
  const meanOf = (cells, key, d = 4) => round(mean(cells.map((c) => c[key])), d);
  for (const [k, cells] of [...groups.entries()].sort()) {
    const [t, a, m] = k.split('\u0000');
    const n = cells.length;
    const locCells = cells.filter((c) => (c.total_loc || 0) > 0);
    const totalTokCells = cells.filter((c) => c.out_tokens !== null && c.out_tokens !== undefined);
    const durCells = cells.filter((c) => c.duration_ms !== null && c.duration_ms !== undefined);
    rows.push({
      task: t, arm: a, model: m, n,
      correct_rate: round(cells.reduce((s, c) => s + (c.correct || 0), 0) / n, 3),
      safe_rate: round(cells.reduce((s, c) => s + (c.safe || 0), 0) / n, 3),
      total_loc_median: medOf(locCells, 'total_loc') || 0,
      src_loc_median: medOf(locCells, 'src_loc') || 0,
      src_files_median: medOf(locCells, 'src_files') || 0,
      new_files_median: medOf(cells, 'new_files'),
      cost_mean: meanOf(cells, 'cost'),
      out_tokens_mean: meanOf(cells, 'out_tokens', 0),
      total_tokens_mean: totalTokCells.length
        ? Math.round(mean(totalTokCells.map((c) => (c.in_tokens || 0) + (c.out_tokens || 0) + (c.cache_tokens || 0))))
        : null,
      time_s_mean: durCells.length ? round(mean(durCells.map((c) => c.duration_ms / 1000)), 1) : null,
      turns_mean: meanOf(cells, 'turns', 1),
      install_attempts_mean: meanOf(cells, 'install_attempts', 2),
      razor_dep_denies_mean: meanOf(cells, 'razor_dep_denies', 2),
      razor_file_denies_mean: meanOf(cells, 'razor_file_denies', 2),
      razor_ledger_mean: meanOf(cells, 'razor_ledger', 2),
    });
  }
  return rows;
}

function printTable(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.task}\u0000${r.model}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const pad = (s, w) => String(s).padStart(w);
  for (const [k, rs] of [...by.entries()].sort()) {
    const [task, model] = k.split('\u0000');
    console.log(`\n=== ${task}  (${model}, n=${rs[0].n}) ===`);
    console.log(`  ${'arm'.padEnd(10)} ${pad('correct', 8)} ${pad('safe', 6)} ${pad('LOC', 6)} `
      + `${pad('files', 6)} ${pad('tot_tok', 9)} ${pad('$/run', 9)} ${pad('time_s', 7)} ${pad('installs', 9)}`);
    for (const r of rs.sort((x, y) => x.arm.localeCompare(y.arm))) {
      const cost = r.cost_mean !== null ? '$' + r.cost_mean.toFixed(4) : '-';
      console.log(`  ${r.arm.padEnd(10)} ${pad(r.correct_rate, 8)} ${pad(r.safe_rate, 6)} `
        + `${pad(r.total_loc_median, 6)} ${pad(r.src_files_median, 6)} `
        + `${pad(r.total_tokens_mean ?? '-', 9)} ${pad(cost, 9)} ${pad(r.time_s_mean ?? '-', 7)} `
        + `${pad(r.install_attempts_mean ?? '-', 9)}`);
    }
  }
}

// --- rescore ----------------------------------------------------------------

async function rescore(runDirArg) {
  let runDir = path.resolve(runDirArg);
  if (!fs.existsSync(runDir)) runDir = path.join(RUNS_DIR, path.basename(runDirArg));
  const results = [];
  for (const name of fs.readdirSync(runDir).sort()) {
    const ws = path.join(runDir, name);
    if (!fs.statSync(ws).isDirectory()) continue;
    const parts = name.split('__');
    if (parts.length !== 4 || !(parts[0] in TASKS)) continue;
    const [tid, arm, model] = parts;
    results.push(await scoreCell(tid, arm, model, ws));
  }
  const rows = aggregate(results);
  fs.writeFileSync(path.join(runDir, 'results.json'), JSON.stringify({ rescored: true, results }, null, 2));
  fs.writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(rows, null, 2));
  printTable(rows);
  console.log(`\nrescored ${results.length} cells from ${runDir}`);
}

// --- main -------------------------------------------------------------------

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const rivalDir = flag('rival-dir', null);
  if (rivalDir) ARM_DIRS[flag('rival-name', 'rival')] = path.resolve(rivalDir);

  if (has('selftest')) process.exit((await selftest()) ? 1 : 0);
  const rescoreArg = flag('rescore', null);
  if (rescoreArg) return rescore(rescoreArg);

  if (await selftest()) {
    console.error('instruments broken; refusing to spend on the API');
    process.exit(1);
  }

  let taskIds;
  let runs = Number(flag('runs', 2));
  if (has('smoke')) { taskIds = ['oh-question']; runs = 1; }
  else if (has('default')) taskIds = DEFAULT_TASKS;
  else if (has('full')) taskIds = FULL_TASKS;
  else if (flag('task', null)) taskIds = flag('task').split(',').map((t) => t.trim());
  else { console.error('give --default, --full, --task, --smoke, or --rescore'); process.exit(1); }

  const unknown = taskIds.filter((t) => !(t in TASKS));
  if (unknown.length) { console.error(`unknown tasks: ${unknown}`); process.exit(1); }

  const rivalName = rivalDir ? flag('rival-name', 'rival') : null;
  const defaultArms = ['baseline', 'razor', ...(rivalDir ? [rivalName] : [])];
  const arms = flag('arms', null) ? flag('arms').split(',').map((a) => a.trim()) : defaultArms;
  const badArms = arms.filter((a) => a !== 'baseline' && !(a in ARM_DIRS));
  if (badArms.length) { console.error(`unknown arms ${badArms} (rival needs --rival-dir)`); process.exit(1); }

  const models = flag('models', 'haiku').split(',').map((m) => m.trim());
  const workers = Number(flag('workers', 4));
  const stamp = stampNow();
  const outDir = path.join(RUNS_DIR, stamp);
  fs.mkdirSync(outDir, { recursive: true });

  const cells = [];
  for (const tid of taskIds) for (const model of models) for (const arm of arms) {
    for (let r = 0; r < runs; r++) cells.push([tid, arm, model, r]);
  }
  const total = cells.length;
  const results = [];
  let done = 0;

  const writeResults = () => fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({
    date: stamp,
    models: Object.fromEntries(models.map((m) => [m, MODELS[m] || m])),
    claude: claudeVersion(),
    arms: Object.fromEntries(arms.map((a) => [a, ARM_DIRS[a] || 'none'])),
    results,
  }, null, 2));

  console.log(`running ${total} cells, ${workers} at a time -> ${outDir}`);

  let idx = 0;
  async function worker() {
    while (idx < cells.length) {
      const [tid, arm, model, r] = cells[idx++];
      const ws = path.join(outDir, `${tid}__${arm}__${model}__${r}`);
      fs.mkdirSync(ws, { recursive: true });
      let res;
      try { res = await runCell(tid, arm, model, ws); }
      catch (e) { res = { task: tid, arm, model, error: String(e).slice(0, 200) }; }
      results.push(res);
      done++;
      console.log(`  [${done}/${total}] ${tid} / ${arm} #${r}  LOC=${res.total_loc} `
        + `correct=${res.correct} safe=${res.safe} cost=$${res.cost} installs=${res.install_attempts}`);
      writeResults();
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, cells.length) }, worker));

  const rows = aggregate(results);
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(rows, null, 2));
  printTable(rows);
  console.log(`\nwrote ${outDir}${path.sep}results.json + summary.json (${results.length} cells)`);
  console.log(`\nnext: node runner/report.js ${outDir}`);
}

main();
