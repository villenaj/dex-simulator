import { test } from "node:test";
import assert from "node:assert/strict";

import { Rng } from "../src/simulate";

const draw = (rng: Rng, n: number) => Array.from({ length: n }, () => rng.next());

/** Rng whose next() replays a fixed list (for exact branch control). */
const scripted = (values: number[]): Rng => {
  const rng = new Rng("scripted");
  let i = 0;
  rng.next = () => {
    if (i >= values.length) throw new Error("scripted rng exhausted");
    return values[i++];
  };
  return rng;
};

test("same seed -> identical sequence; different seed -> different sequence", () => {
  assert.deepEqual(draw(new Rng("abc"), 20), draw(new Rng("abc"), 20));
  assert.notDeepEqual(draw(new Rng("abc"), 20), draw(new Rng("abd"), 20));
});

test("empty seed falls back to a time/random seed (not a fixed stream)", () => {
  assert.notDeepEqual(draw(new Rng(""), 10), draw(new Rng(""), 10));
});

test("next() stays in [0, 1) and is roughly uniform", () => {
  const values = draw(new Rng("uniform"), 20_000);
  for (const v of values) assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `mean ${mean}`);
  const buckets = new Array(10).fill(0);
  for (const v of values) buckets[Math.floor(v * 10)]++;
  for (const b of buckets) assert.ok(b > 1700 && b < 2300, `bucket ${b}`);
});

test("range(min, max) maps into [min, max)", () => {
  const rng = new Rng("range");
  for (let i = 0; i < 2000; i++) {
    const v = rng.range(-3, 7);
    assert.ok(v >= -3 && v < 7);
  }
  assert.equal(scripted([0]).range(5, 9), 5);
  assert.equal(scripted([0.5]).range(5, 9), 7);
});

test("normal() has mean ~0, stddev ~1 and survives u = 0", () => {
  const rng = new Rng("normal");
  const xs = Array.from({ length: 20_000 }, () => rng.normal());
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  assert.ok(Math.abs(mean) < 0.03, `mean ${mean}`);
  assert.ok(Math.abs(sd - 1) < 0.03, `sd ${sd}`);
  // u is clamped to 1e-12, so a zero draw yields a finite value
  assert.ok(Number.isFinite(scripted([0, 0]).normal()));
});

test("poisson(lambda) returns 0 for lambda <= 0 without consuming randomness", () => {
  const rng = scripted([]);
  assert.equal(rng.poisson(0), 0);
  assert.equal(rng.poisson(-1), 0);
});

test("poisson(lambda) has mean ~lambda and integer non-negative output", () => {
  const rng = new Rng("poisson");
  for (const lambda of [0.2, 1.5, 6]) {
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const k = rng.poisson(lambda);
      assert.ok(Number.isInteger(k) && k >= 0);
      sum += k;
    }
    assert.ok(Math.abs(sum / n - lambda) < lambda * 0.05 + 0.02, `lambda ${lambda} mean ${sum / n}`);
  }
});

test("pickWeighted selects by cumulative weight", () => {
  const items = [
    { id: "a", weight: 1 },
    { id: "b", weight: 2 },
    { id: "c", weight: 1 },
  ];
  // total 4: roll = next * 4
  assert.equal(scripted([0.1]).pickWeighted(items).id, "a"); // 0.4
  assert.equal(scripted([0.25]).pickWeighted(items).id, "a"); // 1.0 (boundary inclusive)
  assert.equal(scripted([0.5]).pickWeighted(items).id, "b"); // 2.0
  assert.equal(scripted([0.9]).pickWeighted(items).id, "c"); // 3.6
});

test("pickWeighted frequencies follow weights", () => {
  const rng = new Rng("weights");
  const items = [
    { id: 0, weight: 1 },
    { id: 1, weight: 3 },
  ];
  let ones = 0;
  const n = 20_000;
  for (let i = 0; i < n; i++) if (rng.pickWeighted(items).id === 1) ones++;
  assert.ok(Math.abs(ones / n - 0.75) < 0.02, `share ${ones / n}`);
});
