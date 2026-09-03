import assert from "node:assert/strict";
import test from "node:test";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { ITEM } from "../src/items.js";
import {
  authoredPrepareWorld,
  disposeFluidStage,
  fluidLifecycleHost,
  LIFECYCLE_POSE,
  LIFECYCLE_SEED,
} from "./game-fluid-lifecycle-fixture.js";

// Real Game orchestration and owners, authored terrain, no GPU or natural-play claim.
test("Game stages projectile ownership and archives it without binding or changing the live world", async (t) => {
  const f = fluidLifecycleHost(t, { generatorVersion: 3 });
  const worlds = authoredPrepareWorld(t);
  const live = f.snapshot();
  const bytes = f.coordinator.budget.totalBytes;
  const saved = {
    version: 3,
    world: {
      version: 3,
      seed: LIFECYCLE_SEED,
      generatorVersion: 3,
      dimension: "overworld",
      edits: [],
    },
    player: { ...LIFECYCLE_POSE, yaw: 0, pitch: 0, flying: false },
  };
  const staged = await f.game.prepareWorld(saved.world.seed, saved);
  try {
    assert.equal(worlds.length, 1);
    const service = staged.projectileServices;
    assert.ok(service instanceof GameProjectileServices);
    assert.equal(service.active, false);
    assert.equal(service.game, null);
    assert.equal(service.projectiles.staged, true);
    assert.equal(service.renderer, null);
    assert.equal(service.world, staged.world);
    assert.equal(service.gameplay, staged.gameplay);
    assert.equal(service.coordinator, staged.world.coordinator);
    assert.equal(service.serialize().playerProjectiles.seed, saved.world.seed);
    assert.equal(staged.world.coordinator.usage(service), 0);
    assert.equal(staged.world.coordinator.usage(service.projectiles), 1024);
    assert.deepEqual(f.snapshot(), live);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
  } finally {
    disposeFluidStage(staged);
  }
  assert.equal(staged.world.coordinator.budget.totalBytes, 0);
});

test("late malformed projectile staging releases all candidate owners and leaves live ownership intact", async (t) => {
  const f = fluidLifecycleHost(t, { generatorVersion: 3 });
  const worlds = authoredPrepareWorld(t);
  const live = f.snapshot();
  const bytes = f.coordinator.budget.totalBytes;
  const saved = {
    version: 3,
    world: {
      version: 3,
      seed: LIFECYCLE_SEED,
      generatorVersion: 3,
      dimension: "overworld",
      edits: [],
    },
    player: { ...LIFECYCLE_POSE, yaw: 0, pitch: 0, flying: false },
    playerProjectiles: null,
  };
  await assert.rejects(
    () => f.game.prepareWorld(saved.world.seed, saved),
    /staged projectile services/
  );
  assert.equal(worlds.length, 1);
  assert.equal(worlds[0]._disposed, true);
  assert.equal(worlds[0].coordinator.budget.totalBytes, 0);
  assert.deepEqual(f.snapshot(), live);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
});

test("Game advances pearls once after physical movement, before survival, and renders before the draw", (t) => {
  const f = fluidLifecycleHost(t, { generatorVersion: 3 });
  const service = new GameProjectileServices({
    world: f.world,
    gameplay: f.gameplay,
    context: f.context,
  });
  try {
    assert.equal(service.activate(f.game).ok, true);
    assert.equal(
      f.gameplay.inventoryTransaction((owned) => {
        owned.slots[0] = { id: ITEM.ENDER_PEARL, count: 2 };
        return true;
      }),
      true
    );
    assert.equal(service.throw(), true);
    const order = [];
    const frames = [];
    for (const [owner, name, label] of [
      [f.player, "update", "player"],
      [service, "frame", "pearls"],
      [f.gameplay, "update", "survival"],
      [service, "render", "pearl-render"],
      [f.game.graphics, "render", "draw"],
    ]) {
      const original = owner[name];
      t.mock.method(owner, name, function (...args) {
        order.push(label);
        if (label === "pearls") frames.push({ dt: args[0], options: args[1] });
        return original.apply(this, args);
      });
    }
    f.frame(50);
    assert.deepEqual(order, [
      "player",
      "pearls",
      "survival",
      "pearl-render",
      "draw",
    ]);
    assert.deepEqual(frames, [{ dt: 0.05, options: { simulating: true } }]);
    assert.equal(service.projectiles.projectiles[0].age, 0.05);
    assert.equal(f.gameplay.getHandStack().count, 1);
    const saved = f.snapshot();
    assert.deepEqual(saved.playerProjectiles, service.projectiles.serialize());

    f.game.paused = true;
    f.player.enabled = false;
    order.length = 0;
    f.frame(1000);
    assert.deepEqual(order, ["pearls", "pearl-render", "draw"]);
    assert.deepEqual(frames.at(-1), {
      dt: 0.1,
      options: { simulating: false },
    });
    assert.deepEqual(service.projectiles.serialize(), saved.playerProjectiles);
    order.length = 0;
    f.game.building = true;
    f.frame(50);
    assert.deepEqual(order, []);
  } finally {
    service.dispose();
  }
});
