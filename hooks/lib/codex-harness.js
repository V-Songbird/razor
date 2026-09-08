'use strict';

// Native Codex wire adapter. The original adapter remains the reference lane
// for Razor's Claude contract fixtures and recorded benchmark results.
const fs = require('fs');
const os = require('os');
const path = require('path');
const legacy = require('./harness');

let input;
function readInput() {
  if (input !== undefined) return input;
  try {
    const value = JSON.parse(fs.readFileSync(0, 'utf-8'));
    input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    input = {};
  }
  return input;
}

function emitContext(event, text) {
  if (!text) return;
  // Stop context alone does not request another model response in Codex.
  // The ledger saves fired=true before this single continuation is emitted.
  // A read-only state file can prevent that save; the native continuation
  // flag is a second bound so failed persistence never creates a Stop loop.
  if (event === 'Stop') {
    if (readInput().stop_hook_active === true) return;
    process.stdout.write(JSON.stringify({ decision: 'block', reason: text }));
    return;
  }
  legacy.emitContext(event, text);
}

// Codex does not run Claude userConfig installation prompts. Keep Razor's
// environment controls and defaults without importing another host's options.
function settingOff(name) {
  return process.env[`RAZOR_${name}`] === 'off';
}

function settingNumber(name, fallback) {
  const n = parseInt(process.env[`RAZOR_${name}`] ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

function settingGiven(name) {
  const value = process.env[`RAZOR_${name}`];
  return value !== undefined && value !== '';
}

function stateDir() {
  const fallback = path.join(os.tmpdir(), 'razor-codex');
  for (const dir of [process.env.PLUGIN_DATA, fallback].filter(Boolean)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch {
      // A missing data directory must not break the tool call.
    }
  }
  return fallback;
}

function turnKey(data) {
  // turn_id is the documented field. Codex transcripts are not a stable hook
  // API, so never infer user turns by reading their private format.
  return typeof data.turn_id === 'string' && data.turn_id ? data.turn_id : 'unknown-turn';
}

module.exports = {
  ...legacy,
  readInput,
  emitContext,
  settingOff,
  settingNumber,
  settingGiven,
  stateDir,
  turnKey,
};