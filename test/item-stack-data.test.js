import assert from "node:assert/strict";
import test from "node:test";
import {
  cloneStackData,
  ENCHANTMENTS,
  enchantmentLevel,
  getEnchantment,
  MAX_REPAIR_COST,
  MAX_STACK_ENCHANTMENTS,
  MAX_STACK_NAME_LENGTH,
  normalizeEnchantments,
  normalizeMapTarget,
  normalizePotionData,
  normalizeStackData,
  normalizeStackDataSchema,
  resolveItemStats,
  sameStackKind,
  stackDataIdentity,
  stackIdentity,
} from "../src/item-stack-data.js";
import {
  cloneStack,
  isMergeable,
  isValidStack,
} from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { createWorldContext } from "../src/world-spec.js";

const pickaxe = (data, durability = 17) => ({
  id: ITEM.IRON_PICKAXE,
  count: 1,
  durability,
  ...(data === undefined ? {} : { data }),
});
const enchanted = {
  version: 1,
  enchantments: { unbreaking: 3, efficiency: 5 },
  name: "North:gate | pick",
  repairCost: 3,
};

test("metadata normalizes field/enchantment order and every clone detaches its records", () => {
  const source = structuredClone(enchanted);
  const normalized = normalizeStackData(ITEM.IRON_PICKAXE, source);
  assert.deepEqual(Object.keys(normalized.enchantments), [
    "efficiency",
    "unbreaking",
  ]);
  const reordered = {
    repairCost: 3,
    name: source.name,
    enchantments: { efficiency: 5, unbreaking: 3 },
    version: 1,
  };
  assert.equal(
    JSON.stringify(normalized),
    JSON.stringify(normalizeStackData(ITEM.IRON_PICKAXE, reordered))
  );
  source.enchantments.efficiency = 1;
  assert.equal(normalized.enchantments.efficiency, 5);
  const copied = cloneStackData(normalized);
  copied.enchantments.unbreaking = 1;
  assert.equal(normalized.enchantments.unbreaking, 3);
  const stack = cloneStack(pickaxe(normalized));
  stack.data.enchantments.efficiency = 2;
  assert.equal(normalized.enchantments.efficiency, 5);
});

test("plain stacks retain their legacy serialized shape, including empty v1 normalization", () => {
  const plain = { id: ITEM.APPLE, count: 3 };
  assert.equal(normalizeStackData(plain.id, undefined), undefined);
  assert.equal(cloneStackData(undefined), undefined);
  assert.equal(
    normalizeStackData(plain.id, {
      version: 1,
      enchantments: {},
      repairCost: 0,
    }),
    undefined
  );
  assert.equal(JSON.stringify(cloneStack(plain)), JSON.stringify(plain));
  assert.deepEqual(cloneStack({ ...plain, data: { version: 1 } }), plain);
  assert.equal(Object.hasOwn(cloneStack(pickaxe()), "data"), false);
});

test("unknown versions, arbitrary nested JSON, invalid levels and ineligible metadata reject", () => {
  const bad = [
    null,
    [],
    {},
    { version: 0 },
    { version: 2, name: "Do not strip" },
    { version: "1" },
    { version: 1, arbitrary: { nested: true } },
    { version: 1, enchantments: [] },
    { version: 1, enchantments: { made_up: 1 } },
    { version: 1, enchantments: { efficiency: 0 } },
    { version: 1, enchantments: { efficiency: -1 } },
    { version: 1, enchantments: { efficiency: 1.5 } },
    { version: 1, enchantments: { efficiency: "1" } },
    {
      version: 1,
      enchantments: { efficiency: getEnchantment("efficiency").maxLevel + 1 },
    },
    { version: 1, enchantments: { efficiency: { level: 1 } } },
    { version: 1, enchantments: { fortune: 1, silk_touch: 1 } },
    { version: 1, repairCost: -1 },
    { version: 1, repairCost: MAX_REPAIR_COST + 1 },
    { version: 1, repairCost: 1.5 },
    { version: 1, repairCost: Infinity },
  ];
  for (const data of bad) {
    assert.throws(
      () => normalizeStackData(ITEM.IRON_PICKAXE, data),
      RangeError
    );
    assert.equal(isValidStack(pickaxe(data)), false);
    assert.throws(() => cloneStack(pickaxe(data)), RangeError);
  }
  for (const [id, enchantments] of [
    [ITEM.APPLE, { unbreaking: 1 }],
    [ITEM.IRON_HELMET, { efficiency: 1 }],
    [ITEM.IRON_PICKAXE, { protection: 1 }],
    [ITEM.SHIELD, { protection: 1 }],
    [ITEM.BOW, { sharpness: 1 }],
    [ITEM.IRON_SWORD, { sharpness: 1, smite: 1 }],
    [ITEM.IRON_BOOTS, { depth_strider: 1, frost_walker: 1 }],
    [ITEM.BOW, { infinity: 1, mending: 1 }],
  ])
    assert.throws(
      () => normalizeStackData(id, { version: 1, enchantments }),
      RangeError
    );
  assert.throws(
    () => normalizeStackData(ITEM.APPLE, { version: 1, repairCost: 1 }),
    RangeError
  );
  assert.throws(() => normalizeStackData(-1, undefined), RangeError);
  assert.equal(getEnchantment("__proto__"), null);
  const tooMany = Object.fromEntries(
    Object.keys(ENCHANTMENTS)
      .slice(0, MAX_STACK_ENCHANTMENTS + 1)
      .map((name) => [name, 1])
  );
  assert.throws(() => normalizeEnchantments(tooMany), /Too many enchantments/);
});

