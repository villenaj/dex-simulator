import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import mariadb from "mariadb";
import { MongoClient } from "mongodb";

import { config } from "../src/config";
import { connect, disconnect } from "../src/db";

// No real connections: MongoClient.connect and mariadb.createPool are mocked.
let pools: unknown[];
const savedMongo = { ...config.mongo };
const savedMaria = { ...config.maria };

beforeEach(() => {
  pools = [];
  mock.method(MongoClient.prototype, "connect", async function (this: MongoClient) {
    return this;
  });
  mock.method(mariadb, "createPool", (options: unknown) => {
    pools.push(options);
    return { fake: "pool", options };
  });
  Object.assign(config.mongo, { host: "127.0.0.1", port: 27017, dbName: "xode_indexer", user: "", pass: "", authSource: "admin" });
  Object.assign(config.maria, { host: "127.0.0.1", port: 3306, user: "root", password: "", database: "dex_db" });
});

afterEach(() => {
  mock.restoreAll();
  Object.assign(config.mongo, savedMongo);
  Object.assign(config.maria, savedMaria);
});

test("connect: unauthenticated mongo URL, db handle and mariadb pool options", async () => {
  const conns = await connect();
  const opts = conns.mongo.options;
  assert.deepEqual(opts.hosts.map(String), ["127.0.0.1:27017"]);
  assert.equal(opts.dbName, "xode_indexer");
  assert.equal(opts.credentials, undefined);
  assert.equal(opts.serverSelectionTimeoutMS, 5000);
  assert.equal(conns.db.databaseName, "xode_indexer");
  assert.deepEqual(pools, [
    { host: "127.0.0.1", port: 3306, user: "root", password: "", database: "dex_db", connectionLimit: 4 },
  ]);
  assert.equal((conns.maria as unknown as { fake: string }).fake, "pool");
});

test("connect: credentials are URL-encoded and authSource is applied", async () => {
  Object.assign(config.mongo, { host: "mongo", port: 27018, dbName: "idx", user: "u@x", pass: "p:/?#", authSource: "adm" });
  const conns = await connect();
  const opts = conns.mongo.options;
  assert.deepEqual(opts.hosts.map(String), ["mongo:27018"]);
  assert.equal(opts.credentials?.username, "u@x");
  assert.equal(opts.credentials?.password, "p:/?#");
  assert.equal(opts.credentials?.source, "adm");
  assert.equal(conns.db.databaseName, "idx");
});

test("connect: user without password -> no auth", async () => {
  Object.assign(config.mongo, { user: "u", pass: "" });
  const conns = await connect();
  assert.equal(conns.mongo.options.credentials, undefined);
});

test("connect: mongo connection errors propagate before a maria pool is created", async () => {
  mock.method(MongoClient.prototype, "connect", async () => {
    throw new Error("ECONNREFUSED");
  });
  await assert.rejects(connect(), /ECONNREFUSED/);
  assert.equal(pools.length, 0);
});

test("disconnect closes mongo and ends the maria pool", async () => {
  const order: string[] = [];
  await disconnect({
    mongo: { close: async () => void order.push("mongo") },
    maria: { end: async () => void order.push("maria") },
    db: {},
  } as never);
  assert.deepEqual(order, ["mongo", "maria"]);
});
