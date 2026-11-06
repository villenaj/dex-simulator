import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// Only CLI paths that exit before any chain/DB connection are exercised here
// (no command, unknown command, removed `backfill`). live/fund/status/purge are never run.
const ROOT = path.resolve(__dirname, "..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const ENTRY = path.join(ROOT, "src", "index.ts");

// Empty cwd so the repo .env is not loaded; strip config env vars for good measure.
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "sim-cli-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SIM_|MONGO_|MARIA_|DOTENV_)/.test(k)));
// Point at an unroutable RPC so an accidental connection attempt could never reach a real node.
env.SIM_RPC_URL = "ws://127.0.0.1:1";

const run = (...args: string[]) =>
  spawnSync(TSX, [ENTRY, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });

test("no command prints usage and exits 1", () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage: tsx src\/index\.ts <live \| fund \| status \| purge \[--state state\/state\.json\]>/);
});

test("unknown command prints usage and exits 1", () => {
  const result = run("nope");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Usage:/);
});

test("backfill is rejected with an explanatory error and exit 1", () => {
  const result = run("backfill");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backfill is gone/);
  assert.doesNotMatch(result.stdout, /Usage:/);
});

test(
  "Object.prototype keys (e.g. `constructor`, `toString`) are treated as unknown commands",
  {
    skip:
      "BUG src/index.ts:198 - CHAIN_COMMANDS[command] resolves inherited keys, so these connect to the chain " +
      "instead of printing usage; not run because it would open a chain connection",
  },
  () => {
    const result = run("constructor");
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Usage:/);
  },
);
