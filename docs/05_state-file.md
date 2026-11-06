# State File

The state file is a **legacy artifact**. The old DB-writing simulator recorded the MariaDB `swap` row IDs it inserted, so they could be removed later. The current simulator never writes a state file; it only reads and deletes one in `purge` (`src/state.ts`).

## Location

| Context | Path |
| --- | --- |
| Default | `<project>/state/state.json`, resolved from `src/state.ts` as `path.resolve(__dirname, "..", "state", "state.json")` |
| Docker | `/app/state/state.json`, bind-mounted from `./state` by both compose files |
| Custom | `purge --state <path>`, resolved against the current working directory |

The `README` mentions a second file, `state/state.dex_db.json`, for data the old simulator wrote to the mainnet-indexer DB names. The code has no special handling for that name; it is just passed with `--state`.

`state/` is listed in both `.gitignore` and `.dockerignore`, so the files are never committed or baked into the image. At the time of writing, the local `state/` directory is empty.

## Format

```ts
// src/state.ts:7-9
interface LegacyState {
  swapIds: number[];
}
```

```json
{ "swapIds": [1201, 1202, 1203] }
```

- `swapIds` are values of the `swap.swap_id` column (auto-increment primary key; see `Rakson-OPC-DEX/dex_db_schema.sql`).
- `loadState` does a plain `JSON.parse` with no validation. A file without `swapIds` would make `deleteSwaps` fail on `ids.length`. Fields other than `swapIds` are ignored. Whether the old simulator wrote other fields cannot be confirmed from this repository.

## Lifecycle in `purge`

1. `loadState(file)` returns `null` if the file does not exist.
2. If it exists, `deleteSwaps` removes those rows in chunks of 500 (`src/legacy.ts:15-23`).
3. `clearState(file)` deletes the file, whether or not it existed or any rows matched.

So `purge` is one-shot per state file: the second run still deletes any remaining `sim_*` candles but has no swap IDs left to delete. Make sure the DB names point at the database the file belongs to before running it. Running it against the wrong DB deletes rows by ID in that DB and then discards the file.
