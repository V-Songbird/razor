'use strict';

// Gate (Grep|Glob|Read|Edit|Write|Bash|PowerShell, via pre-tool-use.js) —
// post-edit search debounce.
//
// Searching before the first Edit/Write of the turn is normal diligence
// (understanding the problem, checking for reuse) and is never metered here
// — every escalation actually observed happened AFTER the core work was
// already written, not before. Once the turn has made its first edit,
// further searching is a different signal: the implementation exists, so
// more Grep/Glob is almost always a test/file-naming-convention hunt or a
// re-verification reflex — not new understanding. The 2nd post-edit search is denied once
// with a reason; the retry passes. Any Read/Edit/Write resets the post-edit
// search count to zero (evidence a decision was made, not more looking),
// but never un-sets the has-edited phase within a turn — inside one task
// the phase only moves forward.
//
// The phase is per TURN, not per session: a new user prompt is a new task,
// and its opening exploration is the same diligence the pre-edit exemption
// exists for. A session-scoped phase metered turn-initial searching on
// every request after the first edit of the session.
//
// Known limit: only Grep/Glob are counted. Existence checks issued via
// Bash/PowerShell (e.g. `Test-Path`, `ls`) aren't covered — classifying
// arbitrary shell commands as read-only vs. acting isn't reliable without a
// real parser, and isn't yet confirmed to be razor-specific behavior. Shell
// calls DO reset the streak, though: running a command after an edit is
// acting on the work (usually verifying it), so a search that follows starts
// a fresh streak — erring permissive keeps the gate's false-positive surface
// near zero.

const { settingNumber, turnKey } = require('./razor-lib');
const { PROVENANCE, retryContract } = require('./dep-guard');

const BUDGET = settingNumber('SEARCH_BUDGET', 1);

const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write']);
const RESET_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'PowerShell']);

// Pure phase step: given the previous phase state, the incoming tool, and
// the current turn key, returns the next state and whether to deny this
// call. A turn-key change resets the whole phase — new task, fresh
// diligence window.
function stepPhase(phase, toolName, budget, turn) {
  let s = phase || { hasEdited: false, count: 0, fired: false, turn };
  if (turn !== undefined && s.turn !== turn) {
    s = { hasEdited: false, count: 0, fired: false, turn };
  }

  if (RESET_TOOLS.has(toolName)) {
    return { next: { ...s, hasEdited: s.hasEdited || EDIT_TOOLS.has(toolName), count: 0, fired: false }, deny: false };
  }
  if (!SEARCH_TOOLS.has(toolName)) return { next: s, deny: false };
  if (!s.hasEdited) return { next: s, deny: false }; // pre-edit: unmetered

  const count = s.count + 1;
  const deny = count > budget && !s.fired;
  return { next: { ...s, count, fired: s.fired || deny }, deny };
}

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (BUDGET <= 0) return null; // 0 or negative disables the meter

  const tool = data.tool_name;
  if (!SEARCH_TOOLS.has(tool) && !RESET_TOOLS.has(tool)) return null;

  const { next, deny } = stepPhase(state.searchPhase, tool, BUDGET, turnKey(data));
  state.searchPhase = next;

  if (!deny) return null;
  return (
    `razor: another search after you'd already started implementing (post-edit budget ${BUDGET}). ` +
    PROVENANCE +
    'If a genuinely different area of the codebase needs checking, ' +
    retryContract('search')
  );
}

module.exports = { check, stepPhase, BUDGET };
