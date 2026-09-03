import assert from "node:assert/strict";
import test from "node:test";
import {
  ARMOR_MATERIALS,
  ARMOR_SLOTS,
  getArmorSpec,
  getToolSpec,
  reduceArmorDamage,
  TOOL_KINDS,
  TOOL_MATERIALS,
} from "../src/gear.js";

const tools = ["pickaxe", "axe", "sword", "shovel", "hoe"];
const slots = ["head", "chest", "legs", "feet"];
const upgrade = {
  baseMaterial: "diamond",
  ingredient: "minecraft:netherite_ingot",
  template: "minecraft:netherite_upgrade_smithing_template",
};

// Independent Java reference fixtures, intentionally pinning the requested
// parity tables, including the copper Java/Bedrock and copper-boots discrepancies.
// Columns: material, durability, harvest level, mining efficiency, enchantability,
// repair alternatives, attack damage by tool, attack speed by tool.
const toolCases = [
  [
    "wood",
    59,
    0,
    2,
    15,
    ["#minecraft:planks"],
    [2, 7, 4, 2.5, 1],
    [1.2, 0.8, 1.6, 1, 1],
  ],
  [
    "gold",
    32,
    0,
    12,
    22,
    ["minecraft:gold_ingot"],
    [2, 7, 4, 2.5, 1],
    [1.2, 1, 1.6, 1, 1],
  ],
  [
    "stone",
    131,
    1,
    4,
    5,
    [
      "minecraft:cobblestone",
      "minecraft:cobbled_deepslate",
      "minecraft:blackstone",
    ],
    [3, 9, 5, 3.5, 1],
    [1.2, 0.8, 1.6, 1, 2],
  ],
  [
    "copper",
    190,
    1,
    5,
    13,
    ["minecraft:copper_ingot"],
    [3, 9, 5, 3.5, 1],
    [1.2, 0.8, 1.6, 1, 2],
  ],
  [
    "iron",
    250,
    2,
    6,
    14,
    ["minecraft:iron_ingot"],
    [4, 9, 6, 4.5, 1],
    [1.2, 0.9, 1.6, 1, 3],
  ],
  [
    "diamond",
    1561,
    3,
    8,
    10,
    ["minecraft:diamond"],
    [5, 9, 7, 5.5, 1],
    [1.2, 1, 1.6, 1, 4],
  ],
  [
    "netherite",
    2031,
    4,
    9,
    15,
    ["minecraft:netherite_ingot"],
    [6, 10, 8, 6.5, 1],
    [1.2, 1, 1.6, 1, 4],
  ],
];

// Columns: material, multiplier, slot durabilities, slot armor points,
// enchantability, toughness per piece, repair ingredient, full-set armor,
// full-set toughness.
const armorCases = [
  [
    "leather",
    5,
    [55, 80, 75, 65],
    [1, 3, 2, 1],
    15,
    0,
    "minecraft:leather",
    7,
    0,
  ],
  [
    "copper",
    11,
    [121, 176, 165, 143],
    [2, 4, 3, 1],
    8,
    0,
    "minecraft:copper_ingot",
    10,
    0,
  ],
  [
    "gold",
    7,
    [77, 112, 105, 91],
    [2, 5, 3, 1],
    25,
    0,
    "minecraft:gold_ingot",
    11,
    0,
  ],
  [
    "chainmail",
    15,
    [165, 240, 225, 195],
    [2, 5, 4, 1],
    12,
    0,
    "minecraft:iron_ingot",
    12,
    0,
  ],
  [
    "iron",
    15,
    [165, 240, 225, 195],
    [2, 6, 5, 2],
    9,
    0,
    "minecraft:iron_ingot",
    15,
    0,
  ],
  [
    "diamond",
    33,
    [363, 528, 495, 429],
    [3, 8, 6, 3],
    10,
    2,
    "minecraft:diamond",
    20,
    8,
  ],
  [
    "netherite",
    37,
    [407, 592, 555, 481],
    [3, 8, 6, 3],
    15,
    3,
    "minecraft:netherite_ingot",
    20,
    12,
  ],
];

