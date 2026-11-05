import "@polkadot/api-augment";
import { ApiPromise, Keyring, WsProvider } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";

import { config } from "./config";

const XODE_SS58_PREFIX = 280;

export type KeyringPair = ReturnType<Keyring["addFromUri"]>;

// AssetConversion.pools 키와 같은 인코딩 (네이티브 XON 은 parent `Here`).
// api-augment 의 타입은 범용 런타임 기준이라 Xode 의 Location 키와 맞지 않아 never 로 넘깁니다.
const NATIVE_ASSET = { parents: 1, interior: "Here" } as never;
const quoteAsset = (): never => ({
  parents: 0,
  interior: { X2: [{ PalletInstance: 50 }, { GeneralIndex: config.chain.quoteAssetId }] },
}) as never;

export interface Chain {
  api: ApiPromise;
  funder: KeyringPair;
  baseDecimals: number;
  quoteDecimals: number;
}

export interface Balances {
  base: bigint;
  quote: bigint;
}

export interface Reserves {
  base: bigint;
  quote: bigint;
}

export interface SwapReceipt {
  txHash: string;
  blockHash: string;
  blockNumber: number;
  amountIn: bigint;
  amountOut: bigint;
}

// ---------- units ----------

export const toUnits = (value: number, decimals: number): bigint => {
  const [whole, fraction = ""] = value.toFixed(decimals).split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0").slice(0, decimals));
};

export const fromUnits = (value: bigint, decimals: number): number => Number(value) / 10 ** decimals;

// ---------- connection ----------

export const connectChain = async (): Promise<Chain> => {
  const api = await ApiPromise.create({
    provider: new WsProvider(config.chain.rpcUrl, 2_500),
    throwOnConnect: true,
    noInitWarn: true,
  });

  // 개발 체인이 아니면 어떤 트랜잭션도 서명하지 않습니다.
  const name = (await api.rpc.system.chain()).toString();
  if (name !== config.chain.expectedName) {
    await api.disconnect();
    throw new Error(
      `Refusing to run: ${config.chain.rpcUrl} is "${name}", expected "${config.chain.expectedName}" (SIM_EXPECTED_CHAIN).`,
    );
  }

  const metadata = await api.query.assets.metadata(config.chain.quoteAssetId);
  const keyring = new Keyring({ type: "sr25519", ss58Format: XODE_SS58_PREFIX });

  return {
    api,
    funder: keyring.addFromUri(config.chain.funderUri),
    baseDecimals: api.registry.chainDecimals[0],
    quoteDecimals: Number(metadata.decimals.toString()),
  };
};

export const disconnectChain = async (chain: Chain) => {
  await chain.api.disconnect();
};

export const walletKeys = (count: number): KeyringPair[] => {
  const keyring = new Keyring({ type: "sr25519", ss58Format: XODE_SS58_PREFIX });
  return Array.from({ length: count }, (_, i) => keyring.addFromUri(`${config.chain.walletUri}//${i}`));
};

// ---------- reads ----------

export const getReserves = async ({ api }: Chain): Promise<Reserves> => {
  const result = (await api.call.assetConversionApi.getReserves(NATIVE_ASSET, quoteAsset())).toJSON() as
    | [string | number, string | number]
    | null;
  if (!result) throw new Error(`No ${config.pair.base}/${config.pair.quote} pool on ${config.chain.rpcUrl}.`);
  return { base: BigInt(result[0]), quote: BigInt(result[1]) };
};

/** 풀 가격 (XON 1개당 USDT) */
export const poolPrice = (chain: Chain, reserves: Reserves): number =>
  fromUnits(reserves.quote, chain.quoteDecimals) / fromUnits(reserves.base, chain.baseDecimals);

export const getBalances = async ({ api }: Chain, address: string): Promise<Balances> => {
  const [account, asset] = await Promise.all([
    api.query.system.account(address),
    api.query.assets.account(config.chain.quoteAssetId, address),
  ]);
  return {
    base: account.data.free.toBigInt(),
    quote: asset.isSome ? asset.unwrap().balance.toBigInt() : 0n,
  };
};

// ---------- submission ----------

