# Selected market-rate capture

`gbrain market-signals` is a manual, attended path for one selected forwarded
market-rate email. It has three commands: `inspect`, `keep`, and `read`.

`inspect` is read-only. It loads one selected forwarded email and shows
table-shaped row suggestions. Suggestions are not gbrain data.

`keep` is the only writer. It reloads the raw page and rebuilds the suggestions
before accepting selected IDs, so a caller cannot submit its own price, route,
evidence, or hash. At the storage boundary, only selected rows are written to
`lp-rate-intel` as ready market-rate data.

`read` returns only those kept market-rate rows. Drift can use it without
reading or parsing email.

## Manual commands

```text
gbrain market-signals inspect --source default --forwarder forwarder@example.test --slug emails/2026/market-rate
gbrain market-signals keep --source default --derived lp-rate-intel --forwarder forwarder@example.test --slug emails/2026/market-rate --row market-rate-<sha256>
gbrain market-signals read --source lp-rate-intel --origin "PORT ALPHA"
```

`inspect` returns disposable suggestions from the exact forwarded original.
Pass one or more returned `--row` IDs to `keep`. Stored pages live under
`market-rate/`; `read` returns those pages only and leaves legacy
`market-signal/` pages isolated.

## Non-goals

This command does not poll mail, schedule work, sync a source, call a model, or
run automatically. It provides no HTML preservation, sender discovery, or
automatic scan. It does not register sources or create real market-rate data as
part of this work. Drift implementation, deployment, and push are outside this
guide.
