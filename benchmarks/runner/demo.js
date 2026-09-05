'use strict';

// Draws the README's side-by-side replay (assets/demo.svg) from two real
// sessions of one task in a run directory: the file each session delivered,
// shown as a diff against the seed, one line at a time on the recorded clock,
// with what each one did to package.json underneath.
//
//   node runner/demo.js --run /tmp/razor-bench/20260901-012606 --task dep-http-lib
//     [--model opus] [--baseline <cell dir>] [--razor <cell dir>] [--out ../assets/demo.svg]
//
// Without --run it takes the newest run that has the task. Without --baseline
// it takes the first no-plugin session that added a package — that is the thing
// the picture is about, and the caption prints how many of them did, so nothing
// is hidden by the choice. Without --razor it takes the first razor session.
// Both themes ride on prefers-color-scheme, like bench-supplychain.svg.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RAZOR_TASKS } = require('./tasks.js');

const W = 700, PAD = 28, GAP = 22;
const COL = Math.floor((W - 2 * PAD - GAP) / 2);
const FS = 13, LH = 18, CPL = 40;
const RUN_S = 8, HOLD_S = 6, DUR = RUN_S + HOLD_S;
const RUNS_BASE = process.env.RAZOR_BENCH_RUNS
  ? path.resolve(process.env.RAZOR_BENCH_RUNS)
  : path.join(os.tmpdir(), 'razor-bench');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > width && line) { out.push(line); line = word; } else line = next;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

// Line diff by longest common subsequence: [{ kind: ctx|add|del, text }].
function diffLines(before, after) {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ kind: 'del', text: a[i] }); i++; }
    else { out.push({ kind: 'add', text: b[j] }); j++; }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

const fadeIn = (t) => `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${(t / DUR).toFixed(3)};${Math.min((t + 0.2) / DUR, 1).toFixed(3)};1" dur="${DUR}s" repeatCount="indefinite"/>`;

// One column: the diff, a line at a time across this session's share of the
// clock, then the package.json verdict. `pkgAdded` names any dependency the
// session put in package.json; a line that pulls one in is drawn as `bad`.
function column(x, side, slowMs, Y0) {
  const parts = [];
  const lines = side.lines;
  const total = lines.length + 1;
  const at = (i) => (side.ms * RUN_S / slowMs) * (i + 1) / total;
  const mono = ' font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"';
  let y = Y0;
  lines.forEach((l, i) => {
    const pulls = side.pkgAdded.some((dep) => l.text.includes(`'${dep}'`) || l.text.includes(`"${dep}"`));
    const cls = l.kind === 'del' ? 'mut' : pulls ? 'bad' : l.kind === 'add' ? 'ink' : 'ink2';
    const mark = l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' ';
    const chunks = wrap(l.text, CPL);
    parts.push(`<g opacity="0">${fadeIn(at(i))}`);
    chunks.forEach((c, k) => {
      parts.push(`<text class="${cls}" x="${x + 6}" y="${y}" font-size="${FS}"${mono}${l.kind === 'add' && !pulls ? ' font-weight="600"' : ''}>${esc(k === 0 ? `${mark} ${c}` : `    ${c}`)}</text>`);
      y += LH;
    });
    parts.push('</g>');
  });
  y += 8;
  const verdict = side.pkgAdded.length
    ? { cls: 'bad', text: `package.json  + ${side.pkgAdded.join(', ')}` }
    : { cls: 'cwt', text: 'package.json  unchanged' };
  parts.push(`<g opacity="0">${fadeIn(at(lines.length))}<text class="${verdict.cls}" x="${x + 6}" y="${y}" font-size="${FS}"${mono} font-weight="700">${esc(verdict.text)}</text></g>`);
  y += LH;
  return { svg: parts.join(''), bottom: y };
}

