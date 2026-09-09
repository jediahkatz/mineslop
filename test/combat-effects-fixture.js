import assert from "node:assert/strict";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { GameIngredientMobActions } from "../src/game-ingredient-mob-actions.js";
import { ITEM } from "../src/items.js";
import { addStatusEffects } from "../src/status-effects.js";
import { gameMobFixture, gameMobGenerator } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const targetPosition = { x: 2.5, y: 65, z: 8.5 };

function habitatGenerator(biome, water = false) {
  return (seed, dimension, generatorVersion) => {
    const source = gameMobGenerator(seed, dimension, generatorVersion);
    if (dimension !== "overworld") return source;
    return {
      ...source,
      getBiome: () => getBiomeById(biome),
      generateChunk(cx, cz) {
        const chunk = source.generateChunk(cx, cz);
        chunk.biomes.fill(BIOMES.findIndex((entry) => entry.id === biome));
        if (water) chunk.blocks.fill(BLOCK.WATER,
          (65 - chunk.minY) * 256, (76 - chunk.minY) * 256);
        return chunk;
      },
    };
  };
}
export const combatBeach = habitatGenerator("beach");
const combatOcean = habitatGenerator("ocean", true);

/**
 * Authored finite gear/status and habitat, not a native acquisition/UI claim.
 * Game, player, victim, status, Gameplay and every reward sink are real owners.
 * The separate field test exercises paid anvil/brewing/drinking prerequisites.
 */
export async function combatFixture(t, kind = "horse") {
  const f = await gameMobFixture(t, {
    seed: "combat-effect-regression", generatorVersion: 4,
    generatorFactory: kind === "drowned" ? combatOcean : combatBeach,
    ...(kind === "drowned" ? {
      spawnPosition: { x: 2.5, y: 65, z: 35.5 }, admissionRadius: 3,
    } : {}),
  });
  if (kind === "turtle" || kind === "drowned") {
    const plan = f.ecology.prepareAdmission(kind, targetPosition);
    assert.ok(plan, `actual ${kind} admission: ${JSON.stringify(f.ecology.habitat(targetPosition, kind))}`);
    assert.equal(f.ecology.commit(plan).ok, true);
    f.mob = f.wildlife.byId.get(plan.result.id);
  } else {
    f.mob = f.wildlife.spawn(kind, targetPosition, { id: `offense:${kind}` });
  }
  assert.ok(f.mob);
  assert.equal(f.mob.health, f.mob.spec.health);
  f.actions = kind === "spider"
    ? (f.game.ingredientMobActions ??= new GameIngredientMobActions(f.game))
    : f.game.mobActions;
  approach(f, f.mob);
  return f;
}

export function approach(f, mob) {
  f.player.setPosition({ x: mob.position.x, y: mob.position.y, z: mob.position.z + 2.5 });
  f.aim(mob);
  f.game.updateTarget();
  assert.equal(f.game.meleeTarget?.entity === mob, true);
}

export function equip(f, {
  bow = false, hand = "main", enchantments = {}, durability, arrows = bow ? 3 : 0,
} = {}) {
  const stack = progressionStack(bow ? ITEM.BOW : ITEM.IRON_SWORD, 1,
    Object.keys(enchantments).length ? { enchantments } : undefined, durability);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    if (hand === "offhand") owned.offhand = stack;
    else owned.slots[f.gameplay.selected] = stack;
    owned.slots[9] = arrows ? progressionStack(ITEM.ARROW, arrows) : null;
    return true;
  }), true);
  return f.gameplay.getHandStack(hand);
}

export function effect(f, id = "strength", amplifier = 0, durationTicks = 200) {
  const effects = f.progression.services.effects;
  const plan = effects.prepare(addStatusEffects(effects.serialize(), [
    { id, amplifier, durationTicks },
  ]));
  assert.ok(plan);
  assert.equal(f.coordinator.commit([plan]).ok, true);
}

export function chargedShot(f, hand = "main", seconds = 1) {
  const use = f.game.useActions.use;
  assert.equal(use.start("bow", hand, f.gameplay.getHandStack(hand),
    f.gameplay.getHandRevision(hand)), true);
  for (let remaining = seconds; remaining > 1e-9; remaining -= 0.25)
    use.advance(Math.min(0.25, remaining));
  const shot = use.release();
  assert.ok(shot);
  return Object.freeze(shot);
}

/** Read the original leaves even while a deliberately stale Game binding refuses. */
export function combatState(f) {
  const owners = f.progression.services._owners;
  return {
    gameplay: f.gameplay.serialize(),
    mainRevision: f.gameplay.getHandRevision(),
    offhandRevision: f.gameplay.getHandRevision("offhand"),
    effects: owners.effects.serialize(), stations: owners.stations.serialize(),
    mobs: f.mobs.wildlife.serialize(), horses: f.horses.serialize(),
    ecology: f.ecology.ecology.serialize(), overflow: f.overflow.serialize(),
    pickups: f.game.pickups.serialize(), xp: f.mobs.experienceOrbs.serialize(),
    bytes: f.coordinator.budget.totalBytes, lastAction: f.game.lastAction,
  };
}

export function uniqueAttackOwners(f, parts) {
  assert.ok(parts?.length);
  assert.equal(parts.filter((part) => part.owner === f.gameplay).length, 1);
  assert.equal(parts.filter((part) => part.owner === f.wildlife).length, 1);
  assert.equal(new Set(parts.map((part) => part.owner)).size, parts.length);
}
