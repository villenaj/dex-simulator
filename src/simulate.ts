import { config } from "./config";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export type Side = "buy" | "sell";

export interface Wallet {
  index: number;
  address: string;
  // 지갑별 매수 성향 (0~1). 일부는 꾸준히 모으고, 일부는 주로 파는 식으로 성향이 다릅니다.
  buyBias: number;
  weight: number;
}

export interface TradePlan {
  side: Side;
  // 입력 자산 수량 (매수: USDT, 매도: XON)
  amountIn: number;
}

// ---------- RNG ----------

const hashSeed = (seed: string): number => {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export class Rng {
  private state: number;

  constructor(seed: string) {
    this.state = hashSeed(seed || `${Date.now()}-${Math.random()}`);
  }

  // mulberry32
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const limit = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > limit);
    return k - 1;
  }

  pickWeighted<T extends { weight: number }>(items: T[]): T {
    const total = items.reduce((sum, item) => sum + item.weight, 0);
    let roll = this.next() * total;
    for (const item of items) {
      roll -= item.weight;
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }
}

// ---------- Activity shape ----------

// 로컬 시간 기준 시간대별 활동 가중치 (새벽은 한산, 점심/저녁에 활발)
const HOURLY_WEIGHT = [
  0.5, 0.3, 0.2, 0.15, 0.15, 0.2, 0.35, 0.6, 0.9, 1.1, 1.3, 1.4,
  1.3, 1.2, 1.1, 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 1.6, 1.2, 0.8,
];
const HOURLY_WEIGHT_SUM = HOURLY_WEIGHT.reduce((a, b) => a + b, 0);

export const hourShare = (at: Date): number => HOURLY_WEIGHT[at.getHours()] / HOURLY_WEIGHT_SUM;

export const createWallets = (rng: Rng, addresses: string[]): Wallet[] =>
  addresses.map((address, i) => ({
    index: i,
    address,
    buyBias: Math.min(0.85, Math.max(0.15, 0.5 + rng.normal() * 0.18)),
    // Zipf 분포: 소수의 지갑이 자주 거래하고 대부분은 가끔 거래합니다.
    weight: 1 / Math.pow(i + 1, 1.1),
  }));

const niceRound = (value: number, rng: Rng): number => {
  // 사람이 직접 입력한 듯한 금액(10, 25, 50, 100 ...)이 섞이도록 일부만 반올림합니다.
  if (rng.next() > 0.45) return value;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const steps = [1, 2, 2.5, 5, 10];
  const step = steps[Math.floor(rng.next() * steps.length)] * magnitude * (rng.next() < 0.5 ? 0.1 : 1);
  return Math.max(step, Math.round(value / step) * step);
};

const sampleTradeUsdt = (rng: Rng): number => {
  const raw = config.price.medianTradeUsdt * Math.exp(rng.normal() * 1.05);
  return Math.min(2500, Math.max(2, raw));
};

// ---------- Arrivals ----------

interface Arrival {
  at: Date;
  wallet: Wallet;
}

const arrivalsBetween = (
  rng: Rng,
  wallets: Wallet[],
  from: Date,
  to: Date,
  perDayAt: (at: Date) => number,
): Arrival[] => {
  const arrivals: Arrival[] = [];
  const dayFactor = new Map<number, number>();

  for (let t = from.getTime(); t < to.getTime(); t += HOUR_MS) {
    const hourStart = new Date(t);
    const hourEnd = Math.min(t + HOUR_MS, to.getTime());
    const dayKey = Math.floor(t / DAY_MS);
    if (!dayFactor.has(dayKey)) {
      // 하루 단위로 활동량이 들쭉날쭉하도록 랜덤 계수 적용
      dayFactor.set(dayKey, Math.exp(rng.normal() * 0.35));
    }

    const fraction = (hourEnd - t) / HOUR_MS;
    const lambda = perDayAt(hourStart) * hourShare(hourStart) * dayFactor.get(dayKey)! * fraction;
    const count = rng.poisson(lambda);

    for (let i = 0; i < count; i++) {
      const at = new Date(rng.range(t, hourEnd));
      const wallet = rng.pickWeighted(wallets);
      arrivals.push({ at, wallet });

      // 같은 사용자가 몇 분 안에 한두 번 더 거래하는 경우
      if (rng.next() < 0.15) {
        const followUps = 1 + Math.floor(rng.next() * 2);
        let last = at.getTime();
        for (let j = 0; j < followUps; j++) {
          last += rng.range(40_000, 15 * 60_000);
          if (last < to.getTime()) arrivals.push({ at: new Date(last), wallet });
        }
      }
    }
  }

  return arrivals.sort((a, b) => a.at.getTime() - b.at.getTime());
};

// ---------- Trades ----------

/**
 * 지갑들이 따라가는 적정 가격. 기하 랜덤 워크로 움직이고, 실제 풀 가격과의 차이만큼
 * 매수/매도 확률을 기울여 풀 가격이 적정 가격을 따라가게 합니다.
 */
export class FairPrice {
  private lastAt: number;

  constructor(
    private rng: Rng,
    public price: number,
    at: Date,
  ) {
    this.lastAt = at.getTime();
  }

  advance(at: Date): number {
    const vol = config.price.dailyVolatility;
    const dtDays = Math.max(0, at.getTime() - this.lastAt) / DAY_MS;
    this.price *= Math.exp(vol * Math.sqrt(dtDays) * this.rng.normal() - 0.5 * vol * vol * dtDays);
    this.lastAt = at.getTime();
    return this.price;
  }
}

export const planTrade = (rng: Rng, wallet: Wallet, poolPrice: number, fairPrice: number): TradePlan => {
  const pull = 4 * Math.log(fairPrice / poolPrice);
  const buyChance = Math.min(0.95, Math.max(0.05, wallet.buyBias + pull));
  const side: Side = rng.next() < buyChance ? "buy" : "sell";
  const usdt = sampleTradeUsdt(rng);

  // 매수는 USDT 금액, 매도는 XON 수량을 사용자가 입력한 것처럼 만듭니다.
  return { side, amountIn: side === "buy" ? niceRound(usdt, rng) : niceRound(usdt / poolPrice, rng) };
};

/** [from, to) 구간의 거래 도착 시각과 지갑 */
export const arrivalsWindow = (rng: Rng, wallets: Wallet[], from: Date, to: Date) =>
  arrivalsBetween(rng, wallets, from, to, () => config.activity.tradesPerDay);
