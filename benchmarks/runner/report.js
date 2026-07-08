#!/usr/bin/env node
'use strict';
// Turn a run's summary.json into report.md (tables) + charts.svg (grouped bars).
//
//   node runner/report.js <run-dir>
//
// Charts are hand-rolled SVG, no dependencies. The headline chart shows each arm
// as a percent of the no-plugin baseline (median of per-task ratios) on LOC,
// total tokens, cost and time — lower is better, dashed 100 line is the baseline.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Same out-of-tree location run.js writes runs to (kept in sync via RAZOR_BENCH_RUNS).
const RUNS_BASE = process.env.RAZOR_BENCH_RUNS
  ? path.resolve(process.env.RAZOR_BENCH_RUNS)
  : path.join(os.tmpdir(), 'razor-bench');

const TIERS = {
  'dependency traps (Bash on, shimmed)': ['dep-slug', 'dep-querystring', 'dep-uuid',
    'dep-http', 'dep-retry', 'dep-dotenv'],
  'vibe-coder dep traps (prompt names the lib)': ['dep-http-lib', 'dep-retry-lib', 'dep-dotenv-lib'],
  'reuse trap': ['reuse-scan'],
  'sprawl trap (Bash on, git)': ['sprawl-todo'],
  'injection overhead (no code)': ['oh-question', 'oh-typo'],
};
const ARM_ORDER = ['baseline', 'razor', 'rival'];
const COLORS = { baseline: '#9aa0a6', razor: '#4a7bc9', rival: '#c96f4a' };

function median(xs) {
  const v = xs.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function load(runDir) {
  const rows = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
  const byTask = {};
  for (const r of rows) {
    (byTask[r.task] || (byTask[r.task] = {}))[r.arm] = r;
  }
  return { rows, byTask };
}

// Median over tasks of arm_value / baseline_value (tasks where baseline > 0).
function ratiosVsBaseline(byTask, arm, metric, tasks) {
  const rs = [];
  for (const t of tasks) {
    const b = byTask[t] && byTask[t].baseline;
    const a = byTask[t] && byTask[t][arm];
    if (!b || !a) continue;
    const bv = b[metric], av = a[metric];
    if (bv && av !== null && av !== undefined && bv > 0) rs.push(av / bv);
  }
  return rs.length ? median(rs) : null;
}

function barChart(title, groups, series, values, unit = '%', width = 760) {
  const nG = groups.length, nS = series.length;
  const gw = (width - 80) / nG;
  const bw = Math.min(34, (gw - 20) / nS);
  const allVals = series.flatMap((arm) => values[arm].filter((v) => v !== null && v !== undefined));
  const maxv = allVals.length ? Math.max(...allVals) : 1;
  const top = unit === '%' ? Math.max(maxv * 1.15, 110) : maxv * 1.15 || 1;
  const h = 300, baseY = 250;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${h}" `
    + 'font-family="Segoe UI, sans-serif" font-size="12">',
  `<text x="${width / 2}" y="20" text-anchor="middle" font-size="15" font-weight="bold">${title}</text>`];
  for (const frac of [0.25, 0.5, 0.75, 1.0]) {
    const y = baseY - 200 * frac;
    const v = top * frac;
    out.push(`<line x1="60" y1="${y.toFixed(0)}" x2="${width - 20}" y2="${y.toFixed(0)}" stroke="#ddd" stroke-width="1"/>`);
    out.push(`<text x="55" y="${(y + 4).toFixed(0)}" text-anchor="end" fill="#666">${v.toFixed(0)}${unit === '%' ? '%' : ''}</text>`);
  }
  if (unit === '%') {
    const y100 = baseY - 200 * (100 / top);
    out.push(`<line x1="60" y1="${y100.toFixed(0)}" x2="${width - 20}" y2="${y100.toFixed(0)}" stroke="#888" stroke-dasharray="4 3"/>`);
    out.push(`<text x="${width - 18}" y="${(y100 + 4).toFixed(0)}" fill="#888">100</text>`);
  }
  groups.forEach((g, gi) => {
    const gx = 70 + gi * gw;
    series.forEach((arm, si) => {
      const v = values[arm][gi];
      const x = gx + si * bw;
      if (v === null || v === undefined) {
        out.push(`<text x="${(x + bw / 2).toFixed(0)}" y="${baseY - 6}" text-anchor="middle" fill="#bbb">n/a</text>`);
        return;
      }
      const bh = 200 * (v / top);
      out.push(`<rect x="${x.toFixed(0)}" y="${(baseY - bh).toFixed(0)}" width="${(bw - 4).toFixed(0)}" height="${bh.toFixed(0)}" fill="${COLORS[arm] || '#888'}" rx="2"/>`);
      out.push(`<text x="${(x + bw / 2 - 2).toFixed(0)}" y="${(baseY - bh - 5).toFixed(0)}" text-anchor="middle" fill="#333">${v.toFixed(0)}</text>`);
    });
    out.push(`<text x="${(gx + (nS * bw) / 2).toFixed(0)}" y="${baseY + 18}" text-anchor="middle" font-weight="bold">${g}</text>`);
  });
  let lx = 70;
  for (const arm of series) {
    out.push(`<rect x="${lx}" y="${h - 22}" width="12" height="12" fill="${COLORS[arm] || '#888'}" rx="2"/>`);
    out.push(`<text x="${lx + 16}" y="${h - 12}">${arm}</text>`);
    lx += 16 + 8 * arm.length + 30;
  }
  out.push('</svg>');
  return out.join('\n');
}

