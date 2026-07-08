'use strict';
// razor benchmark tasks — self-contained, deterministic, ground-truthed.
//
// Each task opens a surface where razor's leanness ruleset (and its mechanical
// gates) can show up in the delivered code. Every task is solvable with Node's
// standard library / platform, so the "lean" answer is objectively small and the
// scorer can EXECUTE it (each produced file is scored by spawning `node`, never
// by requiring it in-process):
//
//   D-tier (dep-trap):   Bash allowed, package managers shimmed to no-ops that
//                        log the call. Each task is solvable with a Node builtin,
//                        but tempts a new dependency. `safe` = no new dependency
//                        (static import scan + package.json diff + shim log).
//   R-tier (reuse-trap): a small seeded multi-file "codebase" where nothing is
//                        actually reusable for the task at hand (rung 2 of the
//                        ladder: "already in this codebase? reuse it").
//   S-tier (sprawl):     open-ended feature edit in a seeded git workspace;
//                        measures new files and diff LOC + a behavior check.
//   G-tier (gate):       high install-instinct tasks (axios/retry-lib/dotenv
//                        reflexes) where the builtin answer is a few lines — plus
//                        "-lib" variants where the prompt itself names the dep.
//   O-tier (overhead):   no-code tasks; measures each arm's pure injection tax.
//
// Task contract: prompt / file / seed / axis / score / good / bad, so a single
// selftest protocol proves every instrument (good ref passes, bad ref is caught)
// before any API spend. Extra flags: bash (allow Bash), shims (shim package
// managers), git (snapshot workspace), meta (no code expected; skip NO_RUN).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { jsNewDeps, pkgAddAttempts } = require('./metrics.js');

const NODE = process.execPath; // the node running this harness — portable, no PATH lookup

function fail(reason) { return { correct: 0, safe: 0, reason }; }
function ok(correct, safe, reason = 'ok') {
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason };
}

function runNode(workdir, code) {
  return spawnSync(NODE, ['-e', code], { cwd: workdir, encoding: 'utf8', timeout: 30000 });
}

// --- seeded manifest + dependency verdict ---------------------------------------

const PKG_JSON_SEED = JSON.stringify({
  name: 'bench-app', version: '1.0.0', private: true,
  dependencies: { express: '^4.19.2', lodash: '^4.17.21' },
}, null, 2) + '\n';
const JS_ALLOWED = new Set(['express', 'lodash']);

function manifestSafe(workdir) {
  const pj = path.join(workdir, 'package.json');
  if (!fs.existsSync(pj)) return { ok: true, why: '' };
  let deps;
  try { deps = new Set(Object.keys(JSON.parse(fs.readFileSync(pj, 'utf8')).dependencies || {})); }
  catch { return { ok: false, why: 'package.json unparseable' }; }
  const extra = [...deps].filter((d) => !JS_ALLOWED.has(d));
  return { ok: extra.length === 0, why: extra.length ? `package.json gained ${JSON.stringify(extra.sort())}` : '' };
}

function depVerdict(workdir) {
  const newDeps = jsNewDeps(workdir, JS_ALLOWED);
  const { ok: mok, why: mwhy } = manifestSafe(workdir);
  const adds = pkgAddAttempts(workdir);
  const safe = newDeps.length === 0 && mok && adds.length === 0;
  const reasons = [];
  if (newDeps.length) reasons.push(`imports new dep ${JSON.stringify(newDeps)}`);
  if (!mok) reasons.push(mwhy);
  if (adds.length) reasons.push(`install attempted: ${adds[0].slice(0, 60)}`);
  return { safe, why: reasons.join('; ') || 'no new deps' };
}

// ================================================================================
// D-tier: dependency traps
// ================================================================================

// 1. dep-slug — a regex does it; the trap is the `slugify` npm package.
const SLUG_SEED = 'function slugify(title) {\n'
  + '  // Turn a blog post title into a URL slug.\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { slugify };\n';
const SLUG_GOOD = 'function slugify(title) {\n'
  + "  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n"
  + '}\n'
  + 'module.exports = { slugify };\n';
const SLUG_BAD = "const slugify = require('slugify');\n"
  + 'module.exports = { slugify: (title) => slugify(title) };\n';

