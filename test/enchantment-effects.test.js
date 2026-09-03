import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  activeEnchantmentLevel,
  bowDamage,
  durabilityLoss,
  durabilityUseChance,
  fishingLootWeights,
  fishingWaitTicks,
  fortuneBinomialCount,
  fortuneDropChance,
  fortuneOreMultiplier,
  fortuneUniformCount,
  meleeDamage,
  miningSpeed,
  planMendingExperience,
  reduceEnchantedDamage,
  respirationAirLoss,
  selectSilkTouchDrops,
  waterMovement,
} from "../src/enchantment-effects.js";
import { getSupportedEnchantments } from "../src/enchantment-rules.js";
import { reduceArmorDamage } from "../src/gear.js";
import { getItem, ITEM } from "../src/items.js";
import {
  enchantedBook,
  materialStack,
  registeredFishingRod,
  tool,
} from "./enchantment-fixture.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const enchantedTool = (id, enchantments, durability = getItem(id).durability) =>
  tool(id, durability, { enchantments });
const armorIds = {
  head: ITEM.IRON_HELMET,
  chest: ITEM.IRON_ARMOR,
  legs: ITEM.IRON_LEGGINGS,
  feet: ITEM.IRON_BOOTS,
};
const protectionArmor = () =>
  Object.fromEntries(
    Object.entries(armorIds).map(([slot, id]) => [
      slot,
      enchantedTool(id, { protection: 4 }),
    ])
  );

test("Efficiency adds L²+1 only to effective tools above base speed one", () => {
  const pick = enchantedTool(ITEM.IRON_PICKAXE, { efficiency: 5 });
  assert.equal(miningSpeed(6, pick, { effectiveTool: true }), 32);
  assert.equal(miningSpeed(6, pick, { effectiveTool: false }), 6);
  assert.equal(miningSpeed(1, pick, { effectiveTool: true }), 1);
  assert.equal(
    miningSpeed(6, enchantedTool(ITEM.IRON_PICKAXE, { efficiency: 3 }), {
      effectiveTool: true,
    }),
    16
  );
  assert.equal(miningSpeed(1, null), 1);
});

test("Aqua Affinity removes underwater slowdown but does not erase airborne slowdown", () => {
  const pick = enchantedTool(ITEM.IRON_PICKAXE, { efficiency: 5 });
  const helmet = enchantedTool(ITEM.IRON_HELMET, { aqua_affinity: 1 });
  close(miningSpeed(6, pick, { effectiveTool: true, submerged: true }), 6.4);
  close(
    miningSpeed(6, pick, { effectiveTool: true, submerged: true, helmet }),
    32
  );
  close(
    miningSpeed(6, pick, {
      effectiveTool: true,
      submerged: true,
      onGround: false,
      helmet,
    }),
    6.4
  );
  close(
    miningSpeed(6, pick, {
      effectiveTool: true,
      submerged: true,
      onGround: false,
    }),
    1.28
  );
  assert.throws(() => miningSpeed(NaN, pick), RangeError);
  assert.throws(() => miningSpeed(6, pick, { effectiveTool: 1 }), RangeError);
});

test("Sharpness and conditional Smite add actual melee damage after the base critical component", () => {
  const sharp = enchantedTool(ITEM.IRON_SWORD, { sharpness: 3 });
  assert.equal(meleeDamage(10, sharp), 12);
  assert.equal(meleeDamage(15, sharp), 17);
  assert.equal(meleeDamage(10, sharp, { attackStrength: 0.5 }), 11);
  assert.equal(meleeDamage(10, sharp, { attackStrength: 0 }), 10);
  const smite = enchantedTool(ITEM.IRON_AXE, { smite: 2 });
  assert.equal(meleeDamage(10, smite), 10);
  assert.equal(meleeDamage(10, smite, { targetFamily: "undead" }), 15);
  assert.equal(meleeDamage(10, smite, { targetFamily: "arthropod" }), 10);
  assert.throws(
    () => meleeDamage(10, sharp, { attackStrength: 2 }),
    RangeError
  );
});

