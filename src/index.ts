import path from "path";

import { assertLocalTargets, config, pairKey } from "./config";
import { connect, disconnect } from "./db";
import {
  Chain,
  connectChain,
  disconnectChain,
  fromUnits,
  getBalances,
  getReserves,
  KeyringPair,
  poolPrice,
  swap,
  toUnits,
  topUpWallets,
  walletKeys,
} from "./chain";
import { countSimCandles, deleteSimCandles, deleteSwaps } from "./legacy";
import { arrivalsWindow, createWallets, FairPrice, planTrade, Rng, Wallet } from "./simulate";
import { clearState, DEFAULT_STATE_FILE, loadState } from "./state";

const ONE_MINUTE_MS = 60_000;

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const log = (...args: unknown[]) => console.log(`[${new Date().toISOString()}]`, ...args);

const fmt = (value: number, digits = 4) => value.toLocaleString("en-US", { maximumFractionDigits: digits });

const setupWallets = () => {
  const keys = walletKeys(config.activity.walletCount);
  // 지갑 성향(매수 비율, 거래 빈도)은 지갑 키에서 고정적으로 정해 재시작해도 같게 유지합니다.
  const wallets = createWallets(new Rng(`${config.chain.walletUri}-profile`), keys.map((key) => key.address));
  return { keys, wallets };
};

// ---------- commands ----------

const fund = async (chain: Chain) => {
  const { keys } = setupWallets();
  log(`Topping up ${keys.length} wallets from ${chain.funder.address} ...`);
  const funded = await topUpWallets(chain, keys);
  log(funded > 0 ? `Funded ${funded} wallets.` : "All wallets already funded.");
};

const executeTrade = async (chain: Chain, rng: Rng, fair: FairPrice, wallet: Wallet, keys: KeyringPair[]) => {
  const reserves = await getReserves(chain);
  const price = poolPrice(chain, reserves);
  const plan = planTrade(rng, wallet, price, fair.advance(new Date()));
  const isBuy = plan.side === "buy";

  // 한 번에 풀 입력 자산의 2% 를 넘지 않도록 제한합니다.
  const reserveIn = isBuy ? reserves.quote : reserves.base;
  let amountIn = toUnits(plan.amountIn, isBuy ? chain.quoteDecimals : chain.baseDecimals);
  if (amountIn > reserveIn / 50n) amountIn = reserveIn / 50n;

  // 잔고가 모자라면 이번 거래의 두 배만큼 채워 둡니다. XON 은 수수료용으로 1개를 더 남깁니다.
  const feeReserve = toUnits(1, chain.baseDecimals);
  const balance = await getBalances(chain, wallet.address);
  const short = isBuy ? balance.quote < amountIn : balance.base < amountIn + feeReserve;
  if (short || balance.base < feeReserve) {
    await topUpWallets(chain, [keys[wallet.index]], {
      [wallet.address]: {
        base: isBuy ? feeReserve * 2n : (amountIn + feeReserve) * 2n,
        quote: isBuy ? amountIn * 2n : 0n,
      },
    });
  }

  const receipt = await swap(chain, keys[wallet.index], plan.side, amountIn);
  const baseAmount = fromUnits(isBuy ? receipt.amountOut : receipt.amountIn, chain.baseDecimals);
  const quoteAmount = fromUnits(isBuy ? receipt.amountIn : receipt.amountOut, chain.quoteDecimals);

  log(
    `${plan.side.toUpperCase().padEnd(4)} ${fmt(baseAmount)} ${config.pair.base} for ${fmt(quoteAmount)} ${config.pair.quote}` +
      ` @ ${fmt(quoteAmount / baseAmount, 6)}  #${receipt.blockNumber} ${receipt.txHash.slice(0, 12)}…  ${wallet.address.slice(0, 8)}…`,
  );
};

