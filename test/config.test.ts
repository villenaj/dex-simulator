import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

type ConfigModule = typeof import("../src/config");

// config.ts reads process.env and ./.env (dotenv, relative to cwd) at import time.
// Load a fresh copy from an empty temp cwd with a controlled environment so the
// repo's real .env never leaks in.
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-config-"));
after(() => fs.rmSync(emptyDir, { recursive: true, force: true }));

const isConfigKey = (key: string) => /^(SIM_|MONGO_|MARIA_|DOTENV_)/.test(key);

const loadConfig = (env: Record<string, string> = {}, dotenvFile?: string): ConfigModule => {
  const savedEnv = { ...process.env };
  const savedCwd = process.cwd();
  const dir = dotenvFile === undefined ? emptyDir : fs.mkdtempSync(path.join(os.tmpdir(), "sim-config-env-"));
  if (dotenvFile !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotenvFile);
  try {
    for (const key of Object.keys(process.env)) if (isConfigKey(key)) delete process.env[key];
    Object.assign(process.env, env);
    process.chdir(dir);
    const resolved = require.resolve("../src/config");
    delete require.cache[resolved];
    return require(resolved) as ConfigModule;
  } finally {
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    if (dir !== emptyDir) fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("defaults when no env / .env is present", () => {
  const { config, pairKey } = loadConfig();
  assert.deepEqual(config, {
    chain: {
      rpcUrl: "ws://192.168.254.200:9977",
      expectedName: "Local Testnet",
      funderUri: "//Alice",
      walletUri: "//XodeSim",
      quoteAssetId: 1984,
      slippageBps: 100,
      finalizeTimeoutMs: 180_000,
    },
    funding: { baseTarget: 200, quoteTarget: 1000 },
    mongo: { host: "127.0.0.1", port: 27017, dbName: "xode_indexer", user: "", pass: "", authSource: "admin" },
    maria: { host: "127.0.0.1", port: 3306, user: "root", password: "", database: "dex_db" },
    pair: { poolId: "0", base: "XON", quote: "USDT" },
    activity: { tradesPerDay: 18, walletCount: 24 },
    price: { dailyVolatility: 0.06, medianTradeUsdt: 35 },
    seed: "",
  });
  assert.equal(pairKey(), "pool:0");
});

test("env overrides are applied and numeric values parsed", () => {
  const { config, pairKey } = loadConfig({
    SIM_RPC_URL: "ws://127.0.0.1:9944",
    SIM_EXPECTED_CHAIN: "Xode Dev",
    SIM_QUOTE_ASSET_ID: "1337",
    SIM_SLIPPAGE_BPS: "50",
    SIM_FUND_XON: "12.5",
    SIM_WALLET_COUNT: "3",
    SIM_DAILY_VOLATILITY: "1e-2",
    SIM_POOL_ID: "7",
    SIM_SEED: "abc",
    MONGO_PORT: "27018",
    MARIA_DB_HOST: "mariadb",
    MARIA_DB_PASS: "secret",
  });
  assert.equal(config.chain.rpcUrl, "ws://127.0.0.1:9944");
  assert.equal(config.chain.expectedName, "Xode Dev");
  assert.equal(config.chain.quoteAssetId, 1337);
  assert.equal(config.chain.slippageBps, 50);
  assert.equal(config.funding.baseTarget, 12.5);
  assert.equal(config.activity.walletCount, 3);
  assert.equal(config.price.dailyVolatility, 0.01);
  assert.equal(config.seed, "abc");
  assert.equal(config.mongo.port, 27018);
  assert.equal(config.maria.host, "mariadb");
  assert.equal(config.maria.password, "secret");
  assert.equal(pairKey(), "pool:7");
});

test("num(): blank, whitespace, non-numeric and infinite values fall back; 0 is kept", () => {
  for (const bad of ["", "   ", "abc", "Infinity", "NaN"]) {
    assert.equal(loadConfig({ SIM_SLIPPAGE_BPS: bad }).config.chain.slippageBps, 100, JSON.stringify(bad));
  }
  assert.equal(loadConfig({ SIM_SLIPPAGE_BPS: "0" }).config.chain.slippageBps, 0);
  assert.equal(loadConfig({ SIM_SLIPPAGE_BPS: " 25 " }).config.chain.slippageBps, 25);
});

test("str(): values are trimmed and blank values fall back", () => {
  const { config } = loadConfig({ SIM_FUNDER_SURI: "  //Bob  ", SIM_WALLET_SURI: "   ", SIM_BASE: "" });
  assert.equal(config.chain.funderUri, "//Bob");
  assert.equal(config.chain.walletUri, "//XodeSim");
  assert.equal(config.pair.base, "XON");
});

test("tradesPerDay falls back to SIM_TRADES_PER_DAY_END, and SIM_TRADES_PER_DAY wins", () => {
  assert.equal(loadConfig({ SIM_TRADES_PER_DAY_END: "40" }).config.activity.tradesPerDay, 40);
  assert.equal(
    loadConfig({ SIM_TRADES_PER_DAY: "5", SIM_TRADES_PER_DAY_END: "40" }).config.activity.tradesPerDay,
    5,
  );
});

test("MONGO_URI: host is extracted (scheme, credentials, port, path stripped; lowercased)", () => {
  const cases: [string, string][] = [
    ["127.0.0.1", "127.0.0.1"],
    ["mongo", "mongo"],
    ["mongodb://localhost:27017", "localhost"],
    ["MONGODB://User:P%40ss@Mongo.Example.COM:27017/db?authSource=admin", "mongo.example.com"],
    ["mongodb://[::1]:27017/db", "::1"],
    ["mongodb://h1:27017,h2:27017/db", "h1"],
  ];
  for (const [uri, host] of cases) assert.equal(loadConfig({ MONGO_URI: uri }).config.mongo.host, host, uri);
});

test(".env in the working directory is loaded, but real env vars take precedence", () => {
  const { config } = loadConfig({ SIM_POOL_ID: "9" }, "SIM_SEED=from-dotenv\nSIM_POOL_ID=1\n");
  assert.equal(config.seed, "from-dotenv");
  assert.equal(config.pair.poolId, "9");
});

test("assertLocalTargets accepts localhost-style hosts", () => {
  for (const [mongo, maria] of [
    ["mongodb://127.0.0.1:27017", "127.0.0.1"],
    ["mongodb://localhost", "LOCALHOST"],
    ["mongodb://[::1]:27017", "::1"],
    ["mongo", "mariadb"],
  ]) {
    const { assertLocalTargets } = loadConfig({ MONGO_URI: mongo, MARIA_DB_HOST: maria });
    assert.doesNotThrow(assertLocalTargets, `${mongo} / ${maria}`);
  }
});

test("assertLocalTargets refuses remote hosts and names every offender", () => {
  const both = loadConfig({ MONGO_URI: "mongodb://user:pw@db.prod.example:27017", MARIA_DB_HOST: "10.0.0.5" });
  assert.throws(both.assertLocalTargets, {
    message: "Refusing to run: purge only touches localhost databases. Offending settings: MONGO_URI=db.prod.example, MARIA_DB_HOST=10.0.0.5",
  });

  const mariaOnly = loadConfig({ MARIA_DB_HOST: "192.168.1.10" });
  assert.throws(mariaOnly.assertLocalTargets, /Offending settings: MARIA_DB_HOST=192\.168\.1\.10$/);

  // credentials in the URI must not let a remote host pass
  const tricky = loadConfig({ MONGO_URI: "mongodb://localhost:pw@remote.example/db" });
  assert.throws(tricky.assertLocalTargets, /MONGO_URI=remote\.example/);
});
