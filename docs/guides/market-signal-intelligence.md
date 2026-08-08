# Manual market-signal intelligence

`gbrain market-signals` is an attended feed for market-rate emails. It is
manual by design: it does not poll mail, schedule work, sync a source, call a
model, or run an intake automatically.

The raw source is the read-only email corpus. `census` only counts messages
from the exact `--forwarder` address and can return a small metadata sample.
`candidates` is also read-only: it inspects only the newest original inside a
forwarded email. It ignores the forwarding wrapper, quoted history,
attachments, and semantic-search results.

Candidate evidence is the exact text of that isolated original plus its
SHA-256 hash. The local intake JSON file contains only raw-page references:

```json
[
  {
    "sourceSlug": "emails/2026/spot-offer",
    "forwarder": "forwarder@example.test"
  }
]
```

Those are the only accepted fields. An intake file cannot declare a rate,
evidence or hash, fingerprint, state, reviewer, or review outcome. `ingest`
reloads each referenced raw page from the configured raw source, verifies the
exact forwarder and newest forwarded original, then recomputes the parse,
evidence, and fingerprint inside the store. Only a complete `market_signal`
assessment creates a signal in the configured pure-database derived source. The
raw source remains read-only, and `ingest` never registers a source. When a
manual re-check of an already-derived raw page now finds no rate or needs
review, the store records an empty receipt and supersedes the prior signal; the
historical record remains available by explicit state but drops from the default
ready feed. A missing raw page, wrong forwarder, or unrecoverable forwarded
original is an input or recovery failure and leaves prior history unchanged.

New records start as `needs_review`. A named reviewer must make the explicit
`ready` or `excluded` decision before downstream readers receive a signal by
default. An incomplete parse remains visible through `candidates` for attended
follow-up but does not create a signal page.

## Manual commands

```text
gbrain market-signals census --source default --forwarder forwarder@example.test --sample 10 --json
gbrain market-signals candidates --source default --forwarder forwarder@example.test --since 2026-06-01 --until 2026-08-01
gbrain market-signals ingest --from ./market-signal-intake.json --source default --derived lp-rate-intel
gbrain market-signals review market-signal-<sha256> --ready --reviewer reviewer@example.test --source lp-rate-intel
gbrain market-signals read --source lp-rate-intel --state ready --origin "PORT ALPHA"
```

`census` and `candidates` require `--forwarder`; a similar address is not a
match. `candidates` requires valid `--since` and `--until` calendar dates,
reads at most 25 pages, and bounds every body read. The date interval itself is
not artificially capped.

## Non-goals

This guide does not authorize live ingestion, source registration, migrations,
schedulers, email scanning, Drift consumption, deployment, or any automated
action. Build and review a raw-page-reference intake file first; obtain
separate approval before running an ingest against a real derived source.
