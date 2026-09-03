import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { durabilityLoss } from "../src/enchantment-effects.js";
import { experienceForLevel } from "../src/experience.js";
import { armorItemId, toolItemId } from "../src/gear-content.js";
import { ARMOR_SLOTS, TOOL_KINDS } from "../src/gear.js";
import { getItem, ITEM } from "../src/items.js";
import { addStatusEffects } from "../src/status-effects.js";
import { progressionLiveFixture, progressionStack } from "./progression-live-fixture.js";

function anvil(t) {
  const f = progressionLiveFixture(t);
  f.place("anvil");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, {
      name: "Old pick", enchantments: { unbreaking: 2 },
    }, 10);
    owned.slots[1] = progressionStack(ITEM.IRON_INGOT, 3);
    return true;
  });
  assert.equal(f.open().opened, true);
  f.transfer(0, 0); f.transfer(1, 1);
  return f;
}

test("live anvil repair/rename pays exact XP/materials only when the complete result fits", (t) => {
  const f = anvil(t);
  const rename = "<b>Repaired ⛏</b>";
  const preview = f.services.view({ rename }).preview;
  assert.equal(preview.ok, true);
  assert.equal(preview.levelCost, 4);
  assert.equal(preview.rightConsumed, 3);
  assert.equal(preview.output.durability, 196);
  f.editInventory((owned) => {
    owned.cursor = progressionStack(ITEM.APPLE);
    return true;
  });
  const occupied = f.snapshot();
  const action = { type: "takeResult", previewKey: preview.key, rename };
  assert.equal(f.action(action).reason, "output_capacity");
  assert.deepEqual(f.snapshot(), occupied);
  f.editInventory((owned) => {
    owned.cursor = null;
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    return true;
  });
  const full = f.snapshot();
  assert.equal(f.action({ ...action, shift: true }).ok, false);
  assert.deepEqual(f.snapshot(), full);
  const result = f.action(action);
  assert.equal(result.ok, true);
  assert.deepEqual(f.gameplay.cursor, preview.output);
  assert.equal(f.gameplay.cursor.data.name, rename);
  assert.deepEqual(f.gameplay.cursor.data.enchantments, { unbreaking: 2 });
  assert.equal(f.gameplay.cursor.data.repairCost, 1);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(36));
  assert.equal(f.services.stations.get(f.at).record.left, null);
  assert.equal(f.services.stations.get(f.at).record.right, null);
});

test("anvil stale names and insufficient levels preserve repair inputs and wear RNG", (t) => {
  const f = anvil(t);
  const preview = f.services.view({ rename: "One" }).preview;
  const original = f.snapshot();
  assert.equal(f.action({ type: "takeResult", rename: "Two", previewKey: preview.key }).reason, "stale_preview");
  assert.deepEqual(f.snapshot(), original);
  f.editInventory((owned) => { owned.experienceTotal = 0; return true; });
  const poor = f.snapshot();
  assert.equal(f.action({ type: "takeResult", rename: "One", previewKey: preview.key }).reason, "insufficient_levels");
  assert.deepEqual(f.snapshot(), poor);
});

test("last-stage anvil break retains unused material with output, XP and wear in one commit", (t) => {
  const stage = progressionLiveFixture(t, { activate: false });
  stage.put(stage.at.x, stage.at.y, stage.at.z, BLOCK.DAMAGED_ANVIL);
  stage.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    return true;
  });
  const saved = stage.snapshot();
  saved.progression.stations.stations = [{ ...stage.at, kind: "anvil", record: {
    version: 1, left: progressionStack(ITEM.IRON_PICKAXE, 1, { name: "Last repair" }, 249),
    right: progressionStack(ITEM.IRON_INGOT, 2),
  } }];
  // Select authored saved RNG input, not a patched random function.
  let seed = 0;
  while (seed < 10000 && nextEnchantingSeed(seed) / 0x100000000 >= 0.12) seed++;
  assert.ok(seed < 10000);
  saved.progression.stations.randomState = seed;
  const f = progressionLiveFixture(t, { saved });
  assert.equal(f.open().opened, true);
  const preview = f.services.view().preview;
  const plan = f.prepare({ type: "takeResult", previewKey: preview.key });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.length, 4);
  assert.equal(f.services.commit(plan).anvilBroken, true);
  assert.equal(f.world.get(f.at.x, f.at.y, f.at.z), BLOCK.AIR);
  assert.equal(f.services.stations.get(f.at), null);
  assert.equal(f.gameplay.cursor.durability, 250);
  assert.equal(f.gameplay.cursor.data.name, "Last repair");
  assert.equal(f.overflow.serialize().entries.find((entry) => entry.id === ITEM.IRON_INGOT).count, 1);
  assert.equal(f.gameplay.getState().experience.level, 39);
  assert.equal(f.services.commit(plan).ok, false);
});

