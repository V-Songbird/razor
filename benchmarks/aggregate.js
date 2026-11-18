#!/usr/bin/env node
"use strict";

// Prints the table docs/knowledge/benchmarks.md shows for a run, from that run's per-session results.
// usage: node benchmarks/aggregate.js [benchmarks/<run>.json]
// A session passes when it is correct and safe. Lines are source lines (src_loc), averaged over the coding jobs:
// every job but the two with no code to write (oh-question, oh-typo). A difference is the mean over jobs of
// the per-job mean difference, plus or minus 1.96 standard errors.

const fs = require("node:fs");
const path = require("node:path");

const NO_CODE = new Set(["oh-question", "oh-typo"]);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

function main(file = path.join(__dirname, "20261117-152649.json")) {
  const run = JSON.parse(fs.readFileSync(file, "utf8"));
  const cell = (model, arm, keep = () => true) => run.results.filter((r) => r.model === model && r.arm === arm && keep(r));
  const coding = (r) => !NO_CODE.has(r.task);
  const tasks = [...new Set(run.results.map((r) => r.task))].sort();
  const lines = [`Run ${run.date}: ${run.results.length} sessions, ${run.claude}, $${run.cost_total.toFixed(2)} in all.`, "",
    "| Model | Setup | Correct and safe | Mean coding lines | Mean cost per session |", "| --- | --- | --- | --- | --- |"];
  for (const model of Object.keys(run.models)) {
    for (const arm of Object.keys(run.arms)) {
      const rows = cell(model, arm);
      lines.push(`| ${run.models[model]} | ${arm} | ${rows.filter((r) => r.correct && r.safe).length}/${rows.length} | `
        + `${mean(cell(model, arm, coding).map((r) => r.src_loc)).toFixed(1)} | $${mean(rows.map((r) => r.cost)).toFixed(3)} |`);
    }
  }
  // Razor against each other setup, paired by job.
  const paired = (model, other, metric, keep) => {
    const diffs = tasks.filter((task) => keep({ task })).map((task) => {
      const of = (arm) => mean(cell(model, arm, (r) => r.task === task).map((r) => r[metric]));
      return of(other) - of("razor");
    });
    const m = mean(diffs);
    return { m, se: 1.96 * Math.sqrt(diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (diffs.length - 1) / diffs.length) };
  };
  lines.push("", "Razor against each other setup, per job (positive means Razor is lower):", "");
  for (const model of Object.keys(run.models)) {
    for (const other of Object.keys(run.arms).filter((arm) => arm !== "razor")) {
      const loc = paired(model, other, "src_loc", coding);
      const cost = paired(model, other, "cost", () => true);
      lines.push(`- ${run.models[model]}, against ${other}: ${loc.m.toFixed(1)} ± ${loc.se.toFixed(1)} lines, $${cost.m.toFixed(4)} ± $${cost.se.toFixed(4)}`);
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

if (require.main === module) main(process.argv[2]);

module.exports = { main };
