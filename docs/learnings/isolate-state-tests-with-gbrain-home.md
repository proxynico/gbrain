## Context

Ledger tests intended to use a temporary home changed `HOME`, but a parallel
unit run still rewrote and removed `~/.gbrain/sync-failures.jsonl`.

## Lesson

Use `GBRAIN_HOME` as the parent of the test-owned `.gbrain` directory. Before
any read, write, or removal, assert the resolved path equals the exact path
under that temporary root. Changing `HOME` is not a reliable gbrain boundary.

## When It Applies

Any test that touches paths resolved through `configDir()`, `gbrainPath()`, or
`syncFailuresPath()`.

## Evidence or Example

`test/sync-resumable-import.serial.test.ts` and `test/sync-failures.test.ts`
set `GBRAIN_HOME` and assert the exact ledger path. A guarded run of the latter
passes 61 tests without changing the live ledger hash.

## Related Lessons

None.
