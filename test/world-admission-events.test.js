import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { cellIndex, cloneChunkData } from "../src/chunk-data.js";
import { createGenerator, GENERATOR_VERSION } from "../src/terrain.js";
import { V4_GENERATION_MANIFEST } from "../src/terrain-v4-manifest.js";
import { World } from "../src/world.js";
import {
  ADMISSION_SEED,
  admissionWorkerWorld,
  admissionWorld,
  drainAdmissions,
} from "./world-admission-fixture.js";

function assertPublished(event) {
  const { world, key, chunk } = event;
  assert.ok(Object.isFrozen(event));
  assert.equal(world._disposed, false);
  assert.equal(event.seed, world.seed);
  assert.equal(event.dimension, world.dimension);
  assert.equal(event.generatorVersion, world.generatorVersion);
  assert.equal(event.epoch, world.epoch);
  assert.equal(key, `${event.cx},${event.cz}`);
  assert.equal(
    world.chunks.get(key),
    chunk,
    "notify borrows the installed resident"
  );
  assert.equal(event.incarnation, chunk.incarnation);
  assert.equal(event.revision, 0);
  assert.equal(chunk.revision, 0);
  assert.ok(chunk.originals instanceof Map);
  assert.ok(chunk.sections instanceof Map);
  assert.ok(world.dirtyChunks.has(key));
  for (let sy = Math.floor(world.minY / 16); sy < world.maxY / 16; sy++) {
    assert.equal(chunk.sectionRevisions.get(sy), 0);
    assert.ok(
      world.dirtySectionRevisions.get(`${event.cx},${event.cz},${sy}`) > 0
    );
  }
}

test("binding is explicit, has no resident replay, and synchronous/spawn loads notify once", (t) => {
  const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
  world.generate(0);
  const events = [];
  world.onChunkAdmitted = function (event) {
    assert.equal(this, world);
    events.push(event);
    assertPublished(event);
  };
  assert.equal(
    events.length,
    0,
    "the parent forwards initially resident chunks itself"
  );
  world.generate(0);
  assert.equal(events.length, 0, "already resident chunks are not re-admitted");
  world.generate(1);
  assert.equal(events.length, 8);
  assert.equal(generated.length, 9);
  assert.equal(new Set(events.map((event) => event.incarnation)).size, 8);
  world.getSpawn();
  assert.equal(events.length, 8);
  assert.deepEqual(world.admissionObserverErrors, []);
  world.onChunkAdmitted = undefined;
  world._removeChunk("0,0", world.chunks.get("0,0"));
  world.generate(0);
  assert.equal(events.length, 8, "unbinding is not an implicit subscription");
});

