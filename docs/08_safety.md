# Safety Notes

The simulator signs real transactions and `purge` deletes rows. These are the guards, and their limits.

## Guards in the code

| Guard | Where | Protects against | Limit |
| --- | --- | --- | --- |
| Chain name check | `src/chain.ts:62-69` | Signing on mainnet or any other chain. Runs before any key is used, for `live`, `fund` and `status`. | Only as good as `SIM_EXPECTED_CHAIN`. If someone sets it to a mainnet's chain name, the check passes. Another node that also reports `Local Testnet` passes too. |
| Local DB check | `src/config.ts:79-89` | `purge` deleting from a remote or production DB. | `mongo` and `mariadb` are accepted as "local" because they are Docker service names; on another Docker network those names could resolve elsewhere. Only the host is checked, not the DB name. |
| Candle filter | `src/legacy.ts` | Deleting real candles. Only `lastSourceType` `sim_swap` / `sim_gap` for `pool:<SIM_POOL_ID>` are removed. | — |
| Swap ID list | `src/state.ts`, `src/legacy.ts` | Deleting real swaps. Only IDs listed in the state file are removed. | IDs are auto-increment numbers. Against the wrong DB they can match real rows. |
| Dry run | `src/chain.ts:220-230` | Broadcasting a swap that would fail (fees, balance, pool errors). | Needs `system_dryRun` on the node. |
| Slippage | `src/chain.ts:216` | Fills worse than the quote by more than `SIM_SLIPPAGE_BPS`. | — |
| 2% pool cap | `src/index.ts:58-59` | One trade moving the price too far. | — |
| `transferKeepAlive`, `keep_alive = true` | `src/chain.ts:182-184,218` | Reaping the funder or a wallet account. | — |

## Keys

- `SIM_WALLET_SURI` (default `//XodeSim`) and `SIM_FUNDER_SURI` (default `//Alice`) are **public dev derivation paths**. Anyone can derive the same keys. Never fund them on a real network.
- `.env` contains these URIs and the DB passwords. It is gitignored and dockerignored. Keep it that way.

## Data

- `live`, `fund` and `status` never open a DB connection. All indexed data comes from the queue.
- `purge` is the only destructive command. Before running it, check `MONGO_DB_NAME`, `MARIA_DB_NAME` and `--state` together: the state file belongs to one specific database. See [State file](05_state-file.md).
- `purge` deletes the state file after running, so a mistake cannot be repeated, but it also cannot be retried.

## Operational

- Don't run two `live` processes with the same `SIM_WALLET_SURI`. They would share wallets and nonces. Signing uses `nonce: -1` (next nonce including pending), which reduces but does not rule out conflicts. Two compose files on one host already conflict on `container_name`.
- The funder pays for all top-ups. When it runs dry, top-up batches fail and the affected trades are logged as failures; `live` keeps running.
- Stopping the Docker container with the default 10 s timeout can kill an in-flight swap's wait. See [Running](07_running.md#stopping-the-container).

## Tests

The test suite never connects to the chain or the DBs and never runs `live`, `fund`, `status` or `purge`. See [TESTING.md](TESTING.md).