test("smithing consumes a real template and ingot and preserves absolute damage and all metadata", (t) => {
  const f = progressionLiveFixture(t);
  f.place("smithing");
  const data = { name: "Ancient pick", repairCost: 7, enchantments: { efficiency: 4, unbreaking: 3 } };
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.NETHERITE_UPGRADE_TEMPLATE, 2);
    owned.slots[1] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, data, 1000);
    owned.slots[2] = progressionStack(ITEM.NETHERITE_INGOT, 3);
    return true;
  });
  assert.equal(f.open().opened, true);
  for (let i = 0; i < 3; i++) f.transfer(i, i);
  const preview = f.services.view().preview;
  assert.equal(preview.ok, true);
  const beforeXp = f.gameplay.getState().experience.total;
  assert.equal(f.action({ type: "takeResult", previewKey: `${preview.key}stale` }).ok, false);
  assert.equal(f.action({ type: "takeResult", previewKey: preview.key }).ok, true);
  assert.equal(f.gameplay.cursor.id, ITEM.NETHERITE_PICKAXE);
  assert.equal(f.gameplay.cursor.durability, 1470);
  assert.deepEqual(f.gameplay.cursor.data, { version: 1, ...data });
  const record = f.services.stations.get(f.at).record;
  assert.equal(record.template.count, 1);
  assert.equal(record.addition.count, 2);
  assert.equal(record.base, null);
  assert.equal(f.gameplay.getState().experience.total, beforeXp);
});

test("every registered diamond tool and armor slot has a paid matching netherite upgrade", (t) => {
  const pairs = [
    ...TOOL_KINDS.map((kind) => [toolItemId("diamond", kind), toolItemId("netherite", kind)]),
    ...ARMOR_SLOTS.map((slot) => [armorItemId("diamond", slot), armorItemId("netherite", slot)]),
  ];
  assert.equal(pairs.length, 9);
  for (const [baseId, outputId] of pairs) {
    const f = progressionLiveFixture(t);
    f.place("smithing");
    const data = { name: "Preserved upgrade", repairCost: 3, enchantments: { unbreaking: 3 } };
    f.editInventory((owned) => {
      owned.slots[0] = progressionStack(ITEM.NETHERITE_UPGRADE_TEMPLATE);
      owned.slots[1] = progressionStack(baseId, 1, data, getItem(baseId).durability - 7);
      owned.slots[2] = progressionStack(ITEM.NETHERITE_INGOT);
      return true;
    });
    assert.equal(f.open().opened, true);
    for (let index = 0; index < 3; index++) f.transfer(index, index);
    const preview = f.services.view().preview;
    assert.equal(preview.ok, true);
    assert.equal(preview.output.id, outputId);
    assert.equal(preview.output.durability, getItem(outputId).durability - 7);
    assert.equal(f.action({ type: "takeResult", previewKey: preview.key }).ok, true);
    assert.deepEqual(f.gameplay.cursor.data, { version: 1, ...data });
    assert.equal(f.services.view().slots.every((stack) => stack === null), true);
    assert.equal(f.gameplay.getState().experience.level, 40);
  }
});

