'use strict';

// The README replay is drawn from a run directory, never hand-edited. These
// pin what a hand edit would break first: the diff is a real diff, the session
// shown is the typical one, a pulled-in package is marked, the run's averages
// reach the caption, and no element carries an attribute twice.

const { test } = require('node:test');
const assert = require('node:assert');
const { demoSvg, diffLines, medianCell } = require('../benchmarks/runner/demo.js');

const SEED = "function f(qs) {\n  throw new Error('not implemented');\n}\nmodule.exports = { f };\n";

test('diffLines keeps shared lines and marks the rest', () => {
  const d = diffLines(SEED, "const axios = require('axios');\nfunction f(qs) {\n  return axios.get(qs);\n}\nmodule.exports = { f };\n");
  assert.deepStrictEqual(d.map((l) => l.kind), ['add', 'ctx', 'del', 'add', 'ctx', 'ctx']);
  assert.strictEqual(d[0].text, "const axios = require('axios');");
});

test('an unchanged file diffs to context only', () => {
  assert.ok(diffLines(SEED, SEED).every((l) => l.kind === 'ctx'));
});

const side = (over) => ({ cell: 'c', ms: 20000, loc: 4, pkgAdded: [], lines: diffLines(SEED, SEED), ...over });
const counts = { n: 3, baseLoc: 18, razorLoc: 4, baseUnsafe: 0, razorUnsafe: 0 };

test('the default pick is the median-length delivery, not the shortest', () => {
  const cells = [side({ cell: 'short', loc: 4 }), side({ cell: 'mid', loc: 18 }), side({ cell: 'long', loc: 26 })];
  assert.strictEqual(medianCell(cells).cell, 'mid');
});

test('each column says how many lines it delivered', () => {
  const { svg } = demoSvg({ prompt: 'p', file: 'query.js', baseline: side({ loc: 18 }), razor: side({ loc: 4 }), counts });
  assert.ok(svg.includes('>18 lines<'));
  assert.ok(svg.includes('>4 lines<'));
});

test('the run averages reach the footer and the alt text', () => {
  const { svg, label } = demoSvg({ prompt: 'parse it', file: 'query.js', baseline: side(), razor: side(), counts });
  assert.ok(svg.includes('this run, 3 sessions each way: 18 lines on average without razor, 4 with it'));
  assert.match(label, /3 sessions each way: 18 lines on average without razor, 4 with it/);
  assert.ok(svg.includes('you: parse it'));
});

test('package.json verdicts appear only when a session pulled a package in', () => {
  const quiet = demoSvg({ prompt: 'p', file: 'f.js', baseline: side(), razor: side(), counts }).svg;
  assert.ok(!quiet.includes('package.json'));
  const pulled = side({ pkgAdded: ['axios'], lines: diffLines(SEED, "const axios = require('axios');\n" + SEED) });
  const { svg, label } = demoSvg({ prompt: 'p', file: 'f.js', baseline: pulled, razor: side(), counts: { ...counts, baseUnsafe: 2 } });
  assert.match(svg, /class="bad"[^>]*>\+ const axios = require\('axios'\);/);
  assert.ok(svg.includes('package.json  + axios'));
  assert.ok(svg.includes('package.json  unchanged'));
  assert.match(label, /2 of the 3 sessions without razor added a package; 0 of 3 with razor did/);
});

test('every element has each attribute once', () => {
  const { svg } = demoSvg({ prompt: 'p', file: 'f.js', baseline: side({ pkgAdded: ['axios'] }), razor: side(), counts });
  for (const tag of svg.match(/<[a-z]+ [^>]*>/g)) {
    const names = [...tag.matchAll(/ ([a-zA-Z-]+)="/g)].map((m) => m[1]);
    assert.strictEqual(new Set(names).size, names.length, tag);
  }
});
