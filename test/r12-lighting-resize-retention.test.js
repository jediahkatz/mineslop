import assert from "node:assert/strict";
import test from "node:test";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { BLOCK_LIGHT_METADATA_LIMITS } from "../src/block-light-revisions.js";
import { BLOCK } from "../src/blocks.js";
import { readChunkCell } from "../src/chunk-data.js";
import { authoredLightingWorld, faultRenderer } from "./r12-lighting-regression-fixture.js";

const position = { x: 8, y: 8, z: 8 };

function settle(field, world, renderer, radius) {
  for (let frame = 0; frame < 10000; frame++) {
    field.update(world, position, radius);
    assert.ok(field.stats.cacheChecks <= BLOCK_LIGHT_METADATA_LIMITS.pruning);
    assert.ok(field.stats.completed + field.stats.reused <= BLOCK_LIGHT_LIMITS.publications);
    const budget = field.store.flush(renderer);
    assert.ok(budget.uploadedBytes <= 131072 && budget.copies >= 0);
    if (!field.pending && !field.store.queue.size) return frame + 1;
  }
  assert.fail("Authored resize fixture did not settle");
}

test("unchanged canonical block light survives R4 to R6 GPU-store replacement", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(2, 48);
  for (const [key, chunk] of authoredLightingWorld(2, 48).chunks) {
    const [x, z] = key.split(",").map(Number);
    world.chunks.set(`${x + 13},${z}`, chunk);
  }
  // Non-cube emitters use the native auxiliary-cell reader, unlike the
  // air/stone-only metadata fixture. Supply its origin and section map.
  for (const chunk of world.chunks.values()) {
    chunk.minY = world.spec.minY;
    chunk.sections = new Map();
  }
  const center = world.chunks.get("0,0");
  center.blocks = center.blocks.slice();
  center.blocks[8 * 256 + 8 * 16 + 8] = BLOCK.TORCH;
  assert.deepEqual(readChunkCell(center, 8 * 256 + 8 * 16 + 8), world.getCell(8, 8, 8),
    "authored torch supports the native cell reader");
  world.generate = world.ensureArea = () => assert.fail("Lighting cannot generate terrain");
  for (const method of ["values", "entries", "keys", "forEach", Symbol.iterator])
    world.chunks[method] = () => assert.fail("Lighting cannot enumerate resident chunks");
  const field = new BlockLightField(), renderer = faultRenderer();
  t.after(() => field.dispose());
  settle(field, world, renderer, 4);
  const original = field.cache.get("0,0,0"), originalStore = field.store;
  assert.equal(original.certified, true);
  const originalSignature = field.revisions.signature(world, 0, 0, 0, 2);
  const originalValues = original.values.slice();
  const originalSample = field.sample({ x: 9, y: 8, z: 8 });
  assert.ok(originalSample[0] > 0.5);

  field.update(world, position, 6);
  assert.equal(field.cache.get("0,0,0"), original);
  assert.notEqual(field.store, originalStore);
  assert.equal(originalStore.disposed, true);
  assert.ok(field.store.mapping.every((value) => value === 0), "new GPU handles are unavailable before flush");
  assert.equal(field.stats.globalInvalidations, 0);
  assert.ok(field.stats.cacheChecks <= BLOCK_LIGHT_METADATA_LIMITS.pruning);
  assert.ok(field.stats.completed + field.stats.reused <= BLOCK_LIGHT_LIMITS.publications);
  field.store.flush(renderer);
  settle(field, world, renderer, 6);
  const after = field.cache.get("0,0,0");
  assert.equal(after === original, true, "radius-only resize must retain the unchanged canonical object");
  assert.deepEqual(after.values, originalValues);
  assert.equal(field.revisions.signature(world, 0, 0, 0, 2), originalSignature);
  assert.deepEqual(field.sample({ x: 9, y: 8, z: 8 }), originalSample);
});

function resizeWorld(radius = 2, height = 48, torch = true) {
  const world = authoredLightingWorld(radius, height);
  for (const chunk of world.chunks.values()) {
    chunk.minY = 0;
    chunk.sections = new Map();
  }
  if (torch) {
    const center = world.chunks.get("0,0");
    center.blocks = center.blocks.slice();
    center.blocks[8 * 256 + 8 * 16 + 8] = BLOCK.TORCH;
  }
  return world;
}