test("smithing full output and stale World/hand controls spend none of the three inputs", (t) => {
  const f = progressionLiveFixture(t);
  f.place("smithing");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.NETHERITE_UPGRADE_TEMPLATE);
    owned.slots[1] = progressionStack(ITEM.DIAMOND_SWORD);
    owned.slots[2] = progressionStack(ITEM.NETHERITE_INGOT);
    return true;
  });
  assert.equal(f.open().opened, true);
  for (let index = 0; index < 3; index++) f.transfer(index, index);
  const preview = f.services.view().preview;
  const action = { type: "takeResult", previewKey: preview.key };
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.cursor = progressionStack(ITEM.APPLE);
    return true;
  });
  const full = f.snapshot();
  assert.equal(f.action(action).ok, false);
  assert.equal(f.action({ ...action, shift: true }).ok, false);
  assert.deepEqual(f.snapshot(), full);
  f.editInventory((owned) => { owned.cursor = null; return true; });
  for (const invalidate of [
    () => { f.gameplay.select(1); f.gameplay.select(0); },
    () => {
      f.put(f.at.x, f.at.y, f.at.z, BLOCK.AIR);
      f.put(f.at.x, f.at.y, f.at.z, BLOCK.SMITHING_TABLE);
    },
  ]) {
    const plan = f.prepare(action);
    assert.equal(plan.ok, true);
    invalidate();
    const before = f.snapshot();
    assert.equal(f.services.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("gear hooks calculate actual toughness, EPF, speed, damage, breathing and lighting modifiers", (t) => {
  const f = progressionLiveFixture(t), gear = f.services.gear;
  f.editInventory((owned) => {
    for (const slot of ["head", "chest", "legs", "feet"])
      owned.equipment[slot] = progressionStack(armorItemId("netherite", slot), 1, {
        enchantments: { protection: 4, ...(slot === "head" ? { respiration: 3, aqua_affinity: 1 } :
          slot === "feet" ? { feather_falling: 4, depth_strider: 3 } : {}) },
      });
    owned.slots[0] = progressionStack(ITEM.DIAMOND_SWORD, 1, { enchantments: { sharpness: 3 } });
    return true;
  });
  const effects = addStatusEffects(f.services.effects.serialize(), [
    "speed", "strength", "haste", "water_breathing", "night_vision",
  ].map((id) => ({ id, amplifier: 0, durationTicks: 200 })));
  assert.equal(f.coordinator.commit([f.services.effects.prepare(effects)]).ok, true);
  const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8);
  assert.deepEqual(gear.armorProfile(), { armorPoints: 20, toughness: 12, knockbackResistance: 0.4 });
  close(gear.incomingDamage(20).damage, 2.592);
  close(gear.incomingDamage(5, { kind: "pearl" }).damage, 1);
  assert.equal(gear.incomingDamage(5, { kind: "pearl" }).wearArmor, false);
  close(gear.knockback(10), 6);
  close(gear.movementSpeed(4), 4.8);
  assert.equal(gear.movementSpeed(4, { kind: "flight" }), 4);
  close(gear.attackSpeed(2), 2.2);
  assert.equal(gear.meleeDamage(gear.attackDamage(8) * 1.5), 18.5);
  const pick = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { enchantments: { efficiency: 3 } });
  close(gear.miningSpeed(8, pick, { effectiveTool: true, submerged: true }), 21.6);
  close(gear.waterMovement({ onGround: true }).acceleration, 0.1);
  assert.equal(gear.respirationAirLoss(0.9), 0);
  assert.ok(gear.breathing(5, 0.25).air > 5);
  assert.equal(gear.visualLight(0.1), 1);
  const fire = f.services.effects.prepare(addStatusEffects(effects, [
    { id: "fire_resistance", amplifier: 0, durationTicks: 200 },
  ]));
  assert.equal(f.coordinator.commit([fire]).ok, true);
  assert.deepEqual(gear.incomingDamage(8, { kind: "lava" }), { damage: 0, wearArmor: false });
});

test("station harvesting combines Unbreaking RNG, held wear and escrow in one owner-unique plan", (t) => {
  const f = anvil(t);
  const tool = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { enchantments: { unbreaking: 3 } }, 1000);
  f.editInventory((owned) => { owned.slots[0] = tool; return true; });
  const seed = f.services.stations.randomState, tableSeed = f.services.stations.playerState;
  const roll = nextEnchantingSeed(seed) / 0x100000000;
  const wear = [{ area: "inventory", index: 0, amount: 1 }];
  const changes = [{ ...f.at, before: f.world.getCell(f.at.x, f.at.y, f.at.z),
    after: normalizeCell({ id: BLOCK.AIR }) }];
  const prepare = () => f.services.prepareStationRemoval(changes, {
    randomDraws: 1,
    prepareGameplay: (rolls) => f.services.gear.prepareWearParticipant(wear, rolls),
    extraDrops: [progressionStack(BLOCK.ANVIL)],
  });
  const stale = prepare();
  assert.equal(stale.ok, true);
  f.gameplay.select(1); f.gameplay.select(0);
  const before = f.snapshot();
  assert.equal(f.services.commit(stale).ok, false);
  assert.deepEqual(f.snapshot(), before);
  const plan = prepare();
  assert.equal(plan.participants.length, 4);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, 4);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.gameplay.getHandStack().durability, 1000 - durabilityLoss(tool, [roll], f.context));
  assert.equal(f.services.stations.randomState, nextEnchantingSeed(seed));
  assert.deepEqual(f.services.stations.playerState, tableSeed);
  assert.equal(f.services.stations.size, 0);
  assert.equal(f.overflow.size, 3);
});