test("a cold spawn search notifies for the columns it actually admits", (t) => {
  const events = [];
  const { world, generated } = admissionWorld(t, {
    generatorVersion: 4,
    onChunkAdmitted(event) {
      events.push(event);
      assertPublished(event);
    },
  });
  const spawn = world.getSpawn();
  assert.equal(spawn.x, 0.5);
  assert.equal(spawn.z, 0.5);
  assert.ok(Math.abs(spawn.y - (world.minY + 17.01)) < 1e-6);
  assert.equal(events.length, 9);
  assert.equal(generated.length, 9);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("saved edits, negative-Y state/fluid planes and descriptors precede constructor notification", (t) => {
  let observed;
  let mutations = 0;
  const { world, generated } = admissionWorld(t, {
    generatorVersion: 4,
    onMutation: () => {
      mutations++;
    },
    onChunkAdmitted(event) {
      observed = event;
      assertPublished(event);
      assert.deepEqual(event.world.getCell(1, -47, 2), {
        id: BLOCK.OAK_STAIRS,
        state: S.TOP | 3,
        fluid: F.WATER_SOURCE,
      });
      assert.deepEqual(event.world.getCell(2, -47, 2), {
        id: BLOCK.WATER,
        state: 0,
        fluid: F.WATER_2,
      });
      assert.equal(event.chunk.originals.size, 2);
    },
  });
  t.mock.method(world, "commitMutation", () =>
    assert.fail("admission must not replay gameplay writes")
  );
  const saved = {
    version: 3,
    generatorVersion: 4,
    seed: world.seed,
    dimension: "overworld",
    edits: [
      ["overworld", 1, -47, 2, BLOCK.OAK_STAIRS, S.TOP | 3, F.WATER_SOURCE],
      ["overworld", 2, -47, 2, BLOCK.WATER, 0, F.WATER_2],
    ],
  };
  assert.equal(world.loadEdits(saved), true);
  assert.equal(observed, undefined);
  const reserved = world.coordinator.usage(world);
  world.generate(0);
  const chunk = world.chunks.get("0,0");
  assert.equal(observed.chunk, chunk);
  assert.equal(observed.chunk.blocks, chunk.blocks);
  assert.equal(observed.chunk.sections, chunk.sections);
  assert.deepEqual(chunk.structures, generated[0].chunk.structures);
  assert.notEqual(chunk.structures, generated[0].chunk.structures);
  assert.deepEqual(chunk.originals.get(cellIndex(2, -47, 2, world.spec)), {
    id: BLOCK.WATER,
    state: 0,
    fluid: F.BUBBLE_UP,
  });
  assert.equal(chunk.sections.get(-3).states[256 + 33], S.TOP | 3);
  assert.equal(chunk.sections.get(-3).fluids[256 + 34], F.WATER_2);
  assert.deepEqual(world.getCell(3, -47, 2), {
    id: BLOCK.OAK_LOG,
    state: S.AXIS_Z,
    fluid: F.NONE,
  });
  assert.equal(mutations, 0);
  assert.equal(world.coordinator.usage(world), reserved);
  assert.deepEqual(world.serialize(), saved);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("queued fallback, synchronous fulfillment and streaming share one admission path", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
  const events = [];
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 1);
  assert.equal(events.length, 0);
  world.generate(0);
  assert.equal(events.length, 1);
  assert.equal(world._requests.has("0,0"), false);
  drainAdmissions(t, world);
  assert.equal(await loading, world);
  assert.equal(events.length, 9);
  assert.equal(generated.length, 9);
  world.updateStreaming({ x: 32, z: 0 }, 0);
  assert.equal(events.length, 9, "queuing is not admission");
  drainAdmissions(t, world);
  assert.ok(events.length > 9);
  assert.equal(events.length, generated.length);
  assert.equal(
    new Set(events.map((event) => event.incarnation)).size,
    events.length
  );
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("worker data and a sync/worker race retain complete residents without duplicate events", async (t) => {
  const { world, workers, generated } = admissionWorkerWorld(t);
  const events = [];
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
  };
  const first = world.ensureArea({ x: 0, z: 0 }, 0);
  t.mock.timers.tick(1);
  const worker = workers[0];
  const firstJob = worker.sent[0];
  worker.reply(firstJob);
  await first;
  assert.equal(events.length, 1);
  assert.equal(generated.length, 0);
  assert.deepEqual(world.getCell(1, 17, 2), {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 1,
    fluid: F.WATER_SOURCE,
  });
  assert.equal(events[0].chunk.sections.get(1).fluids[256 + 34], F.BUBBLE_UP);
  assert.equal(events[0].chunk.structures[0].markers[0].type, "container");
  const second = world.ensureArea({ x: 16, z: 0 }, 0);
  t.mock.timers.tick(1);
  const secondJob = worker.sent.at(-1);
  const synchronous = world._generateSync(1, 0);
  assert.equal(events.length, 2);
  assert.equal(world._inFlight.size, 1);
  worker.reply(secondJob);
  await second;
  worker.reply(firstJob);
  worker.reply(secondJob);
  assert.equal(world.chunks.get("1,0"), synchronous);
  assert.equal(events.length, 2);
  assert.deepEqual(generated, [[1, 0]]);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("throwing worker observers cannot fail admission, disable workers or trigger fallback", async (t) => {
  const { world, workers, generated } = admissionWorkerWorld(t);
  const failure = new Error("admission observer failed");
  let notified = 0;
  world.onChunkAdmitted = (event) => {
    notified++;
    assertPublished(event);
    throw failure;
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 1);
  drainAdmissions(t, world, workers);
  assert.equal(await loading, world);
  assert.equal(world.chunks.size, 9);
  assert.equal(notified, 9);
  assert.equal(generated.length, 0);
  assert.equal(workers.length, 1);
  assert.equal(world._workerDisabled, false);
  assert.equal(world.admissionObserverErrors.length, 9);
  assert.ok(
    world.admissionObserverErrors.every(({ error }) => error === failure)
  );
});

test("a failed worker falls back through the same notifications exactly once per resident", async (t) => {
  const { world, workers, generated } = admissionWorkerWorld(t);
  const events = [];
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 1);
  t.mock.timers.tick(1);
  workers[0].onerror({ preventDefault() {} });
  drainAdmissions(t, world, workers);
  await loading;
  assert.equal(world._workerDisabled, true);
  assert.equal(workers[0].terminated, true);
  assert.equal(generated.length, 9);
  assert.equal(events.length, 9);
  assert.equal(new Set(events.map((event) => event.key)).size, 9);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("eviction and re-admission change incarnation without changing epoch or coordinates", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world } = admissionWorld(t, { generatorVersion: 4 });
  const events = [];
  world.onChunkAdmitted = (event) => events.push(event);
  world.generate(0);
  const first = events[0];
  world.updateStreaming({ x: 1024, z: 1024 }, 0);
  assert.equal(world.chunks.has(first.key), false);
  world.generate(0);
  const second = events[1];
  assert.equal(events.length, 2);
  assert.equal(second.key, first.key);
  assert.equal(second.epoch, first.epoch);
  assert.ok(second.incarnation > first.incarnation);
  assert.notEqual(second.chunk, first.chunk);
  assert.equal(world.chunks.get(second.key), second.chunk);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("staged reload publishes every resident before re-entrant observers, without gameplay writes", (t) => {
  const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
  world.generate(1);
  assert.equal(world.set(5, -47, 5, BLOCK.GLASS), true);
  const saved = world.serialize();
  const previous = new Map(world.chunks);
  const epoch = world.epoch;
  const generationCount = generated.length;
  const events = [];
  let mutations = 0;
  world.onMutation = () => {
    mutations++;
  };
  t.mock.method(world, "commitMutation", () =>
    assert.fail("reload is not a gameplay action")
  );
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
    assert.equal(world.chunks.size, previous.size);
    for (const [key, chunk] of world.chunks) {
      assert.notEqual(chunk, previous.get(key));
      assert.ok(chunk.incarnation > previous.get(key).incarnation);
    }
    assert.equal(world.get(5, -47, 5), BLOCK.GLASS);
    if (events.length === 1) world.generate(1);
  };
  assert.equal(world.loadEdits(saved), true);
  assert.equal(
    events.length,
    9,
    "re-entrant generation sees all staged residents"
  );
  assert.equal(generated.length, generationCount);
  assert.ok(events.every((event) => event.epoch === epoch + 1));
  assert.equal(mutations, 0);
  assert.deepEqual(world.serialize(), saved);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("an injected fixture generator change re-admits the expanded layout", (t) => {
  const { world } = admissionWorld(t, { generatorVersion: 3 });
  world.generate(0);
  const previous = world.chunks.get("0,0");
  const events = [];
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
  };
  assert.equal(
    world.loadEdits({
      version: 3,
      seed: world.seed,
      generatorVersion: 4,
      dimension: "overworld",
      edits: [
        ["overworld", 1, -47, 2, BLOCK.OAK_STAIRS, S.TOP | 2, F.WATER_SOURCE],
      ],
    }),
    true
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].generatorVersion, 4);
  assert.equal(events[0].chunk.minY, -64);
  assert.equal(events[0].chunk.blocks.length, 384 * 256);
  assert.ok(events[0].incarnation > previous.incarnation);
  assert.deepEqual(world.getCell(1, -47, 2), {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 2,
    fluid: F.WATER_SOURCE,
  });
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("native constructor and saved-version activation share post-edit admission identity", {
  timeout: 30000, // Real v3 resident followed by two default-factory native v4 admissions.
}, (t) => {
  assert.equal(GENERATOR_VERSION, 3);
  const world = new World(ADMISSION_SEED, { useWorker: false });
  const native = new World(ADMISSION_SEED, {
    generatorVersion: 4,
    useWorker: false,
  });
  t.after(() => world.dispose());
  t.after(() => native.dispose());
  assert.equal(world.generatorVersion, 3);
  assert.equal(world._generatorFactory, createGenerator);
  assert.equal(native._generatorFactory, createGenerator);
  assert.equal(native.generator.generationManifest, V4_GENERATION_MANIFEST);
  const previous = world._generateSync(0, 0);
  const epoch = world.epoch;
  const after = {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 2,
    fluid: F.WATER_SOURCE,
  };
  const saved = {
    version: 3,
    seed: ADMISSION_SEED,
    generatorVersion: 4,
    dimension: "overworld",
    edits: [["overworld", 1, -47, 2, after.id, after.state, after.fluid]],
  };
  const events = [];
  let mutations = 0;
  world.onMutation = () => mutations++;
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
    assert.deepEqual(
      world.getCell(1, -47, 2),
      after,
      "saved edits precede the native notification"
    );
  };
  assert.equal(world.loadEdits(saved), true);
  assert.equal(world.generator.generationManifest, V4_GENERATION_MANIFEST);
  assert.equal(world.generatorVersion, 4);
  assert.equal(world.epoch, epoch + 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].seed, ADMISSION_SEED);
  assert.equal(events[0].generatorVersion, 4);
  assert.equal(events[0].dimension, "overworld");
  assert.equal(events[0].key, "0,0");
  assert.ok(events[0].incarnation > previous.incarnation);
  assert.notEqual(events[0].chunk, previous);
  assert.equal(events[0].chunk.blocks.length, 384 * 256);
  assert.equal(events[0].chunk.originals.size, 1);
  assert.equal(
    mutations,
    0,
    "native activation is not gameplay mutation replay"
  );
  assert.equal(native.loadEdits(saved), true);
  const constructed = native._generateSync(0, 0);
  assert.deepEqual(
    cloneChunkData(events[0].chunk),
    cloneChunkData(constructed)
  );
  assert.deepEqual(world.serialize(), saved);
  assert.deepEqual(native.serialize(), saved);
  assert.deepEqual(world.admissionObserverErrors, []);
  assert.deepEqual(native.admissionObserverErrors, []);
});

for (const method of ["generate", "getSpawn"]) {
  test(`observer disposal stops the remaining synchronous ${method} admissions`, (t) => {
    const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
    let notified = 0;
    world.onChunkAdmitted = (event) => {
      notified++;
      assertPublished(event);
      world.dispose();
    };
    assert.throws(() => world[method](1), { name: "AbortError" });
    assert.equal(notified, 1);
    assert.equal(generated.length, 1);
    assert.equal(world.chunks.size, 0);
    assert.equal(world.coordinator.usage(world), undefined);
    assert.deepEqual(world.admissionObserverErrors, []);
  });
}

for (const mode of ["worker", "fallback"]) {
  test(`observer disposal never acknowledges a retired ${mode} request`, async (t) => {
    if (mode === "fallback") t.mock.timers.enable({ apis: ["setTimeout"] });
    const {
      world,
      workers = [],
      generated,
    } = mode === "worker"
      ? admissionWorkerWorld(t)
      : admissionWorld(t, { generatorVersion: 4 });
    const failure = new Error("observer failed after disposal");
    let notified = 0;
    world.onChunkAdmitted = (event) => {
      notified++;
      assertPublished(event);
      world.dispose();
      throw failure;
    };
    const loading = world.ensureArea({ x: 0, z: 0 }, 1);
    const cancelled = assert.rejects(loading, { name: "AbortError" });
    const request = world._requests.get("0,0");
    const resolve = request.resolve;
    let resolved = 0;
    request.resolve = (value) => {
      resolved++;
      resolve(value);
    };
    drainAdmissions(t, world, workers);
    await cancelled;
    assert.equal(resolved, 0);
    assert.equal(notified, 1);
    assert.equal(world.chunks.size, 0);
    assert.equal(generated.length, mode === "worker" ? 0 : 1);
    assert.equal(world.admissionObserverErrors.length, 1);
    assert.equal(world.admissionObserverErrors[0].error, failure);
    assert.equal(world.admissionObserverErrors[0].epoch, 0);
    assert.equal(world.epoch, 1);
  });
}

test("a synchronous observer reset cannot acknowledge a newer queued request with the old chunk", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
  const events = [];
  let replacementLoading;
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
    if (event.dimension === "overworld") {
      world.setDimension("nether");
      replacementLoading = world.ensureArea({ x: 0, z: 0 }, 0);
    }
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  const oldRequest = world._requests.get("0,0");
  assert.throws(() => world.generate(0), { name: "AbortError" });
  const replacement = world._requests.get("0,0");
  assert.ok(replacement);
  assert.notEqual(replacement, oldRequest);
  assert.equal(
    world.chunks.size,
    0,
    "old chunk is not installed into the replacement world"
  );
  await cancelled;
  assert.equal(world._pins.get("0,0"), 1);
  drainAdmissions(t, world);
  assert.equal(await replacementLoading, world);
  assert.deepEqual(
    events.map((event) => event.dimension),
    ["overworld", "nether"]
  );
  assert.equal(generated.length, 2);
  assert.equal(world.chunks.get("0,0"), events[1].chunk);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("observer reset rejects the old request and leaves a same-key replacement request intact", async (t) => {
  const { world, workers } = admissionWorkerWorld(t);
  const events = [];
  let replacementLoading;
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
    if (event.dimension === "overworld") {
      world.setDimension("nether");
      replacementLoading = world.ensureArea({ x: 0, z: 0 }, 0);
    }
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  const request = world._requests.get("0,0");
  const resolve = request.resolve;
  let resolved = 0;
  request.resolve = (value) => {
    resolved++;
    resolve(value);
  };
  t.mock.timers.tick(1);
  const oldWorker = workers[0];
  oldWorker.reply(oldWorker.sent[0]);
  const replacement = world._requests.get("0,0");
  assert.ok(replacement);
  assert.notEqual(replacement, request);
  assert.equal(replacement.epoch, world.epoch);
  // A late completion cannot delete a newer request with the same coordinates.
  world._finish(request, null, new Error("late old completion"));
  oldWorker.reply(oldWorker.sent[0]);
  assert.equal(world._requests.get("0,0"), replacement);
  await cancelled;
  assert.equal(resolved, 0);
  assert.equal(world._pins.get("0,0"), 1);
  drainAdmissions(t, world, workers);
  assert.equal(await replacementLoading, world);
  assert.deepEqual(
    events.map((event) => event.dimension),
    ["overworld", "nether"]
  );
  assert.equal(world.chunks.get("0,0"), events[1].chunk);
  assert.equal(workers.length, 2);
  assert.deepEqual(world.admissionObserverErrors, []);
});

test("synchronous transport re-entry never pumps replacement jobs into the retired worker", async (t) => {
  const { world, workers } = admissionWorkerWorld(t, { immediate: true });
  const events = [];
  let replacementLoading;
  world.onChunkAdmitted = (event) => {
    events.push(event);
    assertPublished(event);
    if (event.dimension === "overworld") {
      world.setDimension("nether");
      replacementLoading = world.ensureArea({ x: 0, z: 0 }, 1);
    }
  };
  const loading = world.ensureArea({ x: 0, z: 0 }, 1);
  const cancelled = assert.rejects(loading, { name: "AbortError" });
  drainAdmissions(t, world, workers);
  await cancelled;
  assert.equal(await replacementLoading, world);
  assert.equal(workers.length, 2);
  assert.equal(workers[0].sent.length, 1);
  assert.equal(workers[1].sent.length, 9);
  assert.ok(workers[1].sent.every((request) => request.dimension === "nether"));
  assert.equal(
    events.filter((event) => event.dimension === "overworld").length,
    1
  );
  assert.equal(
    events.filter((event) => event.dimension === "nether").length,
    9
  );
  assert.deepEqual(world.admissionObserverErrors, []);
});

for (const replacement of ["dispose", "dimension"]) {
  test(`staged reload observer ${replacement} suppresses retired notifications and publications`, (t) => {
    const { world, generated } = admissionWorld(t, { generatorVersion: 4 });
    world.generate(1);
    const saved = world.serialize();
    const generationCount = generated.length;
    const events = [];
    let replaced = false;
    world.onChunkAdmitted = (event) => {
      events.push(event);
      assertPublished(event);
      if (replaced) return;
      replaced = true;
      if (replacement === "dispose") world.dispose();
      else {
        world.setDimension("nether");
        world.generate(0);
      }
    };
    assert.equal(
      world.loadEdits(saved),
      true,
      "published reload is not a retryable failure"
    );
    assert.equal(
      events.filter((event) => event.dimension === "overworld").length,
      1
    );
    assert.equal(world.chunks.size, replacement === "dispose" ? 0 : 1);
    assert.equal(
      generated.length,
      generationCount + Number(replacement === "dimension")
    );
    if (replacement === "dimension") {
      assert.equal(world.dimension, "nether");
      assert.equal(events.length, 2);
      assert.equal(world.chunks.get("0,0"), events[1].chunk);
      assert.equal(events[1].epoch, world.epoch);
    }
    assert.deepEqual(world.admissionObserverErrors, []);
  });
}

test("observer diagnostics retain only bounded identity records and false is not a veto", (t) => {
  const { world } = admissionWorld(t);
  world.onChunkAdmitted = (event) => {
    throw `observer-${event.incarnation}`;
  };
  for (let i = 0; i < 20; i++) {
    const previous = world.chunks.get("0,0");
    if (previous) world._removeChunk("0,0", previous);
    assert.equal(world.generate(0), world);
  }
  const errors = world.admissionObserverErrors;
  assert.equal(errors.length, 16);
  assert.equal(errors[0].incarnation, 5);
  assert.equal(errors.at(-1).incarnation, 20);
  assert.equal(errors.at(-1).error, "observer-20");
  assert.ok(errors.every((entry) => Object.isFrozen(entry)));
  assert.ok(
    errors.every(
      (entry) =>
        !Object.hasOwn(entry, "chunk") && !Object.hasOwn(entry, "world")
    )
  );
  errors.length = 0;
  assert.equal(
    world.admissionObserverErrors.length,
    16,
    "diagnostic reads cannot erase history"
  );
  world.onChunkAdmitted = () => false;
  world._removeChunk("0,0", world.chunks.get("0,0"));
  world.generate(0);
  assert.equal(world.chunks.get("0,0").incarnation, 21);
  assert.equal(world.admissionObserverErrors.length, 16);
  assert.equal(world.admissionObserverErrors.at(-1).incarnation, 20);
});

test("invalid async/generator observers are reported without invoking their bodies", (t) => {
  let invoked = 0;
  for (const onChunkAdmitted of [
    async () => {
      invoked++;
    },
    function* () {
      invoked++;
      yield true;
    },
    {},
  ]) {
    const { world } = admissionWorld(t, { onChunkAdmitted });
    world.generate(0);
    assert.equal(world.chunks.size, 1);
    assert.equal(world.admissionObserverErrors.length, 1);
    assert.ok(world.admissionObserverErrors[0].error instanceof TypeError);
  }
  assert.equal(invoked, 0);
});

test("returned promises/thenables report observation failure without rejecting admission", async (t) => {
  const { world } = admissionWorld(t);
  const failure = new Error("invalid asynchronous observation");
  world.onChunkAdmitted = () => Promise.reject(failure);
  world.generate(0);
  await Promise.resolve();
  assert.equal(world.chunks.size, 1);
  assert.equal(world.admissionObserverErrors.length, 1);
  assert.ok(world.admissionObserverErrors[0].error instanceof TypeError);
  let invoked = false;
  world.onChunkAdmitted = () => ({
    then() {
      invoked = true;
    },
  });
  world._removeChunk("0,0", world.chunks.get("0,0"));
  world.generate(0);
  assert.equal(
    invoked,
    false,
    "observers cannot turn admission into awaited work"
  );
  assert.equal(world.admissionObserverErrors.length, 2);
  assert.equal(world.chunks.size, 1);
});

test("generation failures never emit a post-admission event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { world } = admissionWorld(t);
  let notified = 0;
  world.onChunkAdmitted = () => {
    notified++;
  };
  const failure = new Error("fixture generation failed");
  world.generator.generateChunk = () => {
    throw failure;
  };
  assert.throws(
    () => world.generate(0),
    (error) => error === failure
  );
  const loading = world.ensureArea({ x: 0, z: 0 }, 0);
  const rejected = assert.rejects(loading, (error) => error === failure);
  drainAdmissions(t, world);
  await rejected;
  assert.equal(notified, 0);
  assert.equal(world.chunks.size, 0);
  assert.deepEqual(world.admissionObserverErrors, []);
});
