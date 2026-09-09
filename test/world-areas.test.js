import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RESIDENT_CHUNKS } from "../src/render-distance.js";
import { WORLD_MAX, WORLD_MIN } from "../src/world.js";
import {
  admissionWorkerWorld,
  admissionWorld,
  drainAdmissions,
} from "./world-admission-fixture.js";

const footprint = (cx, cz, radius = 0) => ({
  x: cx * 16 + 8, z: cz * 16 + 8, radius,
});
const sorted = (keys) => [...keys].sort();
function bounds(world) {
  assert.ok(world.chunks.size <= MAX_RESIDENT_CHUNKS);
  assert.ok(world._requests.size <= MAX_RESIDENT_CHUNKS);
  assert.ok(world._inFlight.size <= 2);
  assert.ok(new Set([
    ...world.chunks.keys(), ...[...world._inFlight.values()].map(({ key }) => key),
  ]).size <= MAX_RESIDENT_CHUNKS, "residents and physical reservations share one cap");
}
function state(world) {
  return {
    focus: world._focus, scheduled: world._scheduled, pins: [...world._pins],
    requests: [...world._requests], physical: [...world._inFlight],
    wanted: [...world._streamWanted], chunks: [...world.chunks],
    dirty: [...world.dirtyChunks], removed: [...world.removedChunks],
  };
}

test("real-task batch admissions deduplicate overlapping negative squares without loading their bounding box", async (t) => {
  const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
  const expected = ["4,2"];
  for (let cz = -2; cz <= 0; cz++)
    for (let cx = -2; cx <= 1; cx++) expected.push(`${cx},${cz}`);
  const admissions = [];
  world.onChunkAdmitted = ({ key }) => {
    admissions.push(key);
    assert.equal(world._pins.size, expected.length, "one lifetime covers the whole union");
    bounds(world);
  };
  const inputs = [footprint(-1, -1, 1), footprint(0, -1, 1), footprint(4, 2), footprint(-1, -1)];
  const loading = world.ensureAreas(inputs);
  assert.equal(generated.length, 0, "admission stays asynchronous");
  assert.equal(world._requests.size, expected.length);
  inputs[0].x = 10000;
  inputs.length = 0;
  assert.equal(await loading, world);
  assert.deepEqual(sorted(world.chunks.keys()), sorted(expected));
  assert.deepEqual(sorted(admissions), sorted(expected));
  assert.equal(generated.length, expected.length);
  assert.equal(world.isLoaded(2 * 16, 0), false);
  assert.equal(world.removedChunks.size, 0);
  assert.equal(world._pins.size, 0);
  assert.deepEqual(world.admissionObserverErrors, []);
  await new Promise(setImmediate);
  assert.deepEqual(sorted(world.chunks.keys()), sorted(expected));
  assert.equal(generated.length, expected.length, "the retained batch does not regenerate itself");
});

test("legacy single-area real-task calls remain independent rather than implicitly becoming a batch", async (t) => {
  const { world, generated } = admissionWorld(t);
  await Promise.all([0, 1, 2].map((cx) => world.ensureArea(footprint(cx, 0), 0)));
  assert.equal(generated.length, 3);
  assert.equal(world.chunks.size, 2);
  assert.equal(world.chunks.has("2,0"), true);
  assert.equal(world.removedChunks.size, 1);
  assert.equal(world._pins.size, 0);
});

test("concurrent overlapping batches share worker requests and release only their own pins", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  const first = world.ensureAreas([footprint(-1, 0), footprint(0, 0)]);
  const second = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  assert.equal(world._pins.get("0,0"), 2);
  assert.equal(world._requests.size, 3);
  t.mock.timers.tick(1);
  const worker = workers[0];
  assert.deepEqual(sorted([...worker.pending.values()].map(({ cx, cz }) => `${cx},${cz}`)), ["-1,0", "0,0"]);
  for (const request of [...worker.pending.values()]) worker.reply(request);
  assert.equal(await first, world);
  assert.equal(world.chunks.has("-1,0"), true);
  assert.equal(world.chunks.has("0,0"), true);
  assert.equal(world._pins.get("0,0"), 1);
  assert.equal(world._pins.has("-1,0"), false);
  drainAdmissions(t, world, workers);
  assert.equal(await second, world);
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "1,0"]);
  assert.equal(worker.sent.length, 3);
  assert.equal(world._pins.size, 0);
  bounds(world);
});