test("reference keys expose exactly the supported material, tool, and slot sets", () => {
  assert.deepEqual(TOOL_KINDS, tools);
  assert.deepEqual(ARMOR_SLOTS, slots);
  assert.deepEqual(
    Object.keys(TOOL_MATERIALS),
    toolCases.map(([name]) => name)
  );
  assert.deepEqual(Object.keys(ARMOR_MATERIALS), [
    ...armorCases.map(([name]) => name),
    "turtle",
  ]);
});

for (const [
  material,
  durability,
  harvestLevel,
  miningEfficiency,
  enchantability,
  repairIngredients,
  damage,
  speed,
] of toolCases) {
  test(`${material} tools match all five Java combat and material specifications`, () => {
    const craftable = material !== "netherite";
    const smithingUpgrade = craftable ? null : upgrade;
    assert.deepEqual(TOOL_MATERIALS[material], {
      durability,
      harvestLevel,
      miningEfficiency,
      enchantability,
      repairIngredients,
      craftable,
      smithingUpgrade,
      attackDamage: Object.fromEntries(
        tools.map((tool, index) => [tool, damage[index]])
      ),
      attackSpeed: Object.fromEntries(
        tools.map((tool, index) => [tool, speed[index]])
      ),
    });
    for (const [index, tool] of tools.entries()) {
      const spec = getToolSpec(material, tool);
      assert.deepEqual(spec, {
        material,
        tool,
        durability,
        harvestLevel,
        ...(tool === "sword" ? {} : { miningEfficiency }),
        enchantability,
        repairIngredients,
        craftable,
        smithingUpgrade,
        attackDamage: damage[index],
        attackSpeed: speed[index],
        repairDurabilityPerUnit: Math.floor(durability / 4),
      });
      assert.equal(Object.hasOwn(spec, "id"), false);
      assert.equal(Object.hasOwn(spec, "tier"), false);
    }
  });
}

for (const [
  material,
  durabilityMultiplier,
  durabilities,
  points,
  enchantability,
  toughness,
  repairIngredient,
  totalArmor,
  totalToughness,
] of armorCases) {
  test(`${material} armor matches every Java slot and full-set total`, () => {
    const craftable = material !== "chainmail" && material !== "netherite";
    const smithingUpgrade = material === "netherite" ? upgrade : null;
    const knockbackResistance = material === "netherite" ? 0.1 : 0;
    assert.deepEqual(ARMOR_MATERIALS[material], {
      durabilityMultiplier,
      armorPoints: Object.fromEntries(
        slots.map((slot, index) => [slot, points[index]])
      ),
      toughness,
      knockbackResistance,
      enchantability,
      repairIngredients: [repairIngredient],
      craftable,
      smithingUpgrade,
    });
    const specs = slots.map((slot) => getArmorSpec(material, slot));
    for (const [index, spec] of specs.entries()) {
      assert.deepEqual(spec, {
        material,
        slot: slots[index],
        durability: durabilities[index],
        armorPoints: points[index],
        toughness,
        knockbackResistance,
        enchantability,
        repairIngredients: [repairIngredient],
        craftable,
        smithingUpgrade,
        repairDurabilityPerUnit: Math.floor(durabilities[index] / 4),
      });
      assert.equal(Object.hasOwn(spec, "id"), false);
      assert.equal(Object.hasOwn(spec, "tier"), false);
    }
    assert.equal(
      specs.reduce((sum, spec) => sum + spec.armorPoints, 0),
      totalArmor
    );
    assert.equal(
      specs.reduce((sum, spec) => sum + spec.toughness, 0),
      totalToughness
    );
    assert.equal(
      specs.reduce((sum, spec) => sum + spec.knockbackResistance, 0),
      material === "netherite" ? 0.4 : 0
    );
  });
}

