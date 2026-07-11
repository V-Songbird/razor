'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runHook, hookOutput, freshSession } = require('./helpers');
const {
  jsImportRoots, pyImportRoots, newImports, isDeclared, isTestFile, ecosystemOf, findManifest,
} = require('../hooks/import-guard');

describe('unit: jsImportRoots', () => {
  test('finds require/import/export-from/dynamic-import roots', () => {
    const src = [
      "const axios = require('axios');",
      "import express from 'express';",
      "import { chunk } from 'lodash/fp';",
      "export { x } from '@scope/pkg/sub';",
      "const z = await import('zod');",
      "import 'polyfill-lib';",
    ].join('\n');
    assert.deepStrictEqual(
      [...jsImportRoots(src)].sort(),
      ['@scope/pkg', 'axios', 'express', 'lodash', 'polyfill-lib', 'zod'],
    );
  });

  test('builtins, node:/bun: prefixes, and local paths never count', () => {
    const src = [
      "const fs = require('fs');",
      "const fsp = require('node:fs/promises');",
      "import { db } from 'bun:sqlite';",
      "const local = require('./util');",
      "import x from '../lib/x';",
      "import y from '#internal/y';",
    ].join('\n');
    assert.strictEqual(jsImportRoots(src).size, 0);
  });

  test('type-only imports never ship, never count', () => {
    assert.strictEqual(jsImportRoots("import type { Foo } from 'some-types-pkg';").size, 0);
  });
});

describe('unit: pyImportRoots', () => {
  test('finds import/from roots, first dotted segment', () => {
    const src = 'import requests\nimport numpy as np, pandas\nfrom flask import Flask\nfrom django.http import Http404';
    assert.deepStrictEqual([...pyImportRoots(src)].sort(), ['django', 'flask', 'numpy', 'pandas', 'requests']);
  });

  test('stdlib and relative imports never count', () => {
    const src = 'import os\nimport json, sys\nfrom pathlib import Path\nfrom . import sibling\nfrom __future__ import annotations';
    assert.strictEqual(pyImportRoots(src).size, 0);
  });
});

describe('unit: classification helpers', () => {
  test('isDeclared normalizes name/import mismatches in the suppressing direction', () => {
    assert.strictEqual(isDeclared('dotenv', ['python-dotenv']), true);
    assert.strictEqual(isDeclared('yaml', ['pyyaml']), true);
    assert.strictEqual(isDeclared('PIL', ['pillow']), false); // known limit: no alias table
    assert.strictEqual(isDeclared('axios', ['express', 'lodash']), false);
    assert.strictEqual(isDeclared('lodash', ['express', 'lodash']), true);
  });

  test('newImports counts only roots absent from both manifest and existing content', () => {
    const existing = "const axios = require('axios');";
    const incoming = "const axios = require('axios');\nconst dayjs = require('dayjs');\nconst _ = require('lodash');";
    assert.deepStrictEqual(newImports('node', incoming, existing, ['lodash']), ['dayjs']);
  });

  test('isTestFile and ecosystemOf', () => {
    assert.strictEqual(isTestFile('src/foo.test.js'), true);
    assert.strictEqual(isTestFile('tests/helper.py'), true);
    assert.strictEqual(isTestFile('src/foo.js'), false);
    assert.strictEqual(ecosystemOf('a/b.ts'), 'node');
    assert.strictEqual(ecosystemOf('a/b.py'), 'python');
    assert.strictEqual(ecosystemOf('a/b.rs'), null);
  });
});

// Seeded workspace: a manifest + a stub, mirroring the shape agents actually
// meet (an existing project with declared deps).
function makeWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-ig-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'ws', version: '1.0.0', dependencies: { express: '^4.19.2', lodash: '^4.17.21' },
  }));
  fs.writeFileSync(path.join(dir, 'http_client.js'), 'async function fetchJson(url) {}\nmodule.exports = { fetchJson };\n');
  return dir;
}

