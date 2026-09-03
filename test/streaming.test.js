import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import {
  CHUNK_SIZE,
  WORLD_HEIGHT,
  WORLD_MAX,
  WORLD_MIN,
  World,
} from "../src/world.js";

const blankChunk = (cx, cz) => ({
  cx,
  cz,
  blocks: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT),
  biomes: new Uint8Array(CHUNK_SIZE * CHUNK_SIZE),
});

class ControlledWorker {
  static instances = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.pending = new Map();
    this.maxPending = 0;
    this.terminated = false;
    ControlledWorker.instances.push(this);
  }

  postMessage(data) {
    this.sent.push(data);
    this.pending.set(data.id, data);
    this.maxPending = Math.max(this.maxPending, this.pending.size);
  }

  reply(request = this.pending.values().next().value, id = BLOCK.STONE) {
    this.pending.delete(request.id);
    const chunk = blankChunk(request.cx, request.cz);
    chunk.blocks[CHUNK_SIZE * CHUNK_SIZE] = id;
    this.onmessage({
      data: { ...request, ...chunk, type: "chunk", encoding: "u8" },
    });
  }

  terminate() {
    this.terminated = true;
  }
}

function setup(t, { worker = ControlledWorker, useWorker = true } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", {
    configurable: true,
    writable: true,
    value: worker,
  });
  ControlledWorker.instances = [];
  const world = new World("streaming", { useWorker });
  const generated = [];
  world.generator.generateChunk = (cx, cz) => {
    generated.push([cx, cz]);
    return blankChunk(cx, cz);
  };
  t.after(() => {
    world.dispose();
    if (descriptor) Object.defineProperty(globalThis, "Worker", descriptor);
    else delete globalThis.Worker;
  });
  return { world, generated };
}

function drain(t, world) {
  for (let step = 0; step < 1000 && world._requests.size; step++) {
    t.mock.timers.tick(1);
    for (const worker of ControlledWorker.instances) {
      if (worker.terminated) continue;
      for (const request of [...worker.pending.values()]) worker.reply(request);
    }
  }
  assert.equal(world._requests.size, 0, "all requested chunks must settle");
  assert.equal(world._inFlight.size, 0);
}

test("ensureArea loads exactly its negative-coordinate square, nearest first, without padding", async (t) => {
  const { world, generated } = setup(t, { useWorker: false });
  world.set(-1, 10, -17, BLOCK.GLASS);
  const loading = world.ensureArea({ x: -0.1, z: -16.01 }, 1);
  assert.equal(world.chunks.size, 0);
  assert.equal(generated.length, 0);
  assert.equal(ControlledWorker.instances.length, 0);
  drain(t, world);
  assert.equal(await loading, world);
  assert.equal(world.chunks.size, 9);
  assert.equal(generated.length, 9);
  assert.deepEqual(generated[0], [-1, -2]);
  const distances = generated.map(([cx, cz]) => (cx + 1) ** 2 + (cz + 2) ** 2);
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b)
  );
  assert.deepEqual(
    [...world.chunks.keys()].sort(),
    [
      "-2,-3",
      "-2,-2",
      "-2,-1",
      "-1,-3",
      "-1,-2",
      "-1,-1",
      "0,-3",
      "0,-2",
      "0,-1",
    ].sort()
  );
  assert.equal(world.get(-1, 10, -17), BLOCK.GLASS);
  assert.equal(world.get(0, 10, -17), BLOCK.AIR);
  assert.equal(world.get(-1, 10, -16), BLOCK.AIR);
});

