import { test } from "node:test";
import assert from "node:assert/strict";
import type { Db } from "mongodb";
import type { Pool } from "mariadb";

import { config } from "../src/config";
import { countSimCandles, deleteSimCandles, deleteSwaps } from "../src/legacy";

const fakeDb = () => {
  const calls: { collection: string; method: string; filter: unknown }[] = [];
  const db = {
    collection: (name: string) => ({
      countDocuments: async (filter: unknown) => {
        calls.push({ collection: name, method: "countDocuments", filter });
        return 7;
      },
      deleteMany: async (filter: unknown) => {
        calls.push({ collection: name, method: "deleteMany", filter });
        return { acknowledged: true, deletedCount: 5 };
      },
    }),
  } as unknown as Db;
  return { db, calls };
};

test("countSimCandles / deleteSimCandles only target simulated candles of the configured pool", async () => {
  const original = config.pair.poolId;
  try {
    config.pair.poolId = "3";
    const { db, calls } = fakeDb();
    assert.equal(await countSimCandles(db), 7);
    assert.deepEqual(await deleteSimCandles(db), { acknowledged: true, deletedCount: 5 });
    const filter = { pairKey: "pool:3", lastSourceType: { $in: ["sim_swap", "sim_gap"] } };
    assert.deepEqual(calls, [
      { collection: "charts", method: "countDocuments", filter },
      { collection: "charts", method: "deleteMany", filter },
    ]);
  } finally {
    config.pair.poolId = original;
  }
});

const fakeMaria = (affected: (ids: number[]) => unknown) => {
  const queries: { sql: string; params: number[] }[] = [];
  const maria = {
    query: async (sql: string, params: number[]) => {
      queries.push({ sql, params });
      return { affectedRows: affected(params) };
    },
  } as unknown as Pool;
  return { maria, queries };
};

test("deleteSwaps: no ids -> no queries", async () => {
  const { maria, queries } = fakeMaria(() => 0);
  assert.equal(await deleteSwaps(maria, []), 0);
  assert.equal(queries.length, 0);
});

test("deleteSwaps: parameterized IN list, chunks of 500, sums affectedRows", async () => {
  const ids = Array.from({ length: 1201 }, (_, i) => i + 1);
  const { maria, queries } = fakeMaria((chunk) => chunk.length);
  assert.equal(await deleteSwaps(maria, ids), 1201);
  assert.deepEqual(
    queries.map((q) => q.params.length),
    [500, 500, 201],
  );
  assert.deepEqual(queries.flatMap((q) => q.params), ids);
  for (const q of queries) {
    assert.equal(q.sql, `DELETE FROM swap WHERE swap_id IN (${q.params.map(() => "?").join(",")})`);
  }
});

test("deleteSwaps: bigint / missing affectedRows are handled", async () => {
  let n = 0;
  const { maria } = fakeMaria(() => (n++ === 0 ? 3n : undefined));
  assert.equal(await deleteSwaps(maria, Array.from({ length: 600 }, (_, i) => i)), 3);
});