test("Power scales a bow projectile rather than adding generic melee damage", () => {
  const bow = enchantedTool(ITEM.BOW, { power: 4 });
  assert.equal(bowDamage(4, bow), 9);
  assert.equal(meleeDamage(4, bow), 4);
  assert.equal(bowDamage(4, enchantedTool(ITEM.BOW, { power: 5 })), 10);
  assert.equal(bowDamage(4, tool(ITEM.BOW)), 4);
  assert.throws(() => bowDamage(-1, bow), RangeError);
});

test("Protection sums EPF after armor/toughness and observes independent bypass classifications", () => {
  const armor = protectionArmor();
  close(reduceEnchantedDamage(10, armor), 3.6);
  close(reduceEnchantedDamage(reduceArmorDamage(20, 20, 12), armor), 2.592);
  close(reduceEnchantedDamage(10, armor, { damageType: "drowning" }), 3.6);
  for (const damageType of ["starvation", "void", "sonic_boom", "kill"])
    assert.equal(reduceEnchantedDamage(10, armor, { damageType }), 10);
  assert.equal(
    reduceEnchantedDamage(10, armor, { bypassesEnchantments: true }),
    10
  );
  assert.equal(reduceEnchantedDamage(10, {}), 10);
  assert.throws(
    () => reduceEnchantedDamage(10, { chest: armor.head }),
    RangeError
  );
});

test("Feather Falling covers fall and pearl damage and combined protection caps at EPF 20", () => {
  const armor = protectionArmor();
  armor.feet = enchantedTool(ITEM.IRON_BOOTS, {
    protection: 4,
    feather_falling: 4,
  });
  close(reduceEnchantedDamage(10, armor, { damageType: "fall" }), 2);
  close(reduceEnchantedDamage(10, armor, { damageType: "pearl" }), 2);
  close(reduceEnchantedDamage(10, armor, { damageType: "melee" }), 3.6);
  close(
    reduceEnchantedDamage(
      10,
      {
        feet: enchantedTool(ITEM.IRON_BOOTS, { feather_falling: 4 }),
      },
      { damageType: "fall" }
    ),
    5.2
  );
});

test("Projectile Protection contributes twice its level only for projectile damage", () => {
  const armor = protectionArmor();
  armor.head = enchantedTool(ITEM.IRON_HELMET, { projectile_protection: 4 });
  close(reduceEnchantedDamage(10, armor, { damageType: "projectile" }), 2);
  close(reduceEnchantedDamage(10, armor, { damageType: "fire" }), 5.2);
});

test("Respiration gives a precise 1/(L+1) air-decrement chance without a double damage roll", () => {
  const helmet = enchantedTool(ITEM.IRON_HELMET, { respiration: 3 });
  assert.equal(respirationAirLoss(helmet, 0.249), 1);
  assert.equal(respirationAirLoss(helmet, 0.25), 0);
  assert.deepEqual(
    [0.125, 0.375, 0.625, 0.875].map((roll) =>
      respirationAirLoss(helmet, roll)
    ),
    [1, 0, 0, 0]
  );
  assert.equal(respirationAirLoss(null, 0.99), 1);
  assert.equal(respirationAirLoss(tool(ITEM.IRON_HELMET), 0.99), 1);
  assert.throws(() => respirationAirLoss(helmet, 1), RangeError);
});

test("Depth Strider changes horizontal drag/acceleration with half interpolation off the ground", () => {
  const boots = enchantedTool(ITEM.IRON_BOOTS, { depth_strider: 3 });
  const grounded = waterMovement(boots);
  assert.equal(grounded.waterMovementEfficiency, 1);
  close(grounded.drag, 0.54600006);
  close(grounded.acceleration, 0.1);
  const floating = waterMovement(boots, { onGround: false });
  close(floating.drag, 0.67300003);
  close(floating.acceleration, 0.06);
  const first = waterMovement(
    enchantedTool(ITEM.IRON_BOOTS, { depth_strider: 1 })
  );
  close(first.waterMovementEfficiency, 1 / 3);
  close(first.acceleration, 0.02 + 0.08 / 3);
  assert.equal(Object.hasOwn(first, "verticalVelocity"), false);
  assert.deepEqual(waterMovement(null), {
    waterMovementEfficiency: 0,
    drag: 0.8,
    acceleration: 0.02,
  });
  assert.throws(
    () => waterMovement(boots, { waterDrag: Infinity }),
    RangeError
  );
});

