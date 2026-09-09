import assert from "node:assert/strict";
import test from "node:test";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { spendExperienceLevels } from "../src/enchantment-domain.js";
import { experienceForLevel } from "../src/experience.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { VoxelGame } from "../src/game.js";
import { bowStrength } from "../src/item-use.js";
import { getItem, ITEM } from "../src/items.js";
import { potionStack } from "./brewing-fixture.js";
import { gameMobFixture, gameMobGenerator, point } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

/**
 * Paid combat field regression: authored beach, workshop, finite plain gear,
 * books, XP, water and ingredients. NOT native acquisition, GUI or performance
 * evidence. No completed enchantment/potion is injected into the player's hand.
 * All resource owners and primary/bow hit callbacks are production instances.
 * Seven cases per route, one fresh finite victim per case, no HP resets.
 */
const bench = Object.freeze({ dimension: "overworld", x: 8, y: 65, z: 8 });
const routes = [
  { name: "owned-horse", kind: "horse", family: "other" },
  { name: "legacy-zombie", kind: "zombie", family: "undead" },
  { name: "ingredient-spider", kind: "spider", family: "other" },
  { name: "ecology-turtle", kind: "turtle", family: "other" },
];
const cases = [
  { name: "plain" },
  { name: "sharpness", enchantment: "sharpness", level: 3 },
  { name: "smite", enchantment: "smite", level: 2 },
  { name: "strength", potion: "strength" },
  { name: "weakness", potion: "weakness" },
  { name: "bow", bow: true },
  { name: "power", bow: true, enchantment: "power", level: 3 },
];
const count = (f, id) => f.gameplay.slots.reduce(
  (sum, stack) => sum + (stack?.id === id ? stack.count : 0), 0,
);
const stand = (f) => f.progression.services.stations.get(bench).record;

// Authored beach metadata supplies the turtle's real admission prerequisites.
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

async function fixture(t, route, variant) {
  const f = await gameMobFixture(t, {
    seed: "progression-combat-field", generatorVersion: 4,
    generatorFactory: beachGenerator, autoSpawn: false,
  });
  f.probeLabel = `${route.name}:${variant.name}`;
  assert.equal(f.game.primary, VoxelGame.prototype.primary);
  assert.equal(f.game.useActions.fireBow, GameUseActions.prototype.fireBow);
  assert.equal(f.game.progressionIntegration, f.progression);
  assert.equal(f.progression.active, true);
  assert.equal(f.progression.services.active, true);
  assert.equal(f.gameplay.mode, "survival");
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots[0] = progressionStack(variant.bow ? ITEM.BOW : ITEM.IRON_SWORD);
    if (variant.enchantment) {
      owned.slots[1] = progressionStack(ITEM.ENCHANTED_BOOK, 1, {
        enchantments: { [variant.enchantment]: variant.level },
      });
      owned.experienceTotal = experienceForLevel(30);
    }
    if (variant.potion) {
      owned.slots[2] = progressionStack(variant.potion === "strength"
        ? ITEM.NETHER_WART : ITEM.FERMENTED_SPIDER_EYE);
      owned.slots[3] = progressionStack(ITEM.BLAZE_POWDER);
      if (variant.potion === "strength")
        owned.slots[4] = progressionStack(ITEM.BLAZE_POWDER);
      owned.slots[5] = potionStack(f.progression.services.catalog, "water");
    }
    if (variant.bow) owned.slots[9] = progressionStack(ITEM.ARROW, 2);
    return true;
  }), true);
  return f;
}

function stationAction(f, request) {
  const result = f.progression.action({
    ...request, sessionToken: f.progression.services.session?.token,
  });
  assert.equal(result.ok, true, `${f.probeLabel}: ${JSON.stringify(request)}: ${result.reason}`);
  return result;
}

function transfer(f, inventoryIndex, stationIndex) {
  stationAction(f, { type: "click", area: "inventory", index: inventoryIndex, button: 0 });
  stationAction(f, { type: "click", area: "container", index: stationIndex, button: 0 });
  assert.equal(f.gameplay.cursor, null);
}

function openBench(f, block) {
  // Real empty-world frames advance the use cooldown before any victim exists.
  f.frame(5);
  f.player.setPosition({ x: bench.x + 0.5, y: bench.y, z: bench.z + 3.5 });
  f.aim({ x: bench.x + 0.5, y: bench.y, z: bench.z + 0.5 }, 0.5);
  f.game.updateTarget();
  assert.equal(f.game.target?.id, block);
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.progression.isOpen, true);
}

async function closeBench(f) {
  assert.equal(f.progression.close("combat-field").ok, true);
  if (f.game.screenClose) await f.game.screenClose;
  await Promise.resolve();
  assert.equal(f.game.active, true);
}

