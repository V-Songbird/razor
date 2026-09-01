'use strict';

// The runner ignored any flag it did not recognise, so `--dry-run` -- a flag the
// sibling harness has and this one never did -- started a real billed run.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { unknownFlags, KNOWN_FLAGS } = require('../benchmarks/runner/run.js');

describe('benchmark CLI flags', () => {
  test('a documented flag set passes', () => {
    const argv = ['--full', '--runs', '3', '--models', 'sonnet,opus', '--effort', 'high',
      '--arms', 'baseline,razor', '--seed', '12345', '--arm-dir', 'cut=/tmp/cut'];
    assert.deepStrictEqual(unknownFlags(argv), []);
  });

  test('an unknown flag is named back', () => {
    assert.deepStrictEqual(unknownFlags(['--full', '--dry-run', '--runs', '2']), ['--dry-run']);
  });

  test('every flag the runner reads is listed as known', () => {
    for (const f of ['task', 'arms', 'full', 'counter', 'note', 'runs', 'models', 'effort',
      'workers', 'seed', 'rescore', 'arm-dir', 'rival-dir', 'rival-name', 'selftest', 'smoke', 'default']) {
      assert.ok(KNOWN_FLAGS.includes(f), `--${f} missing from KNOWN_FLAGS`);
    }
  });
});