test("Mending uses one Gameplay participant and credits only unspent XP without changing table offers", (t) => {
  const f = progressionLiveFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE, 1, { enchantments: { mending: 1 } }, 244);
    owned.experienceTotal = 0;
    return true;
  });
  const seed = f.services.stations.playerState;
  const plan = f.services.gear.prepareMending(5, { validate: () => f.services.active });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
  assert.equal(plan.result.experienceSpent, 3);
  assert.equal(plan.result.experienceRemaining, 2);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.gameplay.getHandStack().durability, getItem(ITEM.IRON_PICKAXE).durability);
  assert.equal(f.gameplay.getState().experience.total, 2);
  assert.deepEqual(f.services.stations.playerState, seed);
});

test("prepared damage pays health and Unbreaking armor wear together and pins live effect revisions", (t) => {
  const f = progressionLiveFixture(t);
  const chest = progressionStack(armorItemId("netherite", "chest"), 1, {
    name: "Worn defender", enchantments: { protection: 4, unbreaking: 3 },
  }, 200);
  f.editInventory((owned) => { owned.equipment.chest = chest; return true; });
  const prepare = () => f.services.gear.prepareDamage(8, {
    kind: "melee", validate: () => f.services.active,
  });
  const stale = prepare();
  assert.equal(stale.ok, true);
  const effect = f.services.effects.prepare(addStatusEffects(f.services.effects.serialize(), [
    { id: "resistance", amplifier: 0, durationTicks: 200 },
  ]));
  assert.equal(f.coordinator.commit([effect]).ok, true);
  const before = f.snapshot();
  assert.equal(f.services.commit(stale).ok, false);
  assert.deepEqual(f.snapshot(), before);
  const plan = prepare(), reduction = f.services.gear.incomingDamage(8, { kind: "melee" });
  let seed = f.services.stations.randomState;
  const rolls = Array.from({ length: 2 }, () => {
    seed = nextEnchantingSeed(seed);
    return seed / 0x100000000;
  });
  assert.equal(plan.participants.length, 2);
  assert.equal(plan.result.armorWear, 2);
  assert.equal(f.services.commit(plan).ok, true);
  assert.ok(Math.abs(f.gameplay.health - (20 - reduction.damage)) < 1e-8);
  assert.equal(f.gameplay.equipment.chest.durability, 200 - durabilityLoss(chest, rolls, f.context));
  assert.deepEqual(f.gameplay.equipment.chest.data, chest.data);
  assert.equal(f.services.stations.randomState, seed);
  assert.equal(f.services.commit(plan).ok, false);
});

test("lethal gear damage clears timed effects before one parent death notification without touching station escrow", (t) => {
  const f = anvil(t), escrow = f.services.stations.serialize();
  assert.equal(f.coordinator.commit([f.services.effects.prepare(addStatusEffects(
    f.services.effects.serialize(), [{ id: "speed", amplifier: 0, durationTicks: 200 }]
  ))]).ok, true);
  const death = f.gameplay.onDeath;
  let observed = 0;
  f.gameplay.onDeath = (cause) => {
    observed++;
    assert.equal(f.gameplay.dead, true);
    assert.equal(f.services.effects.hasActiveEffects, false);
    assert.deepEqual(f.services.stations.serialize(), escrow);
    death(cause);
  };
  const plan = f.services.gear.prepareDamage(30, {
    kind: "fall", cause: "fall", validate: () => f.services.active,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.length, 2, "armor-bypassing damage does not spend wear RNG");
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.gameplay.health, 0);
  assert.equal(observed, 1);
  assert.equal(f.services.isOpen, false);
  assert.equal(f.services.commit(plan).ok, false);
  assert.equal(observed, 1);
});