async function payEnchant(f, variant) {
  f.put(bench.x, bench.y, bench.z, BLOCK.ANVIL);
  openBench(f, BLOCK.ANVIL);
  transfer(f, 0, 0);
  transfer(f, 1, 1);
  const preview = f.progression.view().preview;
  assert.equal(preview.ok, true);
  assert.ok(preview.levelCost > 0);
  const before = f.gameplay.getState().experience.total;
  stationAction(f, { type: "takeResult", previewKey: preview.key });
  const after = f.gameplay.getState().experience.total;
  const escrow = stand(f);
  assert.equal(after, spendExperienceLevels(before, preview.levelCost));
  assert.equal(escrow.left, null);
  assert.equal(escrow.right, null);
  assert.equal(count(f, ITEM.ENCHANTED_BOOK), 0);
  stationAction(f, { type: "click", area: "inventory", index: 0, button: 0 });
  await closeBench(f);
  assert.equal(f.gameplay.getHandStack().data.enchantments[variant.enchantment], variant.level);
  assert.equal(f.progression.gear.enchantmentLevel(f.gameplay.getHandStack(), variant.enchantment), variant.level);
}

function finishBatch(f, ingredient, output, fuel) {
  const initial = stand(f);
  assert.equal(initial.slots[3].id, ingredient);
  assert.equal(initial.slots[3].count, 1);
  assert.equal(initial.progressTicks, 0);
  // Actual active station clock: 80 bounded 250 ms samples, not wall-clock wait,
  // a finished-potion injection, or a claim of 400 full Game/renderer frames.
  for (let step = 0; step < 79; step++)
    assert.equal(f.progression.frame(0.25).ok, true);
  const pending = stand(f);
  assert.equal(pending.progressTicks, 395);
  assert.equal(pending.slots[3].count, 1, "the ingredient is not paid early");
  assert.equal(f.progression.frame(0.25).ok, true);
  const completed = stand(f);
  assert.equal(completed.slots[0].data.potion.id, output);
  assert.equal(completed.slots[3], null);
  assert.equal(completed.slots[4], null);
  assert.equal(completed.fuelOperations, fuel);
  assert.equal(completed.batch, null);
}

async function brewAndDrink(f, potion) {
  f.put(bench.x, bench.y, bench.z, BLOCK.BREWING_STAND);
  openBench(f, BLOCK.BREWING_STAND);
  transfer(f, 5, 0);
  transfer(f, 2, 3);
  transfer(f, 3, 4);
  await closeBench(f);
  finishBatch(f, potion === "strength" ? ITEM.NETHER_WART : ITEM.FERMENTED_SPIDER_EYE,
    potion === "strength" ? "awkward" : "weakness", 19);
  if (potion === "strength") {
    openBench(f, BLOCK.BREWING_STAND);
    transfer(f, 4, 3);
    await closeBench(f);
    finishBatch(f, ITEM.BLAZE_POWDER, "strength", 18);
  }
  openBench(f, BLOCK.BREWING_STAND);
  stationAction(f, { type: "click", area: "container", index: 0, button: 0 });
  stationAction(f, { type: "click", area: "inventory", index: 5, button: 0 });
  await closeBench(f);
  f.game.select(5);
  f.player.yaw = Math.PI;
  f.player.pitch = 0;
  f.player._syncCamera(0);
  f.frame(5);
  const before = f.gameplay.getHandStack();
  assert.equal(before.data.potion.id, potion);
  assert.equal(f.game.useActions.begin("combat-field-drink"), true);
  f.frame(31);
  assert.equal(count(f, ITEM.POTION), 1);
  assert.equal(f.progression.services.effects.hasActiveEffects, false);
  f.frame();
  f.game.useActions.end("combat-field-drink", true);
  const effects = f.progression.services.effects.serialize().effects;
  assert.equal(count(f, ITEM.POTION), 0);
  assert.equal(count(f, ITEM.GLASS_BOTTLE), 1);
  assert.equal(effects.length, 1);
  assert.equal(effects[0].id, potion);
  assert.equal(effects[0].amplifier, 0);
  assert.ok(effects[0].remainingTicks > 0);
  assert.equal(count(f, ITEM.NETHER_WART), 0);
  assert.equal(count(f, ITEM.BLAZE_POWDER), 0);
  assert.equal(count(f, ITEM.FERMENTED_SPIDER_EYE), 0);
  f.game.select(0);
}

function admitTarget(f, route) {
  // Placement and approach are authored; admission, geometry, health and
  // transaction validation are unchanged. No forced hit or target callback.
  const position = { x: 2.5, y: 65, z: 8.5 };
  let mob;
  if (route.kind === "turtle") {
    const plan = f.ecology.prepareAdmission("turtle", position);
    assert.ok(plan, "real Ecology/Wildlife admission must accept the authored beach");
    assert.equal(f.ecology.commit(plan).ok, true);
    mob = f.wildlife.byId.get(plan.result.id);
  } else {
    mob = f.wildlife.spawn(route.kind, position, { id: `combat:${f.probeLabel}` });
  }
  assert.ok(mob);
  assert.equal(mob.health, mob.spec.health);
  assert.ok(Number.isFinite(mob.health) && mob.health > 11);
  f.player.setPosition({ x: 2.5, y: 65, z: 11 });
  f.aim(mob);
  f.game.updateTarget();
  assert.equal(f.game.meleeTarget?.entity, mob);
  return mob;
}