test("workers are lazy and overlapping area requests deduplicate with at most two in flight", async (t) => {
  const { world } = setup(t);
  assert.equal(ControlledWorker.instances.length, 0);
  const first = world.ensureArea({ x: 0, z: 0 }, 1);
  const second = world.ensureArea({ x: 1, z: 1 }, 1);
  assert.equal(ControlledWorker.instances.length, 0);
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  assert.equal(worker.options.type, "module");
  assert.ok(worker.url.pathname.endsWith("/terrain.worker.js"));
  assert.equal(worker.sent.length, 2);
  assert.equal(world._inFlight.size, 2);
  assert.deepEqual([worker.sent[0].cx, worker.sent[0].cz], [0, 0]);
  assert.equal(world.chunks.size, 0);
  const central = worker.sent[0];
  worker.reply(central);
  world.set(0, 10, 0, BLOCK.GLASS);
  worker.reply(central, BLOCK.LAVA);
  assert.equal(world.get(0, 1, 0), BLOCK.STONE);
  assert.equal(world.get(0, 10, 0), BLOCK.GLASS);
  drain(t, world);
  await Promise.all([first, second]);
  assert.equal(worker.sent.length, 9);
  assert.equal(worker.maxPending, 2);
  assert.equal(new Set(worker.sent.map(({ cx, cz }) => `${cx},${cz}`)).size, 9);
  assert.equal(world.chunks.size, 9);
});

test("updateStreaming only queues synchronously and loads a meshing padding ring", async (t) => {
  const { world, generated } = setup(t, { useWorker: false });
  assert.equal(world.updateStreaming({ x: 0, z: 0 }, 1), world);
  assert.equal(world.chunks.size, 0);
  assert.equal(generated.length, 0);
  assert.equal(ControlledWorker.instances.length, 0);
  const ready = world.ensureArea({ x: 0, z: 0 }, 1);
  drain(t, world);
  await ready;
  assert.equal(world.chunks.size, 25);
  assert.equal(world.isLoaded(2 * CHUNK_SIZE, 2 * CHUNK_SIZE), true);
  assert.equal(world.isLoaded(3 * CHUNK_SIZE, 0), false);
});

test("arriving chunks invalidate diagonal seams and eviction emits render disposal keys", async (t) => {
  const { world } = setup(t, { useWorker: false });
  let loading = world.ensureArea({ x: 0, z: 0 }, 0);
  drain(t, world);
  await loading;
  world.set(0, 10, 0, BLOCK.BRICK);
  world.clearDirty();
  loading = world.ensureArea({ x: CHUNK_SIZE, z: CHUNK_SIZE }, 0);
  drain(t, world);
  await loading;
  assert.deepEqual([...world.dirtyChunks].sort(), ["0,0", "1,1"]);
  world.updateStreaming({ x: 1000, z: 1000 }, 0);
  assert.equal(world.isLoaded(0, 0), false);
  assert.equal(world.get(0, 10, 0), BLOCK.AIR);
  assert.ok(world.removedChunks.has("0,0"));
  assert.ok(world.removedChunks.has("1,1"));
  assert.equal(world.dirtyChunks.size, 0);
  assert.equal(world.edits.size, 1);
  loading = world.ensureArea({ x: 0, z: 0 }, 0);
  drain(t, world);
  await loading;
  assert.equal(world.get(0, 10, 0), BLOCK.BRICK);
});

test("rapid travel discards obsolete queued loads and bounds active work and resident chunks", (t) => {
  const { world } = setup(t);
  world.updateStreaming({ x: 0, z: 0 }, 3);
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  const obsolete = [...worker.pending.values()];
  for (let step = 1; step <= 100; step++) {
    world.updateStreaming({ x: step * 1000, z: -step * 1000 }, 3);
    assert.ok(world._requests.size <= 83);
    assert.ok(world._inFlight.size <= 2);
  }
  for (const request of obsolete) worker.reply(request);
  assert.equal(
    world.chunks.size,
    0,
    "obsolete results must not resurrect old chunks"
  );
  drain(t, world);
  assert.equal(world.chunks.size, 81);
  assert.equal(worker.sent.length, 83);
  for (let step = 1; step <= 8; step++) {
    world.updateStreaming({ x: 100000 + step * CHUNK_SIZE, z: -100000 }, 3);
    drain(t, world);
    assert.ok(world.chunks.size <= 121);
    assert.ok(world.dirtyChunks.size <= world.chunks.size);
    for (const chunk of world.chunks.values()) {
      assert.ok(
        Math.abs(
          chunk.cx - Math.floor((100000 + step * CHUNK_SIZE) / CHUNK_SIZE)
        ) <= 5
      );
      assert.ok(Math.abs(chunk.cz - Math.floor(-100000 / CHUNK_SIZE)) <= 5);
    }
  }
  assert.equal(worker.maxPending, 2);
});

