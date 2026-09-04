import test from "node:test";
import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { GameGravityServices } from "../src/game-gravity-services.js";
import { CROP_GROW_SECONDS } from "../src/settlement.js";
import { fluidServicesFixture } from "./game-fluid-services-fixture.js";

function setup(t, options = {}) {
  const f = fluidServicesFixture(t, { base: BLOCK.AIR, ...options });
  const service = new GameGravityServices({
    world: f.world, isOccupied: () => false,
  });
  assert.equal(service.activate(f.game).ok, true);
  const notify = f.world.onMutation;
  f.world.onMutation = (event) => {
    notify(event);
    service.onMutation(f.world, event);
  };
  t.after(() => service.dispose());
  return { ...f, gravityService: service };
}
const steps = (service, count = 20) => {
  for (let i = 0; i < count; i++) service.frame(0.1);
};

test("gravity host uses real fluid plant retention and leaves inventory untouched", (t) => {
  const f = setup(t);
  const inventory = f.gameplay.serialize();
  f.put(3, 1, 3, BLOCK.RED_FLOWER);
  f.put(3, 2, 3, BLOCK.SAND);
  steps(f.gravityService);
  assert.equal(f.world.get(3, 1, 3), BLOCK.SAND);
  assert.equal(f.overflow.size, 1);
  const [drop] = f.overflow.serialize().entries;
  assert.equal(drop.id, BLOCK.RED_FLOWER);
  assert.equal(drop.count, 1);
  assert.deepEqual([drop.x, drop.y, drop.z], [3, 1, 3]);
  assert.deepEqual(f.gameplay.serialize(), inventory);
  steps(f.gravityService);
  assert.equal(f.overflow.size, 1);
});

test("gravity joins tracked crop removal and retained yield in the same transaction", (t) => {
  const f = setup(t, {
    initial: [[3, 0, 3, BLOCK.FARMLAND], [3, 1, 3, BLOCK.WHEAT_CROP]],
    crops: [{ dimension: "overworld", x: 3, y: 1, z: 3, age: CROP_GROW_SECONDS }],
  });
  f.put(3, 2, 3, BLOCK.GRAVEL);
  steps(f.gravityService);
  assert.equal(f.world.get(3, 1, 3), BLOCK.GRAVEL);
  assert.equal(f.settlement.serialize().crops.length, 0);
  assert.ok(f.overflow.size > 0);
  const drops = f.overflow.serialize();
  steps(f.gravityService);
  assert.deepEqual(f.overflow.serialize(), drops);
});

test("full real retention owner refuses without destroying a plant or falling block", (t) => {
  const f = setup(t, { maxEntries: 1 });
  f.put(3, 1, 3, BLOCK.RED_FLOWER);
  f.put(3, 2, 3, BLOCK.SAND);
  steps(f.gravityService);
  f.put(4, 1, 3, BLOCK.YELLOW_FLOWER);
  f.put(4, 2, 3, BLOCK.GRAVEL);
  steps(f.gravityService);
  assert.equal(f.world.get(4, 1, 3), BLOCK.YELLOW_FLOWER);
  assert.equal(f.world.get(4, 2, 3), BLOCK.GRAVEL);
  assert.equal(f.overflow.size, 1);
});

test("host handles admission and rejects stale events, pause, death and replacement", (t) => {
  const f = setup(t, { initial: [[3, 3, 3, BLOCK.SAND]] });
  const admission = f.admission();
  assert.equal(f.gravityService.onChunkLoaded(f.world, admission), true);
  assert.equal(f.gravityService.onChunkLoaded(f.world, {
    ...admission, incarnation: admission.incarnation + 1,
  }), false);
  f.game.paused = true;
  steps(f.gravityService, 100);
  assert.equal(f.world.get(3, 3, 3), BLOCK.SAND);
  f.game.paused = false;
  f.game.gameplay.dead = true;
  steps(f.gravityService, 100);
  assert.equal(f.world.get(3, 3, 3), BLOCK.SAND);
  f.game.gameplay.dead = false;
  steps(f.gravityService, 100);
  assert.equal(f.world.get(3, 1, 3), BLOCK.SAND);
  f.game.gravityServices = {};
  assert.equal(f.gravityService.frame(0.1).ok, false);
  assert.equal(f.gravityService.onChunkLoaded(f.world, admission), false);
  f.gravityService.dispose();
  assert.equal(f.world.coordinator.usage(f.gravityService.gravity), undefined);
});