test("iron chestplate reference preserves the shipped 240-durability save contract", () => {
  const chestplate = getArmorSpec("iron", "chest");
  assert.equal(chestplate.durability, 240);
  assert.equal(chestplate.armorPoints, 6);
});

test("turtle shell is only a helmet and does not fabricate the unused turtle set", () => {
  assert.deepEqual(ARMOR_MATERIALS.turtle, {
    durabilityMultiplier: 25,
    armorPoints: { head: 2 },
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 9,
    repairIngredients: ["minecraft:turtle_scute"],
    craftable: true,
    smithingUpgrade: null,
  });
  assert.deepEqual(getArmorSpec("turtle", "head"), {
    material: "turtle",
    slot: "head",
    durability: 275,
    armorPoints: 2,
    toughness: 0,
    knockbackResistance: 0,
    enchantability: 9,
    repairIngredients: ["minecraft:turtle_scute"],
    craftable: true,
    smithingUpgrade: null,
    repairDurabilityPerUnit: 68,
  });
  for (const slot of ["chest", "legs", "feet"]) {
    assert.throws(() => getArmorSpec("turtle", slot), RangeError);
  }
});

test("unit repair rounds down instead of claiming every item repairs in four units", () => {
  for (const [material, amount] of [
    ["wood", 14],
    ["gold", 8],
    ["stone", 32],
    ["copper", 47],
    ["iron", 62],
    ["diamond", 390],
    ["netherite", 507],
  ]) {
    for (const tool of tools)
      assert.equal(getToolSpec(material, tool).repairDurabilityPerUnit, amount);
  }
  assert.equal(getArmorSpec("copper", "feet").repairDurabilityPerUnit, 35);
  assert.equal(getArmorSpec("iron", "chest").repairDurabilityPerUnit, 60);
  assert.equal(getArmorSpec("netherite", "chest").repairDurabilityPerUnit, 148);
});

test("noncraftable armor and smithing upgrades stay distinct from repair ingredients", () => {
  for (const slot of slots) {
    const chainmail = getArmorSpec("chainmail", slot);
    assert.equal(chainmail.craftable, false);
    assert.equal(chainmail.smithingUpgrade, null);
    assert.deepEqual(chainmail.repairIngredients, ["minecraft:iron_ingot"]);
    const netherite = getArmorSpec("netherite", slot);
    assert.equal(netherite.craftable, false);
    assert.deepEqual(netherite.smithingUpgrade, upgrade);
    assert.deepEqual(netherite.repairIngredients, [
      "minecraft:netherite_ingot",
    ]);
  }
  for (const tool of tools) {
    const spec = getToolSpec("netherite", tool);
    assert.equal(spec.craftable, false);
    assert.deepEqual(spec.smithingUpgrade, upgrade);
  }
});

test("all exported tables, nested records, and arrays are deeply frozen and unaliased", () => {
  for (const value of [
    TOOL_KINDS,
    ARMOR_SLOTS,
    TOOL_MATERIALS,
    ARMOR_MATERIALS,
  ])
    assertDeepFrozen(value);
  assertUnaliased(TOOL_MATERIALS, ARMOR_MATERIALS);
  for (const table of [TOOL_MATERIALS, ARMOR_MATERIALS]) {
    const materials = Object.values(table);
    for (let i = 0; i < materials.length; i++) {
      for (let j = i + 1; j < materials.length; j++)
        assertUnaliased(materials[i], materials[j]);
    }
  }
  assert.throws(() => {
    TOOL_MATERIALS.iron.durability = 1;
  }, TypeError);
  assert.throws(() => {
    ARMOR_MATERIALS.copper.armorPoints.feet = 2;
  }, TypeError);
  assert.throws(() => {
    TOOL_MATERIALS.stone.repairIngredients.push("minecraft:dirt");
  }, TypeError);
  assert.throws(() => {
    delete ARMOR_MATERIALS.turtle.armorPoints.head;
  }, TypeError);
  assert.throws(() => {
    TOOL_KINDS.push("spear");
  }, TypeError);
});

