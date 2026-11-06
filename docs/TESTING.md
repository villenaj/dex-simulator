# Testing

Unit tests use Node's built-in test runner (`node:test`), run through `tsx`. No extra test dependencies.

The tests never sign a transaction, never touch the real `state/` directory or `.env`, and never connect to the chain, MariaDB or Mongo.

## Running tests

```bash
pnpm test                                        # all tests
pnpm exec tsx --test test/simulate.trade.test.ts # one file
```

## Layout

```text
test/
├── simulate.rng.test.ts      # seeded random generator
├── simulate.trade.test.ts    # wallets, trade planning, fair price, arrivals
├── chain.units.test.ts       # unit conversion, pool price, wallet keys
├── chain.api.test.ts         # reserves, balances, top-ups, swaps (fake ApiPromise)
├── state.test.ts             # state file load and clear in temp dirs
├── legacy.test.ts            # legacy candle filter and swap deletion SQL
├── config.test.ts            # env parsing, defaults, local-target safety check
├── db.test.ts                # Mongo and MariaDB connection options (mocked)
└── cli.test.ts               # usage output for commands that exit before connecting
```

## Writing tests

- Use a seeded RNG, or a scripted one that returns fixed values, so results are deterministic.
- `config` is a mutable exported object. Set the fields your test depends on instead of relying on `.env`.
- Use `fs.mkdtempSync` for state files. Never read or write the real `state/` directory.
- Fake the chain with a small `ApiPromise` stand-in (see `chain.api.test.ts`), and mock `MongoClient` and `mariadb.createPool`.
- **Never run `live`, `fund`, `status` or `purge` from a test.** They sign real transactions or delete data. `cli.test.ts` only runs commands that exit before connecting, and points the RPC URL at `ws://127.0.0.1:1` as a safeguard.

## Known bugs flagged by tests

| Bug | Location | Test |
| --- | --- | --- |
| `niceRound` can choose a step 10× the value's magnitude and round up to it, so buys can exceed the 2500 USDT cap (amounts of 5000 and 10000 were observed). Each trade is still limited to 2% of the pool. | `src/simulate.ts:106-108` | `{ todo }` in `simulate.trade.test.ts` |
| `CHAIN_COMMANDS[command]` finds inherited `Object.prototype` keys, so a command like `constructor` connects to the chain instead of printing usage. | `src/index.ts:198` | `{ skip }` in `cli.test.ts`; running it would open a chain connection |

Also known, without tests:

- In live mode, the per-day activity factor is recalculated every minute, so day-to-day variation averages out (`src/simulate.ts:131,139`). The average rate is unaffected.
- `hostOf` in `src/config.ts` reads `mongodb+srv://` URIs as host `mongodb+srv`. The local-target check still refuses them, so `purge` stays safe.

When you fix a bug, remove the `todo` or `skip` option so the test is enforced.

## Not covered yet

- `argValue` (`--state`) and the `live`, `status` and `purge` command bodies in `src/index.ts`. Testing them needs `index.ts` to export its helpers and stop running `main()` on import.
- `connectChain`, which needs a real node.
