import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { WorldStorage } from "../src/storage.js";

const archive = (seed) => ({
  version: 3,
  world: { version: 3, seed, generatorVersion: 3, dimension: "overworld",
    edits: [["overworld", 5, 20, 6, 7, 0, 0], ["nether", -5, 20, 6, 7, 0, 0]] },
  quality: "low", soundEnabled: false, time: 0.62,
});
async function fixture(t) {
  const indexedDB = new IDBFactory();
  const storage = new WorldStorage({ indexedDB }), reader = new WorldStorage({ indexedDB });
  t.after(() => Promise.all([storage.close(), reader.close()]));
  await storage.save(archive("old"));
  const before = await reader.readRecords(), revision = storage.revision;
  return { storage, reader, before, revision };
}

for (const kind of [
  "activation", "asynchronous activation", "rejecting asynchronous activation",
  "transaction abort",
]) {
  test(`replacement ${kind} failure preserves chunks, metadata and CAS baseline`, async (t) => {
    const f = await fixture(t);
    let activated = false;
    if (kind === "transaction abort") {
      const put = IDBObjectStore.prototype.put;
      t.mock.method(IDBObjectStore.prototype, "put", function (value) {
        const request = put.call(this, value);
        if (this.name === "worlds")
          request.addEventListener("success", () => this.transaction.abort(), { once: true });
        return request;
      });
    }
    await assert.rejects(f.storage.replace(archive("candidate"), () => {
      activated = true;
      if (kind === "activation") throw new Error("activation failed");
      if (kind === "asynchronous activation") return Promise.resolve();
      if (kind === "rejecting asynchronous activation")
        return Promise.reject(new Error("async activation failed"));
    }));
    assert.equal(activated, true);
    assert.deepEqual(await f.reader.readRecords(), f.before);
    assert.equal(f.storage.revision, f.revision);
    assert.equal(f.storage.identity, f.before.metadata.identity);
    assert.deepEqual(f.storage.signatures, f.reader.signatures);
    if (kind === "rejecting asynchronous activation") {
      await new Promise((resolve) => setImmediate(resolve));
      await f.storage.save(archive("recovered"));
      assert.equal((await f.reader.load()).world.seed, "recovered");
    }
  });
}

test("replacement snapshots are cloned at enqueue and normal writes remain serialized", async (t) => {
  const f = await fixture(t), candidate = archive("candidate");
  let activated = 0;
  const pending = f.storage.replace(candidate, () => { activated++; });
  candidate.world.seed = "mutated-after-enqueue";
  await pending;
  assert.equal(activated, 1);
  assert.equal((await f.reader.load()).world.seed, "candidate");
  await f.storage.save(archive("next"));
  assert.equal((await f.reader.load()).world.seed, "next");
});

test("stale replacement checks CAS before writes or activation, without adopting the winner", async (t) => {
  const f = await fixture(t);
  await f.reader.save(archive("newer-tab"));
  const newer = await f.reader.readRecords();
  let activated = false;
  const mutations = ["put", "clear", "delete"].map((name) =>
    t.mock.method(IDBObjectStore.prototype, name));
  await assert.rejects(f.storage.replace(archive("candidate"), () => {
    activated = true;
  }), { code: "STALE_WORLD" });
  assert.equal(activated, false);
  assert.equal(f.storage.revision, f.revision);
  assert.ok(mutations.every((method) => method.mock.callCount() === 0));
  assert.deepEqual(await f.reader.readRecords(), newer);
});