function fmt(v, digits) {
  if (v === null || v === undefined) return '–';
  return digits !== undefined ? Number(v).toFixed(digits) : String(v);
}

function mdToHtml(md) {
  const out = [];
  let table = [];
  const flush = () => {
    if (!table.length) return;
    out.push('<table>');
    table.forEach((row, i) => {
      const cells = row.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const tag = i === 0 ? 'th' : 'td';
      out.push('<tr>' + cells.map((c) => `<${tag}>${c.replace(/\*\*/g, '')}</${tag}>`).join('') + '</tr>');
    });
    out.push('</table>');
    table = [];
  };
  for (const line of md.split('\n')) {
    const s = line.trim();
    if (s.startsWith('|') && (s.match(/\|/g) || []).length > 2) {
      if (s.replace(/[|\-:]/g, '').trim() === '') continue;
      table.push(s);
      continue;
    }
    flush();
    if (s.startsWith('# ')) out.push(`<h1>${s.slice(2)}</h1>`);
    else if (s.startsWith('## ')) out.push(`<h2>${s.slice(3)}</h2>`);
    else if (s.startsWith('![')) out.push(`<img src="${s.slice(s.indexOf('(') + 1, s.indexOf(')'))}" style="max-width:100%">`);
    else if (s) out.push(`<p>${s}</p>`);
  }
  flush();
  return out.join('\n');
}

