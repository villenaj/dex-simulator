# Project Structure

## Folder layout

```text
net.xode.dex.simulator/
├── src/
│   ├── index.ts               # CLI entry: argument parsing, the four commands, logging, shutdown
│   ├── config.ts              # Reads .env into a `config` object; local-DB guard; pairKey()
│   ├── chain.ts               # Polkadot API: connect + chain guard, keys, reserves, balances, top-up, swap
│   ├── simulate.ts            # Pure model: RNG, wallets, hourly shape, arrivals, fair price, trade planning
│   ├── state.ts               # Load/delete the legacy state file (old swap row IDs)
│   ├── db.ts                  # Mongo and MariaDB connections (purge only)
│   └── legacy.ts              # Queries that count/delete the old fake candles and swap rows
├── test/                      # node:test unit tests, see docs/TESTING.md
├── state/                     # Legacy state files (gitignored, dockerignored, mounted in Docker)
├── docs/                      # This documentation
├── Dockerfile                 # node:24-slim, runs `tsx src/index.ts <command>`
├── docker-compose.yml         # Local Docker: joins the infra network, testnet DB names for purge
├── docker-compose.server.yml  # Dev server (192.168.254.200): host network, local RPC
├── docker-compose.yml.bak     # Previous compose file from the DB-writing version (not used)
├── .env.example               # Template for .env
├── package.json               # Scripts: live, fund, status, purge, build, test
└── tsconfig.json              # ES2022, CommonJS, strict; only type-checked (no dist build is used)
```

There is no build output: `pnpm build` runs `tsc --noEmit`, and both `pnpm` scripts and the Docker image run the TypeScript directly through `tsx`.

## Source files

### `src/index.ts`

The CLI. `main()` (line 187) reads `process.argv[2]`:

- `purge` runs without a chain connection.
- `backfill` throws a "backfill is gone" error.
- `live`, `fund`, `status` are looked up in `CHAIN_COMMANDS`, then run between `connectChain()` and `disconnectChain()`.
- Anything else prints usage and exits with code 1.

It also contains:

| Function | Responsibility |
| --- | --- |
| `argValue(name)` | Returns the argument after `--name` (used only for `--state`). |
| `log(...)` | `console.log` with an ISO timestamp prefix. |
| `setupWallets()` | Derives wallet keys and builds wallet profiles with a fixed RNG seed `${SIM_WALLET_SURI}-profile`, so profiles survive restarts. |
| `executeTrade()` | One trade: read reserves, plan, apply the 2% pool cap, top up if short, swap, log. |
| `fund`, `live`, `status`, `purge` | The commands. See [Commands](04_commands.md). |

### `src/config.ts`

Calls `dotenv.config()` and builds an exported, mutable `config` object from environment variables with `num()` / `str()` helpers. Blank or non-numeric values fall back to the default. See [Configuration](06_configuration.md) for every key.

Also exports:

- `assertLocalTargets()` — throws unless the Mongo and MariaDB hosts are in `LOCAL_HOSTS` (`127.0.0.1`, `localhost`, `::1`, `mongo`, `mariadb`).
- `pairKey()` — `pool:${SIM_POOL_ID}`, the Mongo `charts.pairKey` format the queue uses (`../net.xode.dex.queue/src/models/charts/dao.chart.ts:93`).
- `hostOf()` (internal) — strips `mongodb://` and credentials from `MONGO_URI` and keeps only the host.

### `src/chain.ts`

Everything that talks to the node through `@polkadot/api`.

| Export | Responsibility |
| --- | --- |
| `connectChain()` | Opens a `WsProvider` (2.5 s auto-reconnect delay), checks `system.chain()` against `SIM_EXPECTED_CHAIN`, reads decimals, creates the funder key. |
| `walletKeys(count)` | sr25519 keys `${SIM_WALLET_SURI}//${i}` with SS58 prefix 280. |
| `getReserves()` | `assetConversionApi.getReserves(XON, USDT)`; throws if there is no pool. |
| `poolPrice()` | USDT per XON from the reserves, in human units. |
| `getBalances()` | Free native balance and the quote asset balance (0 if no asset account). |
| `topUpWallets()` | Builds one `utility.batchAll` of `transferKeepAlive` calls from the funder. |
| `swap()` | Quotes, computes `minOut`, signs, dry-runs, submits, waits for finalization, reads `SwapExecuted`. |
| `toUnits()` / `fromUnits()` | Float ⇄ bigint planck conversion. |

`submitAndFinalize()` (internal) resolves only on `isFinalized`, rejects on `Invalid`/`Dropped`/`Usurped`, on a dispatch error (decoded as `section.name`), or after `SIM_FINALIZE_TIMEOUT_MS`.

### `src/simulate.ts`

Pure, chain-free model code. Exports `Rng`, `hourShare`, `createWallets`, `FairPrice`, `planTrade`, `arrivalsWindow`. Fully described in [Simulation model](03_simulation-model.md).

### `src/state.ts`

`DEFAULT_STATE_FILE` (`<project>/state/state.json`), `loadState()` and `clearState()`. There is no writer any more: only the old simulator created these files. See [State file](05_state-file.md).

### `src/db.ts`

`connect()` builds a Mongo URI `mongodb://[user:pass@]host:port/db[?authSource=...]` (credentials only if both user and password are set, 5 s server selection timeout) and a MariaDB pool with `connectionLimit: 4`. `disconnect()` closes both. Used only by `purge`.

### `src/legacy.ts`

| Function | Query |
| --- | --- |
| `countSimCandles(db)` | `charts.countDocuments({ pairKey: "pool:<id>", lastSourceType: { $in: ["sim_swap", "sim_gap"] } })` |
| `deleteSimCandles(db)` | Same filter, `deleteMany`. |
| `deleteSwaps(maria, ids)` | `DELETE FROM swap WHERE swap_id IN (?, ...)` in chunks of 500, parameterized. Returns affected rows. |

The queue itself writes `lastSourceType` values such as `swap`, `gap_fill` and `rollup` (`../net.xode.dex.queue/src/models/charts/dao.chart.ts`), so the `sim_*` filter does not match real indexed candles.
