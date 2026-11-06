# Configuration

All settings come from environment variables, loaded from `.env` by `dotenv` (`src/config.ts:3`). Start from `.env.example`. Defaults below are the **code** defaults in `src/config.ts`; `.env.example` sets the same values unless noted.

Parsing rules (`src/config.ts:8-16`):

- Numbers: a blank or non-numeric value falls back to the default.
- Strings: values are trimmed; blank falls back to the default.
- Values already in the process environment win over `.env` (standard `dotenv` behavior), which is how the compose files override settings.

## Chain

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIM_RPC_URL` | `ws://192.168.254.200:9977` | WebSocket RPC of the Xode dev chain. `docker-compose.server.yml` overrides it to `ws://127.0.0.1:9977`. |
| `SIM_EXPECTED_CHAIN` | `Local Testnet` | Must equal `system.chain()` exactly, or nothing is signed. |
| `SIM_FUNDER_SURI` | `//Alice` | Secret URI of the account that funds the wallets. On the dev chain `//Alice` holds XON and USDT. |
| `SIM_WALLET_SURI` | `//XodeSim` | Wallet `i` is `${SIM_WALLET_SURI}//i`. Also seeds the wallet profiles (`-profile`). Changing it gives a new set of wallets with new biases. |
| `SIM_QUOTE_ASSET_ID` | `1984` | Asset ID of the quote token (USDT) in pallet instance 50. This, not `SIM_QUOTE`, decides which pool is traded. |
| `SIM_SLIPPAGE_BPS` | `100` | Slippage for `minOut`, in basis points (100 = 1%). |
| `SIM_FINALIZE_TIMEOUT_MS` | `180000` | How long to wait for a transaction to finalize. **Not in `.env.example`.** |

## Funding

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIM_FUND_XON` | `200` | Target XON per wallet. Topped up when below half. |
| `SIM_FUND_USDT` | `1000` | Target USDT per wallet. Topped up when below half. |

A single trade can raise the target above these values; see [Simulation model](03_simulation-model.md#8-funding-before-a-trade).

## Pair

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIM_POOL_ID` | `0` | Builds `pool:<id>` for the `status` header and the `purge` candle filter. Not used to select the pool for swaps. |
| `SIM_BASE` | `XON` | Display label in logs only. |
| `SIM_QUOTE` | `USDT` | Display label in logs only. Also used in the "No XON/USDT pool" error. |

## Activity and price

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIM_TRADES_PER_DAY` | `18` | Target average trades per day, before the hourly shape. Falls back to the legacy `SIM_TRADES_PER_DAY_END` if unset (`src/config.ts:67`). |
| `SIM_TRADES_PER_DAY_END` | — | Legacy name, read only as the fallback above. Not in `.env.example`. |
| `SIM_WALLET_COUNT` | `24` | Number of simulator wallets. |
| `SIM_DAILY_VOLATILITY` | `0.06` | Daily volatility of the fair-price random walk. |
| `SIM_MEDIAN_TRADE_USDT` | `35` | Median trade size in USDT (log-normal). |
| `SIM_SEED` | blank (random) | Seed for the live RNG. `Date.now()` is appended to it, so runs are **not** reproducible. |

## Databases (`purge` only)

These are read by `purge` and nothing else. `live`, `fund` and `status` never open a DB connection.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MONGO_URI` | `127.0.0.1` | Mongo **host**. A `mongodb://user:pass@host:port/db` string is accepted, but only the host part is kept (`hostOf`, `src/config.ts:18-26`); port, credentials and DB in it are ignored. |
| `MONGO_PORT` | `27017` | Mongo port. |
| `MONGO_DB_NAME` | `xode_indexer` | Mongo database. The testnet indexer uses `xode_indexer_testnet`. |
| `MONGO_USER` | blank | Mongo user. Credentials are added only when both user and password are set. `.env.example` sets the dev user. |
| `MONGO_PASS` | blank | Mongo password. `.env.example` sets the dev password. |
| `MONGO_AUTH_SOURCE` | `admin` | `authSource` query parameter (only with credentials). |
| `MARIA_DB_HOST` | `127.0.0.1` | MariaDB host. |
| `MARIA_DB_PORT` | `3306` | MariaDB port. |
| `MARIA_DB_USER` | `root` | MariaDB user. |
| `MARIA_DB_PASS` | blank | MariaDB password. `.env.example` sets the dev password. |
| `MARIA_DB_NAME` | `dex_db` | MariaDB database. The testnet indexer uses `dex_db_testnet`. |

`MONGO_URI` and `MARIA_DB_HOST` must be one of `127.0.0.1`, `localhost`, `::1`, `mongo`, `mariadb`, or `purge` refuses to run.

## Other

| Variable | Default | Purpose |
| --- | --- | --- |
| `TZ` | host time zone; `Asia/Manila` in both compose files | Decides which local hour the hourly activity shape uses (`Date.getHours()`). |

## Overrides in the compose files

| Variable | `docker-compose.yml` | `docker-compose.server.yml` |
| --- | --- | --- |
| `MONGO_URI` | `mongo` | from `.env` |
| `MARIA_DB_HOST` | `mariadb` | from `.env` |
| `MONGO_DB_NAME` | `xode_indexer_testnet` | from `.env` |
| `MARIA_DB_NAME` | `dex_db_testnet` | from `.env` |
| `SIM_RPC_URL` | from `.env` | `ws://127.0.0.1:9977` |
| `TZ` | `${TZ:-Asia/Manila}` | `${TZ:-Asia/Manila}` |
