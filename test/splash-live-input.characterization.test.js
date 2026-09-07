import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { ITEM } from "../src/items.js";
import { potionStack } from "./brewing-fixture.js";
import {
  gameMobFixture,
  gameMobGenerator,
} from "./game-mob-integration-fixture.js";

function holdSplash(f, id = "harming") {
  const stack = potionStack(f.progression.services.catalog, id, { form: "splash" });
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[f.gameplay.selected] = stack;
    owned.offhand = null;
    return true;
  }), true);
  return stack;
}

function setHands(f, main, offhand) {
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[f.gameplay.selected] = main;
    owned.offhand = offhand;
    return true;
  }), true);
}

function recordRoute(t, f) {
  const route = [];
  for (const [owner, method, label] of [
    [f.game, "beginUse", "VoxelGame.beginUse"],
    [f.game.useActions, "perform", "GameUseActions.perform"],
    [f.game.mobActions, "interact", "GameMobActions.interact"],
    [f.vehicles, "interactHorse", "GameVehicleServices.interactHorse"],
    [f.progression, "throwPotion", "GameProgressionIntegration.throwPotion"],
  ]) {
    const original = owner[method];
    t.mock.method(owner, method, function (...args) {
      route.push(label);
      return Reflect.apply(original, this, args);
    });
  }
  return route;
}

function useKey(f) {
  f.key("KeyV");
  f.key("KeyV", false);
}

function beachGenerator(seed, dimension, generatorVersion) {
  const source = gameMobGenerator(seed, dimension, generatorVersion);
  if (dimension !== "overworld") return source;
  return {
    ...source,
    getBiome: () => getBiomeById("beach"),
    generateChunk(cx, cz) {
      const chunk = source.generateChunk(cx, cz);
      chunk.biomes.fill(BIOMES.findIndex((entry) => entry.id === "beach"));
      return chunk;
    },
  };
}

