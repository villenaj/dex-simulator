import { test } from "node:test";
import assert from "node:assert/strict";

import { Keyring } from "@polkadot/api";

import { config } from "../src/config";
import { Chain, fromUnits, poolPrice, toUnits, walletKeys } from "../src/chain";

test("toUnits converts decimals exactly for typical amounts", () => {
  assert.equal(toUnits(1, 12), 1_000_000_000_000n);
  assert.equal(toUnits(1.5, 6), 1_500_000n);
  assert.equal(toUnits(0.000001, 6), 1n);
  assert.equal(toUnits(35, 6), 35_000_000n);
  assert.equal(toUnits(0, 12), 0n);
  assert.equal(toUnits(200, 12), 200_000_000_000_000n);
  assert.equal(toUnits(1234.5678, 0), 1235n); // toFixed(0) rounds
});

test("toUnits rounds (not truncates) beyond the precision", () => {
  assert.equal(toUnits(1.2345678, 6), 1_234_568n);
  assert.equal(toUnits(0.0000004, 6), 0n);
});

test("toUnits handles negative values", () => {
  assert.equal(toUnits(-1.5, 6), -1_500_000n);
});

test("toUnits avoids classic float artifacts at 6/12 decimals", () => {
  assert.equal(toUnits(0.1 + 0.2, 6), 300_000n);
  assert.equal(toUnits(0.1 + 0.2, 12), 300_000_000_000n);
});

test("fromUnits is the inverse of toUnits for representable values", () => {
  for (const [v, d] of [
    [1, 12],
    [1.5, 6],
    [35.25, 6],
    [0.000001, 6],
  ] as const) {
    assert.equal(fromUnits(toUnits(v, d), d), v);
  }
  assert.equal(fromUnits(0n, 12), 0);
  assert.equal(fromUnits(123n, 0), 123);
});

const chain = (baseDecimals: number, quoteDecimals: number) => ({ baseDecimals, quoteDecimals }) as Chain;

test("poolPrice = quote / base in human units", () => {
  // 1000 XON (12 dp) / 500 USDT (6 dp) -> 0.5 USDT per XON
  assert.equal(poolPrice(chain(12, 6), { base: toUnits(1000, 12), quote: toUnits(500, 6) }), 0.5);
  assert.equal(poolPrice(chain(12, 6), { base: toUnits(2, 12), quote: toUnits(5, 6) }), 2.5);
});

test("walletKeys derives `${walletUri}//${i}` with Xode SS58 prefix 280", () => {
  const original = config.chain.walletUri;
  try {
    config.chain.walletUri = "//Alice";
    const keys = walletKeys(3);
    assert.equal(keys.length, 3);
    assert.equal(new Set(keys.map((k) => k.address)).size, 3);
    // deterministic
    assert.deepEqual(walletKeys(3).map((k) => k.address), keys.map((k) => k.address));
    // a different walletUri gives different accounts
    config.chain.walletUri = "//Bob";
    assert.notEqual(walletKeys(1)[0].address, keys[0].address);
    assert.deepEqual(walletKeys(0), []);
    // derivation path and ss58 format 280 (Xode)
    const xode = new Keyring({ type: "sr25519", ss58Format: 280 });
    const generic = new Keyring({ type: "sr25519", ss58Format: 42 });
    assert.equal(keys[2].address, xode.addFromUri("//Alice//2").address);
    assert.notEqual(keys[2].address, generic.addFromUri("//Alice//2").address);
  } finally {
    config.chain.walletUri = original;
  }
});
