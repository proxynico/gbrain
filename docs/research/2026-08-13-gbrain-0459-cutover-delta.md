# GBrain 0.45.9.0 cutover delta

## Question

Can the approved GBrain 0.45.2.0 reversible cutover be retargeted safely to the newer stable release?

## Decision this feeds

Whether to rebuild the isolated candidate at 0.45.9.0 and continue the same backup, stop, switch, restart, verify, and rollback flow.

## Findings

- The live CLI reports `latest_version: 0.45.9.0`; upstream refs `refs/tags/v0.45.9.0` and `refs/tags/latest-stable` both resolve to `1ec6a6e842a15f2bde2ebe8c3a686a6fa6b17aa5`. Evidence: `/opt/homebrew/bin/gbrain check-update --json` and `git ls-remote origin refs/tags/v0.45.9.0 refs/tags/latest-stable`, run 2026-08-13.
- `v0.45.9.0` descends from `v0.45.2.0`; the retarget is a forward-only candidate change. Evidence: `git merge-base --is-ancestor v0.45.2.0 v0.45.9.0` exited 0.
- Package version is `0.45.9.0`. Evidence: `git show v0.45.9.0:package.json`.
- The release adds migration 126, `session_context_state`, for ambient-recall session cursors. It is additive: one new table and index, with no alteration or deletion of existing rows. Evidence: `git diff v0.45.2.0..v0.45.9.0 -- src/core/migrate.ts` and `CHANGELOG.md` section `0.45.7.0`.
- No new agent migration directive exists under `skills/migrations/` between these tags. Evidence: `git diff --name-status v0.45.2.0..v0.45.9.0 -- skills/migrations` returned no paths.
- `0.45.8.0` explicitly requires only upgrade plus doctor; `0.45.9.0` recommends `gbrain bootstrap verify`, which is a verification step and should be run after the live switch. Evidence: `CHANGELOG.md` sections `0.45.8.0` and `0.45.9.0`.

## Implications

Retarget the isolated candidate to the immutable `v0.45.9.0` tag. Update the production schema proof from 125 to 126 and include the new table/index in post-cutover verification. Preserve the same `0.42.73.2` Git rollback point and database backup; because the migration is additive, code rollback does not require dropping the new table.

## Open gaps or uncertainty

- The 21 Nico-specific commits still need replay and conflict resolution against `v0.45.9.0`.
- Full candidate tests and local capability-contract tests must pass before production is stopped.
- `gbrain bootstrap verify` may report pre-existing workspace hygiene findings; record them without applying unrelated bootstrap rewrites during this version cutover.