const live = async (chain: Chain) => {
  const rng = new Rng(config.seed ? `${config.seed}-live-${Date.now()}` : "");
  const { keys, wallets } = setupWallets();

  const funded = await topUpWallets(chain, keys);
  if (funded > 0) log(`Funded ${funded} wallets from ${chain.funder.address}.`);

  const startPrice = poolPrice(chain, await getReserves(chain));
  const fair = new FairPrice(rng, startPrice, new Date());

  log(
    `Live swaps on ${config.chain.expectedName} (${config.chain.rpcUrl}) ${config.pair.base}/${config.pair.quote}` +
      ` at ~${config.activity.tradesPerDay} trades/day, pool price ${fmt(startPrice, 6)}. Ctrl+C to stop.`,
  );

  let stopping = false;
  let wake: (() => void) | null = null;
  // 종료 신호가 오면 대기 중인 sleep 을 즉시 깨웁니다. (진행 중인 스왑은 확정까지 기다립니다)
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  // SIGINT: Ctrl+C, SIGTERM: docker stop
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopping = true;
      log("Stopping...");
      wake?.();
    });
  }

  while (!stopping) {
    const windowStart = new Date();
    const windowEnd = new Date(windowStart.getTime() + ONE_MINUTE_MS);

    for (const { at, wallet } of arrivalsWindow(rng, wallets, windowStart, windowEnd)) {
      const waitMs = at.getTime() - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      if (stopping) break;

      try {
        await executeTrade(chain, rng, fair, wallet, keys);
      } catch (error) {
        log(`Swap from ${wallet.address.slice(0, 8)}… failed: ${error instanceof Error ? error.message : error}`);
      }
    }

    const remaining = windowEnd.getTime() - Date.now();
    if (!stopping && remaining > 0) await sleep(remaining);
  }
};

const status = async (chain: Chain) => {
  const { keys } = setupWallets();
  const reserves = await getReserves(chain);
  const header = await chain.api.rpc.chain.getHeader();

  log(`chain: ${config.chain.expectedName} (${config.chain.rpcUrl}) block #${header.number.toNumber()}  ${pairKey()}`);
  log(
    `pool: ${fmt(fromUnits(reserves.base, chain.baseDecimals))} ${config.pair.base} / ` +
      `${fmt(fromUnits(reserves.quote, chain.quoteDecimals))} ${config.pair.quote}  price ${fmt(poolPrice(chain, reserves), 6)}`,
  );

  const funder = await getBalances(chain, chain.funder.address);
  log(
    `funder ${chain.funder.address}: ${fmt(fromUnits(funder.base, chain.baseDecimals))} ${config.pair.base}, ` +
      `${fmt(fromUnits(funder.quote, chain.quoteDecimals))} ${config.pair.quote}`,
  );
  for (const key of keys) {
    const balance = await getBalances(chain, key.address);
    log(
      `  ${key.address}  ${fmt(fromUnits(balance.base, chain.baseDecimals))} ${config.pair.base}` +
        `  ${fmt(fromUnits(balance.quote, chain.quoteDecimals))} ${config.pair.quote}`,
    );
  }
};

/** 예전 버전이 DB 에 직접 넣은 가짜 캔들/스왑 행을 지웁니다. 체인 데이터와 큐가 기록한 행은 건드리지 않습니다. */
const purge = async () => {
  assertLocalTargets();
  const stateFile = path.resolve(argValue("state") ?? DEFAULT_STATE_FILE);
  const conns = await connect();
  try {
    const before = await countSimCandles(conns.db);
    const state = loadState(stateFile);
    const candles = await deleteSimCandles(conns.db);
    const swaps = state ? await deleteSwaps(conns.maria, state.swapIds) : 0;
    clearState(stateFile);
    log(`${config.mongo.dbName} / ${config.maria.database}: removed ${candles.deletedCount}/${before} simulated candles`);
    log(`and ${swaps} simulated swap rows (ids from ${stateFile}).`);
    log("Note: today's pool_ticker row is refreshed by the queue on its next swap/snapshot.");
  } finally {
    await disconnect(conns);
  }
};

const CHAIN_COMMANDS: Record<string, (chain: Chain) => Promise<void>> = { live, fund, status };

const main = async () => {
  const command = process.argv[2];

  if (command === "purge") return purge();
  if (command === "backfill") {
    throw new Error(
      "backfill is gone: swaps are now real transactions on the dev chain and can't be backdated. " +
        "Run `live` to build history, and `purge` once to remove the old DB-only data.",
    );
  }

  const run = CHAIN_COMMANDS[command];
  if (!run) {
    console.log("Usage: tsx src/index.ts <live | fund | status | purge [--state state/state.json]>");
    process.exit(1);
  }

  const chain = await connectChain();
  try {
    await run(chain);
  } finally {
    await disconnectChain(chain);
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