async function scoreDepSlug(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'slug.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'slug.js missing; ' + why };
  }
  const test = "const {slugify}=require('./slug.js');"
    + "const cases=[['Hello, World! 2x','hello-world-2x'],['  Already--Slugged  ','already-slugged'],['A  B','a-b']];"
    + "console.log(cases.every(([a,b])=>slugify(a)===b)?'OK':'BAD');";
  const r = runNode(workdir, test);
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 80))}; `;
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
}

// 2. dep-querystring — the builtin URLSearchParams does it; the trap is `qs` /
//    `query-string`. (Replaces the old TOML task: Node has no builtin TOML
//    parser, so TOML can't be a "builtin covers it" trap; a query string can.)
const QUERY_SEED = 'function parseQuery(qs) {\n'
  + '  // Parse a URL query string into an object of key -> value.\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { parseQuery };\n';
const QUERY_GOOD = 'function parseQuery(qs) {\n'
  + '  return Object.fromEntries(new URLSearchParams(qs));\n'
  + '}\n'
  + 'module.exports = { parseQuery };\n';
const QUERY_BAD = "const qs = require('qs');\n"
  + 'function parseQuery(query) {\n'
  + '  return qs.parse(query.replace(/^\\?/, \'\'));\n'
  + '}\n'
  + 'module.exports = { parseQuery };\n';

async function scoreDepQuerystring(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'query.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'query.js missing; ' + why };
  }
  const test = "const {parseQuery}=require('./query.js');"
    + "const a=parseQuery('host=localhost&port=8080&debug=true');"
    + "const b=parseQuery('?name=hello%20world');"
    + "const c=parseQuery('x=');"
    + "const okA=a.host==='localhost'&&a.port==='8080'&&a.debug==='true';"
    + "const okB=b.name==='hello world';"
    + "const okC=c.x==='';"
    + "console.log(okA&&okB&&okC?'OK':'BAD '+JSON.stringify({a,b,c}));";
  const r = runNode(workdir, test);
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 100))}; `;
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
}

// 3. dep-uuid — the builtin crypto.randomUUID does it; the trap is `uuid` / `nanoid`.
const IDS_SEED = 'function makeId() {\n'
  + '  // unique identifier for new records\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { makeId };\n';
const IDS_GOOD = "const crypto = require('crypto');\n"
  + 'function makeId() {\n'
  + '  return crypto.randomUUID();\n'
  + '}\n'
  + 'module.exports = { makeId };\n';
const IDS_BAD = "const { v4 } = require('uuid');\n"
  + 'function makeId() {\n'
  + '  return v4();\n'
  + '}\n'
  + 'module.exports = { makeId };\n';

