'use strict';

// The benchmark queue decides which arm meets a cold prompt cache and which
// meets a warm one, and a cold cell costs roughly twice a warm one. That makes
// the ordering part of every cost number the README publishes, so it is pinned
// here rather than left to a runner nothing tests.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  buildQueue, makeRng, shuffled, FULL_TASKS, COUNTER_TASKS, NOTE_TASKS,
} = require('../benchmarks/runner/run.js');
const { RAZOR_TASKS } = require('../benchmarks/runner/tasks.js');

const ARMS = ['baseline', 'razor'];
const TASKS = ['dep-slug', 'oh-question'];
const MODELS = ['sonnet'];

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

// The note suite is multi-turn and scores a message rather than code. It must
// stay out of --full for the same reason the counter-suite does: the published
// corpus has to keep meaning exactly what it meant when the numbers were taken.
describe('the note suite is its own group', () => {
  test('--full excludes both the counter-suite and the note suite', () => {
    for (const id of [...COUNTER_TASKS, ...NOTE_TASKS]) {
      assert.ok(!FULL_TASKS.includes(id), `${id} leaked into --full`);
    }
    assert.ok(FULL_TASKS.length > 0);
  });

  test('the two groups do not overlap, and the note suite is not empty', () => {
    assert.ok(NOTE_TASKS.length >= 2, 'a drift task and a false-alarm task');
    for (const id of NOTE_TASKS) assert.ok(!COUNTER_TASKS.includes(id), id);
  });

  test('every note task is a conversation — a single prompt cannot show drift', () => {
    for (const id of NOTE_TASKS) {
      assert.ok(Array.isArray(RAZOR_TASKS[id].followups), `${id} has no followups`);
      assert.ok(RAZOR_TASKS[id].followups.length >= 1, id);
    }
  });

  test('no task outside the note suite carries followups', () => {
    for (const [id, task] of Object.entries(RAZOR_TASKS)) {
      if (NOTE_TASKS.includes(id)) continue;
      assert.strictEqual(task.followups, undefined, `${id} would silently run extra turns`);
    }
  });
});
