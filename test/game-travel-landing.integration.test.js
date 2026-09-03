import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { cellIndex } from "../src/chunk-data.js";
import { sampleFluid } from "../src/fluid-sampling.js";
import { GameTravel } from "../src/game-travel.js";
import {
  createTravelPreviewWorld,
  installTravelLanding,
  stageTravelDestination,
  travelLandingValid,
} from "../src/game-travel-stage.js";
import { World } from "../src/world.js";
import { findSafeLanding } from "../src/world-interactions.js";
import { buildingFixture } from "./building-fixture.js";
import { holdExplorationTool } from "./exploration-services-fixture.js";
import { nativeExplorationHost } from "./game-exploration-host-fixture.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

const destination = Object.freeze({ x: 8, y: 21, z: 8, dimension: "overworld" });
const wetLanding = Object.freeze({ x: 8.5, y: 21.01, z: 8.5 });

function landingFixture(t) {
  const f = buildingFixture(t);
  f.player.world = f.world;
  f.game.graphics.renderRadius = 0;
  f.put(2, 20, 3, BLOCK.AIR); // Remove the building fixture's unrelated footing.
  f.put(8, 20, 8, BLOCK.STONE);
  f.put(8, 21, 8, BLOCK.KELP);
  f.put(8, 22, 8, BLOCK.KELP);
  return f;
}

// Observe the actual guard/mutator without substituting reads or commit results.
function observePlatform(t, preview) {
  const reads = [];
  const read = preview.getCell;
  t.mock.method(preview, "getCell", function (x, y, z) {
    if (x >= 7 && x <= 9 && z >= 7 && z <= 9 && y >= 66 && y <= 68)
      reads.push([x, y, z]);
    return read.call(this, x, y, z);
  });
  return { reads, apply: t.mock.method(preview, "applyCells") };
}

test("travel staging prefers a later genuinely safe natural landing to a platform", async (t) => {
  const f = landingFixture(t);
  f.put(9, 20, 8, BLOCK.STONE);
  const before = f.snapshot(), position = f.player.position.clone();
  const epoch = f.world.epoch, revision = f.world._editRevision;
  assert.deepEqual(
    findSafeLanding(f.world, destination, { allowPlatform: false }),
    wetLanding
  );
  assert.equal(travelLandingValid(f.world, wetLanding), false);
  const stage = await stageTravelDestination(f.game, destination);
  t.after(() => stage.dispose());
  assert.notEqual(stage.world, f.world);
  assert.notEqual(stage.world.coordinator, f.coordinator);
  assert.equal(stage.world._generatorFactory, f.world._generatorFactory);
  assert.deepEqual(stage.position, {
    x: 9.5, y: 21.01, z: 8.5, dimension: "overworld",
  });
  assert.deepEqual(stage.changes, []);
  assert.equal(travelLandingValid(stage.world, stage.position), true);
  assert.equal(stage.current(), true);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.player.position.clone(), position);
  assert.equal(f.world.epoch, epoch);
  assert.equal(f.world._editRevision, revision);
});

test("no safe natural candidate reaches the allowed protected-platform proposal and live install", async (t) => {
  const f = landingFixture(t);
  const before = f.snapshot(), position = f.player.position.clone();
  let observation;
  const stage = await stageTravelDestination(f.game, destination, {
    worldFactory(source, dimension) {
      const preview = createTravelPreviewWorld(source, dimension);
      observation = observePlatform(t, preview);
      return preview;
    },
  });
  t.after(() => stage.dispose());
  assert.deepEqual(stage.position, {
    x: 8.5, y: 67.01, z: 8.5, dimension: "overworld",
  });
  assert.equal(stage.changes.length, 9);
  assert.ok(stage.changes.every(({ x, y, z, before, after }) =>
    x >= 7 && x <= 9 && z >= 7 && z <= 9 && y === 66 &&
    before.id === BLOCK.AIR && after.id === BLOCK.OBSIDIAN &&
    after.state === 0 && after.fluid === FLUID.NONE
  ));
  assert.equal(observation.apply.mock.callCount(), 1);
  assert.ok(observation.reads.some(([x, y, z]) => x === 9 && y === 68 && z === 9));
  assert.equal(travelLandingValid(stage.world, stage.position), true);
  assert.equal(sampleFluid(stage.world, stage.position).waterImmersion, 0);
  assert.deepEqual(f.snapshot(), before, "only the detached preview may change");
  assert.deepEqual(f.player.position.clone(), position);
  assert.equal(f.world.get(8, 66, 8), BLOCK.AIR);
  assert.equal(installTravelLanding(f.world, stage), true);
  for (const { x, y, z, after } of stage.changes)
    assert.deepEqual(f.world.getCell(x, y, z), after);
  assert.equal(travelLandingValid(f.world, stage.position), true);
  assert.deepEqual(f.world.getCell(8, 21, 8), normalizeCell({ id: BLOCK.KELP }));
  assert.deepEqual(f.gameplay.serialize(), before.gameplay);
});