/** 서명된 트랜잭션을 전송하고 최종 확정까지 기다립니다. 블록 안에서 실패하면 에러를 던집니다. */
const submitAndFinalize = (
  chain: Chain,
  tx: SubmittableExtrinsic<"promise">,
): Promise<{ blockHash: string; txHash: string; events: { event: { section: string; method: string; data: any } }[] }> =>
  new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error(`not finalized within ${config.chain.finalizeTimeoutMs / 1000}s (tx ${tx.hash.toHex()})`));
    }, config.chain.finalizeTimeoutMs);

    const settle = (fn: () => void) => {
      clearTimeout(timer);
      unsubscribe?.();
      fn();
    };

    tx.send(({ status, events, dispatchError, txHash }) => {
      if (status.isInvalid || status.isDropped || status.isUsurped) {
        settle(() => reject(new Error(`transaction ${status.type.toLowerCase()} (tx ${txHash.toHex()})`)));
        return;
      }
      if (!status.isFinalized) return;

      if (dispatchError) {
        const message = dispatchError.isModule
          ? (({ section, name }) => `${section}.${name}`)(chain.api.registry.findMetaError(dispatchError.asModule))
          : dispatchError.toString();
        settle(() => reject(new Error(`failed on chain: ${message} (tx ${txHash.toHex()})`)));
        return;
      }

      settle(() => resolve({ blockHash: status.asFinalized.toHex(), txHash: txHash.toHex(), events }));
    })
      .then((unsub) => {
        unsubscribe = unsub;
      })
      .catch((error) => settle(() => reject(error)));
  });

/**
 * 잔고가 목표의 절반 아래인 지갑을 funder 계정에서 목표치까지 채웁니다. (utility.batchAll 1건)
 * USDT 는 sufficient 자산이 아니므로 같은 배치에서 XON 을 먼저 보냅니다.
 */
export const topUpWallets = async (
  chain: Chain,
  wallets: KeyringPair[],
  minimum: Partial<Record<string, Balances>> = {},
): Promise<number> => {
  const { api } = chain;
  const baseTarget = toUnits(config.funding.baseTarget, chain.baseDecimals);
  const quoteTarget = toUnits(config.funding.quoteTarget, chain.quoteDecimals);
  const calls: SubmittableExtrinsic<"promise">[] = [];
  let funded = 0;

  for (const wallet of wallets) {
    const balance = await getBalances(chain, wallet.address);
    const need = minimum[wallet.address];
    const wantBase = need && need.base > baseTarget ? need.base : baseTarget;
    const wantQuote = need && need.quote > quoteTarget ? need.quote : quoteTarget;
    const lowBase = balance.base < wantBase / 2n || (need !== undefined && balance.base < need.base);
    const lowQuote = balance.quote < wantQuote / 2n || (need !== undefined && balance.quote < need.quote);

    if (lowBase) calls.push(api.tx.balances.transferKeepAlive(wallet.address, wantBase - balance.base));
    if (lowQuote) {
      calls.push(api.tx.assets.transferKeepAlive(config.chain.quoteAssetId, wallet.address, wantQuote - balance.quote));
    }
    if (lowBase || lowQuote) funded++;
  }

  if (calls.length > 0) {
    const batch = await api.tx.utility.batchAll(calls).signAsync(chain.funder, { nonce: -1 });
    await submitAndFinalize(chain, batch);
  }
  return funded;
};

/**
 * swapExactTokensForTokens 로 실제 스왑을 실행합니다.
 * 예상 수령량은 런타임 API 로 미리 계산하고, 슬리피지를 넘으면 체인에서 거절됩니다.
 */
export const swap = async (
  chain: Chain,
  signer: KeyringPair,
  side: "buy" | "sell",
  amountIn: bigint,
): Promise<SwapReceipt> => {
  const { api } = chain;
  const path = side === "buy" ? [quoteAsset(), NATIVE_ASSET] : [NATIVE_ASSET, quoteAsset()];

  const quoted = (await api.call.assetConversionApi.quotePriceExactTokensForTokens(
    path[0],
    path[1],
    amountIn,
    true,
  )).toJSON() as string | number | null;
  if (quoted === null) throw new Error("pool could not quote this swap");
  const minOut = (BigInt(quoted) * BigInt(10_000 - config.chain.slippageBps)) / 10_000n;

  const tx = api.tx.assetConversion.swapExactTokensForTokens(path, amountIn, minOut, signer.address, true);

  // 수수료·잔고 문제는 전송 전에 걸러냅니다.
  await tx.signAsync(signer, { nonce: -1 });
  const dryRun = await api.rpc.system.dryRun(tx.toHex());
  if (dryRun.isErr) throw new Error(`dry run rejected: ${dryRun.asErr.toString()}`);
  if (dryRun.asOk.isErr) {
    const error = dryRun.asOk.asErr;
    const message = error.isModule
      ? (({ section, name }) => `${section}.${name}`)(api.registry.findMetaError(error.asModule))
      : error.toString();
    throw new Error(`dry run failed: ${message}`);
  }

  const result = await submitAndFinalize(chain, tx);
  const header = await api.rpc.chain.getHeader(result.blockHash);

  const executed = result.events.find(
    ({ event }) => event.section === "assetConversion" && event.method === "SwapExecuted",
  );
  const [, , eventIn, eventOut] = executed ? executed.event.data : [];

  return {
    txHash: result.txHash,
    blockHash: result.blockHash,
    blockNumber: header.number.toNumber(),
    amountIn: eventIn ? BigInt(eventIn.toString()) : amountIn,
    amountOut: eventOut ? BigInt(eventOut.toString()) : BigInt(quoted),
  };
};