test("Unbreaking applies different tool/armor wear chances and rolls per durability point", () => {
  const pick = enchantedTool(ITEM.IRON_PICKAXE, { unbreaking: 3 });
  const chest = enchantedTool(ITEM.IRON_ARMOR, { unbreaking: 3 });
  assert.equal(durabilityUseChance(pick), 0.25);
  close(durabilityUseChance(chest), 0.7);
  assert.equal(durabilityLoss(pick, [0, 0.249, 0.25, 0.9]), 2);
  assert.equal(durabilityLoss(chest, [0.699, 0.7, 0.9]), 1);
  assert.equal(durabilityLoss(tool(), [0.1, 0.2, 0.9]), 3);
  assert.equal(durabilityLoss(pick, []), 0);
  assert.throws(
    () => durabilityUseChance(materialStack(ITEM.APPLE)),
    RangeError
  );
  assert.throws(() => durabilityLoss(pick, [1]), RangeError);
  assert.throws(() => durabilityLoss(pick, [NaN]), RangeError);
});

test("Fortune ore distribution gives the documented exact multipliers and means", () => {
  const third = [0.1, 0.3, 0.5, 0.7, 0.9].map((roll) =>
    fortuneOreMultiplier(3, roll)
  );
  assert.deepEqual(third, [1, 1, 2, 3, 4]);
  close(third.reduce((a, b) => a + b, 0) / third.length, 2.2);
  const second = [0.125, 0.375, 0.625, 0.875].map((roll) =>
    fortuneOreMultiplier(2, roll)
  );
  assert.deepEqual(second, [1, 1, 2, 3]);
  close(second.reduce((a, b) => a + b, 0) / second.length, 1.75);
  assert.equal(fortuneOreMultiplier(0, 0.999), 1);
  assert.throws(() => fortuneOreMultiplier(4, 0), RangeError);
  assert.throws(() => fortuneOreMultiplier(3, -0.1), RangeError);
});

test("Fortune uniform bonus, caps and binomial crop trials are numerical rather than tooltip-only", () => {
  assert.equal(fortuneUniformCount(4, 3, 0.99), 7);
  assert.equal(fortuneUniformCount(4, 3, 0.99, { maximum: 4 }), 4);
  assert.equal(fortuneUniformCount(2, 3, 0.99, { maximum: 5 }), 5);
  assert.equal(fortuneUniformCount(7, 3, 0.99, { maximum: 9 }), 9);
  assert.equal(fortuneUniformCount(1, 3, 0.99, { bonusMultiplier: 2 }), 7);
  assert.equal(fortuneUniformCount(4, 0, 0.99), 4);
  assert.equal(fortuneBinomialCount(1, 0, [0.1, 0.6, 0.8]), 2);
  assert.equal(fortuneBinomialCount(1, 3, [0.1, 0.2, 0.3, 0.4, 0.7, 0.8]), 5);
  assert.equal(fortuneBinomialCount(2, 3, Array(6).fill(0.1)), 8);
  assert.equal(fortuneBinomialCount(1, 0, Array(3).fill(4 / 7)), 1);
  assert.throws(() => fortuneBinomialCount(1, 3, [0.1]), RangeError);
  assert.throws(() => fortuneUniformCount(1.5, 2, 0.1), RangeError);
});

test("Fortune tabulated profiles use vanilla non-linear chances, not a generic multiplier", () => {
  assert.deepEqual(
    [0, 1, 2, 3].map((value) => fortuneDropChance("gravel", value)),
    [1 / 10, 1 / 7, 1 / 4, 1]
  );
  assert.equal(fortuneDropChance("gilded_blackstone", 3), 1);
  assert.equal(fortuneDropChance("jungle_sapling", 3), 1 / 24);
  assert.equal(fortuneDropChance("sapling", 3), 1 / 10);
  assert.equal(fortuneDropChance("leaf_stick", 2), 1 / 40);
  assert.equal(fortuneDropChance("apple", 3), 1 / 120);
  assert.equal(fortuneDropChance("vine", 3), 1);
  assert.throws(() => fortuneDropChance("__proto__", 1), RangeError);
});

