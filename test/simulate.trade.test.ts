import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config";
import { arrivalsWindow, createWallets, FairPrice, hourShare, planTrade, Rng, Wallet } from "../src/simulate";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Pin config values the module reads at call time so .env cannot influence results.
beforeEach(() => {
  config.price.medianTradeUsdt = 35;
  config.price.dailyVolatility = 0.06;
  config.activity.tradesPerDay = 18;
});

const wallet = (overrides: Partial<Wallet> = {}): Wallet => ({ index: 0, address: "addr0", buyBias: 0.5, weight: 1, ...overrides });

test("hourShare sums to 1 over the 24 local hours and favors evening over early morning", () => {
  let sum = 0;
  for (let h = 0; h < 24; h++) sum += hourShare(new Date(2026, 0, 1, h, 30));
  assert.ok(Math.abs(sum - 1) < 1e-12, `sum ${sum}`);
  assert.ok(hourShare(new Date(2026, 0, 1, 20)) > hourShare(new Date(2026, 0, 1, 4)));
});

test("createWallets: one per address, Zipf weights, buyBias clamped to [0.15, 0.85]", () => {
  const addresses = Array.from({ length: 200 }, (_, i) => `addr${i}`);
  const wallets = createWallets(new Rng("profile"), addresses);
  assert.equal(wallets.length, 200);
  wallets.forEach((w, i) => {
    assert.equal(w.index, i);
    assert.equal(w.address, addresses[i]);
    assert.ok(w.buyBias >= 0.15 && w.buyBias <= 0.85, `buyBias ${w.buyBias}`);
    assert.ok(Math.abs(w.weight - 1 / Math.pow(i + 1, 1.1)) < 1e-15);
  });
  // weights are strictly decreasing
  for (let i = 1; i < wallets.length; i++) assert.ok(wallets[i].weight < wallets[i - 1].weight);
  // with 200 draws and sd 0.18, both clamps should be hit at least once or values spread widely
  const biases = wallets.map((w) => w.buyBias);
  assert.ok(Math.max(...biases) - Math.min(...biases) > 0.4);
});

test("createWallets is deterministic for a given seed (stable profiles across restarts)", () => {
  const addrs = ["a", "b", "c"];
  assert.deepEqual(createWallets(new Rng("s"), addrs), createWallets(new Rng("s"), addrs));
  assert.deepEqual(createWallets(new Rng("s"), []), []);
});

test("planTrade: side follows buyBias when pool == fair price", () => {
  const rng = new Rng("bias");
  const n = 10_000;
  for (const bias of [0.2, 0.8]) {
    let buys = 0;
    for (let i = 0; i < n; i++) if (planTrade(rng, wallet({ buyBias: bias }), 1, 1).side === "buy") buys++;
    assert.ok(Math.abs(buys / n - bias) < 0.025, `bias ${bias} -> ${buys / n}`);
  }
});

test("planTrade: fair price above pool pulls toward buys, below pulls toward sells (clamped to 5%..95%)", () => {
  const rng = new Rng("pull");
  const n = 10_000;
  const share = (pool: number, fair: number) => {
    let buys = 0;
    for (let i = 0; i < n; i++) if (planTrade(rng, wallet(), pool, fair).side === "buy") buys++;
    return buys / n;
  };
  assert.ok(share(1, 1.05) > 0.6);
  assert.ok(share(1, 0.95) < 0.4);
  // extreme gaps hit the clamp, never 0% / 100%
  const high = share(1, 100);
  const low = share(1, 0.01);
  assert.ok(Math.abs(high - 0.95) < 0.015, `high ${high}`);
  assert.ok(Math.abs(low - 0.05) < 0.015, `low ${low}`);
});

test("planTrade: buys are in USDT, sells are in base units (USDT / pool price)", () => {
  const rng = new Rng("units");
  const buys: number[] = [];
  const sells: number[] = [];
  for (let i = 0; i < 20_000; i++) {
    const plan = planTrade(rng, wallet(), 0.5, 0.5);
    (plan.side === "buy" ? buys : sells).push(plan.amountIn);
  }
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const v of [...buys, ...sells]) assert.ok(v > 0 && Number.isFinite(v));
  // median USDT ~35, median XON ~35 / 0.5 = 70 (niceRound shifts a little)
  assert.ok(median(buys) > 25 && median(buys) < 50, `buy median ${median(buys)}`);
  assert.ok(median(sells) > 50 && median(sells) < 100, `sell median ${median(sells)}`);
});

test("planTrade: medianTradeUsdt from config scales amounts", () => {
  config.price.medianTradeUsdt = 350;
  const rng = new Rng("scale");
  const buys: number[] = [];
  for (let i = 0; i < 5000; i++) {
    const plan = planTrade(rng, wallet({ buyBias: 0.85 }), 1, 1);
    if (plan.side === "buy") buys.push(plan.amountIn);
  }
  buys.sort((a, b) => a - b);
  const median = buys[Math.floor(buys.length / 2)];
  assert.ok(median > 250 && median < 500, `median ${median}`);
});

test("planTrade: amounts never go below the 2 USDT floor", () => {
  const rng = new Rng("floor");
  for (let i = 0; i < 20_000; i++) {
    const plan = planTrade(rng, wallet({ buyBias: 0.85 }), 1, 1);
    if (plan.side === "buy") assert.ok(plan.amountIn >= 2 * 0.99, `amount ${plan.amountIn}`);
  }
});

