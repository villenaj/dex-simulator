# Commands

All commands go through `src/index.ts`. `pnpm <command>` runs `tsx src/index.ts <command>` (`package.json`); in Docker the entrypoint is the same (`Dockerfile`), so `docker compose run --rm simulator <command>` works too.

```text
Usage: tsx src/index.ts <live | fund | status | purge [--state state/state.json]>
```

## Summary

| Command | Chain connection | Signs | DB access | Safety check |
| --- | --- | --- | --- | --- |
| `live` | Yes | Swaps (wallets), top-ups (funder) | None | `SIM_EXPECTED_CHAIN` |
| `fund` | Yes | Top-ups (funder) | None | `SIM_EXPECTED_CHAIN` |
| `status` | Yes | Nothing | None | `SIM_EXPECTED_CHAIN` |
| `purge` | No | Nothing | Deletes from Mongo `charts` and MariaDB `swap` | `assertLocalTargets()` |
| `backfill` | No | Nothing | None | Always throws |

## Chain connection and `SIM_EXPECTED_CHAIN`

`live`, `fund` and `status` all start with `connectChain()` (`src/chain.ts:55-80`):

1. Connect to `SIM_RPC_URL` with `throwOnConnect: true`, so an unreachable node fails immediately.
2. Read `system.chain()`. If it is not exactly `SIM_EXPECTED_CHAIN` (default `Local Testnet`), disconnect and throw `Refusing to run: <url> is "<name>", expected "<expected>" (SIM_EXPECTED_CHAIN).` No key is used before this check.
3. Read quote decimals from `assets.metadata(SIM_QUOTE_ASSET_ID)` and native decimals from the registry.
4. Create the funder key from `SIM_FUNDER_SURI`.

The connection is closed in a `finally` after the command (`src/index.ts:205-210`). Errors are printed (message only) and the process exits with code 1 (`src/index.ts:213-216`).

## `live`

Runs until stopped. `src/index.ts:84-139`.

1. Create the live RNG (see [Simulation model](03_simulation-model.md#1-random-number-generator)) and the wallets.
2. `topUpWallets(all wallets)` — one funder batch for any wallet below half its target.
3. Read the pool price and start the fair price there. Log the start line.
4. Register `SIGINT` / `SIGTERM` handlers.
5. Loop over one-minute windows: plan arrivals, sleep until each is due, run `executeTrade`. A failed trade is logged and skipped.
6. After the last arrival, sleep out the rest of the minute and start the next window.

**Writes:** swap extrinsics from simulator wallets; `utility.batchAll` top-ups from the funder.
**Reads:** reserves, balances, quotes, dry-runs.

**Stopping.** A signal sets `stopping` and wakes the current sleep. A swap that is already in flight is **not** interrupted; it runs until finalized or until `SIM_FINALIZE_TIMEOUT_MS` (default 180 s). Pressing Ctrl+C again does not force-quit, because the handler replaces Node's default behavior. The handlers are registered only after the initial top-up, so a signal during step 2 kills the process the default way. With Docker, see the stop-timeout note in [Running](07_running.md#stopping-the-container).

Example log line:

```text
[2026-11-06T03:12:45.123Z] BUY  512.3 XON for 50 USDT @ 0.097599  #123456 0x1a2b3c4d5e…  <addr8>…
```

(Format from `src/index.ts:77-81`; the numbers are illustrative.)

## `fund`

`src/index.ts:43-48`. Derives all `SIM_WALLET_COUNT` wallets and calls `topUpWallets`. A wallet is topped up if its XON is below `SIM_FUND_XON / 2` or its USDT is below `SIM_FUND_USDT / 2`, and it receives exactly the difference to the full target. Everything goes in one `utility.batchAll` from the funder, waited on until finalized. Logs `Funded N wallets.` or `All wallets already funded.`

`live` does the same on startup, so `fund` is only needed to pre-fund or to check that the funder works.

If the funder cannot cover the batch, the whole batch fails (it is `batchAll`) and the command errors. Check the funder balance with `status`.

## `status`

`src/index.ts:141-165`. Read-only. Prints:

- chain name, RPC URL, current block number, `pool:<SIM_POOL_ID>`
- pool reserves in XON and USDT, and the pool price
- funder address and balances
- every wallet address with its XON and USDT balances (queried one by one)

It still goes through the chain-name check, so it is a safe way to confirm `.env` points at the right node before running `live` or `fund`.

## `purge`

`src/index.ts:167-185`. Removes rows the **old** DB-writing simulator inserted. It never connects to the chain and never touches rows written by the queue.

1. `assertLocalTargets()` (`src/config.ts:79-89`): throws unless the Mongo host (parsed from `MONGO_URI`) and `MARIA_DB_HOST` are in `127.0.0.1`, `localhost`, `::1`, `mongo`, `mariadb`.
2. Resolve the state file: `--state <path>` (relative to the **current working directory**) or `DEFAULT_STATE_FILE` (`<project>/state/state.json`).
3. Connect to Mongo `MONGO_DB_NAME` and MariaDB `MARIA_DB_NAME`.
4. Count, then delete, `charts` documents with `pairKey: "pool:<SIM_POOL_ID>"` and `lastSourceType` in `sim_swap`, `sim_gap`.
5. If the state file exists, delete `swap` rows whose `swap_id` is in `swapIds`, 500 per statement. If it does not exist, no swap rows are deleted.
6. Delete the state file.
7. Log the counts and a note that today's `pool_ticker` row is refreshed by the queue on its next swap or snapshot.

If the state file is malformed JSON, the command fails after counting and before deleting anything (`loadState` runs before `deleteSimCandles`).

**Which DB?** The defaults are `xode_indexer` / `dex_db`. For the testnet databases written by the Docker container, override the names, as shown in the [README](../README.md#cleaning-up-data-from-the-old-db-only-simulator). In Docker, `docker-compose.yml` already sets the testnet names; `docker-compose.server.yml` does not, so it uses whatever `.env` says.

### `--state`

The only flag. Parsed by `argValue("state")` (`src/index.ts:25-28`), which takes the argument right after `--state` anywhere in `argv`, so `pnpm purge -- --state x` works whether or not pnpm forwards the `--`. It is ignored by all other commands.

## `backfill` (removed)

`src/index.ts:191-196`. Throws:

```text
backfill is gone: swaps are now real transactions on the dev chain and can't be backdated. Run `live` to build history, and `purge` once to remove the old DB-only data.
```

There is no way to create past history; it accumulates only while `live` runs.

## Unknown commands

Print usage and exit 1. Exception: names of inherited `Object.prototype` members such as `constructor` are found by `CHAIN_COMMANDS[command]` and connect to the chain instead (`src/index.ts:198`, listed in [TESTING.md](TESTING.md#known-bugs-flagged-by-tests)).
