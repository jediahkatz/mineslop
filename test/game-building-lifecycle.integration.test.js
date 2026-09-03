import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { servicesFixture } from "./game-building-services-fixture.js";

const worldData = () => ({
  version: 3,
  seed: "building-lifecycle",
  generatorVersion: 3,
  dimension: "overworld",
  edits: [],
});

test("component preflight migrates legacy time and rejects malformed present building sidecars", () => {
  const saved = { version: 3, world: worldData(), time: 0.85 };
  const before = structuredClone(saved);
  const result = normalizeWorldComponents(saved);
  assert.deepEqual(result.beds, { version: 1, spawn: null });
  assert.deepEqual(result.worldClock, { version: 1, day: 0, time: 0.85 });
  assert.deepEqual(saved, before);
  const authoritative = normalizeWorldComponents({
    ...saved,
    worldClock: { version: 1, day: 7, time: 0.25 },
  });
  assert.equal(authoritative.time, 0.25);
  assert.equal(authoritative.worldClock.day, 7);
  for (const invalid of [
    { beds: null },
    { beds: { version: 99, spawn: null } },
    { worldClock: null },
    { worldClock: { version: 1, day: -1, time: 0.25 } },
  ])
    assert.throws(
      () => normalizeWorldComponents({ ...saved, ...invalid }),
      /bed or calendar/
    );
});

test("Game forwards initial residents and later world publications to the active building service", (t) => {
  const f = servicesFixture(t);
  const admissions = [];
  const mutations = [];
  const admitted = f.services.onChunkLoaded.bind(f.services);
  const mutated = f.services.onMutation.bind(f.services);
  t.mock.method(f.services, "onChunkLoaded", (world, event) => {
    admissions.push({ world, event });
    return admitted(world, event);
  });
  t.mock.method(f.services, "onMutation", (world, event) => {
    mutations.push({ world, event });
    assert.equal(
      world.get(event.changes[0].x, event.changes[0].y, event.changes[0].z),
      event.changes[0].after.id,
      "publication precedes notification"
    );
    return mutated(world, event);
  });
  VoxelGame.prototype.bindWorldServiceEvents.call(f.game);
  assert.equal(admissions.length, f.world.chunks.size);
  assert.ok(
    admissions.every(
      ({ world, event }) =>
        world === f.world &&
        event.epoch === world.epoch &&
        event.incarnation ===
          world.chunks.get(`${event.cx},${event.cz}`).incarnation
    )
  );
  f.world.generate(1);
  assert.equal(admissions.length, f.world.chunks.size);
  f.put(3, f.y, 3, BLOCK.STONE);
  assert.equal(mutations.length, 1);
  const admissionCallback = f.world.onChunkAdmitted;
  const mutationCallback = f.world.onMutation;
  f.game.world = {};
  admissionCallback(admissions[0].event);
  mutationCallback(mutations[0].event);
  assert.equal(admissions.length, f.world.chunks.size);
  assert.equal(
    mutations.length,
    1,
    "a retired world cannot drive the replacement game"
  );
  f.game.world = f.world;
});

test("archive snapshot, portable export and preflight preserve the real bed identity and calendar", (t) => {
  const f = servicesFixture(t, {
    saved: { worldClock: { version: 1, day: 7, time: 0.5 } },
  });
  const bed = f.placeBed();
  assert.equal(f.services.buildingActions.tryUse(bed.foot).ok, true);
  const expected = f.services.serialize();
  assert.ok(expected.beds.spawn);
  // Unrelated optional serialized owners are absent in this targeted archive
  // fixture; real World/Gameplay/overflow/building state is retained.
  const absent = { serialize: () => undefined };
  Object.assign(f.game, {
    pickups: absent,
    fuses: absent,
    settlement: absent,
    mobStates: {},
    quality: "low",
    soundEnabled: false,
  });
  f.game.wildlife.serialize = () => undefined;
  Object.assign(f.player, { yaw: 0, pitch: 0, flying: false });
  f.game.currentTime = 0.01;
  const snapshot = new GameArchive(f.game, {}).snapshot();
  assert.equal(
    snapshot.time,
    expected.worldClock.time,
    "the service owns legacy time projection"
  );
  const normalized = normalizeWorldComponents(
    parseWorldFile(exportWorldFile(snapshot))
  );
  assert.deepEqual(normalized.beds, expected.beds);
  assert.deepEqual(normalized.worldClock, expected.worldClock);
  const restored = new GameBuildingServices({
    world: f.world,
    gameplay: f.gameplay,
    context: f.context,
    saved: normalized,
  });
  t.after(() => restored.dispose());
  assert.deepEqual(restored.beds.getRespawn(), f.services.beds.getRespawn());
  assert.deepEqual(restored.worldClock.serialize(), expected.worldClock);
});

test("Game stages calendar ownership before any live-world teardown", async (t) => {
  const game = Object.create(VoxelGame.prototype);
  const originalGameplay = { mode: "survival" };
  Object.assign(game, {
    gameplay: originalGameplay,
    quality: "low",
    ui: { setLoading() {} },
  });
  const saved = {
    version: 3,
    world: worldData(),
    beds: { version: 1, spawn: null },
    worldClock: { version: 1, day: 9, time: 0.77 },
  };
  const staged = await game.prepareWorld(saved.world.seed, saved);
  t.after(() => {
    staged.fluidServices.dispose();
    staged.buildingServices.dispose();
    for (const name of ["gameplay", "settlement", "overflow", "fuses", "world"])
      staged[name].dispose();
  });
  assert.equal(game.gameplay, originalGameplay);
  assert.equal(game.buildingServices, undefined);
  assert.equal(staged.buildingServices.active, false);
  assert.equal(staged.settlement._world, staged.world);
  assert.deepEqual(
    staged.buildingServices.worldClock.serialize(),
    saved.worldClock
  );
  assert.equal(staged.buildingServices.coordinator, staged.world.coordinator);
  let closed = false;
  game.closeScreens = () => {
    closed = true;
  };
  await assert.rejects(
    () => game.initialize(saved.world.seed, { ...saved, beds: null }),
    /bed or calendar/
  );
  assert.equal(
    closed,
    false,
    "malformed sidecars reject before touching live screens/owners"
  );
  assert.equal(game.gameplay, originalGameplay);
});
