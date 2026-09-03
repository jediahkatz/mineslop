import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { StaleWorldError, WorldStorage } from "../src/storage.js";

const snapshot = (seed = "first", block = 7, time = 0.36) => ({
  version: 3,
  world: {
    version: 3,
    generatorVersion: 2,
    dimension: "overworld",
    seed,
    edits: [["overworld", 5, 20, 6, block, 0, 0]],
  },
  time,
});

function storesFor(t) {
  const indexedDB = new IDBFactory();
  const stores = Array.from(
    { length: 3 },
    () => new WorldStorage({ indexedDB })
  );
  t.after(() => Promise.all(stores.map((store) => store.close())));
  return stores;
}

const transactionDone = (transaction) =>
  new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () => reject(transaction.error);
  });

for (const scenario of [
  "different seed",
  "same seed",
  "seed changed away and back",
  "archive cleared and recreated",
  "database deleted and recreated",
  "connection reopened",
]) {
  test(`a stale tab cannot overwrite a ${scenario} revision`, async (t) => {
    const [a, b, reader] = storesFor(t);
    await a.save(snapshot());
    const stale = await b.load();
    if (scenario === "seed changed away and back")
      await a.save(snapshot("intermediate", 10));
    if (scenario === "archive cleared and recreated") {
      const database = await a.open();
      const transaction = database.transaction(
        ["worlds", "chunks"],
        "readwrite"
      );
      transaction.objectStore("worlds").clear();
      transaction.objectStore("chunks").clear();
      await transactionDone(transaction);
      assert.equal(await a.load(), null);
    }
    if (scenario === "database deleted and recreated") {
      const request = a.indexedDB.deleteDatabase(a.name);
      await new Promise((resolve, reject) => {
        request.onsuccess = resolve;
        request.onerror = () => reject(request.error);
      });
      assert.equal(await a.load(), null);
    }
    if (scenario === "connection reopened") await b.close();
    const latest = snapshot(
      scenario === "different seed" ? "second" : "first",
      64,
      0.8
    );
    await a.save(latest);
    await assert.rejects(b.save(stale), StaleWorldError);
    assert.deepEqual(await reader.load(), latest);
  });
}

test("stale replacement rejects before any clear, deletion, or write and stays stale", async (t) => {
  const [a, b, reader] = storesFor(t);
  await a.save(snapshot());
  const stale = await b.load();
  const previousRevision = b.revision;
  const previousSignatures = new Map(b.signatures);
  const latest = snapshot("second", 64, 0.8);
  latest.world.edits.push(["end", 160, 30, -160, 9, 0, 0]);
  await a.save(latest);
  const before = await reader.load();
  stale.world.seed = "third";
  stale.world.edits = [];
  const mutations = ["clear", "delete", "put"].map((method) =>
    t.mock.method(IDBObjectStore.prototype, method)
  );
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(b.save(stale), {
      name: "StaleWorldError",
      code: "STALE_WORLD",
      message: /another.*tab.*export.*reload/i,
    });
  for (const mutation of mutations) assert.equal(mutation.mock.callCount(), 0);
  assert.equal(b.revision, previousRevision);
  assert.deepEqual(b.signatures, previousSignatures);
  assert.deepEqual(await reader.load(), before);
  const reloaded = await b.load();
  reloaded.time = 0.6;
  await b.save(reloaded);
  assert.deepEqual(await reader.load(), reloaded);
});

test("concurrent connections compare and swap inside the same write transaction", async (t) => {
  const [a, b, reader] = storesFor(t);
  await a.save(snapshot());
  await b.load();
  const candidates = [snapshot("first", 9, 0.5), snapshot("second", 64, 0.8)];
  const results = await Promise.allSettled([
    a.save(candidates[0]),
    b.save(candidates[1]),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1
  );
  const rejected = results.find((result) => result.status === "rejected");
  assert.ok(rejected.reason instanceof StaleWorldError);
  const winner = results.findIndex((result) => result.status === "fulfilled");
  assert.deepEqual(await reader.load(), candidates[winner]);
});

test("metadata-only changes invalidate other tabs without rewriting chunks", async (t) => {
  const [a, b, reader] = storesFor(t);
  await a.save(snapshot());
  const stale = await b.load();
  const latest = snapshot("first", 7, 0.8);
  const put = t.mock.method(IDBObjectStore.prototype, "put");
  await a.save(latest);
  assert.deepEqual(
    put.mock.calls.map((call) => call.this.name),
    ["worlds"]
  );
  await assert.rejects(b.save(stale), StaleWorldError);
  assert.deepEqual(await reader.load(), latest);
});

test("an empty archive read does not authorize overwriting a subsequent save", async (t) => {
  const [a, b, reader] = storesFor(t);
  assert.deepEqual(await Promise.all([a.load(), b.load()]), [null, null]);
  const latest = snapshot("second", 64);
  await a.save(latest);
  await assert.rejects(b.save(snapshot()), StaleWorldError);
  assert.deepEqual(await reader.load(), latest);
});

test("legacy IndexedDB records gain v3 cells and a revision without losing chunks", async (t) => {
  const [a, b, reader] = storesFor(t);
  const original = snapshot();
  const metadata = structuredClone(original);
  metadata.version = 2;
  metadata.world.version = 2;
  delete metadata.world.edits;
  const database = await a.open();
  const transaction = database.transaction(["worlds", "chunks"], "readwrite");
  transaction.objectStore("worlds").put({
    key: "active",
    identity: JSON.stringify(["first", 2]),
    snapshot: metadata,
  });
  transaction.objectStore("chunks").put({
    key: "active|overworld|0,0",
    worldKey: "active",
    dimension: "overworld",
    cx: 0,
    cz: 0,
    edits: [[5, 20, 6, 7]],
  });
  await transactionDone(transaction);
  assert.deepEqual(await a.load(), original);
  const stale = await b.load();
  const latest = snapshot("first", 7, 0.8);
  await a.save(latest);
  assert.notEqual(a.revision, null);
  assert.deepEqual([...a.signatures.values()].map(JSON.parse), [
    [[5, 20, 6, 7, 0, 0]],
  ]);
  await assert.rejects(b.save(stale), StaleWorldError);
  assert.deepEqual(await reader.load(), latest);
});

test("an aborted replacement rolls back cleared chunks and cached revision", async (t) => {
  const [a, , reader] = storesFor(t);
  const original = snapshot();
  await a.save(original);
  const revision = a.revision;
  const signatures = new Map(a.signatures);
  const originalPut = IDBObjectStore.prototype.put;
  const failure = new Error("Metadata write failed");
  const put = t.mock.method(
    IDBObjectStore.prototype,
    "put",
    function (...args) {
      if (this.name === "worlds") throw failure;
      return originalPut.apply(this, args);
    }
  );
  const replacement = snapshot("second", 64, 0.8);
  await assert.rejects(a.save(replacement), (error) => error === failure);
  assert.equal(a.revision, revision);
  assert.deepEqual(a.signatures, signatures);
  assert.deepEqual(await reader.load(), original);
  put.mock.restore();
  await a.save(replacement);
  assert.deepEqual(await reader.load(), replacement);
});
