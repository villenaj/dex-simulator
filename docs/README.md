# XON/USDT Swap Simulator Documentation

This folder documents `net.xode.dex.simulator`, a development tool that keeps the Xode DEX chart and swap history busy. It signs and submits **real swaps on the Xode dev chain** (Local Testnet). The queue indexes them like any other user's swaps.

The [project README](../README.md) is the short version. These pages go deeper: the exact formulas, every setting, what each command touches, and the known problems.

## Quick start

Requirements: Node.js `>=20.19.0` and pnpm `10.17.0` (`package.json`). The dev chain must be reachable, and `net.xode.dex.queue` must be running and synced, or the swaps never reach the UI.

```bash
corepack enable
pnpm install
cp .env.example .env

pnpm status     # read-only check: chain name, pool, balances
pnpm fund       # top up the simulator wallets from the funder
pnpm live       # submit swaps in real time (Ctrl+C to stop)
```

## Commands

| Command | Signs transactions | Touches DBs | Description |
| --- | --- | --- | --- |
| `pnpm live` | Yes (swaps, top-ups) | No | Tops up wallets, then submits swaps at random times until stopped. |
| `pnpm fund` | Yes (one `utility.batchAll`) | No | Tops up every wallet below half its target. |
| `pnpm status` | No | No | Prints block, pool reserves and price, funder and wallet balances. |
| `pnpm purge` | No | Yes (deletes) | Removes fake rows written by the old DB-only simulator. Localhost DBs only. |
| `pnpm build` | No | No | Type-check only (`tsc --noEmit`). |
| `pnpm test` | No | No | Unit tests. See [TESTING.md](TESTING.md). |

`backfill` no longer exists and fails with an explanation. See [Commands](04_commands.md).

## Documentation index

1. [Overview](01_overview.md) — what the simulator is and where it sits next to the queue, server and front.
2. [Project structure](02_project-structure.md) — every file under `src/` and what it owns.
3. [Simulation model](03_simulation-model.md) — wallets, Zipf weights, buy bias, fair price, arrivals, sizing, caps, slippage.
4. [Commands](04_commands.md) — each command step by step, what it reads and writes, safety checks, flags.
5. [State file](05_state-file.md) — the legacy `state/state.json` format and how `purge` uses it.
6. [Configuration](06_configuration.md) — every environment variable, its purpose and default.
7. [Running locally and in Docker](07_running.md) — `pnpm`, `docker-compose.yml` vs `docker-compose.server.yml`.
8. [Safety notes](08_safety.md) — what protects mainnet and production data, and what does not.
9. [Known issues](09_known-issues.md) — bugs and surprising behavior found while writing these docs.
10. [Testing](TESTING.md) — running and writing tests, known bugs flagged by tests.

## Related projects

All siblings live in `../` (`Rakson-OPC-DEX/`).

| Project | Relation |
| --- | --- |
| `net.xode.dex.queue` | Indexes `assetConversion.SwapExecuted` events into Mongo and MariaDB. Without it, simulated swaps exist only on chain. |
| `net.xode.dex.server` | Serves the indexed data to the front. |
| `net.xode.dex.front` | Shows the chart, ticker and swap history the simulator is meant to fill. |
| `../docker-compose.infra.yml` | Local Mongo, MariaDB, Redis and RabbitMQ. Its default network is what `docker-compose.yml` joins. |