test("all batch validation finishes before focus, pins, queues or residents change", async (t) => {
  const { world } = admissionWorkerWorld(t);
  const loading = world.ensureAreas([footprint(0, 0)]);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  const before = state(world);
  for (const input of [
    null, {}, [], [null], [footprint(0, 0), {}],
    [footprint(0, 0), { x: NaN, z: 0, radius: 0 }],
    [{ x: WORLD_MAX, z: 0, radius: 0 }],
    [{ x: WORLD_MIN - 0.1, z: 0, radius: 0 }],
    [{ x: 0, z: 0, radius: -1 }], [{ x: 0, z: 0, radius: 1.5 }],
    [{ x: 0, z: 0, radius: 15 }], [{ x: 0, z: 0, radius: Infinity }],
    [footprint(0, 0), { ...footprint(1, 0), dimension: "nether" }],
    Array(MAX_RESIDENT_CHUNKS + 1).fill(footprint(0, 0)),
    [footprint(0, 0, 14), footprint(40, 0)],
  ]) {
    await assert.rejects(world.ensureAreas(input), RangeError);
    assert.deepEqual(state(world), before);
    assert.equal(world._focus, before.focus);
  }
  world.dispose();
  await cancelled;
});

test("batch capacity includes existing overlapping pins and refuses new keys atomically", async (t) => {
  const { world } = admissionWorkerWorld(t);
  const first = world.ensureAreas([footprint(0, 0, 14), footprint(0, 0)]);
  const cancelled = assert.rejects(first, { name: "AbortError" });
  t.mock.timers.tick(1);
  const before = state(world);
  assert.equal(world._pins.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world._pins.get("0,0"), 1, "duplicates are not extra owners within a batch");
  assert.equal(world._inFlight.size, 2);
  await assert.rejects(world.ensureAreas([footprint(0, 0), footprint(40, 0)]), RangeError);
  assert.deepEqual(state(world), before);
  await assert.rejects(world.ensureArea(footprint(40, 0), 0), RangeError);
  assert.deepEqual(state(world), before);
  world.dispose();
  await cancelled;
});

test("new batch and single-area demand retire an old union even on all-resident cache hits", async (t) => {
  const { world, generated } = admissionWorld(t);
  await world.ensureAreas([footprint(0, 0), footprint(2, 0), footprint(4, 0)]);
  await world.ensureAreas([footprint(0, 0), footprint(2, 0)]);
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "2,0"]);
  assert.equal(world.removedChunks.has("4,0"), true);
  await world.ensureArea(footprint(0, 0), 0);
  assert.deepEqual([...world.chunks.keys()], ["0,0"]);
  assert.equal(world.removedChunks.has("2,0"), true);
  assert.equal(generated.length, 3);
  assert.equal(world._pins.size, 0);
});

test("batch footprints clip each world corner without admitting an intervening rectangle", async (t) => {
  const { world, generated } = admissionWorld(t);
  await world.ensureAreas([
    { x: WORLD_MIN, z: WORLD_MIN, radius: 1 },
    { x: WORLD_MAX - 0.01, z: WORLD_MAX - 0.01, radius: 1 },
  ]);
  assert.equal(world.chunks.size, 8);
  assert.equal(generated.length, 8);
  assert.equal(world.removedChunks.size, 0);
  assert.equal(world.isLoaded(0, 0), false);
  for (const { cx, cz } of world.chunks.values()) {
    assert.ok(cx * 16 >= WORLD_MIN && cx * 16 < WORLD_MAX);
    assert.ok(cz * 16 >= WORLD_MIN && cz * 16 < WORLD_MAX);
  }
});