test("every lookup returns a fresh, deeply frozen snapshot, including nested repair and upgrade data", () => {
  const factories = [
    ...Object.keys(TOOL_MATERIALS).flatMap((material) =>
      tools.map((tool) => () => getToolSpec(material, tool))
    ),
    ...Object.entries(ARMOR_MATERIALS).flatMap(([material, entry]) =>
      Object.keys(entry.armorPoints).map(
        (slot) => () => getArmorSpec(material, slot)
      )
    ),
  ];
  const previous = [];
  for (const create of factories) {
    const first = create();
    const second = create();
    assert.deepEqual(first, second);
    assertDeepFrozen(first);
    assertDeepFrozen(second);
    assertUnaliased(first, second);
    assertUnaliased(first, TOOL_MATERIALS);
    assertUnaliased(first, ARMOR_MATERIALS);
    for (const other of previous) assertUnaliased(first, other);
    previous.push(first);
    assert.throws(() => {
      first.durability = 0;
    }, TypeError);
    assert.throws(() => {
      first.repairIngredients[0] = "minecraft:dirt";
    }, TypeError);
    if (first.smithingUpgrade) {
      assert.throws(() => {
        first.smithingUpgrade.baseMaterial = "wood";
      }, TypeError);
    }
    assert.deepEqual(create(), second);
  }
});

test("reference records are plain serializable data and detached mutable copies cannot affect them", () => {
  const original = getToolSpec("netherite", "axe");
  const copy = JSON.parse(JSON.stringify(original));
  assert.deepEqual(copy, original);
  copy.repairIngredients[0] = "minecraft:dirt";
  copy.smithingUpgrade.baseMaterial = "wood";
  copy.durability = 0;
  assert.equal(original.durability, 2031);
  assert.deepEqual(original.repairIngredients, ["minecraft:netherite_ingot"]);
  assert.deepEqual(original.smithingUpgrade, upgrade);
  assert.deepEqual(getToolSpec("netherite", "axe"), original);
});

test("lookups reject unknown, cross-category, case-mismatched, and inherited keys", () => {
  const unsupported = [
    "",
    "IRON",
    " iron",
    "iron ",
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
  ];
  for (const material of [...unsupported, "leather", "chainmail", "turtle"])
    assert.throws(() => getToolSpec(material, "pickaxe"), RangeError);
  for (const material of [...unsupported, "wood", "stone", "armadillo"])
    assert.throws(() => getArmorSpec(material, "head"), RangeError);
  for (const tool of [...unsupported, "bow", "spear", "firestarter", "head"])
    assert.throws(() => getToolSpec("iron", tool), RangeError);
  for (const slot of [
    ...unsupported,
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "body",
    "offhand",
  ])
    assert.throws(() => getArmorSpec("iron", slot), RangeError);
});

test("lookup selectors never coerce numbers, arrays, objects, or symbols", () => {
  const coercible = {
    toString() {
      throw new Error("selector must not be coerced");
    },
  };
  for (const value of [
    undefined,
    null,
    false,
    1,
    0n,
    Symbol("iron"),
    [],
    ["iron"],
    {},
    coercible,
  ]) {
    assert.throws(() => getToolSpec(value, "pickaxe"), TypeError);
    assert.throws(() => getToolSpec("iron", value), TypeError);
    assert.throws(() => getArmorSpec(value, "head"), TypeError);
    assert.throws(() => getArmorSpec("iron", value), TypeError);
  }
});

test("Java damage/toughness reduction matches exact reference cases and breakpoints", () => {
  // Columns: incoming HP, armor points, toughness, HP taken.
  for (const [damage, armor, toughness, expected] of [
    [10, 15, 0, 6],
    [20, 20, 12, 7.2],
    [20, 20, 8, 8],
    [20, 20, 0, 12],
    [1, 20, 0, 0.22],
    [10, 7, 0, 9.2],
    [100, 20, 0, 84],
    [100, 20, 12, 84],
    [23.5, 15, 0, 20.445],
    [24, 15, 0, 21.12],
    [24.5, 15, 0, 21.56],
    [0.5, 2.5, 0, 0.455],
  ]) {
    assertClose(reduceArmorDamage(damage, armor, toughness), expected);
  }
  assert.equal(reduceArmorDamage(10, 15), 6);
  assert.equal(reduceArmorDamage(10, 15, undefined), 6);
});

