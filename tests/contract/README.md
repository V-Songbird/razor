# Contract fixtures and goldens

One pair of files per scenario, driven by [`../contract.test.js`](../contract.test.js):

- `fixtures/<name>.json` — the exact payload piped to the hook's stdin.
  `{{CWD}}` and `{{SESSION}}` are filled in once the scenario's throwaway
  project exists; nothing else is substituted.
- `golden/<name>.txt` — the exact bytes the hook must write to stdout. An
  empty file means the hook must emit nothing at all.

The point is the wire, not the logic. Every other suite parses the output and
asserts on a field, which cannot see a renamed envelope key, a lost raw-stdout
channel, a stray newline, or a quietly reworded deny. This one compares bytes.

Each scenario also carries `must` / `mustNot` literals in the test file. A
golden regenerated from the code proves the output is *stable*; those literals
are what proves it still *means* something.

## Regenerating

After a deliberate wording change:

```
node tests/contract.test.js --update
```

Then read the diff. A golden that moved without a reason you can name is the
bug, not the test.

## Porting

These goldens are the acceptance criteria for a port. A second host emits
different shapes for the same decisions — a different deny envelope, JSON where
this one takes raw text — so a port keeps these fixtures, writes its own
goldens, and passes them.
