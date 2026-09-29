#!/usr/bin/env node
'use strict';

// Checks that each commandWindows in hooks/codex-hooks.json is the one this
// script builds, with hooks/windows-launcher.ps1 as its fallback, and fails
// naming the first stale hook. --write regenerates them in place.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'hooks/codex-hooks.json');

// Codex may start commandWindows from cmd or PowerShell, and a PowerShell
// start costs about 200 ms per hook, so cmd starts Node itself. The set keeps
// cmd from running a node.exe in the working directory. cmd's `for` PATH search
// finds node.exe before Node runs, so cmd never prints its not-found text and a
// crashed hook's stderr and exit code reach Codex. Without node.exe on PATH, the
// encoded PowerShell launcher finds Node through fnm. The search reads a copy of
// PATH named .P, because a PowerShell parent would expand `$PATH` in the command.
function build(source, event) {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error('Invalid hook event: ' + event);
  const inline = `process.argv[2]='${event}';require(require('path').join(process.env.PLUGIN_ROOT,'hooks','codex-hook.js')).main()`;
  // Unquoted inside cmd's quotes, with delayed expansion on, the script must
  // hold nothing cmd or PowerShell rewrites.
  if (/[\s"$%`&|<>^!]/.test(inline)) throw new Error('Inline hook script needs quoting');
  const script = source.replace(/\r\n/g, '\n').replaceAll('__RAZOR_EVENT__', event);
  const fallback = 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  return `cmd /d /s /v:on /c "set NoDefaultCurrentDirectoryInExePath=1&& set .N=&& set .P=!PATH!&& (for %i in (node.exe) do @set .N=%~$.P:i)& set .P=& if not defined .N (${fallback}) else node -e ${inline}"`;
}

function main(write = false) {
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const source = fs.readFileSync(path.join(ROOT, 'hooks/windows-launcher.ps1'), 'utf8');
  for (const groups of Object.values(config.hooks)) for (const group of groups) for (const handler of group.hooks) {
    // build() repeats the script and event of command; any other command shape fails here.
    const match = handler.command.match(/^node "\$\{PLUGIN_ROOT\}\/hooks\/codex-hook\.js" ([A-Za-z]+)$/);
    if (!match) throw new Error('Unknown hook command shape: ' + handler.command);
    const expected = build(source, match[1]);
    if (write) handler.commandWindows = expected;
    else if (handler.commandWindows !== expected) throw new Error('Stale Windows launcher for ' + match[1] + '; run node scripts/build-windows-launchers.js --write');
  }
  if (write) fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { build, main };
if (require.main === module) main(process.argv.includes('--write'));