for (const id of [BLOCK.CHEST, BLOCK.TURTLE_EGG, BLOCK.KELP]) {
  test(`protected platform cell ${id} refuses after the natural search without partial writes`, async (t) => {
    const f = landingFixture(t);
    f.put(9, 68, 9, id); // Last of the 27 guard reads, after nine proposed changes.
    f.put(9, 69, 9, BLOCK.WATER);
    f.put(9, 70, 9, BLOCK.WATER); // A chest must not offer an alternative dry roof.
    const before = f.snapshot(), position = f.player.position.clone();
    const epoch = f.world.epoch, revision = f.world._editRevision;
    let preview, observation;
    await assert.rejects(stageTravelDestination(f.game, destination, {
      worldFactory(source, dimension) {
        preview = createTravelPreviewWorld(source, dimension);
        observation = observePlatform(t, preview);
        return preview;
      },
    }), /No safe destination was found/);
    assert.equal(observation.reads.length, 27, "the protected fallback is actually attempted");
    assert.deepEqual(observation.reads.at(-1), [9, 68, 9]);
    assert.equal(observation.apply.mock.callCount(), 0);
    assert.equal(preview._disposed, true);
    assert.equal(preview.coordinator.budget.totalBytes, 0);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(f.player.position.clone(), position);
    assert.equal(f.world.epoch, epoch);
    assert.equal(f.world._editRevision, revision);
    assert.deepEqual(f.world.getCell(9, 68, 9), normalizeCell({ id }));
  });
}

// A separate authored destination for the refusal case only. The existing
// native shipwreck -> fortress -> original shipwreck regression stays unchanged.
function blockedPreview(source, dimension) {
  return new World(source.seed, {
    dimension, generatorVersion: source.generatorVersion, useWorker: false,
    generatorFactory(seed, atDimension, version) {
      const generator = emptyFixtureGenerator(seed, atDimension, version);
      return {
        ...generator,
        generateChunk(cx, cz) {
          const chunk = generator.generateChunk(cx, cz);
          for (const [x, y, z, id] of [
            [8, 20, 8, BLOCK.STONE],
            [8, 21, 8, BLOCK.KELP],
            [8, 22, 8, BLOCK.KELP],
            [9, 68, 9, BLOCK.TURTLE_EGG],
          ]) {
            if (Math.floor(x / 16) === cx && Math.floor(z / 16) === cz)
              chunk.blocks[cellIndex(x, y, z, chunk)] = id;
          }
          return chunk;
        },
      };
    },
  });
}

test("a protected return landing leaves the real native Nether source, claims and exact slots unchanged", async (t) => {
  const f = await nativeExplorationHost(t, { kind: "nether_fortress" });
  const entry = f.entries()[0], service = f.service, ledger = service.exploration;
  assert.ok(entry);
  assert.equal(f.world.dimension, "nether");
  assert.equal(f.game.inventoryActions.openStation(f.hit(entry.marker)), true);
  holdExplorationTool(f);
  const claim = structuredClone(ledger.container(entry.marker));
  const slots = structuredClone(
    f.settlement.inspectContainer(f.world, f.hit(entry.marker)).slots
  );
  assert.ok(claim);
  assert.ok(slots.some(Boolean), "preserve real initialized native loot, not empty fixtures");
  const before = structuredClone(f.snapshot()), ownership = structuredClone(f.ownership());
  const position = f.player.position.clone(), velocity = f.player.velocity.clone();
  const epoch = f.world.epoch, revision = f.world._editRevision;
  const chunks = new Map(f.world.chunks), factory = f.world._generatorFactory;
  const wildlife = f.game.wildlife;
  const changeDimension = t.mock.method(f.world, "setDimension");
  const liveAdmission = t.mock.method(f.world, "ensureArea");
  const sourceCommit = t.mock.method(f.coordinator, "commit");
  let preview, observation;
  f.game.travel = new GameTravel(f.game, {
    worldFactory(source, dimension) {
      assert.equal(source, f.world);
      assert.equal(dimension, "overworld");
      preview = blockedPreview(source, dimension);
      observation = observePlatform(t, preview);
      return preview;
    },
  });
  const result = await f.game.teleport(destination);
  assert.equal(result.ok, false);
  assert.match(result.message, /No safe destination was found/);
  assert.equal(result.rollbackFailed, undefined);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(observation.reads.length, 27);
  assert.deepEqual(observation.reads.at(-1), [9, 68, 9]);
  assert.equal(observation.apply.mock.callCount(), 0);
  assert.equal(preview._disposed, true);
  assert.equal(preview.coordinator.budget.totalBytes, 0);
  assert.equal(changeDimension.mock.callCount(), 0, "no departure or recovery");
  assert.equal(liveAdmission.mock.callCount(), 0);
  assert.equal(sourceCommit.mock.callCount(), 0);
  assert.equal(f.game.world, f.world);
  assert.equal(f.player.world, f.world);
  assert.equal(f.world.dimension, "nether");
  assert.equal(f.world.epoch, epoch);
  assert.equal(f.world._editRevision, revision);
  assert.equal(f.world._generatorFactory, factory);
  assert.deepEqual(f.world.chunks, chunks);
  assert.equal(f.game.wildlife, wildlife);
  assert.equal(f.game.explorationServices, service);
  assert.equal(f.game.exploration, ledger);
  assert.deepEqual(ledger.container(entry.marker), claim);
  assert.deepEqual(f.settlement.inspectContainer(f.world, f.hit(entry.marker)).slots, slots);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(f.ownership(), ownership);
  assert.deepEqual(f.player.position.clone(), position);
  assert.deepEqual(f.player.velocity.clone(), velocity);
  assert.equal(f.game.building, false);
  assert.equal(f.game.transitionGate.busy, false);
  assert.equal(f.calls.archives.length, 0);
});
