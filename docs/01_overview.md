# Overview

## What it is

`net.xode.dex.simulator` generates realistic-looking XON/USDT trading activity for developing the DEX chart, ticker and swap history UI. It is a small TypeScript CLI run with `tsx` (`package.json`, `Dockerfile`).

It does this by **sending real transactions**: each simulated trade is an `assetConversion.swapExactTokensForTokens` extrinsic signed by one of a set of dev wallets and submitted to the Xode dev chain (`src/chain.ts`, `swap`). Nothing about a trade is written to a database by the simulator.

## Place in the system

```text
 net.xode.dex.simulator                 Xode dev chain (Local Testnet)
 ┌──────────────────────┐   signed     ┌──────────────────────────────┐
 │ live / fund          │──extrinsics─▶│ assetConversion pool          │
 │ status (read-only)   │◀──queries────│ XON (native) / USDT (asset)   │
 └──────────────────────┘              └──────────────┬───────────────┘
                                                      │ SwapExecuted events
                                                      ▼
                                       net.xode.dex.queue (indexer)
                                                      │
                                     Mongo (charts) / MariaDB (swap, pool_ticker)
                                                      │
                                       net.xode.dex.server ──▶ net.xode.dex.front
```

- The queue watches `assetConversion.SwapExecuted` events (`../net.xode.dex.queue/src/services/producer/producer.queue.ts`, around line 500) and writes candles and swap rows. The simulator's swaps go through that path like any user's swap, so chart, history, ticker and chain always agree.
- The only DB code in the simulator is `purge` (`src/legacy.ts`, `src/db.ts`), which cleans up rows written by an **older** version that inserted fake swaps straight into the DBs.

## Why real transactions

Older versions wrote fake swaps and candles directly into Mongo and MariaDB (marked `lastSourceType: sim_swap / sim_gap`, `src/legacy.ts`). Those rows had no on-chain counterpart. The current version trades on chain instead. The consequence is that history cannot be backdated: `backfill` was removed and now throws an explanatory error (`src/index.ts:191`). History builds up only while `live` runs.

## What it trades

- **Base:** the chain's native token (XON), encoded as the location `{ parents: 1, interior: "Here" }` (`src/chain.ts:13`).
- **Quote:** asset `SIM_QUOTE_ASSET_ID` (default `1984`, USDT) from pallet instance 50, encoded as `{ parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: id }] } }` (`src/chain.ts:14-17`).
- Decimals are read from the chain: native from `api.registry.chainDecimals[0]`, quote from `assets.metadata` (`src/chain.ts:71-78`).

`SIM_BASE` / `SIM_QUOTE` are **only labels** in log output, and `SIM_POOL_ID` is used only by `purge` and the `status` header. They do not select which pool is traded. See [Configuration](06_configuration.md).

## Main moving parts

| Part | Where | Summary |
| --- | --- | --- |
| Chain guard | `src/chain.ts:62-69` | Refuses to continue unless `system.chain()` equals `SIM_EXPECTED_CHAIN`. |
| Wallets | `src/chain.ts:86-89`, `src/simulate.ts:93-100` | `SIM_WALLET_COUNT` sr25519 keys `${SIM_WALLET_SURI}//i`, each with a buy bias and Zipf weight. |
| Funding | `src/chain.ts:163-194` | The funder tops wallets up in a single `utility.batchAll`. |
| Activity model | `src/simulate.ts` | Poisson arrivals with an hourly shape, log-normal sizes, fair-price pull. |
| Swap submission | `src/chain.ts:200-247` | Quote, apply slippage, dry-run, submit, wait for finalization. |
| Legacy cleanup | `src/index.ts:167-185`, `src/legacy.ts` | Deletes old fake rows from local DBs. |

Continue with [Project structure](02_project-structure.md) or [Simulation model](03_simulation-model.md).