function resizeField(t) {
  t.mock.method(performance, "now", () => 0);
  const field = new BlockLightField();
  t.after(() => field.dispose());
  return field;
}

test("resize reuse rejects old store tickets and failed republication stays unavailable until retry", (t) => {
  const field = resizeField(t), world = resizeWorld(), renderer = faultRenderer();
  settle(field, world, renderer, 4);
  const original = field.cache.get("0,0,0"), previous = field.store;
  const ticket = { ...previous.pages.get(field.index(0, 0, 0)).ticket };
  field.update(world, position, 6);
  assert.equal(field.cache.get("0,0,0"), original);
  assert.equal(previous.disposed, true);
  assert.equal(field.store.publish(ticket, original.values), false);
  assert.ok(field.store.mapping.every((value) => value === 0));
  const at = field.index(0, 0, 0);
  renderer.mode = "oom";
  renderer.fail = (call, source) => call.target === field.store.table && source.image.data[at] !== 0;
  assert.throws(() => field.store.flush(renderer), /1285/);
  assert.equal(field.store.mapping[at], 0);
  assert.equal(field.store.sample(at, 0), undefined);
  assert.ok(field.store.queue.size > 0 && field.store.resources().pendingRequired > 0);
  settle(field, world, renderer, 6);
  assert.equal(field.cache.get("0,0,0"), original);
  assert.equal(renderer.gpu.get(field.store.table)[at], field.store.mapping[at]);
  assert.ok(field.sample({ x: 9, y: 8, z: 8 })[0] > 0.5);
});

test("mutation during incremental resize invalidates queued reuse before its first GPU publication", (t) => {
  const field = resizeField(t), world = resizeWorld(), renderer = faultRenderer();
  settle(field, world, renderer, 4);
  const original = field.cache.get("0,0,0");
  field.update(world, position, 6);
  assert.ok(field.cacheWork);
  field.observeMutation(world, world.toggle());
  assert.notEqual(field.cache.get("0,0,0"), original);
  assert.equal(field.store.mapping[field.index(0, 0, 0)], 0);
  assert.equal(field.store.queue.has(field.index(0, 0, 0)), false);
  settle(field, world, renderer, 6);
  assert.deepEqual(field.sample({ x: 9, y: 8, z: 8 }), [0, 0, 0]);
});

test("shrink prunes incrementally, retains in-scope identity and cannot resurrect outside canonical pages on regrowth", (t) => {
  const field = resizeField(t), world = resizeWorld(6, 16), renderer = faultRenderer();
  settle(field, world, renderer, 4);
  const center = field.cache.get("0,0,0"), outside = field.cache.get("3,0,0");
  const before = field.cache.size;
  field.update(world, position, 1);
  assert.equal(field.cache.get("0,0,0"), center);
  assert.ok(before - field.cache.size <= BLOCK_LIGHT_METADATA_LIMITS.pruning);
  assert.ok(field.resources().pendingCacheWork && field.pending > 0);
  assert.ok(field.store.mapping.every((value) => value === 0));
  // Restore while pruning is unfinished: old out-of-scope entries must not
  // acquire aliased slots in the smaller store.
  field.restoreGPU();
  settle(field, world, renderer, 1);
  assert.equal(field.cache.get("0,0,0"), center);
  assert.equal(field.cache.has("3,0,0"), false);
  assert.ok(field.cache.size <= 9);
  assert.ok(field.topology.size <= 25);
  assert.ok(field.resources().metadataEntries <= 49);
  assert.equal(field.store.resources().requiredPages, 9);
  assert.ok([...field.cache.values()].every((entry) => field.within(entry)));
  assert.ok([...field.store.pages.values()].every((page) => {
    const [x, z] = page.ticket.owner.split(":")[0].split(",").map(Number);
    return field.within({ x, z });
  }));
  const oldChunk = world.chunks.get("4,0"), blocks = oldChunk.blocks.slice();
  blocks[8 * 256 + 8 * 16] = BLOCK.TORCH;
  world.chunks.set("4,0", { ...oldChunk, blocks, sections: new Map(), sectionRevisions: new Map() });
  field.update(world, position, 4);
  assert.ok(field.store.mapping.every((value) => value === 0));
  settle(field, world, renderer, 4);
  assert.equal(field.cache.get("0,0,0"), center);
  assert.notEqual(field.cache.get("3,0,0"), outside);
  assert.ok(field.sample({ x: 63, y: 8, z: 8 })[0] > 0.5, "new chunk identity supplies new light after regrowth");
});

