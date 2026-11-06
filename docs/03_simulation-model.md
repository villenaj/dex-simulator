# Simulation Model

This page describes exactly how `live` decides **when** a trade happens, **who** trades, **which side**, and **how much**. Formulas and constants are taken from `src/simulate.ts` and `src/index.ts`. The [README](../README.md#how-the-activity-looks) has the one-paragraph summary.

## 1. Random number generator

`Rng` (`src/simulate.ts:33-80`) is a seeded mulberry32 generator. The string seed is hashed with 32-bit FNV-1a (`hashSeed`). An empty seed falls back to `${Date.now()}-${Math.random()}`.

| Method | Definition |
| --- | --- |
| `next()` | Uniform in `[0, 1)` (mulberry32). |
| `range(min, max)` | `min + (max - min) * next()` |
| `normal()` | Box–Muller: `sqrt(-2 ln u) * cos(2π v)`, with `u` floored at `1e-12`. |
| `poisson(λ)` | Knuth's multiplication method; returns 0 for `λ <= 0`. |
| `pickWeighted(items)` | Roulette-wheel selection on `item.weight`. |

Two independent generators are used:

| Generator | Seed | Used for |
| --- | --- | --- |
| Profile RNG | `${SIM_WALLET_SURI}-profile` (`src/index.ts:37`) | Wallet buy biases. Fixed, so the same wallets keep the same personality across restarts. |
| Live RNG | `${SIM_SEED}-live-${Date.now()}` if `SIM_SEED` is set, otherwise random (`src/index.ts:85`) | Arrivals, sides, sizes, fair price. |

Because `Date.now()` is appended, **`SIM_SEED` does not make `live` runs reproducible**, despite the comment in `.env.example`. See [Known issues](09_known-issues.md).

## 2. Wallets and Zipf weights

`createWallets` (`src/simulate.ts:93-100`) gives wallet `i` (0-based):

```text
weight_i  = 1 / (i + 1)^1.1                                   # Zipf, exponent 1.1
buyBias_i = clamp(0.5 + N(0,1) * 0.18, 0.15, 0.85)            # profile RNG
```

The wallet address is `${SIM_WALLET_SURI}//i` (`src/chain.ts:86-89`). Each arrival picks a wallet with probability `weight_i / Σ weight`.

With the default 24 wallets, `Σ weight ≈ 3.322`: wallet 0 takes about **30%** of trades and wallet 23 about **0.9%**. Weights depend only on the index, not on the address.

## 3. Arrivals: Poisson with an hourly shape

`live` works in **one-minute windows** (`ONE_MINUTE_MS`, `src/index.ts:23,120-138`). For each window it calls `arrivalsWindow(rng, wallets, start, start + 60 s)`, which calls `arrivalsBetween` with a constant rate of `SIM_TRADES_PER_DAY` (`src/simulate.ts:203-204`).

`arrivalsBetween` (`src/simulate.ts:123-164`) steps through the window an hour at a time (a one-minute window is a single step) and computes:

```text
dayFactor = exp(N(0,1) * 0.35)                       # one per UTC day key floor(t / 86 400 000)
fraction  = (stepEnd - stepStart) / 1 hour            # 1/60 for a one-minute window
λ         = SIM_TRADES_PER_DAY * hourShare(stepStart) * dayFactor * fraction
count     ~ Poisson(λ)
```

Each of the `count` trades gets a uniform time inside the step and a weighted wallet. Then, with probability **0.15**, the same wallet gets **1 or 2** follow-up trades, each `40 s` to `15 min` after the previous one. Follow-ups are kept only if they fall before the end of the window. Arrivals are sorted by time and executed in order; `live` sleeps until each one is due.

### Hourly shape

`hourShare(at) = HOURLY_WEIGHT[at.getHours()] / 22.65` (`src/simulate.ts:85-91`). `getHours()` uses the **process time zone** (`TZ`; Docker defaults to `Asia/Manila`).

| Hour | Weight | Share | Expected trades at 18/day |
| --- | --- | --- | --- |
| 00 | 0.5 | 2.21% | 0.40 |
| 01 | 0.3 | 1.32% | 0.24 |
| 02 | 0.2 | 0.88% | 0.16 |
| 03 | 0.15 | 0.66% | 0.12 |
| 04 | 0.15 | 0.66% | 0.12 |
| 05 | 0.2 | 0.88% | 0.16 |
| 06 | 0.35 | 1.55% | 0.28 |
| 07 | 0.6 | 2.65% | 0.48 |
| 08 | 0.9 | 3.97% | 0.72 |
| 09 | 1.1 | 4.86% | 0.87 |
| 10 | 1.3 | 5.74% | 1.03 |
| 11 | 1.4 | 6.18% | 1.11 |
| 12 | 1.3 | 5.74% | 1.03 |
| 13 | 1.2 | 5.30% | 0.95 |
| 14 | 1.1 | 4.86% | 0.87 |
| 15 | 1.1 | 4.86% | 0.87 |
| 16 | 1.2 | 5.30% | 0.95 |
| 17 | 1.3 | 5.74% | 1.03 |
| 18 | 1.4 | 6.18% | 1.11 |
| 19 | 1.6 | 7.06% | 1.27 |
| 20 | 1.7 | 7.51% | 1.35 |
| 21 | 1.6 | 7.06% | 1.27 |
| 22 | 1.2 | 5.30% | 0.95 |
| 23 | 0.8 | 3.53% | 0.64 |

The "expected" column excludes the day factor and follow-ups.

### What actually happens in `live`

Because `arrivalsBetween` creates a new `dayFactor` map on every call, and `live` calls it once a minute, the day factor is **re-drawn every minute** rather than once per day. Two effects (derived from the code, not measured):

- Day-to-day variation disappears; the rate is just the hourly shape with per-minute noise.
- The mean rate is `E[exp(0.35 N)] = exp(0.35² / 2) ≈ 1.063`, so about **6% more** trades than `SIM_TRADES_PER_DAY`.

Follow-ups are almost always discarded: a follow-up needs to land at least 40 s after its parent but before the window ends, which only happens when the parent is in the first 20 s of the minute and the gap is short. By that calculation fewer than 1% of follow-up candidates survive. The README's "about 15% of trades are followed by one or two more" does not hold in practice. See [Known issues](09_known-issues.md).

Execution is sequential: a swap blocks for ~40–60 s until finalized, so arrivals that came due meanwhile run back to back.

## 4. Fair price random walk

`FairPrice` (`src/simulate.ts:172-190`) starts at the current pool price when `live` starts (`src/index.ts:91-92`). Each trade advances it to "now" with a geometric Brownian step:

```text
σ   = SIM_DAILY_VOLATILITY          (default 0.06)
Δt  = days since the previous advance
P  ← P * exp(σ * sqrt(Δt) * N(0,1) - 0.5 * σ² * Δt)
```

The `-0.5σ²Δt` term keeps the expected price unchanged (no drift). The fair price is never written anywhere; it only biases sides. The fill price always comes from the pool.

## 5. Buy/sell decision

`planTrade` (`src/simulate.ts:192-200`):

```text
pull      = 4 * ln(fairPrice / poolPrice)
buyChance = clamp(buyBias + pull, 0.05, 0.95)
side      = next() < buyChance ? "buy" : "sell"
```

When the pool is 5% below the fair price, `pull ≈ +0.195`, so a neutral wallet (bias 0.5) buys about 70% of the time. Buying raises the pool price, which pulls it back towards the fair price. This is what keeps the pool from drifting to one side.

## 6. Trade size and `niceRound`

### Raw size

`sampleTradeUsdt` (`src/simulate.ts:111-114`):

```text
usdt = clamp(SIM_MEDIAN_TRADE_USDT * exp(N(0,1) * 1.05), 2, 2500)
```

Log-normal with median `SIM_MEDIAN_TRADE_USDT` (default 35) and σ = 1.05. About 68% of samples fall between `35 / e^1.05 ≈ 12` and `35 * e^1.05 ≈ 100` USDT.

The input amount is:

- **buy:** `niceRound(usdt)` USDT
- **sell:** `niceRound(usdt / poolPrice)` XON

### `niceRound`

`src/simulate.ts:102-109`. With probability 0.55 the value is kept as is. Otherwise:

```text
magnitude = 10^floor(log10(value))
step      = pick([1, 2, 2.5, 5, 10]) * magnitude * (50% ? 0.1 : 1)
result    = max(step, round(value / step) * step)
```

Example: `37.42` (magnitude 10). With the `× 0.1` factor the step is 1, 2, 2.5, 5 or 10, giving `37`, `38`, `37.5`, `35` or `40`. With `× 1` the step is 10, 20, 25, 50 or 100, giving `40`, `40`, `25`, `50` or `100`.

Choosing `10 × magnitude` with the `× 1` factor always yields `10 × magnitude` (below `5 × magnitude` through the `max(step, …)` floor, above it by normal rounding). So any value is pushed up to the next power of ten with probability `0.45 × 0.5 × 0.2 = 4.5%`. For example, a 2400 USDT buy can become 10000 USDT, which breaks the 2500 cap. This is tracked in [TESTING.md](TESTING.md#known-bugs-flagged-by-tests).

## 7. Pool-percentage cap

Before submitting, `executeTrade` (`src/index.ts:56-59`) converts the amount to planck units and caps it:

```text
reserveIn = buy ? quoteReserve : baseReserve
amountIn  = min(amountIn, reserveIn / 50)      # 2% of the input-side reserve, integer division
```

This limits one swap's price impact (roughly 4% for a constant-product pool at 2% of the reserve, before fees). It also bounds the `niceRound` overshoot.

## 8. Funding before a trade

Still in `executeTrade` (`src/index.ts:61-73`), with `feeReserve = 1 XON`:

```text
short = buy  ? quoteBalance < amountIn
              : baseBalance  < amountIn + feeReserve
if short or baseBalance < feeReserve:
    topUpWallets([wallet], minimum = {
        base:  buy ? 2 * feeReserve : 2 * (amountIn + feeReserve),
        quote: buy ? 2 * amountIn   : 0
    })
```

`topUpWallets` (`src/chain.ts:163-194`) then, per wallet:

```text
wantBase  = max(SIM_FUND_XON,  minimum.base)        (in planck)
wantQuote = max(SIM_FUND_USDT, minimum.quote)
topped up if balance < want / 2  or  balance < minimum
transfer  = want - balance
```

Transfers are `balances.transferKeepAlive` (XON) and `assets.transferKeepAlive` (USDT), XON first because USDT is not a sufficient asset (comment at `src/chain.ts:161`). All calls go in one `utility.batchAll` signed by the funder, so either every transfer lands or none does.

## 9. Quote and slippage

`swap()` (`src/chain.ts:200-247`):

1. Path: buy `[USDT, XON]`, sell `[XON, USDT]`.
2. `quoted = assetConversionApi.quotePriceExactTokensForTokens(in, out, amountIn, include_fee = true)`. A `null` quote throws `pool could not quote this swap`.
3. `minOut = quoted * (10 000 - SIM_SLIPPAGE_BPS) / 10 000` (bigint, default 100 bps = 1%).
4. `assetConversion.swapExactTokensForTokens(path, amountIn, minOut, signer, keep_alive = true)`, signed with `nonce: -1` (next nonce including the pool).
5. `system.dryRun` on the signed extrinsic. Errors are decoded to `section.name` and thrown before anything is broadcast.
6. Submit and wait for **finalization** (not just inclusion), up to `SIM_FINALIZE_TIMEOUT_MS`.
7. Read `amountIn` / `amountOut` from the `assetConversion.SwapExecuted` event (data positions 2 and 3). If the event is missing, fall back to the requested input and the quote.

The log line prints side, XON amount, USDT amount, the effective price `USDT / XON`, block number, a short tx hash and a short wallet address (`src/index.ts:77-81`).

Any error in steps 2–7, or in the top-up, is caught in `live`, logged as `Swap from <addr>… failed: <message>`, and the loop continues (`src/index.ts:128-132`).