test("zero damage and zero armor do not create damage or allow toughness alone to protect", () => {
  for (const damage of [0, -0, 0.5, 10, Number.MAX_VALUE]) {
    for (const toughness of [0, 12, 20]) {
      assert.equal(
        reduceArmorDamage(damage, 0, toughness),
        damage === 0 ? 0 : damage
      );
      assert.equal(
        reduceArmorDamage(damage, -0, toughness),
        damage === 0 ? 0 : damage
      );
    }
  }
  assert.equal(reduceArmorDamage(0, 20, 12), 0);
  assert.equal(Object.is(reduceArmorDamage(-0, 20, 12), -0), false);
});

test("effective protection caps at 80% without prematurely clamping armor points to 20", () => {
  assertClose(reduceArmorDamage(10, 30, 0), 2);
  assertClose(reduceArmorDamage(100, 30, 0), 76);
  assertClose(reduceArmorDamage(100, 100, 0), 20);
  for (const toughness of [20, 21, 100, Number.MAX_VALUE])
    assertClose(reduceArmorDamage(20, 20, toughness), 44 / 7);
});

test("damage reduction stays finite and bounded even for extreme finite inputs", () => {
  for (const damage of [0, Number.MIN_VALUE, 0.5, 10, 100, Number.MAX_VALUE]) {
    for (const armor of [0, 1, 15, 20, 30, Number.MAX_VALUE]) {
      for (const toughness of [0, 3, 8, 12, 20, Number.MAX_VALUE]) {
        const reduced = reduceArmorDamage(damage, armor, toughness);
        assert.ok(Number.isFinite(reduced));
        assert.ok(reduced >= 0 && reduced <= damage);
        assert.ok(reduced >= damage * (0.2 - Number.EPSILON));
      }
    }
  }
});

test("negative or nonfinite inputs throw even when another input would short-circuit", () => {
  for (const invalid of [-1, -0.5, NaN, Infinity, -Infinity]) {
    for (const args of [
      [invalid, 15, 0],
      [10, invalid, 0],
      [10, 15, invalid],
      [invalid, 0, 0],
      [0, invalid, 0],
      [0, 0, invalid],
    ])
      assert.throws(() => reduceArmorDamage(...args), RangeError);
  }
});

test("damage inputs are numeric only, without implicit coercion or hidden defaults", () => {
  for (const invalid of [
    null,
    false,
    true,
    "10",
    [],
    [10],
    {},
    10n,
    Symbol("damage"),
  ]) {
    assert.throws(() => reduceArmorDamage(invalid, 15), TypeError);
    assert.throws(() => reduceArmorDamage(10, invalid), TypeError);
    assert.throws(() => reduceArmorDamage(10, 15, invalid), TypeError);
    assert.throws(() => reduceArmorDamage(0, 0, invalid), TypeError);
  }
  assert.throws(() => reduceArmorDamage(), TypeError);
  assert.throws(() => reduceArmorDamage(10), TypeError);
});

function assertClose(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)),
    `expected ${expected}, received ${actual}`
  );
}

function assertDeepFrozen(value) {
  for (const reference of objectReferences(value))
    assert.equal(Object.isFrozen(reference), true);
}

function assertUnaliased(first, second) {
  const references = objectReferences(first);
  for (const reference of objectReferences(second))
    assert.equal(references.has(reference), false);
}

function objectReferences(value) {
  const references = new Set();
  const visit = (entry) => {
    if (entry === null || typeof entry !== "object" || references.has(entry))
      return;
    references.add(entry);
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return references;
}
