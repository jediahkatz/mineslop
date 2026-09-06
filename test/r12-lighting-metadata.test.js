import assert from "node:assert/strict";
import test from "node:test";
import { BlockLightField, BLOCK_LIGHT_LIMITS } from "../src/block-light-field.js";
import { BlockLightRevisions, BLOCK_LIGHT_METADATA_LIMITS } from "../src/block-light-revisions.js";
import { authoredLightingWorld, faultRenderer } from "./r12-lighting-regression-fixture.js";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE } from "../src/block-state.js";

const position = { x: 8, y: 8, z: 8 };

test("pruned revision identities and returning layout coordinates cannot resurrect old topology signatures", () => {
  const world = authoredLightingWorld(1, 16), revisions = new BlockLightRevisions();
  const stats = { columnChecks: 0, stampChecks: 0, metadataPrunes: 0 };
  revisions.update(world, 0, 0, 0, world.spec, stats);
  const layout = revisions.layoutVersion, token = revisions.token(world, 0, 0, 0);
  revisions.update(world, 100, 100, 0, world.spec, stats);
  assert.equal(revisions.tokens.has("0,0,0"), false);
  world.toggle();
  revisions.update(world, 0, 0, 0, world.spec, stats);
  assert.notEqual(revisions.layoutVersion, layout);
  assert.notEqual(revisions.token(world, 0, 0, 0), token);
});

test("exact benign events in unread sections do not reset previously read columns", () => {
  const world = authoredLightingWorld(1, 384), revisions = new BlockLightRevisions();
  const stats = { columnChecks: 0, stampChecks: 0, metadataPrunes: 0 };
  revisions.update(world, 0, 0, 0, world.spec, stats);
  const changes = [];
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    revisions.token(world, x, z, 0);
    const chunk = world.chunks.get(`${x},${z}`);
    chunk.revision++; chunk.sectionRevisions.set(12, 1);
    changes.push({ x: x * 16, z: z * 16, y: 200,
      before: { id: BLOCK.OAK_LOG, state: BLOCK_STATE.AXIS_X, fluid: 0 },
      after: { id: BLOCK.OAK_LOG, state: BLOCK_STATE.AXIS_Z, fluid: 0 } });
  }
  world._editRevision++;
  revisions.observeMutation(world, { epoch: world.epoch, dimension: world.dimension,
    revision: world._editRevision, changes });
  assert.equal(revisions.update(world, 0, 0, 0, world.spec, stats), false);
  assert.equal(revisions.global, false);
  assert.equal(stats.stampChecks, 0);
});

test("real two-millisecond clock makes progress under continuous R12 authored mutation", (t) => {
  const world = authoredLightingWorld(14, 384), field = new BlockLightField();
  let scans = 0, completed = 0, maxUpdateMs = 0, totalUpdateMs = 0;
  field.update(world, position, 12);
  for (let frame = 0; frame < 160; frame++) {
    field.observeMutation(world, world.toggle());
    field.update(world, position, 12);
    scans += field.stats.scans; completed += field.stats.completed;
    maxUpdateMs = Math.max(maxUpdateMs, field.stats.updateMs);
    totalUpdateMs += field.stats.updateMs;
    assert.ok(field.stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
    assert.ok(field.stats.metadataSources <= BLOCK_LIGHT_METADATA_LIMITS.sources);
  }
  assert.ok(scans > 0 && completed > 0);
  assert.ok([...field.cache.values()].some((entry) => entry.y > 2 && entry.certified));
  t.diagnostic(JSON.stringify({ clock: "real", frames: 160, scans, completed, maxUpdateMs,
    meanUpdateMs: totalUpdateMs / 160 }));
  field.dispose();
});

test("R12 authored 841-column continuous mutations bound metadata and allow stable receivers to progress", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(14, 384), field = new BlockLightField(), renderer = faultRenderer();
  let completed = 0, scanned = 0, maximumStamps = 0, maximumTargets = 0, maximumInvalidations = 0;
  field.update(world, position, 12);
  for (let frame = 0; frame < 160; frame++) {
    field.observeMutation(world, world.toggle());
    field.update(world, position, 12);
    const stats = field.stats;
    assert.ok(stats.columnChecks <= BLOCK_LIGHT_METADATA_LIMITS.columns);
    assert.ok(stats.stampChecks <= BLOCK_LIGHT_METADATA_LIMITS.changedColumns * 24);
    assert.ok(stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
    assert.ok(stats.metadataInvalidations <= BLOCK_LIGHT_METADATA_LIMITS.invalidations);
    assert.ok(stats.scans <= BLOCK_LIGHT_LIMITS.scans && stats.visits <= BLOCK_LIGHT_LIMITS.visits);
    assert.equal(stats.globalInvalidations, 0);
    assert.equal(field.store.resources().requiredPages, 15000);
    scanned += stats.scans; completed += stats.completed;
    maximumStamps = Math.max(maximumStamps, stats.stampChecks);
    maximumTargets = Math.max(maximumTargets, stats.metadataTargets);
    maximumInvalidations = Math.max(maximumInvalidations, stats.metadataInvalidations);
    field.store.flush(renderer);
  }
  assert.ok(scanned > 0 && completed > 0);
  assert.ok([...field.cache.values()].some((entry) => entry.y > 2 && entry.certified));
  t.diagnostic(JSON.stringify({ scanned, completed, maximumStamps, maximumTargets, maximumInvalidations,
    requiredPages: field.store.resources().requiredPages, readyPages: field.store.resources().readyPages }));
  field.dispose();
});

test("local events immediately invalidate affected handles but preserve unrelated pages and benign queues", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(14, 384), field = new BlockLightField(), renderer = faultRenderer();
  field.update(world, position, 12);
  const near = field.index(0, 0, 0), far = field.index(10, 10, 23);
  field.store.publish(field.store.claim(near, "near"), 8);
  field.store.publish(field.store.claim(far, "far"), 9);
  field.store.flush(renderer);
  field.observeMutation(world, world.toggle());
  assert.equal(field.store.mapping[near], 0);
  assert.ok(field.store.mapping[far] > 0);
  assert.equal(field.store.sample(far, 0), 9);
  field.update(world, position, 12);
  field.store.flush(renderer);
  assert.equal(renderer.gpu.get(field.store.table)[near], 0);
  assert.equal(field.store.sample(far, 0), 9);
  field.dispose();
});

