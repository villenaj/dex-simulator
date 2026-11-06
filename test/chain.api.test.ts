import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config";
import { Chain, getBalances, getReserves, KeyringPair, swap, topUpWallets, toUnits } from "../src/chain";

// ---------- fakes ----------

type StatusUpdate = {
  status: Record<string, unknown>;
  txHash?: { toHex: () => string };
  dispatchError?: unknown;
  events?: unknown[];
};

const finalized = (blockHash = "0xblock", events: unknown[] = []): StatusUpdate => ({
  status: { isFinalized: true, asFinalized: { toHex: () => blockHash }, type: "Finalized" },
  events,
});
const inBlock = (): StatusUpdate => ({ status: { isInBlock: true, isFinalized: false, type: "InBlock" } });
const invalid = (type: string): StatusUpdate => ({ status: { [`is${type}`]: true, type } });

interface FakeTx {
  kind: string;
  args: unknown[];
  hash: { toHex: () => string };
  signedWith?: { signer: unknown; options: unknown };
  unsubscribed: number;
  signAsync: (signer: unknown, options: unknown) => Promise<FakeTx>;
  toHex: () => string;
  send: (cb: (result: any) => void) => Promise<() => void>;
}

const makeTx = (kind: string, args: unknown[], updates: () => StatusUpdate[], sendError?: Error): FakeTx => {
  const tx: FakeTx = {
    kind,
    args,
    hash: { toHex: () => `0xhash-${kind}` },
    unsubscribed: 0,
    async signAsync(signer, options) {
      tx.signedWith = { signer, options };
      return tx;
    },
    toHex: () => `0xsigned-${kind}`,
    async send(cb) {
      if (sendError) throw sendError;
      // emit status updates after send() has resolved, as polkadot.js does
      setImmediate(() => {
        for (const u of updates()) cb({ txHash: { toHex: () => `0xtx-${kind}` }, events: [], ...u });
      });
      return () => {
        tx.unsubscribed++;
      };
    },
  };
  return tx;
};

interface FakeOptions {
  reserves?: [string | number, string | number] | null;
  balances?: Record<string, { base: bigint; quote?: bigint }>;
  quoted?: string | number | null;
  updates?: () => StatusUpdate[];
  dryRun?: unknown;
  sendError?: Error;
  blockNumber?: number;
}

const makeChain = (opts: FakeOptions = {}) => {
  const calls: { method: string; args: unknown[] }[] = [];
  const txs: FakeTx[] = [];
  const updates = opts.updates ?? (() => [inBlock(), finalized()]);
  const tx = (kind: string) => (...args: unknown[]) => {
    calls.push({ method: kind, args });
    const t = makeTx(kind, args, updates, opts.sendError);
    txs.push(t);
    return t;
  };
  const api = {
    call: {
      assetConversionApi: {
        getReserves: async (...args: unknown[]) => {
          calls.push({ method: "getReserves", args });
          return { toJSON: () => (opts.reserves === undefined ? null : opts.reserves) };
        },
        quotePriceExactTokensForTokens: async (...args: unknown[]) => {
          calls.push({ method: "quote", args });
          return { toJSON: () => (opts.quoted === undefined ? null : opts.quoted) };
        },
      },
    },
    query: {
      system: {
        account: async (address: string) => ({
          data: { free: { toBigInt: () => opts.balances?.[address]?.base ?? 0n } },
        }),
      },
      assets: {
        account: async (_id: number, address: string) => {
          const quote = opts.balances?.[address]?.quote;
          return quote === undefined
            ? { isSome: false, unwrap: () => assert.fail("unwrap on None") }
            : { isSome: true, unwrap: () => ({ balance: { toBigInt: () => quote } }) };
        },
      },
    },
    tx: {
      balances: { transferKeepAlive: tx("balances.transferKeepAlive") },
      assets: { transferKeepAlive: tx("assets.transferKeepAlive") },
      utility: { batchAll: tx("utility.batchAll") },
      assetConversion: { swapExactTokensForTokens: tx("assetConversion.swap") },
    },
    rpc: {
      system: {
        dryRun: async (hex: string) => {
          calls.push({ method: "dryRun", args: [hex] });
          return opts.dryRun ?? { isErr: false, asOk: { isErr: false } };
        },
      },
      chain: {
        getHeader: async (hash: string) => {
          calls.push({ method: "getHeader", args: [hash] });
          return { number: { toNumber: () => opts.blockNumber ?? 42 } };
        },
      },
    },
    registry: {
      findMetaError: () => ({ section: "assetConversion", name: "ProvidedMinimumNotSufficientForSwap" }),
    },
  };
  const chain = { api, funder: { address: "funder" }, baseDecimals: 12, quoteDecimals: 6 } as unknown as Chain;
  return { chain, calls, txs };
};