test("Silk Touch chooses only explicit registered drops, suppresses XP, and preserves harvest permission", () => {
  const pick = enchantedTool(ITEM.IRON_PICKAXE, { silk_touch: 1 });
  const normalDrops = [materialStack(ITEM.DIAMOND, 3)];
  const silkDrops = [materialStack(BLOCK.DIAMOND_ORE)];
  const result = selectSilkTouchDrops(pick, {
    normalDrops,
    silkDrops,
    experience: 5,
  });
  assert.deepEqual(result, {
    drops: silkDrops,
    experience: 0,
    silkTouch: true,
  });
  assert.deepEqual(
    selectSilkTouchDrops(tool(), { normalDrops, silkDrops, experience: 5 }),
    {
      drops: normalDrops,
      experience: 5,
      silkTouch: false,
    }
  );
  assert.deepEqual(
    selectSilkTouchDrops(pick, { normalDrops, silkDrops: null, experience: 5 }),
    {
      drops: normalDrops,
      experience: 5,
      silkTouch: false,
    }
  );
  assert.deepEqual(
    selectSilkTouchDrops(pick, {
      normalDrops,
      silkDrops,
      experience: 5,
      canHarvest: false,
    }),
    {
      drops: [],
      experience: 0,
      silkTouch: false,
    }
  );
  silkDrops[0].count = 9;
  assert.equal(result.drops[0].count, 1);
  assert.ok(Object.isFrozen(result.drops[0]));
  assert.throws(
    () =>
      selectSilkTouchDrops(pick, {
        normalDrops,
        silkDrops: [{ id: -1, count: 1 }],
      }),
    RangeError
  );
});

test("Mending repairs at two durability per XP and returns a detached immutable equipment plan", () => {
  const equipment = {
    main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 10),
  };
  const before = JSON.stringify(equipment);
  const result = planMendingExperience(equipment, 5, [0.5]);
  assert.equal(result.equipment.main.durability, 20);
  assert.equal(result.repaired, 10);
  assert.equal(result.experienceSpent, 5);
  assert.equal(result.experienceRemaining, 0);
  assert.equal(result.drawsUsed, 1);
  assert.equal(JSON.stringify(equipment), before);
  assert.ok(Object.isFrozen(result.equipment.main.data.enchantments));
  assert.notEqual(result.equipment.main, equipment.main);
});

test("Mending selection is uniform over damaged held/equipped gear, not biased to a slot or lower wear", () => {
  const equipment = {
    main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 1),
    offhand: enchantedTool(ITEM.BOW, { mending: 1 }, 300),
    head: enchantedTool(ITEM.IRON_HELMET, { mending: 1 }),
  };
  const first = planMendingExperience(equipment, 5, [0.25]);
  assert.equal(first.equipment.main.durability, 11);
  assert.equal(first.equipment.offhand.durability, 300);
  const second = planMendingExperience(equipment, 5, [0.75]);
  assert.equal(second.equipment.main.durability, 1);
  assert.equal(second.equipment.offhand.durability, 310);
  assert.equal(
    second.equipment.head.durability,
    getItem(ITEM.IRON_HELMET).durability
  );
});

test("Mending reuses only remaining XP between candidates and rounds an odd final point down", () => {
  const equipment = {
    main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 248),
    offhand: enchantedTool(ITEM.BOW, { mending: 1 }, 300),
  };
  const result = planMendingExperience(equipment, 5, [0, 0]);
  assert.equal(result.equipment.main.durability, 250);
  assert.equal(result.equipment.offhand.durability, 308);
  assert.equal(result.repaired, 10);
  assert.equal(result.experienceSpent, 5);
  assert.equal(result.drawsUsed, 2);
  const odd = planMendingExperience(
    {
      main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 249),
    },
    5,
    [0]
  );
  assert.equal(odd.repaired, 1);
  assert.equal(odd.experienceSpent, 0);
  assert.equal(odd.experienceRemaining, 5);
});

test("Mending ignores full/unenchanted gear, rejects backpack repair, and cannot consume absent RNG samples", () => {
  const full = planMendingExperience(
    {
      main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }),
      offhand: tool(ITEM.BOW, 10),
    },
    5,
    []
  );
  assert.equal(full.repaired, 0);
  assert.equal(full.experienceRemaining, 5);
  assert.equal(full.drawsUsed, 0);
  const equipment = {
    main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 10),
  };
  const before = JSON.stringify(equipment);
  assert.throws(() => planMendingExperience(equipment, 5, []), RangeError);
  assert.equal(JSON.stringify(equipment), before);
  assert.throws(
    () => planMendingExperience({ backpack: equipment.main }, 5, [0]),
    RangeError
  );
  assert.throws(
    () => planMendingExperience({ head: equipment.main }, 5, [0]),
    RangeError
  );
  assert.throws(() => planMendingExperience(equipment, -1, [0]), RangeError);
});

