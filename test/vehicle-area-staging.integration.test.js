import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { GameArchive } from "../src/game-archive.js";
import { WorldStorage } from "../src/storage.js";
import { getWorldSpec } from "../src/world-spec.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

const START = { x: 8.5, y: 9.08, z: 12.5 };
const FOOTPRINTS = [
  { x: 8.5, z: 15.5, radius: 1 },
  { x: 8.5, z: 40.5, radius: 1 },
];

// Authored flat ocean and starting boat/rod stock: owner/staging/storage proof,
// not native distribution, resource acquisition, rendering or fishing-loot proof.
function ocean(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  let chunkGenerations = 0;
  return {
    seed, dimension, generatorVersion, spec,
    getSpawn: () => ({ ...START }),
    getBiome: () => getBiomeById("ocean"),
    get counters() { return { chunkGenerations }; },
    generateChunk(cx, cz) {
      chunkGenerations++;
      const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
      blocks.fill(BLOCK.STONE, 0, (4 - spec.minY) * 256);
      blocks.fill(BLOCK.WATER, (4 - spec.minY) * 256, (9 - spec.minY) * 256);
      return {
        cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
        biomes: new Uint8Array(256).fill(BIOMES.findIndex(({ id }) => id === "ocean")),
      };
    },
  };
}

test("stored rider and a real cast two columns apart reload through production batch staging without losing either footprint", async (t) => {
  const source = await gameMobFixture(t, {
    seed: "rider-cast-admission", generatorVersion: 4,
    generatorFactory: ocean, spawnPosition: START,
  });
  source.hold("OAK_BOAT", { data: { version: 1, name: "Boundary boat" } });
  source.aim({ x: 8.5, y: 9, z: 15.5 }, 0);
  const placed = source.vehicles.useHand();
  assert.equal(placed?.ok, true, placed?.reason);
  assert.equal(source.gameplay.getHandStack(), null, "real placement consumes the boat item");
  const boat = source.vehicles.boats.getBoat(placed.id);
  source.aim({ x: boat.x, y: boat.y + 0.3, z: boat.z }, 0);
  const hit = source.vehicles.raycast();
  assert.equal(hit?.type, "boat");
  assert.equal(source.vehicles.interact(hit).ok, true);
  source.withGlobals(() => source.game.applyVehiclePose());
  assert.equal(source.player.seated, true);
  assert.equal(Math.floor(source.player.position.z / 16), 0);

  // One fixed play rectangle, declared before the single cast. No moved bobber,
  // rewritten timer/RNG, second launch, or favorable alternative landing.
  await source.world.ensureAreas(FOOTPRINTS);
  source.hold("FISHING_ROD", {
    hand: "offhand", data: {
      version: 1, name: "Boundary line", enchantments: { luck_of_the_sea: 2 },
    },
  });
  source.aim({ x: 8.5, y: 23, z: 38.5 }, 0);
  const cast = source.vehicles.useHand("offhand");
  assert.equal(cast?.ok, true, cast?.reason);
  assert.equal(cast.action, "cast");
  const phases = new Set();
  for (let step = 0; step < 100; step++) {
    const current = source.vehicles.fishing.getCast();
    assert.ok(current, "the single paid owner's cast must stay live");
    phases.add(current.phase);
    if (current.phase !== "flying") break;
    assert.equal(source.vehicles.frame(0.05).ok, true);
    source.withGlobals(() => source.game.applyVehiclePose());
  }
  const floating = source.vehicles.fishing.getCast();
  assert.equal(floating.phase, "waiting");
  assert.deepEqual([...phases], ["flying", "waiting"]);
  assert.equal(Math.floor(floating.z / 16), 2);
  assert.equal(Math.floor(source.player.position.z / 16), 0);
  assert.equal(source.world.generator.counters.chunkGenerations, 15);
  assert.equal(source.world.chunks.size, 15);
  source.game.paused = true;

  const indexedDB = new IDBFactory(), name = "rider-cast-union";
  const writer = new WorldStorage({ indexedDB, name });
  t.after(() => writer.close());
  const archive = new GameArchive(source.game, writer);
  const before = archive.snapshot();
  assert.equal((await archive.save()).ok, true);
  writer.close();
  const reader = new WorldStorage({ indexedDB, name });
  t.after(() => reader.close());
  const saved = await reader.load();
  assert.deepEqual(saved, before, "a new storage client reads every saved owner byte");

  const restored = await gameMobFixture(t, {
    saved, generatorFactory: ocean, activate: false,
  });
  assert.notEqual(restored.world, source.world);
  assert.notEqual(restored.coordinator, source.coordinator);
  assert.equal(restored.world.generator.counters.chunkGenerations, 15);
  assert.equal(restored.world.chunks.size, 15);
  assert.equal(restored.world.removedChunks.size, 0);
  assert.equal(restored.world._pins.size, 0);
  const expected = [];
  for (let cz = -1; cz <= 3; cz++)
    for (let cx = -1; cx <= 1; cx++) expected.push(`${cx},${cz}`);
  assert.deepEqual([...restored.world.chunks.keys()].sort(), expected.sort());
  assert.equal(restored.vehicles.fishing.needsBinding(), true);
  assert.deepEqual(restored.vehicles.serialize().boats, saved.boats);
  assert.deepEqual(restored.vehicles.serialize().fishing, saved.fishing);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  restored.activate();
  assert.equal(restored.player.seated, true);
  assert.equal(restored.player.vehicleType, "boat");
  assert.equal(restored.vehicles.riderPose().id, placed.id);
  assert.deepEqual(point(restored.player.position), point(saved.player));
  assert.equal(restored.vehicles.fishing.needsBinding(), false);
  const rebound = restored.vehicles.fishing.getCast();
  assert.deepEqual(rebound, {
    ...saved.fishing.casts[0],
    handRevision: restored.gameplay.getHandRevision("offhand"),
  }, "only the documented process-local hand revision changes during binding");
  assert.equal(restored.vehicles.frame(0.05).ok, true);
  assert.equal(restored.vehicles.fishing.getCast().remaining, rebound.remaining - 1);
  assert.equal(restored.vehicles.fishing.getCast().randomState, rebound.randomState);
  assert.equal(restored.world.generator.counters.chunkGenerations, 15);
  assert.deepEqual(archive.snapshot(), before, "cold staging never mutates the live source");
  t.diagnostic(JSON.stringify({
    admission: "stored-rider-and-cast", terrain: "authored", phases: [...phases],
    riderColumn: [0, 0], castColumn: [0, 2], generated: 15, resident: 15,
    removed: restored.world.removedChunks.size, remainingPins: restored.world._pins.size,
    storageReopened: true, riderBound: restored.player.seated,
    castBound: !restored.vehicles.fishing.needsBinding(),
  }));

  // Batch admission is not permission to accept a genuinely obstructed rider.
  const blocked = structuredClone(saved);
  blocked.world.edits.push([
    "overworld", Math.floor(saved.player.x), Math.floor(saved.player.y + 1),
    Math.floor(saved.player.z), BLOCK.STONE, 0, 0,
  ]);
  await reader.save(blocked);
  reader.close();
  const blockedReader = new WorldStorage({ indexedDB, name });
  t.after(() => blockedReader.close());
  const blockedSave = await blockedReader.load();
  await assert.rejects(gameMobFixture(t, {
    saved: blockedSave, generatorFactory: ocean, activate: false,
  }), /Invalid saved vehicle pose: rider-obstructed/);
  assert.deepEqual(await blockedReader.load(), blocked, "refused staging does not rewrite storage");
});