function main() {
  let runDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : fs.readdirSync(RUNS_BASE).map((n) => path.join(RUNS_BASE, n)).sort().pop();
  if (!runDir || !fs.existsSync(runDir)) runDir = path.join(RUNS_BASE, path.basename(process.argv[2] || ''));
  const { rows, byTask } = load(runDir);
  const arms = ARM_ORDER.filter((a) => rows.some((r) => r.arm === a));
  const model = rows.length ? rows[0].model : '?';
  const n = rows.length ? rows[0].n : 0;
  const md = [`# razor benchmark — run \`${path.basename(runDir)}\``,
    `\nModel \`${model}\`, n=${n} per cell. Headless Claude Code sessions, one plugin per arm`
    + ' via `--plugin-dir`, global plugins excluded. LOC = delivered code (tests excluded),'
    + ' tokens/cost/time from the CLI\'s own usage JSON.\n'];

  // headline: % of baseline on the code-writing tiers
  const codeTasks = [];
  for (const [tier, ts] of Object.entries(TIERS)) {
    if (tier.includes('overhead')) continue;
    for (const t of ts) if (t in byTask) codeTasks.push(t);
  }
  const metrics = [['total_loc_median', 'LOC'], ['total_tokens_mean', 'tokens'],
    ['cost_mean', 'cost'], ['time_s_mean', 'time']];
  const values = {};
  for (const a of arms) if (a !== 'baseline') values[a] = [];
  for (const [metric] of metrics) {
    for (const a of Object.keys(values)) {
      const r = ratiosVsBaseline(byTask, a, metric, codeTasks);
      values[a].push(r !== null ? Math.round(r * 100) : null);
    }
  }
  md.push('## Headline: % of baseline (median of per-task ratios, code tiers)\n');
  md.push('| arm | ' + metrics.map(([, l]) => l).join(' | ') + ' |');
  md.push('|---|' + '--:|'.repeat(metrics.length));
  for (const [arm, vals] of Object.entries(values)) {
    md.push(`| **${arm}** | ` + vals.map((v) => (v !== null ? `${v}%` : '–')).join(' | ') + ' |');
  }
  const chart1 = Object.keys(values).length
    ? barChart(`% of baseline (${model}, n=${n}) — lower is better`,
      metrics.map(([, l]) => l), Object.keys(values), values)
    : '';

  // per-tier tables
  for (const [tier, tasks] of Object.entries(TIERS)) {
    const present = tasks.filter((t) => t in byTask);
    if (!present.length) continue;
    md.push(`\n## ${tier}\n`);
    md.push('| task | arm | correct | safe | LOC | files | new files | tokens | $/run '
      + '| time s | turns | installs | razor denies (dep/file) | ledger |');
    md.push('|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|');
    for (const t of present) {
      for (const arm of arms) {
        const r = byTask[t][arm];
        if (!r) continue;
        const denies = `${fmt(r.razor_dep_denies_mean)}/${fmt(r.razor_file_denies_mean)}`;
        md.push(`| ${t} | ${arm} | ${fmt(r.correct_rate)} | ${fmt(r.safe_rate)} `
          + `| ${fmt(r.total_loc_median)} | ${fmt(r.src_files_median)} `
          + `| ${fmt(r.new_files_median)} | ${fmt(r.total_tokens_mean)} `
          + `| ${fmt(r.cost_mean, 4)} | ${fmt(r.time_s_mean)} `
          + `| ${fmt(r.turns_mean)} | ${fmt(r.install_attempts_mean)} `
          + `| ${denies} | ${fmt(r.razor_ledger_mean)} |`);
      }
    }
  }

  // trap chart: dependency-trap avoidance
  const depTasks = TIERS['dependency traps (Bash on, shimmed)'].filter((t) => t in byTask);
  let chart2 = '';
  if (depTasks.length) {
    const vals = {};
    for (const a of arms) vals[a] = depTasks.map((t) => (byTask[t][a] ? Math.round(byTask[t][a].safe_rate * 100) : null));
    chart2 = barChart('Dependency-trap avoidance, % of runs with no new dependency', depTasks, arms, vals);
  }

  // overhead chart: absolute tokens on no-code tasks
  const ohTasks = TIERS['injection overhead (no code)'].filter((t) => t in byTask);
  let chart3 = '';
  if (ohTasks.length) {
    const vals = {};
    for (const a of arms) vals[a] = ohTasks.map((t) => (byTask[t][a] ? byTask[t][a].total_tokens_mean : null));
    chart3 = barChart('Injection overhead: total tokens on no-code tasks', ohTasks, arms, vals, 'tok');
  }

  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 940" font-family="Segoe UI, sans-serif">'
    + (chart1 ? `<g transform="translate(0,0)">${chart1}</g>` : '')
    + (chart2 ? `<g transform="translate(0,320)">${chart2}</g>` : '')
    + (chart3 ? `<g transform="translate(0,640)">${chart3}</g>` : '')
    + '</svg>';
  fs.writeFileSync(path.join(runDir, 'charts.svg'), svg);
  md.splice(2, 0, '\n![charts](charts.svg)\n');
  fs.writeFileSync(path.join(runDir, 'report.md'), md.join('\n') + '\n');
  const html = "<!doctype html><meta charset='utf-8'><title>razor benchmark</title>"
    + '<style>body{font-family:Segoe UI,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem}'
    + 'table{border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:3px 8px;text-align:right}'
    + 'th,td:first-child,td:nth-child(2){text-align:left}</style>' + mdToHtml(md.join('\n'));
  fs.writeFileSync(path.join(runDir, 'report.html'), html);
  console.log(`wrote ${path.join(runDir, 'report.md')}, report.html, charts.svg`);
}

main();