function observe(f, mob) {
  return {
    health: mob.health, dead: mob.dead, position: point(mob.position),
    hand: f.gameplay.getHandStack(), handRevision: f.gameplay.getHandRevision(),
    arrows: count(f, ITEM.ARROW), exhaustion: f.gameplay.exhaustion,
    xp: f.gameplay.getState().experience.total,
    effects: f.progression.services.effects.serialize().effects,
  };
}

function expectedDamage(route, variant) {
  if (variant.bow) return getItem(ITEM.BOW).damage * (variant.enchantment === "power" ? 2 : 1);
  const base = getItem(ITEM.IRON_SWORD).damage;
  return base + (variant.enchantment === "sharpness" ? 2 : 0) +
    (variant.enchantment === "smite" && route.family === "undead" ? 5 : 0) +
    (variant.potion === "strength" ? 3 : variant.potion === "weakness" ? -4 : 0);
}

async function fieldCase(t, route, variant) {
  const f = await fixture(t, route, variant);
  if (variant.enchantment) await payEnchant(f, variant);
  if (variant.potion) await brewAndDrink(f, variant.potion);
  f.frame(5);
  const mob = admitTarget(f, route);
  const expected = expectedDamage(route, variant);
  const before = observe(f, mob), gear = f.progression.gear;
  assert.ok(gear);
  if (variant.bow) {
    // Begin use in an empty direction, then aim during the draw. This is the
    // normal dispatch path, without exercising unrelated entity-use priority.
    f.player.yaw = Math.PI;
    f.player.pitch = 0;
    f.player._syncCamera(0);
    assert.equal(f.game.useActions.begin("combat-field-bow"), true);
    for (let step = 0; step < 4; step++) f.game.useActions.update(0.25);
    f.aim(mob);
    f.game.updateTarget();
    assert.equal(f.wildlife.raycast(f.player.eyePosition, f.player.forward, 32)?.entity, mob);
    const strength = bowStrength(f.game.useActions.use.elapsed);
    const projected = gear.bowDamage(getItem(ITEM.BOW).damage, before.hand);
    assert.equal(strength, 1);
    assert.equal(projected, expected);
    const accepted = f.game.useActions.end("combat-field-bow");
    const after = observe(f, mob);
    const actualDamage = before.health - after.health;
    assert.equal(accepted, true);
    assert.equal(before.arrows - after.arrows, 1);
    assert.equal(before.hand.durability - after.hand.durability, 1);
    assert.equal(after.xp, before.xp);
    assert.ok(actualDamage > 0);
    assert.equal(mob.dead, false);
    assert.equal(f.game.useActions.end("combat-field-bow"), false, "one gesture cannot pay or hit twice");
    assert.deepEqual(observe(f, mob), after);
    return actualDamage;
  }
  const projected = gear.meleeDamage(gear.attackDamage(getItem(ITEM.IRON_SWORD).damage),
    before.hand, { targetFamily: route.family });
  assert.equal(projected, expected);
  f.game.primary(0.05, true);
  const after = observe(f, mob);
  const actualDamage = before.health - after.health;
  assert.ok(actualDamage > 0, `${f.probeLabel}: real primary must land before damage comparisons`);
  assert.equal(before.hand.durability - after.hand.durability, 1);
  assert.ok(Math.abs(after.exhaustion - before.exhaustion - 0.1) < 1e-9);
  assert.equal(after.arrows, before.arrows);
  assert.equal(after.xp, before.xp);
  assert.equal(mob.dead, false);
  assert.equal(f.wildlife.byId.get(mob.id), mob);
  return actualDamage;
}

for (const route of routes) {
  test(`paid progression reaches actual outgoing combat: ${route.name} (authored prerequisites)`, async (t) => {
    const observed = {}, expected = {};
    // Gather the whole route before checking bonuses, so an initial Sharpness
    // failure does not conceal the Strength/Weakness, Smite and Power evidence.
    for (const variant of cases) {
      observed[variant.name] = await fieldCase(t, route, variant);
      expected[variant.name] = expectedDamage(route, variant);
    }
    t.diagnostic(JSON.stringify({
      route: route.name, authoredPrerequisites: true, observed, expected,
      scope: "real primary/use hit and payment; no native/GUI/performance claim",
    }));
    assert.deepEqual(observed, expected,
      "Paid live gear/status projections must reach the real target, not just a helper calculation");
  });
}
