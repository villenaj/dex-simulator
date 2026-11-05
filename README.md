# net.xode.dex.simulator

XON/USDT swap activity simulator for developing the DEX chart and history UI.

It signs and submits **real `assetConversion.swapExactTokensForTokens` transactions on the Xode dev chain**
(Local Testnet, `ws://192.168.254.200:9977`). It never writes to Mongo or MariaDB: the queue indexes the
`SwapExecuted` events like any other user's swaps, so the chart, swap history, ticker and the chain always agree.

Startup aborts unless `system.chain()` returns `SIM_EXPECTED_CHAIN` (default `Local Testnet`), so a mainnet RPC URL
can never be signed against.

## Wallets and funding

- `SIM_WALLET_COUNT` wallets are derived as `${SIM_WALLET_SURI}//0`, `//1`, … (default `//XodeSim//i`). These are
  public dev keys, which is fine on the dev chain only.
- `SIM_FUNDER_SURI` (default `//Alice`, which holds XON and USDT on the dev chain) tops each wallet up to
  `SIM_FUND_XON` / `SIM_FUND_USDT` in one `utility.batchAll` when it drops below half. `live` does this on start and
  again for any wallet that can't afford its next trade.

## How the activity looks

- **Arrivals:** Poisson per hour at `SIM_TRADES_PER_DAY`, weighted by local time of day (quiet overnight, busier
  midday/evening), with a random per-day factor so days aren't uniform.
- **Wallets:** a Zipf frequency (a few regulars, many occasional), each with its own buy/sell tendency. About 15% of
  trades are followed by one or two more from the same wallet within minutes.
- **Sizes:** log-normal around `SIM_MEDIAN_TRADE_USDT`. Some trades use round human amounts. A single swap is capped
  at 2% of the pool's input reserve.
- **Price:** set by the pool. Wallets lean towards a "fair price" that random-walks at `SIM_DAILY_VOLATILITY`: when
  the pool is below it they buy more, above it they sell more, so the pool price wanders realistically without
  draining either side.
- Each swap is quoted with the runtime API, sent with `SIM_SLIPPAGE_BPS` slippage, dry-run, then waited on until
  finalized (~40–60 s on the dev chain). Failed swaps are logged and skipped.

## Usage

```bash
pnpm install
cp .env.example .env

pnpm fund       # top up the simulator wallets from the funder
pnpm live       # keep submitting swaps in real time (Ctrl+C to stop; an in-flight swap still finishes)
pnpm status     # pool reserves/price, funder and wallet balances
pnpm purge      # remove the fake rows older versions wrote straight into the DBs (see below)
```

There is no `backfill` any more: on-chain swaps can't be backdated, so history builds up while `live` runs.

**The queue must be running and synced** (`net.xode.dex.queue`, writing to `xode_indexer_testnet` / `dex_db_testnet`),
otherwise the swaps land on chain but never show up in the UI.

### Cleaning up data from the old DB-only simulator

Older versions inserted fake swaps and candles (`lastSourceType: sim_swap / sim_gap`) directly into the DBs. They
don't exist on chain and should be removed once. `purge` deletes those candles for `pool:<SIM_POOL_ID>` and the
`swap` rows whose IDs are listed in the state file, then deletes the state file. It only accepts localhost DBs.

```bash
# testnet DBs (what the docker container wrote, ids in state/state.json)
MONGO_DB_NAME=xode_indexer_testnet MARIA_DB_NAME=dex_db_testnet pnpm purge
# mainnet-indexer DBs, if you ran the old simulator against them (ids in state/state.dex_db.json)
pnpm purge -- --state state/state.dex_db.json
```

### Docker

The container joins the infra stack's network (`rakson-opc-dex_default`) and talks to the dev chain directly.

```bash
docker compose up -d --build                          # runs `live` in the background, restarts on reboot
docker compose logs -f simulator                      # watch swaps
docker compose stop                                   # graceful stop

docker compose run --rm simulator fund                # one-off commands
docker compose run --rm simulator status
docker compose run --rm simulator purge               # uses the testnet DBs set in docker-compose.yml
```

`TZ` defaults to `Asia/Manila`, so the time-of-day pattern matches the host. Override it with `TZ=... docker compose up -d`.
