#!/usr/bin/env node
'use strict';

// Checks that each commandWindows in hooks/codex-hooks.json is the one
// hooks/windows-launcher.ps1 builds, and fails naming the first stale hook.
// --write regenerates them in place.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'hooks/codex-hooks.json');

function build(source, event) {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error('Invalid hook event: ' + event);
  const script = source.replace(/\r\n/g, '\n').replaceAll('__RAZOR_EVENT__', event);
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
}

function main(write = false) {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const source = fs.readFileSync(path.join(ROOT, 'hooks/windows-launcher.ps1'), 'utf8');
  for (const groups of Object.values(config.hooks)) for (const group of groups) for (const handler of group.hooks) {
    const match = handler.command.match(/\/hooks\/codex-hook\.js" ([A-Za-z]+)$/);
    if (!match) throw new Error('Unknown hook command shape: ' + handler.command);
    const expected = build(source, match[1]);
    if (write) handler.commandWindows = expected;
    else if (handler.commandWindows !== expected) throw new Error('Stale Windows launcher for ' + match[1] + '; run node scripts/build-windows-launchers.js --write');
  }
  if (write) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { build, main };
if (require.main === module) main(process.argv.includes('--write'));
