import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import { clearState, DEFAULT_STATE_FILE, loadState } from "../src/state";

const tempFile = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-state-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
};

test("DEFAULT_STATE_FILE points at <repo>/state/state.json", () => {
  assert.equal(DEFAULT_STATE_FILE, path.resolve(__dirname, "..", "state", "state.json"));
});

test("loadState returns null when the file is missing", (t) => {
  assert.equal(loadState(tempFile(t)), null);
});

test("loadState parses the legacy swapIds file", (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, JSON.stringify({ swapIds: [3, 1, 2], extra: "ignored" }));
  assert.deepEqual(loadState(file), { swapIds: [3, 1, 2], extra: "ignored" });
});

test("loadState throws on malformed JSON", (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, "{not json");
  assert.throws(() => loadState(file), SyntaxError);
});

test("clearState deletes the file and is a no-op when it is already gone", (t) => {
  const file = tempFile(t);
  fs.writeFileSync(file, JSON.stringify({ swapIds: [] }));
  clearState(file);
  assert.equal(fs.existsSync(file), false);
  assert.doesNotThrow(() => clearState(file));
  assert.equal(loadState(file), null);
});