function demoSvg({ prompt, file, baseline, razor, counts }) {
  const slow = Math.max(baseline.ms, razor.ms);
  const xr = PAD + COL + GAP;
  const promptLines = wrap(`you: ${prompt}`, 96);
  const pillY = 62 + promptLines.length * LH + 4;
  const Y0 = pillY + 56;
  const left = column(PAD, baseline, slow, Y0);
  const right = column(xr, razor, slow, Y0);
  const H = Math.max(left.bottom, right.bottom) + 60;
  const label = `The same ask played twice, side by side. The prompt: ${prompt} `
    + `Without razor, Claude ${baseline.pkgAdded.length ? `added ${baseline.pkgAdded.join(' and ')} to package.json and wrote ${file} around it` : `wrote ${file} with no new package`}. `
    + `With razor, Claude ${razor.pkgAdded.length ? `added ${razor.pkgAdded.join(' and ')}` : `wrote ${file} with what Node already has and left package.json alone`}. `
    + `In this run, ${counts.baseUnsafe} of ${counts.baseN} sessions without razor added a package; ${counts.razorUnsafe} of ${counts.razorN} with razor did. `
    + 'One real session each on Claude Opus 5, replayed on the recorded wall clock.';
  const style = '<style>.card{fill:#fcfcfb;stroke:rgba(11,11,11,.07)}.ink{fill:#0b0b0b}.ink2{fill:#52514e}.mut{fill:#898781}'
    + '.bp{fill:#dcd9d0}.ac{fill:#059669}.bad{fill:#e0653f}.cwt{fill:#0a6b0a}.pillt{fill:#52514e}.you{fill:#52514e}'
    + '@media(prefers-color-scheme:dark){.card{fill:#161b22;stroke:#30363d}.ink{fill:#e6edf3}.ink2{fill:#b0b8c0}.mut{fill:#9198a1}'
    + '.bp{fill:#3d3c37}.ac{fill:#3fb950}.bad{fill:#f0876a}.cwt{fill:#3fb950}.pillt{fill:#9198a1}.you{fill:#b0b8c0}}</style>';
  const pill = (x, cls, tcls, text) => `<rect class="${cls}" x="${x}" y="${pillY}" width="${COL}" height="28" rx="14"/>`
    + `<text class="${tcls}" x="${x + COL / 2}" y="${pillY + 19}" font-size="15" font-weight="700" text-anchor="middle">${esc(text)}</text>`;
  const head = [`<text class="ink" x="${PAD + 8}" y="40" font-size="21" font-weight="800">Same ask, same file, both ways</text>`];
  let yy = 62;
  for (const p of promptLines) { head.push(`<text class="you" x="${PAD + 8}" y="${yy}" font-size="14" font-style="italic">${esc(p)}</text>`); yy += LH; }
  head.push(pill(PAD, 'bp', 'pillt', 'no plugin'), pill(xr, 'ac', 'card', 'razor'));
  head.push(`<text class="mut" x="${PAD + 6}" y="${Y0 - 20}" font-size="13">${esc(file)}</text><text class="mut" x="${xr + 6}" y="${Y0 - 20}" font-size="13">${esc(file)}</text>`);
  const foot = `<text class="mut" x="${PAD + 8}" y="${H - 22}" font-size="13.5">this run: ${counts.baseUnsafe} of ${counts.baseN} sessions without razor added a package · ${counts.razorUnsafe} of ${counts.razorN} with razor · Claude Opus 5, recorded clock</text>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif" role="img" aria-label="${esc(label)}">`
    + style
    + '<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="#0b0b0b" flood-opacity=".10"/></filter>'
    + `<rect class="card" x="8" y="6" width="${W - 16}" height="${H - 12}" rx="18" filter="url(#s)"/>`
    + head.join('') + left.svg + right.svg + foot + '</svg>';
  return { svg, label };
}

const depsOf = (pkg) => Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });

// Everything the picture needs from one cell directory of a run.
function readCell(runDir, cell, task) {
  const dir = path.join(runDir, cell);
  const delivered = fs.readFileSync(path.join(dir, task.file), 'utf8');
  const seedPkg = JSON.parse(task.seed['package.json']);
  let pkgAdded = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkgAdded = depsOf(pkg).filter((d) => !depsOf(seedPkg).includes(d));
  } catch { /* no package.json delivered: nothing added */ }
  const result = JSON.parse(fs.readFileSync(path.join(dir, '_claude.json'), 'utf8'));
  return { cell, lines: diffLines(task.seed[task.file], delivered), ms: result.duration_ms, pkgAdded };
}

function newestRunWith(taskId) {
  const dirs = fs.readdirSync(RUNS_BASE).sort().reverse();
  for (const d of dirs) {
    const run = path.join(RUNS_BASE, d);
    if (fs.existsSync(path.join(run, 'results.json')) && fs.readdirSync(run).some((c) => c.startsWith(`${taskId}__baseline__`))) return run;
  }
  throw new Error(`no run under ${RUNS_BASE} has a ${taskId} baseline cell`);
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const taskId = flag('task', 'dep-http-lib');
  const task = RAZOR_TASKS[taskId];
  if (!task) throw new Error(`no task ${taskId} in tasks.js`);
  const model = flag('model', 'opus');
  const runDir = path.resolve(flag('run', '') || newestRunWith(taskId));
  const out = path.resolve(flag('out', path.join(__dirname, '..', '..', 'assets', 'demo.svg')));
  const cells = (arm) => fs.readdirSync(runDir).filter((c) => c.startsWith(`${taskId}__${arm}__${model}__`)).sort();
  const raw = JSON.parse(fs.readFileSync(path.join(runDir, 'results.json'), 'utf8'));
  const rows = (Array.isArray(raw) ? raw : raw.results).filter((r) => r.task === taskId && r.model === model);
  const count = (arm) => ({ n: rows.filter((r) => r.arm === arm).length, unsafe: rows.filter((r) => r.arm === arm && !Number(r.safe)).length });
  const b = count('baseline'), z = count('razor');
  const baseCells = cells('baseline').map((c) => readCell(runDir, c, task));
  const razorCells = cells('razor').map((c) => readCell(runDir, c, task));
  if (!baseCells.length || !razorCells.length) throw new Error(`no ${taskId} cells for both arms in ${runDir}`);
  const pick = (list, name) => {
    if (!name) return null;
    const hit = list.find((c) => c.cell === name);
    if (!hit) throw new Error(`no cell ${name} among ${list.map((c) => c.cell).join(', ')}`);
    return hit;
  };
  const baseline = pick(baseCells, flag('baseline')) || baseCells.find((c) => c.pkgAdded.length) || baseCells[0];
  const razor = pick(razorCells, flag('razor')) || razorCells[0];
  const { svg, label } = demoSvg({
    prompt: task.prompt, file: task.file, baseline, razor,
    counts: { baseUnsafe: b.unsafe, baseN: b.n, razorUnsafe: z.unsafe, razorN: z.n },
  });
  fs.writeFileSync(out, svg);
  console.log(`wrote ${out} from ${baseline.cell} (+${baseline.pkgAdded.join(',') || 'nothing'}, ${baseline.ms} ms) and ${razor.cell} (+${razor.pkgAdded.join(',') || 'nothing'}, ${razor.ms} ms) in ${runDir}`);
  console.log(`alt text for the README:\n${label}`);
}

module.exports = { demoSvg, diffLines, wrap };

if (require.main === module) main();