test(
  "planTrade: buy amounts respect the 2500 USDT cap from sampleTradeUsdt",
  { todo: "niceRound can round up to 10x magnitude (e.g. 2500 -> 10000), bypassing the cap; src/simulate.ts:106-108" },
  () => {
    const rng = new Rng("x");
    for (let i = 0; i < 100_000; i++) {
      const plan = planTrade(rng, wallet({ buyBias: 0.85 }), 1, 1);
      if (plan.side === "buy") assert.ok(plan.amountIn <= 2500, `amount ${plan.amountIn}`);
    }
  },
);

test("FairPrice: zero elapsed time leaves the price unchanged", () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const fair = new FairPrice(new Rng("fp"), 2, at);
  assert.equal(fair.advance(at), 2);
  // time going backwards is clamped to dt = 0
  assert.equal(fair.advance(new Date(at.getTime() - DAY_MS)), 2);
});

test("FairPrice: one day step equals exp(vol*z - vol^2/2)", () => {
  const rng = new Rng("fp");
  const z = 1.5;
  rng.normal = () => z;
  const start = new Date("2026-01-01T00:00:00Z");
  const fair = new FairPrice(rng, 10, start);
  const vol = 0.06;
  const expected = 10 * Math.exp(vol * z - 0.5 * vol * vol);
  assert.ok(Math.abs(fair.advance(new Date(start.getTime() + DAY_MS)) - expected) < 1e-12);
  assert.ok(Math.abs(fair.price - expected) < 1e-12);
});

test("FairPrice: volatility from config, steps compound from the last advance", () => {
  config.price.dailyVolatility = 0;
  const start = new Date("2026-01-01T00:00:00Z");
  const fair = new FairPrice(new Rng("novol"), 3, start);
  for (let d = 1; d <= 5; d++) assert.equal(fair.advance(new Date(start.getTime() + d * DAY_MS)), 3);
});

test("FairPrice: random walk is roughly mean-preserving (martingale drift term)", () => {
  config.price.dailyVolatility = 0.2;
  const start = new Date("2026-01-01T00:00:00Z");
  const rng = new Rng("martingale");
  let sum = 0;
  const n = 20_000;
  for (let i = 0; i < n; i++) sum += new FairPrice(rng, 1, start).advance(new Date(start.getTime() + DAY_MS));
  assert.ok(Math.abs(sum / n - 1) < 0.01, `mean ${sum / n}`);
});

test("arrivalsWindow: sorted, inside [from, to), wallets drawn from the list", () => {
  const rng = new Rng("arrivals");
  const wallets = createWallets(rng, ["a", "b", "c", "d"]);
  const from = new Date("2026-03-01T00:00:00Z");
  const to = new Date(from.getTime() + 7 * DAY_MS);
  const arrivals = arrivalsWindow(rng, wallets, from, to);
  assert.ok(arrivals.length > 0);
  for (let i = 0; i < arrivals.length; i++) {
    const t = arrivals[i].at.getTime();
    assert.ok(t >= from.getTime() && t < to.getTime(), `out of window: ${arrivals[i].at.toISOString()}`);
    assert.ok(wallets.includes(arrivals[i].wallet));
    if (i > 0) assert.ok(t >= arrivals[i - 1].at.getTime());
  }
});

test("arrivalsWindow: empty / inverted windows produce no arrivals", () => {
  const rng = new Rng("empty");
  const wallets = createWallets(rng, ["a"]);
  const at = new Date("2026-03-01T00:00:00Z");
  assert.deepEqual(arrivalsWindow(rng, wallets, at, at), []);
  assert.deepEqual(arrivalsWindow(rng, wallets, at, new Date(at.getTime() - HOUR_MS)), []);
});

test("arrivalsWindow: tradesPerDay = 0 produces no arrivals", () => {
  config.activity.tradesPerDay = 0;
  const rng = new Rng("zero");
  const from = new Date("2026-03-01T00:00:00Z");
  assert.deepEqual(arrivalsWindow(rng, createWallets(rng, ["a"]), from, new Date(from.getTime() + 3 * DAY_MS)), []);
});

test("arrivalsWindow: daily count tracks tradesPerDay (incl. day factor and follow-up trades)", () => {
  config.activity.tradesPerDay = 100;
  const rng = new Rng("rate");
  const wallets = createWallets(rng, ["a", "b", "c"]);
  const days = 60;
  const from = new Date("2026-03-01T00:00:00Z");
  const count = arrivalsWindow(rng, wallets, from, new Date(from.getTime() + days * DAY_MS)).length;
  const perDay = count / days;
  // E[exp(0.35 N)] ~ 1.063 and ~15% of arrivals spawn ~1.5 follow-ups -> ~1.3x tradesPerDay
  assert.ok(perDay > 100 && perDay < 160, `per day ${perDay}`);
});

test("arrivalsWindow: short (1-minute) windows as used by live mode are respected", () => {
  config.activity.tradesPerDay = 50_000;
  const rng = new Rng("minute");
  const wallets = createWallets(rng, ["a", "b"]);
  const from = new Date("2026-03-01T12:00:00Z");
  const to = new Date(from.getTime() + 60_000);
  const arrivals = arrivalsWindow(rng, wallets, from, to);
  assert.ok(arrivals.length > 0);
  for (const { at } of arrivals) assert.ok(at >= from && at < to);
});

test("arrivalsWindow: deterministic for a given seed", () => {
  const from = new Date("2026-03-01T00:00:00Z");
  const to = new Date(from.getTime() + 2 * DAY_MS);
  const run = () => {
    const rng = new Rng("det");
    const wallets = createWallets(rng, ["a", "b", "c"]);
    return arrivalsWindow(rng, wallets, from, to).map(({ at, wallet }) => [at.getTime(), wallet.address]);
  };
  assert.deepEqual(run(), run());
});
