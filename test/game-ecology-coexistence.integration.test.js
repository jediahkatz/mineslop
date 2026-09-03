import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { ITEM } from "../src/items.js";
import { gameMobFixture, gameMobGenerator, point } from "./game-mob-integration-fixture.js";
import { approachGameMob } from "./game-mob-native-fixture.js";

// Authored sand/beach prerequisites isolate Game's real owner transactions.
// Native distribution, catalog admission and work paths have a separate suite.
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

function turtle(f, position) {
  const plan = f.ecology.prepareAdmission("turtle", position);
  assert.ok(plan);
  assert.equal(f.ecology.commit(plan).ok, true);
  const mob = f.wildlife.byId.get(plan.result.id);
  assert.ok(mob);
  return mob;
}

test("the actual Game frame runs Ecology beside a bareback horse with one shared base registration", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horse = f.spawn(), base = point(horse.position);
  assert.equal(f.game.useActions.tap(), true);
  const resident = turtle(f, { x: 14.5, y: 65, z: 8.5 });
  const begin = t.mock.method(f.ecology, "beginFrame");
  const step = t.mock.method(f.ecology, "stepMob");
  f.game.worldDifficulty = { value: "hard", revision: 7 };
  f.key("Space");
  f.frame(2);
  assert.equal(begin.mock.callCount(), 2);
  assert.equal(step.mock.callCount(), 2, "one Ecology tick per real Wildlife substep");
  assert.ok(step.mock.calls.every(({ arguments: args }) => args[0] === resident && args[1] === 0.05));
  assert.deepEqual(point(horse.position), base);
  assert.equal(f.player.vehicleType, "horse");
  assert.equal(f.horses.mountFor().id, horse.id);
  assert.equal(f.wildlife.byId.get(resident.id), resident);
  assert.equal(f.wildlife.ecologyServices, f.ecology);
  assert.equal(f.wildlife.horseServices, f.horses);
  assert.equal(f.ecology.trading, f.progression.services.trading);
  assert.equal(f.ecology.experienceOrbs, f.game.experienceOrbs);
  assert.equal(f.ecology.overflow, f.overflow);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.wildlife._ownsRegistration, true);
  assert.deepEqual(f.game.readWorldDifficulty(), { value: "hard", revision: 7 });
  assert.equal(f.wildlife.context.difficulty, "hard");
  assert.equal(f.wildlife.context.difficultyRevision, 7);
  assert.equal(f.ecology.ecology.identityReserved(horse.id), false);
  assert.equal(f.horses.identityReserved(resident.id), false);

  const saved = f.snapshot();
  for (const copy of [saved.mobs, saved.mobStates.overworld, saved.mobsByDimension.overworld,
    saved.ecology.mobsByDimension.overworld]) {
    assert.equal(copy.entities.filter((entry) => entry.id === horse.id).length, 1);
    assert.equal(copy.entities.filter((entry) => entry.id === resident.id).length, 1);
  }
  assert.equal(saved.horses.entries.length, 1);
  assert.equal(saved.ecology.ecology.entries.length, 1);
  assert.equal(f.ecology.suspend(), true);
  assert.equal(f.horses.active, true);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "the Ecology borrower cannot release Wildlife");
  assert.equal(f.ecology.bindRestoredWildlife(f.wildlife, { horses: f.horses.serialize() }), true);
  assert.equal(f.ecology.activate(f.wildlife), true);
  assert.equal(f.wildlife.byId.get(horse.id), horse, "adoption cannot reload the base");
  assert.equal(f.wildlife.byId.get(resident.id), resident);
  assert.equal(f.horses.mountFor().id, horse.id);
});

