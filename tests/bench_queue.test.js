'use strict';

// The benchmark queue decides which arm meets a cold prompt cache and which
// meets a warm one, and a cold cell costs roughly twice a warm one. That makes
// the ordering part of every cost number the README publishes, so it is pinned
// here rather than left to a runner nothing tests.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { buildQueue, makeRng, shuffled } = require('../benchmarks/runner/run.js');

const ARMS = ['baseline', 'razor'];
const TASKS = ['dep-slug', 'oh-question'];
const MODELS = ['haiku'];

describe('benchmark run order', () => {
  test('every task x model x rep x arm cell is queued exactly once', () => {
    const cells = buildQueue(TASKS, MODELS, ARMS, 3, 'seed-a');
    assert.strictEqual(cells.length, TASKS.length * MODELS.length * ARMS.length * 3);
    const keys = cells.map(([t, a, m, r]) => `${t}|${a}|${m}|${r}`);
    assert.strictEqual(new Set(keys).size, keys.length);
  });

  test('each rep block holds every arm once, so no arm ever runs a whole block ahead', () => {
    const cells = buildQueue(TASKS, MODELS, ARMS, 3, 'seed-b');
    for (let i = 0; i < cells.length; i += ARMS.length) {
      const block = cells.slice(i, i + ARMS.length);
      assert.deepStrictEqual([...block.map((c) => c[1])].sort(), [...ARMS].sort());
      // one task, one model, one rep per block
      assert.strictEqual(new Set(block.map((c) => `${c[0]}|${c[2]}|${c[3]}`)).size, 1);
    }
  });

  test('the same seed replays the same order, a different seed does not', () => {
    const key = (cells) => cells.map((c) => c.join('|')).join(',');
    assert.strictEqual(key(buildQueue(TASKS, MODELS, ARMS, 4, 'seed-c')), key(buildQueue(TASKS, MODELS, ARMS, 4, 'seed-c')));

    const three = ['baseline', 'razor', 'rival'];
    const orders = new Set();
    for (let i = 0; i < 40; i++) orders.add(key(buildQueue(['t'], MODELS, three, 1, `seed-${i}`)));
    assert.ok(orders.size > 1, 'every seed produced the identical order');
  });

  test('no arm takes first position in every block', () => {
    const three = ['baseline', 'razor', 'rival'];
    const cells = buildQueue(['t'], MODELS, three, 30, 'seed-d');
    const firsts = new Set();
    for (let i = 0; i < cells.length; i += three.length) firsts.add(cells[i][1]);
    assert.ok(firsts.size > 1, `only ${[...firsts]} ever ran first`);
  });

  test('shuffled leaves its input alone and keeps every member', () => {
    const rng = makeRng('seed-e');
    const input = ['a', 'b', 'c', 'd'];
    const out = shuffled(input, rng);
    assert.deepStrictEqual(input, ['a', 'b', 'c', 'd']);
    assert.deepStrictEqual([...out].sort(), ['a', 'b', 'c', 'd']);
  });

  test('the rng is a stream, not a constant', () => {
    const rng = makeRng('seed-f');
    const draws = Array.from({ length: 8 }, () => rng());
    assert.ok(draws.every((d) => d >= 0 && d < 1), JSON.stringify(draws));
    assert.ok(new Set(draws).size > 1, 'rng returned the same value every time');
  });
});