test("concurrent explicit area loads pin their chunks until each promise settles", async (t) => {
  const { world } = setup(t);
  const near = world.ensureArea({ x: 0, z: 0 }, 0);
  const far = world.ensureArea({ x: 10000, z: 10000 }, 0);
  world.updateStreaming({ x: -10000, z: -10000 }, 0);
  drain(t, world);
  await Promise.all([near, far]);
  assert.equal(world.isLoaded(0, 0), true);
  assert.equal(world.isLoaded(10000, 10000), true);
  assert.equal(world._pins.size, 0);
});

test("area validation clips both world edges and rejects unsafe positions or unbounded radii", async (t) => {
  const { world } = setup(t, { useWorker: false });
  for (const position of [
    { x: WORLD_MIN, z: WORLD_MIN },
    { x: WORLD_MAX - 0.01, z: WORLD_MAX - 0.01 },
  ]) {
    const ready = world.ensureArea(position, 1);
    drain(t, world);
    await ready;
    assert.equal(world.chunks.size, 4);
    for (const chunk of world.chunks.values()) {
      assert.ok(chunk.cx * CHUNK_SIZE >= WORLD_MIN);
      assert.ok(chunk.cz * CHUNK_SIZE >= WORLD_MIN);
      assert.ok(chunk.cx * CHUNK_SIZE < WORLD_MAX);
      assert.ok(chunk.cz * CHUNK_SIZE < WORLD_MAX);
    }
  }
  for (const position of [
    null,
    {},
    { x: NaN, z: 0 },
    { x: Infinity, z: 0 },
    { x: WORLD_MAX, z: 0 },
    { x: WORLD_MIN - 0.1, z: 0 },
    { x: Number.MAX_SAFE_INTEGER + 1, z: 0 },
  ])
    await assert.rejects(world.ensureArea(position, 0), RangeError);
  for (const radius of [-1, 0.5, NaN, Infinity, 1e9])
    await assert.rejects(world.ensureArea({ x: 0, z: 0 }, radius), RangeError);
});

test("too many simultaneous pinned areas reject atomically instead of growing the queue", async (t) => {
  const { world } = setup(t);
  const first = world.ensureArea({ x: 0, z: 0 }, 8);
  const cancelled = assert.rejects(first, { name: "AbortError" });
  const before = world._requests.size;
  await assert.rejects(world.ensureArea({ x: 10000, z: 10000 }, 8), RangeError);
  assert.equal(world._requests.size, before);
  assert.equal(world._pins.size, before);
  world.dispose();
  await cancelled;
});

for (const failure of [
  "constructor",
  "postMessage",
  "error",
  "messageerror",
  "reported error",
  "malformed response",
  "wrong seed",
  "wrong generator",
  "wrong spec",
  "unregistered block",
  "illegal state",
  "illegal fluid",
  "duplicate sections",
  "timeout",
]) {
  test(`worker ${failure} falls back without hanging or recreating broken workers`, async (t) => {
    let WorkerType = ControlledWorker;
    if (failure === "constructor") {
      WorkerType = class {
        constructor() {
          throw new Error("Worker unsupported");
        }
      };
    } else if (failure === "postMessage") {
      WorkerType = class extends ControlledWorker {
        postMessage() {
          throw new Error("Cannot clone request");
        }
      };
    }
    const { world, generated } = setup(t, { worker: WorkerType });
    const loading = world.ensureArea({ x: 0, z: 0 }, 1);
    t.mock.timers.tick(1);
    const worker = ControlledWorker.instances[0];
    if (failure === "error") worker.onerror({ preventDefault() {} });
    if (failure === "messageerror") worker.onmessageerror({});
    if (failure === "reported error") {
      worker.onmessage({
        data: { ...worker.sent[0], type: "error", message: "Import failed" },
      });
    }
    if (failure === "malformed response") {
      worker.onmessage({
        data: { ...worker.sent[0], type: "chunk", blocks: new Uint8Array(1) },
      });
    }
    if (
      [
        "wrong seed",
        "wrong generator",
        "wrong spec",
        "unregistered block",
        "illegal state",
        "illegal fluid",
        "duplicate sections",
      ].includes(failure)
    ) {
      const request = worker.sent[0];
      const packet = {
        ...request,
        ...blankChunk(request.cx, request.cz),
        type: "chunk",
        encoding: "u8",
      };
      if (failure === "wrong seed") packet.seed = "unrequested";
      if (failure === "wrong generator") packet.generatorVersion = 1;
      if (failure === "wrong spec") packet.minY = -64;
      if (failure === "unregistered block") packet.blocks[0] = 255;
      if (failure === "illegal state") {
        const states = new Uint16Array(4096);
        states[0] = BLOCK_STATE.OPEN;
        packet.sections = [{ sy: 0, states }];
      }
      if (failure === "illegal fluid") {
        const fluids = new Uint8Array(4096);
        fluids[0] = FLUID.WATER_SOURCE;
        packet.sections = [{ sy: 0, fluids }];
      }
      if (failure === "duplicate sections")
        packet.sections = [{ sy: 0 }, { sy: 0 }];
      worker.onmessage({ data: packet });
      assert.equal(
        world.chunks.size,
        0,
        "a malformed packet cannot be admitted"
      );
    }
    if (failure === "timeout") t.mock.timers.tick(15001);
    drain(t, world);
    await loading;
    assert.equal(world.chunks.size, 9);
    assert.equal(generated.length, 9);
    assert.equal(world._workerDisabled, true);
    assert.ok(ControlledWorker.instances.length <= 1);
    if (worker) assert.equal(worker.terminated, true);
  });
}

