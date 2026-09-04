import assert from "node:assert/strict";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";

// Authored terrain, but real World admission, native COW section planes,
// TransactionCoordinator commits, revision increments and mutation events.
export function churnWorld(version = 4, torch = true, dimension = "overworld", loadRadius = 2) {
  let mutations = 0, lastEvent, observer;
  const generatorFactory = (_seed, dimension, generatorVersion) => {
    const spec = getWorldSpec(generatorVersion, dimension);
    return {
      getSpawn: () => ({ x: 17, y: 8, z: 2 }),
      generateChunk(cx, cz) {
        const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
        for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
          const wz = cz * 16 + z;
          if (wz < 0 || wz > 4) continue;
          for (let y = 7; y <= 11; y++)
            if (y === 7 || y === 11 || wz === 0 || wz === 4)
              blocks[(y - spec.minY) * 256 + z * 16 + x] = BLOCK.STONE;
        }
        return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks, biomes: new Uint8Array(256) };
      },
    };
  };
  const world = new World("block-light-churn", { dimension, generatorVersion: version, useWorker: false, generatorFactory,
    onMutation(event) { mutations++; lastEvent = event; observer?.(world, event); } });
  world.generate(loadRadius);
  assert.equal(world.set(15, 8, 1, BLOCK.WATER), true);
  assert.equal(world.set(14, 8, 3, BLOCK.OAK_LOG), true);
  if (torch) assert.equal(world.set(13, 8, 2, BLOCK.TORCH), true);
  const change = (x, y, z, after) => ({ x, y, z, before: world.getCell(x, y, z), after });
  return {
    world,
    position: { x: 8, y: 9.62, z: 2.5 },
    points: [{ x: 14.5, y: 8.02, z: 2.5 }, { x: 16.5, y: 8.02, z: 2.5 }, { x: 15.98, y: 8.02, z: 2.5 }],
    mutate(frame, kind = "both") {
      const changes = [];
      if (kind !== "state") changes.push(change(15, 8, 1,
        { id: BLOCK.WATER, state: 0, fluid: frame % 2 ? FLUID.WATER_2 : FLUID.WATER_3 }));
      if (kind !== "fluid") changes.push(change(14, 8, 3,
        { id: BLOCK.OAK_LOG, state: frame % 2 ? BLOCK_STATE.AXIS_X : BLOCK_STATE.AXIS_Z, fluid: FLUID.NONE }));
      assert.equal(world.applyCells(changes), true);
    },
    metrics: () => ({ mutations, revision: lastEvent?.revision,
      sectionRevision: world.chunks.get("0,0").sectionRevisions.get(0) }),
    // Explicit fixture wiring for the proposed canonical host dispatch.
    // Does not replace World.onMutation or install production subscriptions.
    observe: (callback) => { observer = callback; },
    lastEvent: () => lastEvent,
    dispose: () => world.dispose(),
  };
}
