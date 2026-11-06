# Known Issues

Bugs already flagged by the test suite are listed in [TESTING.md](TESTING.md#known-bugs-flagged-by-tests) and are not repeated in full here:

- `niceRound` can push a trade up to 10× its magnitude, past the 2500 USDT cap (`src/simulate.ts:106-108`).
- `CHAIN_COMMANDS[command]` accepts inherited keys such as `constructor` (`src/index.ts:198`).
- The day factor is re-drawn every minute in `live` (`src/simulate.ts:131,139`).
- `hostOf` reads `mongodb+srv://` URIs as host `mongodb+srv` (safe: `purge` refuses it).

The items below were found while writing this documentation. None of them has a test yet. Behavior described as an estimate is derived from the code, not measured.

| Issue | Location | Effect |
| --- | --- | --- |
| Follow-up trades are almost always dropped in `live`. A follow-up is 40 s to 15 min after its parent but is kept only inside the current one-minute window. | `src/simulate.ts:151-159`, `src/index.ts:120-122` | The README's "about 15% of trades are followed by one or two more" effectively does not happen (estimated well under 1% of follow-ups survive). |
| Average rate is about 6% above `SIM_TRADES_PER_DAY`. | `src/simulate.ts:139,143` | `E[exp(0.35·N)] ≈ 1.063`, re-drawn per minute. A side effect of the day-factor issue above. |
| `SIM_SEED` does not make runs reproducible. | `src/index.ts:85` | `Date.now()` is appended to the seed. `.env.example` says "for reproducible runs". |
| `SIM_POOL_ID`, `SIM_BASE`, `SIM_QUOTE` do not select the traded pool. | `src/chain.ts:13-17`, `src/config.ts:61-65` | The pool is always native XON vs `SIM_QUOTE_ASSET_ID`. A mismatched `SIM_POOL_ID` makes `purge` filter the wrong `pairKey`. |
| `MONGO_URI` is really a host. | `src/config.ts:18-26`, `src/db.ts` | Port, credentials and DB name inside a full URI are dropped; `MONGO_PORT`, `MONGO_USER`, etc. are used instead. |
| `MONGO_URI=::1` (without brackets) is refused. | `src/config.ts:18-26` | `hostOf` splits on `:` and gets an empty host. `[::1]` works. Safe direction. |
| Docker stop timeout is shorter than a swap. | `docker-compose*.yml` | Default 10 s grace vs ~40–60 s finalization; the process is killed mid-wait. See [Running](07_running.md#stopping-the-container). |
| Signals during the initial top-up of `live` are not handled. | `src/index.ts:88,112` | Handlers are registered after the top-up; Ctrl+C there kills the process immediately (the batch may still land). |
| `SIM_FINALIZE_TIMEOUT_MS` and `SIM_TRADES_PER_DAY_END` are undocumented in `.env.example`. | `src/config.ts:39,67` | Documented in [Configuration](06_configuration.md). |
| No validation of the state file shape. | `src/state.ts:11-14` | A file without `swapIds` makes `purge` throw after the candles were already deleted. |