test("live splash input reaches canonical physical mob owners", async (t) => {
  await t.test("empty offhand does not mount a targeted horse before main-hand splash use", async (t) => {
    const f = await gameMobFixture(t);
    const horse = f.spawn("characterization:horse");
    holdSplash(f);
    const route = recordRoute(t, f);
    useKey(f);
    assert.deepEqual(route, [
      "VoxelGame.beginUse",
      "GameUseActions.perform",
      "GameProgressionIntegration.throwPotion",
    ]);
    assert.equal(f.horses.mountFor(), null);
    assert.equal(f.progression.services.potions.size, 1);
    assert.equal(f.gameplay.getHandStack("main"), null);
    f.frame(40);
    assert.ok(horse.health < 24);
  });

  await t.test("legacy physical mob receives the thrown impact", async (t) => {
    const f = await gameMobFixture(t);
    const cow = f.wildlife.spawn("cow", { x: 8.5, y: 65, z: 9.5 }, {
      id: "characterization:cow",
    });
    assert.ok(cow);
    f.player.pitch = -Math.PI / 9;
    f.player._syncCamera(0);
    holdSplash(f);
    const route = recordRoute(t, f);
    const health = cow.health;
    useKey(f);
    assert.deepEqual(route, [
      "VoxelGame.beginUse",
      "GameUseActions.perform",
      "GameProgressionIntegration.throwPotion",
    ]);
    assert.equal(f.progression.services.potions.size, 1);
    f.frame(40);
    const savedMob = f.snapshot().mobs.entities.find(({ id }) => id === cow.id);
    assert.ok(cow.health < health);
    assert.equal(f.progression.services.potions.size, 0);
    assert.equal(Object.hasOwn(savedMob, "statusEffects"), false);
  });

  await t.test("ecology-owned physical mob receives the thrown impact", async (t) => {
    const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
    const plan = f.ecology.prepareAdmission("turtle", { x: 8.5, y: 65, z: 8.5 });
    assert.ok(plan);
    assert.equal(f.ecology.commit(plan).ok, true);
    const turtle = f.wildlife.byId.get(plan.result.id);
    assert.ok(turtle);
    f.aim(turtle);
    holdSplash(f);
    const route = recordRoute(t, f);
    useKey(f);
    assert.deepEqual(route, [
      "VoxelGame.beginUse",
      "GameUseActions.perform",
      "GameProgressionIntegration.throwPotion",
    ]);
    assert.equal(f.progression.services.potions.size, 1);
    assert.equal(f.gameplay.getHandStack("main"), null);
    f.frame(40);
    assert.ok(turtle.health < 30);
  });

  await t.test("a refused seventeenth throw consumes the horse gesture without mounting", async (t) => {
    const f = await gameMobFixture(t);
    const horse = f.spawn("acceptance:full-flight-horse");
    for (let index = 0; index < 16; index++) {
      holdSplash(f);
      assert.equal(f.progression.throwPotion("main").ok, true);
    }
    assert.equal(f.progression.services.potions.size, 16);
    const retained = holdSplash(f);
    f.game.mobTarget = horse;
    useKey(f);
    assert.equal(f.progression.services.potions.size, 16);
    assert.deepEqual(f.gameplay.getHandStack("main"), retained);
    assert.equal(f.horses.mountFor(), null);
  });

  await t.test("main horse food precedes an offhand splash", async (t) => {
    const f = await gameMobFixture(t);
    const horse = f.spawn("acceptance:food-before-offhand-splash");
    const splash = potionStack(f.progression.services.catalog, "harming", { form: "splash" });
    setHands(f, { id: ITEM.WHEAT, count: 2 }, splash);
    useKey(f);
    assert.equal(f.progression.services.potions.size, 0);
    assert.equal(f.gameplay.getHandStack("main").count, 1);
    assert.deepEqual(f.gameplay.getHandStack("offhand"), splash);
    assert.equal(f.horses.state(horse.id).temper, 3);
  });

  await t.test("main horse saddle intent precedes an offhand splash", async (t) => {
    const f = await gameMobFixture(t);
    const horse = f.spawn("acceptance:saddle-before-offhand-splash");
    const saddle = { id: ITEM.SADDLE, count: 1 };
    const splash = potionStack(f.progression.services.catalog, "harming", { form: "splash" });
    setHands(f, saddle, splash);
    useKey(f);
    assert.equal(f.progression.services.potions.size, 0);
    assert.deepEqual(f.gameplay.getHandStack("main"), saddle);
    assert.deepEqual(f.gameplay.getHandStack("offhand"), splash);
  });

  await t.test("offhand splash precedes an empty-main mount fallback", async (t) => {
    const f = await gameMobFixture(t);
    f.spawn("acceptance:mount-before-offhand-splash");
    const splash = potionStack(f.progression.services.catalog, "harming", { form: "splash" });
    setHands(f, null, splash);
    useKey(f);
    assert.equal(f.progression.services.potions.size, 1);
    assert.equal(f.horses.mountFor(), null);
    assert.equal(f.gameplay.getHandStack("offhand"), null);
  });

  await t.test("main ecology food precedes an offhand splash", async (t) => {
    const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
    const plan = f.ecology.prepareAdmission("turtle", { x: 8.5, y: 65, z: 8.5 });
    assert.ok(plan);
    assert.equal(f.ecology.commit(plan).ok, true);
    const turtle = f.wildlife.byId.get(plan.result.id);
    f.aim(turtle);
    const splash = potionStack(f.progression.services.catalog, "harming", { form: "splash" });
    setHands(f, { id: BLOCK.SEAGRASS, count: 2 }, splash);
    useKey(f);
    assert.equal(f.progression.services.potions.size, 0);
    assert.equal(f.gameplay.getHandStack("main").count, 1);
    assert.deepEqual(f.gameplay.getHandStack("offhand"), splash);
    assert.ok(f.ecology.ecology.state(turtle.id).loveTime > 0);
  });
});