test("metadata rejects custom prototypes, accessors and hidden/symbol fields without invoking them", () => {
  const getter = Object.defineProperty({ version: 1 }, "name", {
    enumerable: true,
    get: () => assert.fail("metadata accessors must not execute"),
  });
  const hidden = Object.defineProperty({ version: 1 }, "unknown", {
    value: true,
  });
  const symbol = { version: 1, [Symbol("unknown")]: true };
  const inherited = Object.assign(Object.create({ name: "inherited" }), {
    version: 1,
  });
  for (const data of [getter, hidden, symbol, inherited, new Date()])
    assert.throws(() => normalizeStackDataSchema(data), RangeError);
  assert.throws(
    () => normalizeEnchantments(JSON.parse('{"__proto__":1}')),
    RangeError
  );
});

test("names remain bounded literal text while control/bidi/surrogate strings reject", () => {
  const name = '<b>Tool</b> : ["|", ","]';
  assert.equal(normalizeStackData(ITEM.APPLE, { version: 1, name }).name, name);
  for (const name of [
    "",
    "   ",
    "x".repeat(MAX_STACK_NAME_LENGTH + 1),
    "a\nb",
    "a\tb",
    "a\u0000b",
    "a\u007fb",
    "a\u0085b",
    "a\u202eb",
    "\ud800",
  ])
    assert.throws(
      () => normalizeStackData(ITEM.APPLE, { version: 1, name }),
      RangeError
    );
  assert.equal(
    normalizeStackData(ITEM.APPLE, {
      version: 1,
      name: "🪨".repeat(MAX_STACK_NAME_LENGTH),
    }).name.length,
    MAX_STACK_NAME_LENGTH * 2
  );
});

test("kind identity includes canonical ID/data but excludes count/wear and never merges tools", () => {
  const a = pickaxe(enchanted, 7);
  const b = pickaxe(
    {
      name: enchanted.name,
      version: 1,
      repairCost: 3,
      enchantments: { efficiency: 5, unbreaking: 3 },
    },
    90
  );
  assert.equal(stackIdentity(a), stackIdentity(b));
  assert.equal(sameStackKind(a, b), true);
  assert.equal(isMergeable(a, b), false);
  assert.equal(sameStackKind(a, pickaxe()), false);
  assert.equal(
    sameStackKind(
      a,
      pickaxe({ ...enchanted, enchantments: { efficiency: 4, unbreaking: 3 } })
    ),
    false
  );
  const names = ["a:b", "a|b", 'a",null]', 'a",["b', "<a>", "a,b"];
  const keys = names.map((name) =>
    stackIdentity({ id: ITEM.APPLE, data: { version: 1, name } })
  );
  assert.equal(new Set(keys).size, names.length);
  assert.notEqual(
    keys[0],
    stackIdentity({ id: ITEM.COAL, data: { version: 1, name: names[0] } })
  );
  assert.equal(
    stackIdentity({ id: ITEM.APPLE, count: 1 }),
    stackIdentity({ id: ITEM.APPLE, count: 64 })
  );
});

test("schema-only potion fixtures canonicalize variants without inventing production item IDs", () => {
  const base = { id: "swiftness", form: "drinkable" };
  assert.deepEqual(normalizePotionData(base), {
    ...base,
    extended: false,
    strong: false,
  });
  const variants = [
    base,
    { ...base, extended: true },
    { ...base, strong: true },
    { ...base, form: "splash" },
    { ...base, form: "lingering" },
    { id: "healing", form: "drinkable" },
  ];
  const identities = variants.map((potion) =>
    stackDataIdentity({ version: 1, potion })
  );
  assert.equal(new Set(identities).size, variants.length);
  assert.equal(
    identities[0],
    stackDataIdentity({
      version: 1,
      potion: { ...base, strong: false, extended: false },
    })
  );
  for (const potion of [
    null,
    { ...base, id: "unknown" },
    { ...base, id: {} },
    { ...base, form: "arrow" },
    { ...base, strong: 1 },
    { ...base, extended: "true" },
    { ...base, strong: true, extended: true },
    { id: "water", form: "drinkable", strong: true },
    { id: "healing", form: "drinkable", extended: true },
    { ...base, effect: { amplifier: 20 } },
  ])
    assert.throws(() => normalizePotionData(potion), RangeError);
  const data = { version: 1, potion: base };
  const clone = cloneStackData(data);
  clone.potion.form = "splash";
  assert.equal(data.potion.form, "drinkable");
  assert.throws(() => normalizeStackData(ITEM.APPLE, data), RangeError);
});

