# Running Locally and in Docker

The [README](../README.md#usage) lists the everyday commands. This page explains the prerequisites and the differences between the two compose files.

## Prerequisites

| Need | Why | Check |
| --- | --- | --- |
| Node.js `>=20.19.0`, pnpm `10.17.0` | `package.json` `engines` / `packageManager` | `node -v`, `corepack enable` |
| Reachable dev chain RPC | Every command except `purge` connects to it | `pnpm status` |
| A pool for XON / asset `SIM_QUOTE_ASSET_ID` | `getReserves` throws `No XON/USDT pool on <url>.` otherwise | `pnpm status` |
| Funded funder account | Wallet top-ups come from it | `pnpm status` (funder line) |
| `net.xode.dex.queue` running and synced against the same chain | Otherwise swaps never reach Mongo / MariaDB or the UI | Queue logs show `Detected SwapExecuted event ...` |
| Local Mongo + MariaDB | Only for `purge` | `../docker-compose.infra.yml` |
| RPC method `system_dryRun` allowed | Every swap is dry-run first (`src/chain.ts:222`) | If the node refuses it, every swap fails with `dry run ...` errors. Whether the dev node exposes it was not checked here. |

## Locally with pnpm

```bash
corepack enable
pnpm install
cp .env.example .env   # then review SIM_RPC_URL and SIM_EXPECTED_CHAIN

pnpm status            # confirms the chain name and shows the pool
pnpm live
```

- Runs TypeScript directly through `tsx`; there is no build step (`pnpm build` only type-checks).
- The hourly activity shape follows your machine's local time zone. Set `TZ=Asia/Manila` to match the Docker setup.
- `purge` from the host needs the infra DBs published on localhost (the infra compose maps `27017` and `3306`).

## Docker image

`Dockerfile`: `node:24-slim`, `corepack enable`, `pnpm install --frozen-lockfile`, copies `tsconfig.json` and `src/`. The entrypoint is `node_modules/.bin/tsx src/index.ts` with default command `live`. `.env` and `state/` are excluded by `.dockerignore`; both compose files supply `.env` through `env_file` and mount `./state` to `/app/state`.

## `docker-compose.yml` vs `docker-compose.server.yml`

| | `docker-compose.yml` | `docker-compose.server.yml` |
| --- | --- | --- |
| Intended host | A developer machine | The dev server (`192.168.254.200`), same host as the node |
| Network | External network `rakson-opc-dex_default` (default network of `../docker-compose.infra.yml`) | `network_mode: host` |
| RPC | `SIM_RPC_URL` from `.env` (default `ws://192.168.254.200:9977`) | `ws://127.0.0.1:9977` |
| DB hosts for `purge` | `mongo`, `mariadb` (infra service names) | from `.env` |
| DB names for `purge` | `xode_indexer_testnet`, `dex_db_testnet` | from `.env` |
| User | `1000:1000` | image default (root) |
| Who fills the DBs | the local queue | the server's `xode-queue-agent` (per the file's comment) |
| Restart | `unless-stopped` | `unless-stopped` |
| `TZ` | `${TZ:-Asia/Manila}` | `${TZ:-Asia/Manila}` |

Both use `container_name: xodex-simulator` and image `xodex-simulator:local`, so only one of them can run on a host at a time.

### Local Docker

```bash
docker compose -f ../docker-compose.infra.yml up -d    # creates the rakson-opc-dex_default network
docker compose up -d --build
docker compose logs -f simulator
docker compose run --rm simulator status
```

The infra stack must be up first, or `docker compose up` fails because the external network does not exist.

### Dev server

```bash
docker compose -f docker-compose.server.yml up -d --build
docker compose -f docker-compose.server.yml logs -f simulator
```

`docker-compose.yml.bak` is the previous local compose file from the DB-writing version. It is not used.

## Stopping the container

`docker compose stop` sends `SIGTERM`, which the simulator handles by finishing the current swap (see [Commands](04_commands.md#live)). Neither compose file sets `stop_grace_period`, so Docker's default of 10 seconds applies, while a swap takes about 40–60 s to finalize. If a swap is in flight, Docker kills the process before it finishes. The transaction has already been submitted, so it should still land on chain; only its log line is lost. To stop cleanly, use `docker compose stop -t 200` (longer than `SIM_FINALIZE_TIMEOUT_MS`).

## One-off commands in Docker

```bash
docker compose run --rm simulator fund
docker compose run --rm simulator status
docker compose run --rm simulator purge
docker compose run --rm simulator purge --state state/state.dex_db.json
```

The working directory is `/app`, so `--state state/...` resolves into the mounted `./state` folder.