test("a failed batch surfaces the error and releases its queued work and cache ownership", async (t) => {
  const { world, generated } = admissionWorld(t);
  const generate = world.generator.generateChunk;
  t.mock.method(world.generator, "generateChunk", (cx, cz) => {
    if (cx === 1) throw new Error("declared generation failure");
    return generate(cx, cz);
  });
  await assert.rejects(world.ensureAreas([0, 1, 2, 3].map((cx) => footprint(cx, 0))),
    /declared generation failure/);
  assert.equal(generated.length, 1);
  assert.equal(world._pins.size, 0);
  assert.equal(world._requests.size, 0);
  assert.equal(world._inFlight.size, 0);
  assert.equal(world._focus, null);
  await new Promise(setImmediate);
  assert.equal(generated.length, 1, "failure does not silently retry queued columns");
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("failure in one overlapping batch does not cancel or unpin a newer successful group", async (t) => {
  const { world } = admissionWorld(t);
  const generate = world.generator.generateChunk;
  t.mock.method(world.generator, "generateChunk", (cx, cz) => {
    if (cx === -1) throw new Error("first batch failed");
    return generate(cx, cz);
  });
  const first = world.ensureAreas([footprint(0, 0), footprint(-1, 0)]);
  const failed = assert.rejects(first, /first batch failed/);
  const second = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  await failed;
  assert.equal(world._pins.get("0,0"), 1);
  assert.equal(world._pins.get("1,0"), 1);
  await second;
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "1,0"]);
  assert.equal(world._pins.size, 0);
  assert.equal(world._requests.size, 0);
});

test("an epoch change during admission cannot let an old finally unpin a new same-key batch", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  let replacement;
  world.onChunkAdmitted = () => {
    world.onChunkAdmitted = undefined;
    world.setDimension("nether");
    replacement = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  };
  const loading = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  t.mock.timers.tick(1);
  const old = workers[0], requests = [...old.pending.values()];
  old.reply(requests[0]);
  await cancelled;
  assert.equal(world.epoch, 1);
  assert.equal(world._pins.get("0,0"), 1);
  assert.equal(world._pins.get("1,0"), 1);
  old.reply(requests[1]);
  assert.equal(world.chunks.size, 0, "a retired physical response cannot publish");
  drainAdmissions(t, world, workers);
  await replacement;
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "1,0"]);
  assert.equal(world._pins.size, 0);
  assert.equal(world._inFlight.size, 0);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("same-dimension save replacement cancels old batch work without unpinning its replacement", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  const loading = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  t.mock.timers.tick(1);
  const old = workers[0], requests = [...old.pending.values()];
  old.reply(requests[0]);
  const original = world.chunks.get("0,0");
  const focus = world._focus;
  assert.equal(world.loadEdits(world.serialize()), true);
  assert.equal(world._focus, focus, "same-dimension cache focus keeps its existing save semantics");
  assert.equal(world._pins.size, 0);
  assert.equal(world._inFlight.size, 0);
  assert.equal(world.chunks.size, 1, "save replacement does not invent missing terrain");
  assert.notEqual(world.chunks.get("0,0"), original);
  assert.notEqual(world.chunks.get("0,0").incarnation, original.incarnation);
  const replacement = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  await cancelled;
  assert.equal(world._pins.get("0,0"), 1);
  assert.equal(world._pins.get("1,0"), 1);
  old.reply(requests[1]);
  assert.equal(world.chunks.size, 1);
  drainAdmissions(t, world, workers);
  await replacement;
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "1,0"]);
  assert.equal(world._pins.size, 0);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("disposal rejects a pending batch and retires all physical reservations without late resurrection", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  const loading = world.ensureAreas([footprint(0, 0), footprint(1, 0), footprint(2, 0)]);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  t.mock.timers.tick(1);
  const worker = workers[0], requests = [...worker.pending.values()];
  assert.equal(world._inFlight.size, 2);
  world.dispose();
  await cancelled;
  for (const request of requests) worker.reply(request);
  assert.equal(world.chunks.size, 0);
  assert.equal(world._pins.size, 0);
  assert.equal(world._requests.size, 0);
  assert.equal(world._inFlight.size, 0);
  assert.equal(world._focus, null);
  await assert.rejects(world.ensureAreas([footprint(0, 0)]), { name: "AbortError" });
});