describe('integration: import gate', () => {
  const input = (sessionId, toolName, toolInput) => ({
    session_id: sessionId,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });

  test('Write that imports an undeclared package: denied once with evidence, retry passes', () => {
    const ws = makeWorkspace();
    const session = freshSession();
    const write = input(session, 'Write', {
      file_path: path.join(ws, 'http_client.js'),
      content: "const axios = require('axios');\nasync function fetchJson(url) {}\nmodule.exports = { fetchJson };\n",
    });
    const first = hookOutput(runHook('pre-tool-use.js', write));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /adds a new node dependency/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /`axios`/);
    assert.match(first.hookSpecificOutput.permissionDecisionReason, /express, lodash/);

    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('Edit whose new_string imports an undeclared package is gated the same way', () => {
    const ws = makeWorkspace();
    const session = freshSession();
    const edit = input(session, 'Edit', {
      file_path: path.join(ws, 'http_client.js'),
      old_string: 'async function fetchJson(url) {}',
      new_string: "const axios = require('axios');\nasync function fetchJson(url) {}",
    });
    const first = hookOutput(runHook('pre-tool-use.js', edit));
    assert.strictEqual(first.hookSpecificOutput.permissionDecision, 'deny');
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', edit)), null);
  });

  test('declared deps, builtins, and local imports pass silently', () => {
    const ws = makeWorkspace();
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'http_client.js'),
      content: "const _ = require('lodash');\nconst fs = require('node:fs');\nconst u = require('./util');\nmodule.exports = {};\n",
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('an import the file already has on disk is grandfathered', () => {
    const ws = makeWorkspace();
    fs.writeFileSync(path.join(ws, 'http_client.js'), "const axios = require('axios');\nmodule.exports = {};\n");
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'http_client.js'),
      content: "const axios = require('axios');\nasync function fetchJson(url) { return (await axios.get(url)).data; }\nmodule.exports = { fetchJson };\n",
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('test files are exempt', () => {
    const ws = makeWorkspace();
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'http_client.test.js'),
      content: "const request = require('supertest');\n",
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('python: vibe-named dep denied, dotenv suppressed when python-dotenv is declared', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-igpy-'));
    fs.writeFileSync(path.join(dir, 'requirements.txt'), 'python-dotenv==1.0.0\n');
    const session = freshSession();
    const declared = input(session, 'Write', {
      file_path: path.join(dir, 'env.py'),
      content: 'import dotenv\n',
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', declared)), null);

    const undeclared = input(session, 'Write', {
      file_path: path.join(dir, 'env.py'),
      content: 'import requests\n',
    });
    const deny = hookOutput(runHook('pre-tool-use.js', undeclared));
    assert.strictEqual(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.hookSpecificOutput.permissionDecisionReason, /adds a new python dependency/);
  });

  test('no manifest up-tree: greenfield stays ungated', (t) => {
    const deep = fs.mkdtempSync(path.join(os.tmpdir(), 'razor-igg-'));
    // Guard the assumption instead of trusting the machine: a stray
    // package.json above tmpdir would make this test lie.
    if (findManifest('node', deep)) return t.skip('a manifest exists above tmpdir on this machine');
    const write = input(freshSession(), 'Write', {
      file_path: path.join(deep, 'app.js'),
      content: "const axios = require('axios');\n",
    });
    assert.strictEqual(hookOutput(runHook('pre-tool-use.js', write)), null);
  });

  test('RAZOR_IMPORT_GUARD=off disables the gate', () => {
    const ws = makeWorkspace();
    const write = input(freshSession(), 'Write', {
      file_path: path.join(ws, 'http_client.js'),
      content: "const axios = require('axios');\n",
    });
    const r = runHook('pre-tool-use.js', write, { RAZOR_IMPORT_GUARD: 'off' });
    assert.strictEqual(hookOutput(r), null);
  });
});
