'use strict';

// Gate (Grep|Glob|Read|Edit|Write|Bash|PowerShell, via pre-tool-use.js) —
// post-edit search debounce.
//
// Searching before the first Edit/Write of the session is normal diligence
// (understanding the problem, checking for reuse) and is never metered here
// — every escalation actually observed happened AFTER the core work was
// already written, not before. Once the session has made its first edit,
// further searching is a different signal: the implementation exists, so
// more Grep/Glob is almost always the "leave one check behind" rule
// wondering about a test/file-naming convention, or a re-verification
// reflex — not new understanding. The 2nd post-edit search is denied once
// with a reason; the retry passes. Any Read/Edit/Write resets the post-edit
// search count to zero (evidence a decision was made, not more looking),
// but never un-sets the has-edited phase once true — the phase only moves
// forward.
//
// Known limit: only Grep/Glob are counted. Existence checks issued via
// Bash/PowerShell (e.g. `Test-Path`, `ls`) aren't covered — classifying
// arbitrary shell commands as read-only vs. acting isn't reliable without a
// real parser, and isn't yet confirmed to be razor-specific behavior. Shell
// calls DO reset the streak, though: running a command after an edit is
// acting on the work (usually verifying it), so a search that follows starts
// a fresh streak — erring permissive keeps the gate's false-positive surface
// near zero.

const BUDGET = (() => {
  const n = parseInt(process.env.RAZOR_SEARCH_BUDGET || '', 10);
  return Number.isFinite(n) ? n : 1;
})();

const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const EDIT_TOOLS = new Set(['Edit', 'Write']);
const RESET_TOOLS = new Set(['Read', 'Edit', 'Write', 'Bash', 'PowerShell']);

// Pure phase step: given the previous phase state and the incoming tool,
// returns the next state and whether to deny this call.
function stepPhase(phase, toolName, budget) {
  const s = phase || { hasEdited: false, count: 0, fired: false };

  if (RESET_TOOLS.has(toolName)) {
    return { next: { hasEdited: s.hasEdited || EDIT_TOOLS.has(toolName), count: 0, fired: false }, deny: false };
  }
  if (!SEARCH_TOOLS.has(toolName)) return { next: s, deny: false };
  if (!s.hasEdited) return { next: s, deny: false }; // pre-edit: unmetered

  const count = s.count + 1;
  const deny = count > budget && !s.fired;
  return { next: { hasEdited: true, count, fired: s.fired || deny }, deny };
}

// Dispatcher entry: mutates gate state, returns the deny reason or null.
function check(data, state) {
  if (BUDGET <= 0) return null; // 0 or negative disables the meter

  const tool = data.tool_name;
  if (!SEARCH_TOOLS.has(tool) && !RESET_TOOLS.has(tool)) return null;

  const { next, deny } = stepPhase(state.searchPhase, tool, BUDGET);
  state.searchPhase = next;

  if (!deny) return null;
  return (
    `razor: another search after you'd already started implementing (post-edit budget ${BUDGET}). ` +
    "If you're deciding how to leave a check behind, inline is enough — no need to find a convention. " +
    'If a genuinely different area of the codebase needs checking, re-issue the search.'
  );
}

module.exports = { check, stepPhase, BUDGET };