const pair = (address: string) => ({ address }) as unknown as KeyringPair;

const NATIVE = { parents: 1, interior: "Here" };
const QUOTE = { parents: 0, interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: 1984 }] } };

beforeEach(() => {
  config.chain.quoteAssetId = 1984;
  config.chain.slippageBps = 100;
  config.chain.finalizeTimeoutMs = 2_000;
  config.funding.baseTarget = 200;
  config.funding.quoteTarget = 1000;
});

// ---------- reads ----------

test("getReserves queries native/quote Location keys and parses string/number reserves", async () => {
  const { chain, calls } = makeChain({ reserves: ["1000000000000000", 500000000] });
  assert.deepEqual(await getReserves(chain), { base: 1_000_000_000_000_000n, quote: 500_000_000n });
  assert.deepEqual(calls[0].args, [NATIVE, QUOTE]);
});

test("getReserves uses the configured quote asset id", async () => {
  config.chain.quoteAssetId = 1337;
  const { chain, calls } = makeChain({ reserves: [1, 2] });
  await getReserves(chain);
  assert.equal((calls[0].args[1] as typeof QUOTE).interior.X2[1].GeneralIndex, 1337);
});

test("getReserves throws when the pool does not exist", async () => {
  const { chain } = makeChain({ reserves: null });
  await assert.rejects(getReserves(chain), /No XON\/USDT pool|No .*pool/);
});

test("getBalances reads native free balance and asset balance (0 when no asset account)", async () => {
  const { chain } = makeChain({ balances: { a: { base: 5n, quote: 7n }, b: { base: 3n } } });
  assert.deepEqual(await getBalances(chain, "a"), { base: 5n, quote: 7n });
  assert.deepEqual(await getBalances(chain, "b"), { base: 3n, quote: 0n });
});

// ---------- topUpWallets ----------

const BASE_TARGET = toUnits(200, 12);
const QUOTE_TARGET = toUnits(1000, 6);

test("topUpWallets: no calls / no submission when every wallet is at least half funded", async () => {
  const { chain, calls } = makeChain({
    balances: { a: { base: BASE_TARGET / 2n, quote: QUOTE_TARGET / 2n }, b: { base: BASE_TARGET, quote: QUOTE_TARGET } },
  });
  assert.equal(await topUpWallets(chain, [pair("a"), pair("b")]), 0);
  assert.equal(calls.length, 0);
});

test("topUpWallets: tops low wallets up to the target in one batchAll signed by the funder", async () => {
  const { chain, calls, txs } = makeChain({
    balances: {
      low: { base: 1n, quote: 2n },
      lowQuoteOnly: { base: BASE_TARGET },
      ok: { base: BASE_TARGET, quote: QUOTE_TARGET },
    },
  });
  const funded = await topUpWallets(chain, [pair("low"), pair("lowQuoteOnly"), pair("ok")]);
  assert.equal(funded, 2);

  const transfers = calls.filter((c) => c.method !== "utility.batchAll");
  assert.deepEqual(transfers, [
    { method: "balances.transferKeepAlive", args: ["low", BASE_TARGET - 1n] },
    { method: "assets.transferKeepAlive", args: [1984, "low", QUOTE_TARGET - 2n] },
    { method: "assets.transferKeepAlive", args: [1984, "lowQuoteOnly", QUOTE_TARGET] },
  ]);

  const batch = txs.find((t) => t.kind === "utility.batchAll")!;
  assert.equal((batch.args[0] as unknown[]).length, 3);
  // XON transfer precedes USDT for the same wallet (USDT is not a sufficient asset)
  assert.equal((batch.args[0] as FakeTx[])[0].kind, "balances.transferKeepAlive");
  assert.deepEqual(batch.signedWith, { signer: chain.funder, options: { nonce: -1 } });
  assert.equal(batch.unsubscribed, 1);
});