test("worker fallback keeps a batch's exact dependencies and ignores its late physical responses", async (t) => {
  const { world, workers, generated } = admissionWorkerWorld(t);
  const loading = world.ensureAreas([0, 1, 2, 3].map((cx) => footprint(cx, 0)));
  t.mock.timers.tick(1);
  const worker = workers[0], requests = [...worker.pending.values()];
  assert.equal(world._inFlight.size, 2);
  worker.onerror({ preventDefault() {} });
  assert.equal(world._inFlight.size, 0);
  drainAdmissions(t, world, workers);
  await loading;
  const residents = [...world.chunks];
  assert.equal(generated.length, 4);
  assert.deepEqual(sorted(world.chunks.keys()), ["0,0", "1,0", "2,0", "3,0"]);
  assert.equal(world.removedChunks.size, 0);
  assert.equal(world._pins.size, 0);
  for (const request of requests) worker.reply(request);
  assert.deepEqual([...world.chunks], residents);
  assert.equal(generated.length, 4);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("synchronous generation may satisfy a batch but cannot free its two physical worker slots", async (t) => {
  const { world, workers, generated } = admissionWorkerWorld(t);
  const loading = world.ensureAreas([footprint(0, 0), footprint(1, 0)]);
  t.mock.timers.tick(1);
  const worker = workers[0];
  world.generate(1);
  const residents = [...world.chunks];
  await loading;
  assert.equal(generated.length, 9);
  assert.equal(world._pins.size, 0);
  assert.equal(world._requests.size, 0);
  assert.equal(world._inFlight.size, 2);
  bounds(world);
  for (const request of [...worker.pending.values()]) worker.reply(request);
  assert.deepEqual([...world.chunks], residents);
  assert.equal(world._inFlight.size, 0);
  assert.equal(generated.length, 9);
});

test("a full batch waits for old physical reservations and normal streaming resumes on new demand", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  world.onChunkAdmitted = () => bounds(world);
  const old = { x: 10000, z: 10000 };
  world.updateStreaming(old, 12);
  t.mock.timers.tick(1);
  const worker = workers[0], obsolete = [...worker.pending.values()];
  const loading = world.ensureAreas([footprint(0, 0, 14)]);
  assert.equal(world._requests.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world._pins.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world._inFlight.size, 2);
  for (const request of obsolete) worker.reply(request);
  assert.equal(world.chunks.size, 0);
  for (let step = 0; step < 1000 && world.chunks.size < MAX_RESIDENT_CHUNKS; step++) {
    t.mock.timers.tick(1);
    for (const request of [...worker.pending.values()]) worker.reply(request);
    bounds(world);
  }
  assert.equal(world.chunks.size, MAX_RESIDENT_CHUNKS);
  await loading;
  assert.equal(world._pins.size, 0);
  t.mock.timers.tick(1);
  assert.equal(world.chunks.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world._inFlight.size, 0, "old optional demand cannot evict the latest batch");
  assert.equal(world.streamingStatus().loaded, 0);
  world.updateStreaming(old, 12);
  drainAdmissions(t, world, workers);
  assert.equal(world.streamingStatus().loaded, MAX_RESIDENT_CHUNKS);
  assert.equal(world.chunks.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world.chunks.has("0,0"), false);
  assert.equal(worker.sent.length, 2 + 2 * MAX_RESIDENT_CHUNKS);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("batch retention survives optional visual refill at capacity, not the next streaming update", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  world.onChunkAdmitted = () => bounds(world);
  const position = { x: 0, z: 0 };
  world.updateStreaming(position, 12);
  drainAdmissions(t, world, workers);
  const loading = world.ensureAreas([footprint(100, 100), footprint(101, 100)]);
  t.mock.timers.tick(1);
  const worker = workers[0];
  for (const request of [...worker.pending.values()]) worker.reply(request);
  await loading;
  t.mock.timers.tick(1);
  assert.equal(world.chunks.size, MAX_RESIDENT_CHUNKS);
  assert.equal(world.streamingStatus().loaded, MAX_RESIDENT_CHUNKS - 2);
  assert.equal(world.chunks.has("100,100"), true);
  assert.equal(world.chunks.has("101,100"), true);
  assert.equal(world._inFlight.size, 0);
  assert.equal(world._scheduled, null, "blocked optional work must not spin a timer");
  world.updateStreaming(position, 12);
  assert.equal(world.chunks.size, MAX_RESIDENT_CHUNKS - 2);
  assert.notEqual(world._scheduled, null, "new demand must wake an existing blocked visual queue");
  drainAdmissions(t, world, workers);
  assert.equal(world.streamingStatus().loaded, MAX_RESIDENT_CHUNKS);
  assert.equal(world.chunks.has("100,100"), false);
  assert.equal(world.chunks.has("101,100"), false);
  assert.deepEqual(world.admissionObserverErrors, []);
});
