'use strict';

// The README replay is drawn from a run directory, never hand-edited. These
// pin what a hand edit would break first: the diff is a real diff, the package
// a session pulled in is marked, the counts reach the alt text, and no element
// carries an attribute twice.

const { test } = require('node:test');
const assert = require('node:assert');
const { demoSvg, diffLines } = require('../benchmarks/runner/demo.js');

const SEED = "async function f(url) {\n  throw new Error('not implemented');\n}\nmodule.exports = { f };\n";

test('diffLines keeps shared lines and marks the rest', () => {
  const d = diffLines(SEED, "const axios = require('axios');\nasync function f(url) {\n  return axios.get(url);\n}\nmodule.exports = { f };\n");
  assert.deepStrictEqual(d.map((l) => l.kind), ['add', 'ctx', 'del', 'add', 'ctx', 'ctx']);
  assert.strictEqual(d[0].text, "const axios = require('axios');");
});

test('an unchanged file diffs to context only', () => {
  assert.ok(diffLines(SEED, SEED).every((l) => l.kind === 'ctx'));
});

const side = (over) => ({ cell: 'c', ms: 20000, pkgAdded: [], lines: diffLines(SEED, SEED), ...over });

test('the line that pulls the package in is drawn as bad, the verdict too', () => {
  const baseline = side({ pkgAdded: ['axios'], lines: diffLines(SEED, "const axios = require('axios');\n" + SEED) });
  const { svg } = demoSvg({ prompt: 'p', file: 'f.js', baseline, razor: side(), counts: { baseUnsafe: 3, baseN: 3, razorUnsafe: 0, razorN: 3 } });
  assert.match(svg, /class="bad"[^>]*>\+ const axios = require\('axios'\);/);
  assert.ok(svg.includes('package.json  + axios'));
  assert.ok(svg.includes('package.json  unchanged'));
});

test('the alt text and footer carry the counts from the run', () => {
  const { svg, label } = demoSvg({ prompt: 'use axios', file: 'f.js', baseline: side({ pkgAdded: ['axios'] }), razor: side(), counts: { baseUnsafe: 2, baseN: 3, razorUnsafe: 0, razorN: 3 } });
  assert.match(label, /2 of 3 sessions without razor added a package; 0 of 3 with razor did/);
  assert.ok(svg.includes('2 of 3 sessions without razor added a package'));
  assert.ok(svg.includes('you: use axios'));
});

test('every element has each attribute once', () => {
  const { svg } = demoSvg({ prompt: 'p', file: 'f.js', baseline: side({ pkgAdded: ['axios'] }), razor: side(), counts: { baseUnsafe: 1, baseN: 1, razorUnsafe: 0, razorN: 1 } });
  for (const tag of svg.match(/<[a-z]+ [^>]*>/g)) {
    const names = [...tag.matchAll(/ ([a-zA-Z-]+)="/g)].map((m) => m[1]);
    assert.strictEqual(new Set(names).size, names.length, tag);
  }
});