test("topUpWallets: explicit minimum above the target raises the top-up amount", async () => {
  const needBase = BASE_TARGET * 3n;
  const { chain, calls } = makeChain({ balances: { a: { base: BASE_TARGET, quote: QUOTE_TARGET } } });
  const funded = await topUpWallets(chain, [pair("a")], { a: { base: needBase, quote: 0n } });
  assert.equal(funded, 1);
  assert.deepEqual(calls[0], { method: "balances.transferKeepAlive", args: ["a", needBase - BASE_TARGET] });
  // quote balance is fine (>= half target, >= need 0) -> no asset transfer
  assert.equal(calls.filter((c) => c.method === "assets.transferKeepAlive").length, 0);
});

test("topUpWallets: balance below an explicit minimum (but above half target) still triggers a top-up to target", async () => {
  const balance = (BASE_TARGET * 6n) / 10n; // above target/2
  const { chain, calls } = makeChain({ balances: { a: { base: balance, quote: QUOTE_TARGET } } });
  const funded = await topUpWallets(chain, [pair("a")], { a: { base: (BASE_TARGET * 8n) / 10n, quote: 0n } });
  assert.equal(funded, 1);
  assert.deepEqual(calls[0], { method: "balances.transferKeepAlive", args: ["a", BASE_TARGET - balance] });
});

test("topUpWallets: a minimum the wallet already meets changes nothing", async () => {
  const { chain, calls } = makeChain({ balances: { a: { base: BASE_TARGET, quote: QUOTE_TARGET } } });
  assert.equal(await topUpWallets(chain, [pair("a")], { a: { base: 1n, quote: 1n } }), 0);
  assert.equal(calls.length, 0);
});

test("topUpWallets: propagates on-chain dispatch errors from the batch", async () => {
  const dispatchError = { isModule: true, asModule: {}, toString: () => "Module" };
  const { chain } = makeChain({
    balances: { a: { base: 0n } },
    updates: () => [{ ...finalized(), dispatchError }],
  });
  await assert.rejects(topUpWallets(chain, [pair("a")]), /failed on chain: assetConversion\.ProvidedMinimumNotSufficientForSwap/);
});

// ---------- swap ----------

test("swap (buy): path quote->native, minOut applies slippage, returns event amounts", async () => {
  const event = { event: { section: "assetConversion", method: "SwapExecuted", data: ["who", "to", "1000000", "1990000000000"] } };
  const { chain, calls, txs } = makeChain({
    quoted: "2000000000000",
    updates: () => [inBlock(), finalized("0xfinal", [{ event: { section: "system", method: "ExtrinsicSuccess", data: [] } }, event])],
    blockNumber: 1234,
  });
  const signer = pair("signer");
  const receipt = await swap(chain, signer, "buy", 1_000_000n);

  const quote = calls.find((c) => c.method === "quote")!;
  assert.deepEqual(quote.args, [QUOTE, NATIVE, 1_000_000n, true]);

  const swapTx = txs.find((t) => t.kind === "assetConversion.swap")!;
  // 2_000_000_000_000 * (10000 - 100) / 10000
  assert.deepEqual(swapTx.args, [[QUOTE, NATIVE], 1_000_000n, 1_980_000_000_000n, "signer", true]);
  assert.deepEqual(swapTx.signedWith, { signer, options: { nonce: -1 } });
  assert.deepEqual(calls.find((c) => c.method === "dryRun")!.args, ["0xsigned-assetConversion.swap"]);
  assert.deepEqual(calls.find((c) => c.method === "getHeader")!.args, ["0xfinal"]);

  assert.deepEqual(receipt, {
    txHash: "0xtx-assetConversion.swap",
    blockHash: "0xfinal",
    blockNumber: 1234,
    amountIn: 1_000_000n,
    amountOut: 1_990_000_000_000n,
  });
});