test("missing Worker support uses the same bounded asynchronous fallback", async (t) => {
  const { world, generated } = setup(t, { worker: undefined });
  globalThis.Worker = undefined;
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  assert.equal(generated.length, 0);
  drain(t, world);
  await loading;
  assert.equal(generated.length, 1);
  assert.equal(world.chunks.size, 1);
});

test("fallback generator failures reject the area promise and release its pins", async (t) => {
  const { world } = setup(t, { useWorker: false });
  world.generator.generateChunk = () => {
    throw new Error("Invalid generator data");
  };
  const rejected = assert.rejects(
    world.ensureArea({ x: 0, z: 0 }, 0),
    /Invalid generator data/
  );
  drain(t, world);
  await rejected;
  assert.equal(world._pins.size, 0);
  assert.equal(world.chunks.size, 0);
});

test("dimension switches reject queued loads, preserve edits, and ignore stale replies", async (t) => {
  const { world } = setup(t);
  world.set(0, 10, 0, BLOCK.GLASS);
  const first = world.ensureArea({ x: 0, z: 0 }, 1);
  const cancelled = assert.rejects(first, { name: "AbortError" });
  t.mock.timers.tick(1);
  const oldWorker = ControlledWorker.instances[0];
  const stale = oldWorker.sent[0];
  world.setDimension("nether");
  assert.equal(world.chunks.size, 0);
  const second = world.ensureArea({ x: 0, z: 0 }, 0);
  await cancelled;
  assert.equal(
    world._pins.get("0,0"),
    1,
    "old finally must not unpin the new dimension"
  );
  t.mock.timers.tick(1);
  oldWorker.reply(stale);
  assert.equal(world.chunks.size, 0);
  const worker = ControlledWorker.instances[1];
  worker.reply(worker.sent[0], BLOCK.NETHERRACK);
  await second;
  assert.equal(world.get(0, 1, 0), BLOCK.NETHERRACK);
  assert.equal(world.get(0, 10, 0), BLOCK.AIR);
  world.set(0, 10, 0, BLOCK.GLOWSTONE);
  world.setDimension("overworld");
  assert.ok(world.removedChunks.has("0,0"));
  const returned = world.ensureArea({ x: 0, z: 0 }, 0);
  drain(t, world);
  await returned;
  assert.equal(world.get(0, 10, 0), BLOCK.GLASS);
  assert.deepEqual(world.serialize().edits, [
    ["overworld", 0, 10, 0, BLOCK.GLASS, 0, 0],
    ["nether", 0, 10, 0, BLOCK.GLOWSTONE, 0, 0],
  ]);
});