test("Lure reduces wait ticks without converting nonpositive waits into instant bites", () => {
  assert.equal(fishingWaitTicks(600, 0), 600);
  assert.equal(fishingWaitTicks(500, 3), 200);
  assert.equal(fishingWaitTicks(100, 1), 0);
  assert.equal(fishingWaitTicks(100, 3), -200);
  assert.throws(() => fishingWaitTicks(99, 1), RangeError);
  assert.throws(() => fishingWaitTicks(601, 1), RangeError);
  assert.throws(() => fishingWaitTicks(200, 4), RangeError);
});

test("Luck of the Sea changes exact weights and open-water failure removes treasure", () => {
  assert.deepEqual(fishingLootWeights(0, { openWater: true }), {
    fish: 85,
    junk: 10,
    treasure: 5,
  });
  assert.deepEqual(fishingLootWeights(3, { openWater: true }), {
    fish: 82,
    junk: 4,
    treasure: 11,
  });
  assert.deepEqual(fishingLootWeights(3), { fish: 82, junk: 4, treasure: 0 });
  assert.deepEqual(fishingLootWeights(1, { luck: 1, openWater: true }), {
    fish: 83,
    junk: 6,
    treasure: 9,
  });
  assert.deepEqual(fishingLootWeights(0, { luck: -3, openWater: true }), {
    fish: 88,
    junk: 16,
    treasure: 0,
  });
  close(11 / (82 + 4 + 11), 0.1134020618556701);
  assert.throws(() => fishingLootWeights(4), RangeError);
  assert.throws(() => fishingLootWeights(1, { openWater: 1 }), RangeError);
});

test("registered fishing metadata drives real timing, luck and durability helpers", () => {
  const rod = registeredFishingRod({
    lure: 3,
    luck_of_the_sea: 2,
    unbreaking: 3,
  });
  assert.equal(fishingWaitTicks(500, activeEnchantmentLevel(rod, "lure")), 200);
  assert.deepEqual(
    fishingLootWeights(activeEnchantmentLevel(rod, "luck_of_the_sea"), {
      openWater: true,
    }),
    { fish: 83, junk: 6, treasure: 9 }
  );
  assert.equal(durabilityUseChance(rod), 0.25);
  assert.ok(getSupportedEnchantments().includes("lure"));
  assert.ok(getSupportedEnchantments().includes("luck_of_the_sea"));
});

test("enchanted-book carriers never grant held armor, combat, breathing or movement effects", () => {
  const book = enchantedBook({
    sharpness: 5,
    unbreaking: 3,
    respiration: 3,
    depth_strider: 3,
  });
  assert.equal(activeEnchantmentLevel(book, "sharpness"), 0);
  assert.equal(meleeDamage(3, book), 3);
  assert.equal(respirationAirLoss(book, 0.9), 1);
  assert.equal(waterMovement(book).waterMovementEfficiency, 0);
  assert.throws(() => durabilityUseChance(book), RangeError);
  assert.equal(activeEnchantmentLevel(tool(), "unknown"), 0);
});

test("sparse RNG/drop arrays reject instead of silently granting free wear, repair or missing loot", () => {
  const pick = enchantedTool(ITEM.IRON_PICKAXE, { unbreaking: 3 });
  assert.throws(() => durabilityLoss(pick, Array(1)), RangeError);
  assert.throws(() => fortuneBinomialCount(1, 0, Array(3)), RangeError);
  assert.throws(
    () =>
      planMendingExperience(
        {
          main: enchantedTool(ITEM.IRON_PICKAXE, { mending: 1 }, 10),
        },
        5,
        Array(1)
      ),
    RangeError
  );
  assert.throws(
    () => selectSilkTouchDrops(pick, { normalDrops: Array(1) }),
    RangeError
  );
  assert.throws(
    () =>
      selectSilkTouchDrops(pick, {
        normalDrops: [],
        silkDrops: Array(1),
      }),
    RangeError
  );
});