test("R12 one-column movement retains overlapping holders and repeated events coalesce within the metadata bound", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(15, 384), field = new BlockLightField(), renderer = faultRenderer();
  field.update(world, position, 12);
  const entry = { x: 10, z: 10, y: 23, certified: true, serial: 100, values: null };
  field.cache.set("10,10,23", entry); field.publish(entry);
  field.store.flush(renderer);
  const at = field.index(10, 10, 23), handle = field.store.mapping[at];
  field.update(world, { x: 24, y: 8, z: 8 }, 12);
  assert.equal(field.stats.globalInvalidations, 0);
  assert.equal(field.store.mapping[at], handle);
  assert.equal(field.cache.get("10,10,23"), entry);
  for (let i = 0; i < 1024; i++) field.observeMutation(world, world.toggle());
  assert.ok(field.eventWork <= BLOCK_LIGHT_METADATA_LIMITS.invalidations);
  assert.equal(field.eventGlobal, false, "repeated changes to the same section require only one invalidation");
  field.update(world, { x: 24, y: 8, z: 8 }, 12);
  assert.equal(field.stats.globalInvalidations, 0);
  assert.equal(field.cache.get("10,10,23"), entry);
  assert.equal(field.store.mapping[at], handle);
  field.dispose();
});

test("teleport, epoch and global residency changes invalidate first and enumerate new work in bounded batches", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(14, 384), field = new BlockLightField(), renderer = faultRenderer();
  field.update(world, position, 12);
  field.store.publish(field.store.claim(14999, "before"), 12); field.store.flush(renderer);
  field.update(world, { x: 16008, y: 8, z: 16008 }, 12);
  assert.equal(field.store.mapping[14999], 0);
  assert.ok(field.stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
  assert.equal(field.store.resources().readyPages, 0);
  field.update(world, position, 12);
  world.epoch++;
  field.update(world, position, 12);
  assert.ok(field.stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
  assert.equal(field.store.resources().requiredPages, 15000);
  for (const [key, chunk] of world.chunks)
    world.chunks.set(key, { ...chunk, incarnation: chunk.incarnation + 1 });
  field.update(world, position, 12);
  assert.equal(field.stats.globalInvalidations, 1);
  assert.ok(field.stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
  assert.equal(field.store.resources().readyPages, 0);
  let completed = 0;
  for (let frame = 0; frame < 48; frame++) {
    field.update(world, position, 12);
    completed += field.stats.completed;
  }
  assert.ok(completed > 0, "global reset must resume stable work, not restart every update");
  field.dispose();
});

test("unqueried far-column churn does not reset work; late admissions schedule previously unread heights", (t) => {
  t.mock.method(performance, "now", () => 0);
  const world = authoredLightingWorld(14, 384), field = new BlockLightField();
  field.update(world, position, 12);
  for (let frame = 0; frame < 16; frame++) {
    for (let z = 10; z <= 14; z++) for (let x = 10; x <= 14; x++) world.chunks.get(`${x},${z}`).revision++;
    field.update(world, position, 12);
    assert.equal(field.stats.globalInvalidations, 0);
  }
  field.dispose();
  const empty = authoredLightingWorld(0, 384), later = empty.chunks.get("0,0");
  empty.chunks.clear();
  const cold = new BlockLightField();
  for (let i = 0; i < 250; i++) cold.update(empty, position, 12);
  assert.equal(cold.pending, 0);
  empty.chunks.set("0,0", later);
  cold.update(empty, position, 12);
  assert.ok(cold.pending > 0);
  for (let i = 0; i < 64; i++) cold.update(empty, position, 12);
  assert.equal(cold.cache.size, 24);
  assert.ok(cold.cache.has("0,0,23"));
  for (const [key, chunk] of authoredLightingWorld(14, 384).chunks) empty.chunks.set(key, chunk);
  cold.update(empty, position, 12);
  assert.equal(cold.stats.globalInvalidations, 1);
  assert.ok(cold.stats.metadataTargets <= BLOCK_LIGHT_METADATA_LIMITS.targets);
  cold.dispose();
});
