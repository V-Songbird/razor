'use strict';

// Gate (Write, via pre-tool-use.js) — per-turn new-file shape check.
//
// A raw count of new files treats a migration, its test, its config and four
// production modules as the same thing, which rewards stuffing complexity
// into existing files instead. So the default budget counts PRODUCTION files
// only: tests, fixtures, migrations, generated output, docs and config are
// classified, reported, and never charged. A feature that ships with its
// tests is not sprawl.
//
// Set RAZOR_FILE_BUDGET explicitly and that becomes a raw ceiling on every
// new file — an operator who names a number gets the number they named.
//
// When the count crosses the budget, that one Write is denied with a rung-2
// reason naming the shape; the retry and everything after it in the same turn
// pass. One forced reconsideration per turn, self-clearing. Existing files
// are never gated (edits and overwrites aren't sprawl), and temp and
// scratchpad files are exempt.
//
// Known limit: files created via Bash heredocs bypass the Write tool and
// this meter with them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { turnKey, settingNumber, settingGiven } = require('./razor-lib');
const { PROVENANCE, retryContract } = require('./dep-guard');

const BUDGET = settingNumber('FILE_BUDGET', 4);
// An explicitly named budget is an explicit ceiling: count everything.
const RAW_CEILING = settingGiven('FILE_BUDGET');

// Plural labels for the message. Anything not listed here is production.
const UNCOUNTED = {
  test: 'tests',
  fixture: 'fixtures',
  migration: 'migrations',
  generated: 'generated files',
  docs: 'docs',
  config: 'config',
};

function norm(p) {
  return path.resolve(p).replace(/\\/g, '/').toLowerCase();
}

function isExemptPath(filePath) {
  const target = norm(filePath);
  const tmp = norm(os.tmpdir());
  return target === tmp || target.startsWith(tmp + '/') || target.includes('/scratchpad/');
}

// Path-shape classification. Order matters: generated output can live under a
// test tree, and a fixture can live under a docs tree — the more specific
// signal wins. Everything unrecognized is production, which is the fail-safe
// direction: an unfamiliar layout still gets counted.
function classify(filePath) {
  const p = norm(filePath);
  const name = p.slice(p.lastIndexOf('/') + 1);

  if (/(^|\/)(dist|build|out|coverage|node_modules|__generated__|generated)\//.test(p)) return 'generated';
  if (/\.min\.js$|\.d\.ts$|\.g\.dart$|\.generated\.|_pb2\.py$|\.pb\.go$/.test(p)) return 'generated';

  if (/(^|\/)(tests?|__tests__|specs?)\//.test(p)) return 'test';
  if (/^test_.+/.test(name) || /[._](test|spec)\.[a-z0-9]+$/.test(name)) return 'test';

  if (/(^|\/)(fixtures?|__fixtures__|testdata|mocks?|__mocks__|__snapshots__)\//.test(p)) return 'fixture';
  if (/\.snap$/.test(name)) return 'fixture';

  if (/(^|\/)(migrations?|migrate)\//.test(p)) return 'migration';

  if (/(^|\/)docs?\//.test(p) || /\.(md|mdx|rst|adoc|txt)$/.test(name)) return 'docs';

  if (/\.(json|ya?ml|toml|ini|cfg|conf|env|properties|lock)$/.test(name)) return 'config';
  if (/^\.[^/]+rc(\.[a-z]+)?$/.test(name) || /^(dockerfile|makefile)$/.test(name)) return 'config';
  if (/\.config\.[a-z]+$/.test(name)) return 'config';

  return 'production';
}

// Pure budget step: given the previous turn state, the current turn key, the
// budget and this file's kind, returns the next state and whether this Write
// gets denied. Uncounted kinds are still tallied, so the message can say what
// else the turn produced.
function stepTurn(turn, key, budget, kind = 'production', countAll = false) {
  const next =
    turn && turn.turnKey === key
      ? { ...turn, kinds: { ...(turn.kinds || {}) } }
      : { turnKey: key, count: 0, fired: false, kinds: {} };
  next.kinds[kind] = (next.kinds[kind] || 0) + 1;

  const counts = countAll || kind === 'production';
  if (counts) next.count += 1;
  const deny = counts && next.count > budget && !next.fired;
  if (deny) next.fired = true;
  return { next, deny };
}

// "Already in this codebase?" is rung 2, and whether the directory exists is
// the cheapest honest evidence of it.
function placement(filePath) {
  const dir = path.dirname(filePath);
  const label = path.basename(dir) || dir;
  return fs.existsSync(dir)
    ? `It lands in an existing ${label}/. `
    : `It also creates a new directory, ${label}/. `;
}

function otherKinds(kinds) {
  const parts = Object.entries(kinds)
    .filter(([kind]) => kind !== 'production' && UNCOUNTED[kind])
    .map(([kind, n]) => `${n} ${UNCOUNTED[kind]}`);
  return parts.length ? `Also this turn, uncounted: ${parts.join(', ')}. ` : '';
}

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (BUDGET <= 0) return null; // 0 or negative disables the meter
  if (data.tool_name !== 'Write') return null;

  const filePath = data.tool_input && data.tool_input.file_path;
  if (!filePath || isExemptPath(filePath)) return null;
  if (fs.existsSync(filePath)) return null; // overwrite/edit, not a new file

  const kind = classify(filePath);
  const { next, deny } = stepTurn(state.turn, turnKey(data), BUDGET, kind, RAW_CEILING);
  state.turn = next;

  if (!deny) return null;
  const noun = RAW_CEILING ? 'new file' : 'new production file';
  return (
    `razor: ${noun} #${next.count} this turn (budget ${BUDGET}). ` +
    placement(filePath) +
    otherKinds(next.kinds) +
    'Rung 2 — does an existing file or module already cover this, and does this shape match what was asked for? ' +
    PROVENANCE +
    'If every new file is genuinely needed, ' +
    retryContract('Write')
  );
}

module.exports = { check, stepTurn, classify, isExemptPath, BUDGET, RAW_CEILING };