test("legacy import cancels worker jobs from the previous generator version", async (t) => {
  const { world } = setup(t);
  const loading = world.ensureArea({ x: 0, z: 0 }, 1);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  t.mock.timers.tick(1);
  const oldWorker = ControlledWorker.instances[0];
  const stale = oldWorker.sent[0];
  assert.equal(
    world.loadEdits({
      version: 1,
      seed: world.seed,
      edits: [[0, 10, 0, BLOCK.GLASS]],
    }),
    true
  );
  await cancelled;
  const restored = world.ensureArea({ x: 0, z: 0 }, 0);
  t.mock.timers.tick(1);
  oldWorker.reply(stale);
  assert.equal(world.chunks.size, 0);
  const worker = ControlledWorker.instances[1];
  assert.equal(worker.sent[0].generatorVersion, 1);
  worker.reply();
  await restored;
  assert.equal(world.get(0, 10, 0), BLOCK.GLASS);
  assert.equal(world.generatorVersion, 1);
});

test("dispose rejects in-flight and queued requests and prevents late cache resurrection", async (t) => {
  const { world } = setup(t);
  const loading = world.ensureArea({ x: 0, z: 0 }, 2);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  const stale = worker.sent[0];
  world.dispose();
  await cancelled;
  assert.equal(worker.terminated, true);
  worker.reply(stale);
  t.mock.timers.tick(20000);
  assert.equal(world.chunks.size, 0);
  assert.equal(world._requests.size, 0);
  assert.equal(world._inFlight.size, 0);
  assert.equal(world._pins.size, 0);
  await assert.rejects(world.ensureArea({ x: 0, z: 0 }), {
    name: "AbortError",
  });
  assert.equal(world.set(0, 10, 0, BLOCK.STONE), false);
  assert.equal(world.updateStreaming({ x: 0, z: 0 }), world);
  assert.throws(() => world.getSpawn(), { name: "AbortError" });
});

test("historical unversioned worker replies are accepted only without modern auxiliary data", async (t) => {
  const { world, generated } = setup(t);
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  const request = worker.sent[0];
  worker.pending.delete(request.id);
  worker.onmessage({
    data: {
      type: "chunk",
      id: request.id,
      epoch: request.epoch,
      dimension: request.dimension,
      ...blankChunk(request.cx, request.cz),
    },
  });
  await loading;
  assert.equal(generated.length, 0);
  assert.ok(world.chunks.get("0,0").blocks instanceof Uint16Array);
});

test("modern worker admission preserves high IDs and generated orientation/fluid planes", async (t) => {
  const { world, generated } = setup(t);
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  const request = worker.sent[0];
  const blocks = new Uint16Array(96 * 256);
  const states = new Uint16Array(4096);
  const fluids = new Uint8Array(4096);
  blocks[5 * 256] = BLOCK.OAK_STAIRS;
  states[5 * 256] = BLOCK_STATE.TOP | 1;
  fluids[5 * 256] = FLUID.WATER_SOURCE;
  worker.pending.delete(request.id);
  worker.onmessage({
    data: {
      ...request,
      type: "chunk",
      encoding: "u16",
      blocks,
      biomes: new Uint8Array(256),
      sections: [{ sy: 0, states, fluids }],
      structures: [{ kind: "transport-fixture" }],
    },
  });
  await loading;
  assert.equal(generated.length, 0);
  assert.deepEqual(world.getCell(0, 5, 0), {
    id: BLOCK.OAK_STAIRS,
    state: BLOCK_STATE.TOP | 1,
    fluid: FLUID.WATER_SOURCE,
  });
  assert.deepEqual(world.chunks.get("0,0").structures, [
    { kind: "transport-fixture" },
  ]);
});

test("unknown jobs and old epochs cannot fulfill the current requested column", async (t) => {
  const { world } = setup(t);
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  t.mock.timers.tick(1);
  const worker = ControlledWorker.instances[0];
  const request = worker.sent[0];
  const packet = {
    ...request,
    ...blankChunk(request.cx, request.cz),
    type: "chunk",
    encoding: "u8",
  };
  worker.onmessage({ data: { ...packet, id: request.id + 100 } });
  worker.onmessage({ data: { ...packet, epoch: request.epoch - 1 } });
  assert.equal(world.chunks.size, 0);
  assert.equal(world._inFlight.size, 1);
  worker.reply(request);
  await loading;
  assert.equal(world.get(0, 1, 0), BLOCK.STONE);
});