test("schema-only map fixtures bind seed/generator/dimension and bounded integer structure coordinates", () => {
  const target = {
    seed: "map-schema-only",
    generatorVersion: 4,
    dimension: "overworld",
    structureId: "v4:overworld:village:-2,5",
    x: -25,
    y: -64,
    z: 80,
  };
  const context = createWorldContext({
    seed: target.seed,
    generatorVersion: 4,
  });
  assert.deepEqual(normalizeMapTarget(target, context), target);
  assert.equal(normalizeMapTarget({ ...target, y: 319 }, context).y, 319);
  assert.equal(
    normalizeMapTarget({ ...target, dimension: "nether", y: 255 }, context).y,
    255
  );
  for (const patch of [
    { seed: "another-world" },
    { generatorVersion: 3 },
    { generatorVersion: 99 },
    { dimension: "void" },
    { structureId: "" },
    { structureId: "unstable object {}" },
    { x: -30_000_001 },
    { z: 30_000_000 },
    { x: 0.5 },
    { y: -65 },
    { y: 320 },
    { dimension: "nether", y: -1 },
    { dimension: "end", y: 256 },
    { arbitrary: true },
  ])
    assert.throws(
      () => normalizeMapTarget({ ...target, ...patch }, context),
      RangeError
    );
  assert.throws(
    () => normalizeMapTarget({ ...target, generatorVersion: 3, y: 96 }),
    RangeError
  );
  const data = { version: 1, mapTarget: target };
  const clone = cloneStackData(data, context);
  clone.mapTarget.x = 100;
  assert.equal(data.mapTarget.x, -25);
  assert.throws(
    () => normalizeStackData(ITEM.APPLE, data, context),
    RangeError
  );
});

test("effective projections expose supported numeric modifiers without inventing active effects", () => {
  const efficient = resolveItemStats(pickaxe(enchanted), {
    effectiveMiningTool: true,
  });
  assert.equal(efficient.speed, getItem(ITEM.IRON_PICKAXE).speed + 26);
  assert.equal(
    resolveItemStats(pickaxe(enchanted)).speed,
    getItem(ITEM.IRON_PICKAXE).speed
  );
  assert.equal(efficient.durabilityUseChance, 1 / 4);
  assert.equal(efficient.maxDurability, getItem(ITEM.IRON_PICKAXE).durability);
  const sword = {
    id: ITEM.IRON_SWORD,
    data: { version: 1, enchantments: { sharpness: 3 } },
  };
  assert.equal(resolveItemStats(sword).damage, getItem(sword.id).damage + 2);
  const smite = {
    id: sword.id,
    data: { version: 1, enchantments: { smite: 2 } },
  };
  assert.equal(resolveItemStats(smite).damage, getItem(sword.id).damage);
  assert.equal(
    resolveItemStats(smite, { targetFamily: "undead" }).damage,
    getItem(sword.id).damage + 5
  );
  const boots = {
    id: ITEM.IRON_BOOTS,
    data: {
      version: 1,
      enchantments: { protection: 2, feather_falling: 3, unbreaking: 2 },
    },
  };
  const armored = resolveItemStats(boots, { damageType: "fall" });
  assert.equal(armored.armorPoints, getItem(boots.id).armorPoints);
  assert.equal(armored.protectionFactor, 11);
  assert.equal(armored.durabilityUseChance, 0.6 + 0.4 / 3);
  const bow = {
    id: ITEM.BOW,
    data: { version: 1, enchantments: { power: 4, mending: 1 } },
  };
  const ranged = resolveItemStats(bow);
  assert.equal(ranged.damage, getItem(ITEM.BOW).damage);
  assert.equal(ranged.projectileDamageMultiplier, 2.25);
  assert.equal(enchantmentLevel(bow, "mending"), 1);
  assert.equal(enchantmentLevel(bow, "made_up"), 0);
  for (const unimplemented of [
    "mending",
    "healing",
    "fireAspect",
    "fortune",
    "potionEffects",
  ])
    assert.equal(Object.hasOwn(ranged, unimplemented), false);
});
