'use strict';

// Grok Build sets GROK_HOOK_EVENT on every hook process. Claude Code, Codex
// and Antigravity do not. The same scripts serve all of them, and razor-lib
// picks its harness when it is first loaded, so this has to run before that
// require. A host that already named itself, as the Codex and Antigravity
// entrypoints do, is left alone.
if (!process.env.RAZOR_HOST && process.env.GROK_HOOK_EVENT) process.env.RAZOR_HOST = 'grok';