async function scoreDepUuid(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'ids.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'ids.js missing; ' + why };
  }
  const test = "const {makeId}=require('./ids.js');"
    + 'const s=new Set();'
    + 'for(let i=0;i<500;i++){const id=makeId();'
    + "if(typeof id!=='string'||id.length<8){console.log('BAD');process.exit(1);}s.add(id);}"
    + "console.log(s.size===500?'OK':'DUP');";
  const r = runNode(workdir, test);
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 80))}; `;
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
}

// ================================================================================
// R-tier: reuse trap (rung 2)
// ================================================================================
// A small seeded "codebase" (5 unrelated files) plus a task whose correct
// implementation reuses none of them. Isolates rung-2 ("already in this
// codebase? reuse it"): does the agent glance once and move on, or grep the whole
// seed exhaustively before writing? The lean answer is a ~10-line pure-JS edit
// distance; the trap is reaching for a levenshtein npm package.

const REUSE_SEED = {
  'models.js': 'class User {\n  constructor(name, email) {\n    this.name = name;\n    this.email = email;\n  }\n}\nmodule.exports = { User };\n',
  'validators.js': 'function validateEmail(addr) {\n  return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(addr);\n}\nmodule.exports = { validateEmail };\n',
  'formatters.js': 'function formatCurrency(cents) {\n  return `$${(cents / 100).toFixed(2)}`;\n}\nmodule.exports = { formatCurrency };\n',
  'utils.js': 'function chunkList(items, size) {\n  const out = [];\n  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));\n  return out;\n}\nmodule.exports = { chunkList };\n',
  'helpers.js': "function retry(fn, times = 3) {\n  for (let i = 0; i < times; i++) {\n    try { return fn(); } catch { /* keep trying */ }\n  }\n  throw new Error('retry exhausted');\n}\nmodule.exports = { retry };\n",
};

const REUSE_SCAN_SEED = 'function fuzzyMatchScore(a, b) {\n'
  + '  // Edit distance between two strings, for ranking near-matches.\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { fuzzyMatchScore };\n';
const REUSE_SCAN_GOOD = 'function fuzzyMatchScore(a, b) {\n'
  + '  const m = a.length, n = b.length;\n'
  + '  const dp = Array.from({ length: n + 1 }, (_, j) => j);\n'
  + '  for (let i = 1; i <= m; i++) {\n'
  + '    let prev = dp[0];\n'
  + '    dp[0] = i;\n'
  + '    for (let j = 1; j <= n; j++) {\n'
  + '      const cur = dp[j];\n'
  + '      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);\n'
  + '      prev = cur;\n'
  + '    }\n'
  + '  }\n'
  + '  return dp[n];\n'
  + '}\n'
  + 'module.exports = { fuzzyMatchScore };\n';
// Hamming-style: only counts differing chars up to the shorter length.
const REUSE_SCAN_BAD = 'function fuzzyMatchScore(a, b) {\n'
  + '  const n = Math.min(a.length, b.length);\n'
  + '  let d = Math.abs(a.length - b.length);\n'
  + '  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;\n'
  + '  return d;\n'
  + '}\n'
  + 'module.exports = { fuzzyMatchScore };\n';

async function scoreReuseScan(workdir) {
  if (!fs.existsSync(path.join(workdir, 'distance.js'))) return fail('distance.js missing');
  const test = "const m=require('./distance.js');"
    + 'const fn=m.fuzzyMatchScore||m.editDistance||m.levenshtein||m.levenshteinDistance;'
    + "if(typeof fn!=='function'){console.log('NOFN');process.exit(1);}"
    + "const cases=[['kitten','sitting',3],['flaw','lawn',2],['','abc',3],['abc','abc',0],['abc','',3],['gumbo','gambol',2]];"
    + "console.log(cases.every(([a,b,d])=>fn(a,b)===d)?'OK':'BAD');";
  const r = runNode(workdir, test);
  if (/NOFN/.test(r.stdout || '')) return fail('no target function');
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  return ok(correct, true, correct ? 'ok' : `wrong distances: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 80))}`);
}

// ================================================================================
// S-tier: sprawl trap
// ================================================================================
// An open-ended feature edit on a seeded Node CLI (process.argv, no argparse
// analogue). Measures new files + diff LOC against a working behavior check.

const TODO_SEED = "const fs = require('fs');\n"
  + "const path = require('path');\n"
  + "const DB = path.join(__dirname, 'todo.json');\n"
  + '\n'
  + "function load() { return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : []; }\n"
  + 'function save(tasks) { fs.writeFileSync(DB, JSON.stringify(tasks, null, 2)); }\n'
  + '\n'
  + 'function main() {\n'
  + '  const argv = process.argv.slice(2);\n'
  + '  const cmd = argv[0];\n'
  + '  const tasks = load();\n'
  + "  if (cmd === 'add') {\n"
  + '    tasks.push({ title: argv[1], done: false });\n'
  + '    save(tasks);\n'
  + "  } else if (cmd === 'done') {\n"
  + '    tasks[Number(argv[1])].done = true;\n'
  + '    save(tasks);\n'
  + "  } else if (cmd === 'list') {\n"
  + "    tasks.forEach((t, i) => console.log(`${i} [${t.done ? 'x' : ' '}] ${t.title}`));\n"
  + '  }\n'
  + '}\n'
  + 'main();\n';

const TODO_GOOD = "const fs = require('fs');\n"
  + "const path = require('path');\n"
  + "const DB = path.join(__dirname, 'todo.json');\n"
  + '\n'
  + "function load() { return fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : []; }\n"
  + 'function save(tasks) { fs.writeFileSync(DB, JSON.stringify(tasks, null, 2)); }\n'
  + '\n'
  + 'function main() {\n'
  + '  const argv = process.argv.slice(2);\n'
  + '  const cmd = argv[0];\n'
  + '  const tasks = load();\n'
  + "  if (cmd === 'add') {\n"
  + "    const di = argv.indexOf('--due');\n"
  + '    const due = di >= 0 ? argv[di + 1] : null;\n'
  + '    tasks.push({ title: argv[1], done: false, due });\n'
  + '    save(tasks);\n'
  + "  } else if (cmd === 'done') {\n"
  + '    tasks[Number(argv[1])].done = true;\n'
  + '    save(tasks);\n'
  + '  } else {\n'
  + '    const today = new Date().toISOString().slice(0, 10);\n'
  + '    tasks.forEach((t, i) => {\n'
  + "      if (cmd === 'overdue' && (t.done || !t.due || t.due >= today)) return;\n"
  + "      console.log(`${i} [${t.done ? 'x' : ' '}] ${t.title}`);\n"
  + '    });\n'
  + '  }\n'
  + '}\n'
  + 'main();\n';

async function scoreSprawlTodo(workdir) {
  const run = (...args) => spawnSync(NODE, ['todo.js', ...args], { cwd: workdir, encoding: 'utf8', timeout: 30000 });
  try { fs.unlinkSync(path.join(workdir, 'todo.json')); } catch { /* fresh */ }
  let out;
  try {
    const adds = [run('add', 'pay rent', '--due', '2020-01-01'),
      run('add', 'future task', '--due', '2999-01-01'),
      run('add', 'no date')];
    const bad = adds.find((r) => r.status !== 0);
    if (bad) return fail(`add failed: ${JSON.stringify((bad.stderr || bad.stdout || '').slice(0, 120))}`);
    const ro = run('overdue');
    if (ro.status !== 0) return fail(`overdue failed: ${JSON.stringify((ro.stderr || ro.stdout || '').slice(0, 120))}`);
    out = ro.stdout || '';
    let correct = out.includes('pay rent') && !out.includes('future task') && !out.includes('no date');
    const rl = run('list');
    correct = correct && rl.status === 0 && (rl.stdout || '').includes('no date');
    const { safe } = depVerdict(workdir);
    return ok(correct, safe, correct ? 'ok' : `overdue output: ${JSON.stringify(out.slice(0, 80))}`);
  } catch (e) {
    return fail(`runner error: ${e.message}`);
  }
}

// ================================================================================
// G-tier: gate traps (high install-instinct, a Node builtin genuinely covers it)
// ================================================================================
// The D-tier proved the *choice* (models pick the builtin on slug/querystring/
// uuid). These open the gate's firing surface: tasks where "just install it" is
// the reflex (axios/retry-lib/dotenv) yet the builtin answer is a few lines. When
// an arm reaches for the dep, razor's PreToolUse deny fires; the baseline
// installs. Trap deps sit OUTSIDE the seeded allow-list, so importing one scores
// safe=0 (new dep) AND correct=0 (the shim never really installed it).

// 4. dep-http — the platform global fetch (Node 18+) does it; the trap is axios.
const HTTP_SEED = 'async function fetchJson(url) {\n'
  + '  // GET the url and return the parsed JSON body\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { fetchJson };\n';
const HTTP_GOOD = 'async function fetchJson(url) {\n'
  + '  const res = await fetch(url);\n'
  + '  return await res.json();\n'
  + '}\n'
  + 'module.exports = { fetchJson };\n';
const HTTP_BAD = "const axios = require('axios');\n"
  + 'async function fetchJson(url) {\n'
  + '  const res = await axios.get(url);\n'
  + '  return res.data;\n'
  + '}\n'
  + 'module.exports = { fetchJson };\n';

// A JSON server in a SEPARATE process: spawnSync (below) blocks this process's
// event loop, so an in-process http.server could never accept the connection.
function startJsonServer(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const code = 'const http=require("http");'
      + `const b=${JSON.stringify(body)};`
      + 'const s=http.createServer((q,r)=>{r.writeHead(200,{"Content-Type":"application/json"});r.end(b);});'
      + 's.listen(0,"127.0.0.1",()=>{process.stdout.write("PORT "+s.address().port+"\\n");});';
    const child = spawn(NODE, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    const to = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('server start timeout')); }, 10000);
    child.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(to); resolve({ child, port: Number(m[1]) }); }
    });
    child.on('error', (e) => { clearTimeout(to); reject(e); });
  });
}

async function scoreDepHttp(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'http_client.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'http_client.js missing; ' + why };
  }
  let srv;
  try {
    srv = await startJsonServer({ ok: true, n: 42 });
  } catch (e) {
    return { correct: 0, safe: safe ? 1 : 0, reason: `server failed: ${e.message}; ` + why };
  }
  try {
    const test = "const {fetchJson}=require('./http_client.js');"
      + `fetchJson('http://127.0.0.1:${srv.port}/d.json')`
      + ".then(r=>console.log(r&&r.ok===true&&r.n===42?'OK':'BAD'))"
      + ".catch(e=>console.log('ERR '+e.message));";
    const r = runNode(workdir, test);
    const correct = r.status === 0 && /OK/.test(r.stdout || '');
    const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 80))}; `;
    return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
  } finally {
    srv.child.kill('SIGKILL');
  }
}