test("same-coordinate source replacement during growth cannot reuse a stale canonical dependency signature", (t) => {
  const field = resizeField(t), world = resizeWorld(2, 16, false), renderer = faultRenderer();
  settle(field, world, renderer, 4);
  const original = field.cache.get("0,0,0"), previous = world.chunks.get("1,0");
  const blocks = previous.blocks.slice();
  blocks[8 * 256 + 8 * 16] = BLOCK.TORCH;
  world.chunks.set("1,0", { ...previous, blocks, sections: new Map(), sectionRevisions: new Map() });
  field.update(world, position, 6);
  assert.notEqual(field.cache.get("0,0,0"), original);
  assert.ok(field.store.mapping.every((value) => value === 0));
  settle(field, world, renderer, 6);
  assert.ok(field.sample({ x: 15, y: 8, z: 8 })[0] > 0.5);
});

for (const reset of ["world", "epoch", "height"])
  test(`${reset} change still discards canonical entries during simultaneous radius growth`, (t) => {
    const field = resizeField(t), renderer = faultRenderer();
    let world = resizeWorld();
    settle(field, world, renderer, 4);
    const original = field.cache.get("0,0,0");
    if (reset === "world") world = resizeWorld();
    if (reset === "epoch") world.epoch++;
    if (reset === "height") world.spec.maxY = 16; // Same spec object, different extent.
    field.update(world, position, 6);
    assert.equal(field.stats.globalInvalidations, 1);
    assert.notEqual(field.cache.get("0,0,0"), original);
    assert.ok(field.store.mapping.every((value) => value === 0));
    settle(field, world, renderer, 6);
    assert.notEqual(field.cache.get("0,0,0"), original);
    if (reset === "height") {
      assert.equal(field.cache.has("0,0,2"), false);
      assert.equal(field.store.resources().requiredPages, 169);
    }
  });

test("a partially computed job cannot continue through radius-store replacement", (t) => {
  const field = resizeField(t), world = resizeWorld(), renderer = faultRenderer();
  field.update(world, position, 4);
  const oldJob = field.job;
  assert.ok(oldJob);
  field.update(world, position, 6);
  assert.notEqual(field.job, oldJob);
  assert.ok(field.stats.staleJobs > 0);
  settle(field, world, renderer, 6);
  assert.ok(field.sample({ x: 9, y: 8, z: 8 })[0] > 0.5);
});

test("384-height canonical pages survive rapid resize and republish into high R12 logical slots within existing quotas", (t) => {
  const field = resizeField(t), world = resizeWorld(14, 384, false), renderer = faultRenderer();
  settle(field, world, renderer, 0);
  const original = field.cache.get("0,0,23");
  const oldTicket = { ...field.store.pages.get(23).ticket };
  for (const radius of [12, 6, 12]) {
    field.update(world, position, radius);
    assert.equal(field.cache.get("0,0,23"), original);
    assert.ok(field.store.mapping.every((value) => value === 0));
    assert.ok(field.stats.cacheChecks <= BLOCK_LIGHT_METADATA_LIMITS.pruning);
    assert.ok(field.stats.completed + field.stats.reused <= BLOCK_LIGHT_LIMITS.publications);
    assert.equal(field.store.publish(oldTicket, null), false);
  }
  for (let frame = 0; field.cacheWork && frame < 16; frame++) {
    field.update(world, position, 12);
    const budget = field.store.flush(renderer);
    assert.ok(budget.uploadedBytes <= 131072 && budget.copies >= 0);
    assert.ok(field.stats.completed + field.stats.reused <= BLOCK_LIGHT_LIMITS.publications);
  }
  assert.equal(field.cacheWork, null);
  const at = field.index(0, 0, 23);
  assert.ok(at > 14000);
  assert.equal(field.cache.get("0,0,23"), original);
  assert.equal(field.store.mapping[at], 1);
  assert.equal(renderer.gpu.get(field.store.table)[at], 1);
  assert.equal(field.store.resources().requiredPages, 15000);
  assert.ok(field.store.resources().pendingRequired > 0, "newly required receivers have not been falsely certified");
  settle(field, world, renderer, 0);
  assert.equal(field.cache.get("0,0,23"), original);
  assert.equal(field.store.mapping[23], 1);
  assert.equal(field.cache.size, 24);
  assert.ok(field.resources().metadataEntries <= 25 * 24);
});