test("Game feeds the real turtle owner atomically and never falls through to legacy interaction", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const mob = turtle(f, { x: 8.5, y: 65, z: 8.5 });
  approachGameMob(f, mob);
  f.hold("SEAGRASS", { count: 2 });
  t.mock.method(f.wildlife, "interact", () => assert.fail("No legacy owned interaction"));
  const prepare = f.gameplay.prepareHandCost;
  const veto = t.mock.method(f.gameplay, "prepareHandCost", function (...args) {
    const part = Reflect.apply(prepare, this, args);
    assert.ok(part);
    return { ...part, validate: () => false };
  });
  const before = f.ownership();
  assert.equal(f.game.useActions.tap(), false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.ecology.ecology.state(mob.id).loveTime, 0);
  veto.mock.restore();
  f.game.elapsed += 0.21;
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.ecology.ecology.state(mob.id).loveTime, ECOLOGY_LIMITS.turtleLove);
  assert.deepEqual(f.gameplay.getHandStack(), { id: BLOCK.SEAGRASS, count: 1 });
  assert.equal(f.game.useActions.use.active, false);
  const paid = f.ownership();
  assert.equal(f.game.mobActions.interact(mob).ok, false, "a second feed cannot re-pay an active love window");
  assert.deepEqual(f.ownership(), paid);
});

test("Game egg mining composes one World/tool/Ecology plan and permanently retains its child identity", async (t) => {
  const f = await gameMobFixture(t, { generatorFactory: beachGenerator });
  const horse = f.spawn();
  assert.equal(f.horses.track(horse.id).ok, true);
  const first = turtle(f, { x: 14.5, y: 65, z: 8.5 });
  const second = turtle(f, { x: 16, y: 65, z: 8.5 });
  f.hold("SEAGRASS", { count: 2 });
  for (const mob of [first, second]) {
    approachGameMob(f, mob);
    assert.equal(f.game.mobActions.interact(mob).ok, true);
  }
  const breed = f.ecology.ecology.prepareBreeding(first, second, f.ecology.readRuntimeContext());
  assert.ok(breed);
  assert.equal(f.ecology.commit(breed).ok, true);
  const lay = f.ecology.prepareLayEgg(first.id);
  assert.ok(lay);
  assert.equal(f.ecology.commit(lay).ok, true);
  const egg = f.ecology.ecology.egg(lay.result.eggId);
  assert.equal(f.world.get(egg.position.x, egg.position.y, egg.position.z), BLOCK.TURTLE_EGG);
  f.hold("IRON_PICKAXE");
  const hit = { ...egg.position, dimension: f.world.dimension,
    ...f.world.getCell(egg.position.x, egg.position.y, egg.position.z) };
  const plan = f.game.harvestActions.prepareBreak(hit);
  assert.ok(plan);
  assert.equal(plan.participants.filter((part) => part.owner === f.world).length, 1);
  assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
  assert.equal(plan.participants.filter((part) => part.owner === f.ecology.ecology).length, 1);
  const before = f.ownership();
  for (const owner of [f.world, f.gameplay, f.ecology.ecology]) {
    assert.equal(f.coordinator.commit(plan.participants.map((part) =>
      part.owner === owner ? { ...part, validate: () => false } : part)).ok, false);
    assert.deepEqual(f.ownership(), before);
  }
  assert.equal(f.game.harvestActions.commit(plan).ok, true);
  assert.equal(f.world.get(egg.position.x, egg.position.y, egg.position.z), BLOCK.AIR);
  assert.equal(f.ecology.ecology.egg(egg.id).status, "broken");
  assert.equal(f.ecology.ecology.identityReserved(egg.childId), true);
  assert.equal(f.wildlife.byId.has(egg.childId), false);
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  const after = f.ownership();
  assert.equal(f.game.harvestActions.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), after);
  const restored = await gameMobFixture(t, { saved: after.archive, generatorFactory: beachGenerator });
  assert.equal(restored.ecology.ecology.egg(egg.id).status, "broken");
  assert.equal(restored.ecology.ecology.identityReserved(egg.childId), true);
  assert.equal(restored.wildlife.byId.has(egg.childId), false);
  assert.equal(restored.horses.state(horse.id).alive, true);
  assert.equal(restored.game.experienceOrbs.serialize().orbs.length, 0);
  assert.equal(restored.overflow.serialize().entries.some((entry) => entry.id === ITEM.SCUTE), false);
});