test("swap (sell): path native->quote; falls back to input/quote when SwapExecuted is missing", async () => {
  config.chain.slippageBps = 250;
  const { chain, txs } = makeChain({ quoted: 4000 });
  const receipt = await swap(chain, pair("s"), "sell", 10n);
  const swapTx = txs.find((t) => t.kind === "assetConversion.swap")!;
  assert.deepEqual(swapTx.args[0], [NATIVE, QUOTE]);
  assert.equal(swapTx.args[2], 3900n);
  assert.equal(receipt.amountIn, 10n);
  assert.equal(receipt.amountOut, 4000n);
});

test("swap: rejects when the pool cannot quote", async () => {
  const { chain, txs } = makeChain({ quoted: null });
  await assert.rejects(swap(chain, pair("s"), "buy", 1n), /could not quote/);
  assert.equal(txs.length, 0);
});

test("swap: dry-run transport error and dispatch error are reported, nothing is sent", async () => {
  const rpcErr = makeChain({ quoted: 1, dryRun: { isErr: true, asErr: { toString: () => "Invalid" } } });
  await assert.rejects(swap(rpcErr.chain, pair("s"), "buy", 1n), /dry run rejected: Invalid/);

  const moduleErr = makeChain({
    quoted: 1,
    dryRun: { isErr: false, asOk: { isErr: true, asErr: { isModule: true, asModule: {} } } },
  });
  await assert.rejects(swap(moduleErr.chain, pair("s"), "buy", 1n), /dry run failed: assetConversion\.ProvidedMinimumNotSufficientForSwap/);

  const otherErr = makeChain({
    quoted: 1,
    dryRun: { isErr: false, asOk: { isErr: true, asErr: { isModule: false, toString: () => "BadOrigin" } } },
  });
  await assert.rejects(swap(otherErr.chain, pair("s"), "buy", 1n), /dry run failed: BadOrigin/);
  for (const c of [rpcErr, moduleErr, otherErr]) assert.ok(!c.calls.some((x) => x.method === "getHeader"));
});

test("swap: invalid / dropped / usurped transactions reject", async () => {
  for (const type of ["Invalid", "Dropped", "Usurped"]) {
    const { chain, txs } = makeChain({ quoted: 1, updates: () => [invalid(type)] });
    await assert.rejects(swap(chain, pair("s"), "buy", 1n), new RegExp(`transaction ${type.toLowerCase()}`));
    assert.equal(txs[0].unsubscribed, 1);
  }
});

test("swap: non-module dispatch error message uses toString()", async () => {
  const { chain } = makeChain({
    quoted: 1,
    updates: () => [{ ...finalized(), dispatchError: { isModule: false, toString: () => "Token.FundsUnavailable" } }],
  });
  await assert.rejects(swap(chain, pair("s"), "sell", 1n), /failed on chain: Token\.FundsUnavailable/);
});

test("swap: send() failure rejects", async () => {
  const { chain } = makeChain({ quoted: 1, sendError: new Error("ws closed") });
  await assert.rejects(swap(chain, pair("s"), "buy", 1n), /ws closed/);
});

test("swap: rejects with a timeout when never finalized and unsubscribes", async () => {
  config.chain.finalizeTimeoutMs = 30;
  const { chain, txs } = makeChain({ quoted: 1, updates: () => [inBlock()] });
  await assert.rejects(swap(chain, pair("s"), "buy", 1n), /not finalized within 0\.03s \(tx 0xhash-assetConversion\.swap\)/);
  assert.equal(txs[0].unsubscribed, 1);
});