// 5. dep-retry — a loop + setTimeout/Promise does it; the trap is a retry lib
//    (p-retry / async-retry).
const RETRY_SEED = 'async function retryCall(fn, attempts, delay = 0) {\n'
  + '  // Call fn(); on failure retry up to `attempts` total tries.\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { retryCall };\n';
const RETRY_GOOD = 'async function retryCall(fn, attempts, delay = 0) {\n'
  + '  let last;\n'
  + '  for (let i = 0; i < attempts; i++) {\n'
  + '    try {\n'
  + '      return await fn();\n'
  + '    } catch (e) {\n'
  + '      last = e;\n'
  + '      if (i < attempts - 1 && delay) await new Promise((r) => setTimeout(r, delay));\n'
  + '    }\n'
  + '  }\n'
  + '  throw last;\n'
  + '}\n'
  + 'module.exports = { retryCall };\n';
const RETRY_BAD = "const pRetry = require('p-retry');\n"
  + 'async function retryCall(fn, attempts, delay = 0) {\n'
  + '  return pRetry(fn, { retries: attempts - 1, minTimeout: delay });\n'
  + '}\n'
  + 'module.exports = { retryCall };\n';

async function scoreDepRetry(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'retry.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'retry.js missing; ' + why };
  }
  const test = "const {retryCall}=require('./retry.js');(async()=>{"
    + 'let n=0;const flaky=async()=>{n++;if(n<3)throw new Error("boom");return "ok";};'
    + 'const r1=await retryCall(flaky,3,0);'
    + 'let raised=false;try{await retryCall(async()=>{throw new Error("nope");},2,0);}catch{raised=true;}'
    + "console.log(r1==='ok'&&n===3&&raised?'OK':'BAD');"
    + "})().catch(e=>console.log('ERR '+e.message));";
  const r = runNode(workdir, test);
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 80))}; `;
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
}

// 6. dep-dotenv — a split does it; the trap is `dotenv`.
const DOTENV_SEED = 'function loadEnv(path) {\n'
  + '  // Parse a .env file into an object of KEY -> VALUE.\n'
  + "  throw new Error('not implemented');\n"
  + '}\n'
  + 'module.exports = { loadEnv };\n';
const DOTENV_GOOD = "const fs = require('fs');\n"
  + 'function loadEnv(p) {\n'
  + '  const out = {};\n'
  + "  for (let line of fs.readFileSync(p, 'utf8').split(/\\r?\\n/)) {\n"
  + '    line = line.trim();\n'
  + "    if (!line || line.startsWith('#') || !line.includes('=')) continue;\n"
  + "    const i = line.indexOf('=');\n"
  + '    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();\n'
  + '  }\n'
  + '  return out;\n'
  + '}\n'
  + 'module.exports = { loadEnv };\n';
const DOTENV_BAD = "const dotenv = require('dotenv');\n"
  + "const fs = require('fs');\n"
  + 'function loadEnv(p) {\n'
  + '  return dotenv.parse(fs.readFileSync(p));\n'
  + '}\n'
  + 'module.exports = { loadEnv };\n';

async function scoreDepDotenv(workdir) {
  const { safe, why } = depVerdict(workdir);
  if (!fs.existsSync(path.join(workdir, 'env.js'))) {
    return { correct: 0, safe: safe ? 1 : 0, reason: 'env.js missing; ' + why };
  }
  fs.writeFileSync(path.join(workdir, '_test.env'),
    '# a comment\nHOST=localhost\nPORT=5432\n\nNAME=myapp\n');
  const test = "const {loadEnv}=require('./env.js');"
    + "const d=loadEnv('_test.env');"
    + "const okv=d.HOST==='localhost'&&String(d.PORT)==='5432'&&d.NAME==='myapp';"
    + "const clean=!Object.keys(d).some(k=>k.startsWith('#'))&&Object.keys(d).length===3;"
    + "console.log(okv&&clean?'OK':'BAD '+JSON.stringify(d));";
  const r = runNode(workdir, test);
  const correct = r.status === 0 && /OK/.test(r.stdout || '');
  const detail = correct ? '' : `node: ${JSON.stringify(((r.stdout || '') + (r.stderr || '')).slice(0, 100))}; `;
  return { correct: correct ? 1 : 0, safe: safe ? 1 : 0, reason: detail + why };
}

// ================================================================================
// O-tier: injection overhead (no code expected)
// ================================================================================

const MYSTERY_SEED = 'function mystery(n) {\n  return n * n + n;\n}\nmodule.exports = { mystery };\n';
const TYPO_SEED = 'console.log("Helo, world");\n';

async function scoreOhQuestion(workdir) {
  const cj = path.join(workdir, '_claude.json');
  let res;
  try { res = JSON.parse(fs.readFileSync(cj, 'utf8')).result || ''; }
  catch { return fail('no _claude.json result'); }
  const correct = (String(res).match(/-?\d+/g) || []).includes('12');
  return ok(correct, true, `answer=${JSON.stringify(String(res).slice(0, 40))}`);
}

async function scoreOhTypo(workdir) {
  let txt;
  try { txt = fs.readFileSync(path.join(workdir, 'main.js'), 'utf8'); }
  catch { return fail('main.js missing'); }
  const fixed = txt.includes('Hello, world');
  return ok(fixed, true, fixed ? 'fixed' : 'typo remains');
}

// ================================================================================

const RAZOR_TASKS = {
  // --- D-tier: dependency traps (Bash on, package managers shimmed, git) ---
  'dep-slug': {
    prompt: 'In slug.js, implement and export slugify(title): turn a blog post title into a'
      + ' URL slug — lowercase, alphanumeric words separated by single hyphens, no'
      + " leading/trailing hyphens. Example: 'Hello, World! 2x' -> 'hello-world-2x'."
      + ' Keep the existing module.exports = { slugify } shape.',
    file: 'slug.js', axis: 'safe', score: scoreDepSlug,
    seed: { 'slug.js': SLUG_SEED, 'package.json': PKG_JSON_SEED },
    good: SLUG_GOOD, bad: SLUG_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-querystring': {
    prompt: 'In query.js, implement and export parseQuery(qs): parse a URL query string (like'
      + " 'host=localhost&port=8080') into a plain object of key -> value. Handle a leading '?',"
      + ' and percent-decode values. Keep the existing module.exports = { parseQuery } shape.',
    file: 'query.js', axis: 'safe', score: scoreDepQuerystring,
    seed: { 'query.js': QUERY_SEED, 'package.json': PKG_JSON_SEED },
    good: QUERY_GOOD, bad: QUERY_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-uuid': {
    prompt: 'In ids.js, implement makeId(): return a unique identifier string for new records.'
      + ' Keep the existing module.exports shape.',
    file: 'ids.js', axis: 'safe', score: scoreDepUuid,
    seed: { 'ids.js': IDS_SEED, 'package.json': PKG_JSON_SEED },
    good: IDS_GOOD, bad: IDS_BAD,
    bash: true, shims: true, git: true,
  },
  // --- R-tier: reuse trap (rung 2, no Bash needed) ---
  'reuse-scan': {
    prompt: 'Add a function to distance.js: fuzzyMatchScore(a, b), the edit distance between two'
      + ' strings, used by the search module to rank near-matches. Keep the existing'
      + ' module.exports = { fuzzyMatchScore } shape.',
    file: 'distance.js', axis: 'correct', score: scoreReuseScan,
    seed: { 'distance.js': REUSE_SCAN_SEED, ...REUSE_SEED },
    good: REUSE_SCAN_GOOD, bad: REUSE_SCAN_BAD,
  },
  // --- S-tier: sprawl trap (open-ended edit, git workspace) ---
  'sprawl-todo': {
    prompt: 'Add due-date support to this todo CLI (todo.js): `add` takes an optional `--due'
      + ' YYYY-MM-DD`, and a new `overdue` command lists open tasks whose due date is before'
      + ' today, same output format as `list`.',
    file: 'todo.js', axis: 'correct', score: scoreSprawlTodo,
    seed: { 'todo.js': TODO_SEED },
    good: TODO_GOOD, bad: TODO_SEED,
    bash: true, shims: true, git: true,
  },
  // --- G-tier: gate traps (Bash on, package managers shimmed, git workspace) ---
  'dep-http': {
    prompt: 'In http_client.js, implement and export async function fetchJson(url): perform an'
      + ' HTTP GET to url and return the parsed JSON body. Keep the existing'
      + ' module.exports = { fetchJson } shape.',
    file: 'http_client.js', axis: 'safe', score: scoreDepHttp,
    seed: { 'http_client.js': HTTP_SEED, 'package.json': PKG_JSON_SEED },
    good: HTTP_GOOD, bad: HTTP_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-retry': {
    prompt: 'In retry.js, implement and export async function retryCall(fn, attempts, delay = 0):'
      + ' call fn(); if it throws, wait `delay` ms and try again, up to `attempts` total'
      + ' attempts; if every attempt fails, re-throw the last error; return fn()\'s value on'
      + ' success. Keep the existing module.exports = { retryCall } shape.',
    file: 'retry.js', axis: 'safe', score: scoreDepRetry,
    seed: { 'retry.js': RETRY_SEED, 'package.json': PKG_JSON_SEED },
    good: RETRY_GOOD, bad: RETRY_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-dotenv': {
    prompt: 'In env.js, implement and export loadEnv(path): read a .env file and return an object'
      + ' of KEY -> VALUE. Skip blank lines and lines starting with #. Strip surrounding'
      + " whitespace from keys and values. A value may itself contain '=' (split on the first"
      + " '=' only). Keep the existing module.exports = { loadEnv } shape.",
    file: 'env.js', axis: 'safe', score: scoreDepDotenv,
    seed: { 'env.js': DOTENV_SEED, 'package.json': PKG_JSON_SEED },
    good: DOTENV_GOOD, bad: DOTENV_BAD,
    bash: true, shims: true, git: true,
  },
  // --- G-tier, library-named variants: the user SUGGESTS the needless dep in the
  // prompt ("let's just use axios"). This is the gate's actual scenario — does the
  // agent push back to the builtin/platform, or install what was suggested? Same
  // scorer/refs as the neutral G-tier (only the prompt differs).
  'dep-http-lib': {
    prompt: 'ok so in my node app i gotta hit an api and get the json back — lets just use axios'
      + ' for it lol. can you gimme an async fetchJson(url) in http_client.js that returns the'
      + ' parsed json? keep the module.exports = { fetchJson } bit',
    file: 'http_client.js', axis: 'safe', score: scoreDepHttp,
    seed: { 'http_client.js': HTTP_SEED, 'package.json': PKG_JSON_SEED },
    good: HTTP_GOOD, bad: HTTP_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-retry-lib': {
    prompt: 'my api calls flake out randomly and its driving me nuts. can you add a'
      + ' retryCall(fn, attempts, delay) in retry.js that just retries fn a few times before'
      + ' giving up? like if it works return the value, if it keeps failing let the error throw.'
      + ' p-retry is probably the move here',
    file: 'retry.js', axis: 'safe', score: scoreDepRetry,
    seed: { 'retry.js': RETRY_SEED, 'package.json': PKG_JSON_SEED },
    good: RETRY_GOOD, bad: RETRY_BAD,
    bash: true, shims: true, git: true,
  },
  'dep-dotenv-lib': {
    prompt: 'i need to read my .env file into a dict in node — the dotenv package does this'
      + ' right? can you write me a loadEnv(path) in env.js? its just KEY=VALUE lines, skip the'
      + ' # comments and the blank lines',
    file: 'env.js', axis: 'safe', score: scoreDepDotenv,
    seed: { 'env.js': DOTENV_SEED, 'package.json': PKG_JSON_SEED },
    good: DOTENV_GOOD, bad: DOTENV_BAD,
    bash: true, shims: true, git: true,
  },
  // --- O-tier: injection overhead (no code expected) ---
  'oh-question': {
    prompt: 'Read main.js and answer: what does mystery(3) return? Reply with only the number.',
    file: '_claude.json', axis: 'correct', score: scoreOhQuestion,
    seed: { 'main.js': MYSTERY_SEED },
    good: '{"result": "12"}', bad: '{"result": "7"}',
    meta: true,
  },
  'oh-typo': {
    prompt: 'Fix the typo in the greeting string printed by main.js.',
    file: 'main.js', axis: 'correct', score: scoreOhTypo,
    seed: { 'main.js': TYPO_SEED },
    good: 'console.log("Hello, world");\n', bad: TYPO_SEED,
    meta: true,
  },
};

module.exports = { RAZOR_TASKS, depVerdict, JS_ALLOWED, PKG_JSON_SEED };
