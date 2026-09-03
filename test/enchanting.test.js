import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import {
  equipmentProfile,
  nextEnchantingSeed,
  spendExperienceLevels,
} from "../src/enchantment-domain.js";
import {
  enchantmentCandidates,
  getEnchantmentRule,
  getSupportedEnchantments,
  tableEligible,
} from "../src/enchantment-rules.js";
import {
  createEnchantingPlayer,
  createEnchantingRecord,
  getEnchantingOffers,
  normalizeEnchantingPlayer,
  normalizeEnchantingRecord,
  planEnchanting,
  sampleBookshelfPower,
} from "../src/enchanting.js";
import {
  experienceForLevel,
  experienceState,
  MAX_EXPERIENCE,
} from "../src/experience.js";
import {
  getEnchantment,
  normalizeEnchantments,
} from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import {
  bindings,
  enchantingRecord,
  materialStack,
  registeredEnchantedBook,
  registeredFishingRod,
  tool,
} from "./enchantment-fixture.js";

const playerState = createEnchantingPlayer(123456789);
const input = () =>
  tool(ITEM.IRON_PICKAXE, 17, { name: "North mine", repairCost: 3 });
const offers = (overrides = {}) =>
  getEnchantingOffers({
    input: input(),
    playerState,
    bookshelfPower: 15,
    bindings,
    ...overrides,
  });

function plan(overrides = {}) {
  const record = overrides.record ?? enchantingRecord(input());
  const state = overrides.playerState ?? playerState;
  const power = overrides.bookshelfPower ?? 15;
  const index = overrides.index ?? 2;
  const menu = offers({
    input: record.input,
    playerState: state,
    bookshelfPower: power,
    ...overrides,
  });
  assert.equal(menu.ok, true);
  return planEnchanting({
    record,
    playerState: state,
    bookshelfPower: power,
    index,
    offerKey: menu.offers[index].key,
    experienceTotal: experienceForLevel(30),
    bindings,
    ...overrides,
  });
}

function library(position = { x: 10, y: 65, z: -20 }) {
  const cells = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  return {
    position,
    cells,
    set(dx, dy, dz, id) {
      cells.set(
        key(position.x + dx, position.y + dy, position.z + dz),
        normalizeCell({ id })
      );
    },
    read: (x, y, z) =>
      cells.get(key(x, y, z)) ?? normalizeCell({ id: BLOCK.AIR }),
    sample(options) {
      return sampleBookshelfPower(this.read, position, options);
    },
  };
}

test("player seed and escrow schemas are detached, bounded, and do not persist unpaid previews", () => {
  const record = enchantingRecord(input());
  const normalized = normalizeEnchantingRecord(record);
  record.input.data.name = "Changed caller";
  assert.equal(normalized.input.data.name, "North mine");
  assert.ok(Object.isFrozen(normalized.input.data));
  assert.throws(() => {
    normalized.input.durability = 2;
  }, TypeError);
  assert.deepEqual(
    normalizeEnchantingRecord(JSON.parse(JSON.stringify(normalized))),
    normalized
  );
  assert.deepEqual(createEnchantingRecord(), {
    version: 1,
    input: null,
    lapis: null,
  });
  assert.deepEqual(createEnchantingPlayer(0), { version: 1, seed: 0 });
  assert.equal(
    normalizeEnchantingPlayer(JSON.parse(JSON.stringify(playerState))).seed,
    playerState.seed
  );
  for (const data of [
    undefined,
    null,
    {},
    { version: 2, seed: 1 },
    { version: 1, seed: -1 },
    { version: 1, seed: 0x100000000 },
    { version: 1, seed: 1.5 },
    { version: 1, seed: NaN },
    { version: 1, seed: 1, experienceTotal: 20 },
  ])
    assert.throws(() => normalizeEnchantingPlayer(data), RangeError);
  for (const extra of ["offers", "output", "result", "seed"])
    assert.throws(
      () => normalizeEnchantingRecord({ ...normalized, [extra]: null }),
      RangeError
    );
  const getter = Object.defineProperty({ version: 1 }, "seed", {
    enumerable: true,
    get: () => assert.fail("seed accessors must not run"),
  });
  assert.throws(() => normalizeEnchantingPlayer(getter), RangeError);
});

test("escrow retains valid ineligible items instead of erasing them during load", () => {
  const record = enchantingRecord(
    materialStack(ITEM.APPLE, 3),
    materialStack(ITEM.COAL, 5)
  );
  assert.deepEqual(normalizeEnchantingRecord(record), record);
  assert.equal(offers({ input: record.input }).ok, false);
  assert.deepEqual(normalizeEnchantingRecord(record), record);
});

test("canonical registered gear uses verified material enchantability and preserves iron chestplate 240", () => {
  assert.equal(
    equipmentProfile(ITEM.WOOD_PICKAXE, bindings).enchantability,
    15
  );
  assert.equal(
    equipmentProfile(ITEM.STONE_PICKAXE, bindings).enchantability,
    5
  );
  assert.equal(
    equipmentProfile(ITEM.IRON_PICKAXE, bindings).enchantability,
    14
  );
  assert.equal(
    equipmentProfile(ITEM.DIAMOND_PICKAXE, bindings).enchantability,
    10
  );
  assert.deepEqual(equipmentProfile(ITEM.IRON_ARMOR, bindings), {
    durability: 240,
    enchantability: 9,
    repairIngredients: ["minecraft:iron_ingot"],
  });
  assert.equal(equipmentProfile(ITEM.BOW, bindings).enchantability, 1);
  assert.throws(
    () =>
      equipmentProfile(ITEM.IRON_PICKAXE, {
        materialForItem: () => "diamond",
      }),
    /does not match/
  );
  assert.throws(
    () =>
      equipmentProfile(ITEM.IRON_PICKAXE, {
        materialForItem: async () => "iron",
      }),
    RangeError
  );
});

test("table eligibility distinguishes primary tools, secondary axe combat, and treasure-only Mending", () => {
  assert.equal(tableEligible("sharpness", getItem(ITEM.IRON_SWORD)), true);
  assert.equal(tableEligible("sharpness", getItem(ITEM.IRON_AXE)), false);
  assert.equal(tableEligible("smite", getItem(ITEM.IRON_AXE)), false);
  assert.equal(tableEligible("efficiency", getItem(ITEM.IRON_AXE)), true);
  assert.equal(tableEligible("unbreaking", getItem(ITEM.SHIELD)), false);
  assert.equal(tableEligible("power", getItem(ITEM.BOW)), true);
  assert.equal(tableEligible("protection", getItem(ITEM.IRON_HELMET)), true);
  assert.equal(tableEligible("mending", getItem(ITEM.BOOK)), false);
  assert.equal(tableEligible("efficiency", null), false);
  assert.equal(tableEligible("efficiency", undefined), false);
  assert.equal(tableEligible("efficiency", ITEM.IRON_PICKAXE), false);
  assert.equal(getEnchantmentRule("mending").treasure, true);
  assert.equal(getEnchantmentRule("thorns"), null);
  assert.equal(
    getSupportedEnchantments({ tableOnly: true }).includes("mending"),
    false
  );
  assert.equal(getSupportedEnchantments().includes("mending"), true);
  assert.ok(Object.isFrozen(getSupportedEnchantments()));
  for (const name of getSupportedEnchantments())
    assert.equal(
      getEnchantmentRule(name).maxLevel,
      getEnchantment(name).maxLevel
    );
});

test("26.2 effective power ranges use highest eligible levels, including corrected Protection", () => {
  const protection = (power) =>
    enchantmentCandidates(getItem(ITEM.IRON_ARMOR), power).find(
      (entry) => entry.name === "protection"
    )?.level;
  assert.equal(protection(1), 1);
  assert.equal(protection(11), 1);
  assert.equal(protection(12), 2);
  assert.equal(protection(23), 3);
  assert.equal(protection(34), 4);
  assert.equal(protection(45), 4);
  assert.equal(protection(46), undefined);
  const efficiency = (power) =>
    enchantmentCandidates(getItem(ITEM.IRON_PICKAXE), power).find(
      (entry) => entry.name === "efficiency"
    )?.level;
  assert.equal(efficiency(40), 4);
  assert.equal(efficiency(41), 5);
  assert.equal(efficiency(91), 5);
  assert.equal(efficiency(92), undefined);
  assert.throws(
    () => enchantmentCandidates(getItem(ITEM.IRON_PICKAXE), 0),
    RangeError
  );
});

test("only singleton eligible unenchanted input can be table-enchanted", () => {
  for (const stack of [
    materialStack(ITEM.APPLE),
    materialStack(ITEM.PAPER),
    tool(ITEM.SHIELD),
  ])
    assert.equal(offers({ input: stack }).ok, false);
  assert.equal(offers({ input: null }).reason, "missing_input");
  assert.equal(
    offers({ input: materialStack(ITEM.BOOK, 2) }).reason,
    "input_count"
  );
  assert.equal(
    offers({
      input: tool(ITEM.IRON_PICKAXE, 100, {
        enchantments: { efficiency: 1 },
      }),
    }).reason,
    "already_enchanted"
  );
  assert.equal(
    offers({
      input: {
        ...input(),
        data: { version: 1, enchantments: { efficiency: 6 } },
      },
    }).ok,
    false
  );
  assert.equal(offers({ input: { ...input(), durability: 0 } }).ok, false);
});

test("reopening and reloading never reroll; naming and wear do not reroll enchantment choices", () => {
  const first = offers();
  assert.equal(first.ok, true);
  assert.equal(first.offers.length, 3);
  assert.deepEqual(offers(), first);
  assert.deepEqual(
    offers({ playerState: JSON.parse(JSON.stringify(playerState)) }),
    first
  );
  const renamed = offers({
    input: tool(ITEM.IRON_PICKAXE, 2, { name: "New name" }),
  });
  for (let index = 0; index < 3; index++) {
    assert.deepEqual(
      renamed.offers[index].enchantments,
      first.offers[index].enchantments
    );
    assert.equal(
      renamed.offers[index].requiredLevel,
      first.offers[index].requiredLevel
    );
    assert.notEqual(renamed.offers[index].key, first.offers[index].key);
  }
  assert.ok(Object.isFrozen(first.offers[0].enchantments));
  assert.throws(() => {
    first.offers[0].enchantments.efficiency = 99;
  }, TypeError);
});

test("three offer costs, cap and compatible levels hold over deterministic seed samples", () => {
  const seen = new Set();
  for (let seed = 0; seed < 80; seed++) {
    const menu = offers({ playerState: createEnchantingPlayer(seed) });
    assert.equal(menu.ok, true);
    assert.equal(menu.offers[2].requiredLevel, 30);
    assert.ok(
      menu.offers[0].requiredLevel >= 2 && menu.offers[0].requiredLevel <= 10
    );
    assert.ok(
      menu.offers[1].requiredLevel >= 6 && menu.offers[1].requiredLevel <= 21
    );
    for (const [index, offer] of menu.offers.entries()) {
      assert.equal(offer.levelCost, index + 1);
      assert.equal(offer.lapisCost, index + 1);
      assert.equal(offer.available, true);
      assert.deepEqual(
        normalizeEnchantments(offer.enchantments),
        offer.enchantments
      );
      assert.equal(offer.enchantments.mending, undefined);
      assert.equal(offer.enchantments[offer.clue.name], offer.clue.level);
      assert.ok(!(offer.enchantments.fortune && offer.enchantments.silk_touch));
    }
    seen.add(JSON.stringify(menu.offers.map((offer) => offer.enchantments)));
  }
  assert.ok(seen.size > 1);
  assert.deepEqual(
    offers({ bookshelfPower: 32 }),
    offers({ bookshelfPower: 15 })
  );
  for (const power of [-1, 1.5, Infinity, "15"])
    assert.equal(offers({ bookshelfPower: power }).ok, false);
});

test("a zero-bookshelf row below its lapis tier is disabled rather than sold", () => {
  for (let seed = 0; seed < 40; seed++) {
    const menu = offers({
      playerState: createEnchantingPlayer(seed),
      bookshelfPower: 0,
    });
    assert.equal(menu.ok, true);
    for (const offer of menu.offers) {
      if (offer.requiredLevel < offer.levelCost) {
        assert.equal(offer.available, false);
        assert.deepEqual(offer.enchantments, {});
        assert.equal(offer.clue, null);
      }
    }
  }
});

test("level-30 offer requires level 30 but consumes only three levels and three lapis", () => {
  const record = enchantingRecord(
    input(),
    materialStack(ITEM.LAPIS, 8, { name: "Blue reserve" })
  );
  const before = JSON.stringify({ record, playerState });
  const result = plan({ record });
  assert.equal(result.ok, true);
  assert.equal(result.requiredLevel, 30);
  assert.equal(result.levelCost, 3);
  assert.equal(result.chargedLevels, 3);
  assert.equal(result.lapisCost, 3);
  assert.equal(result.experienceAfter, experienceForLevel(27));
  assert.equal(result.after.record.lapis.count, 5);
  assert.equal(result.after.record.lapis.data.name, "Blue reserve");
  assert.equal(result.output.id, record.input.id);
  assert.equal(result.output.durability, 17);
  assert.equal(result.output.data.name, "North mine");
  assert.equal(result.output.data.repairCost, 3);
  assert.equal(
    result.after.playerState.seed,
    nextEnchantingSeed(playerState.seed)
  );
  assert.notEqual(result.after.playerState.seed, playerState.seed);
  assert.deepEqual(result.after.record.input, result.output);
  assert.equal(JSON.stringify({ record, playerState }), before);
  assert.deepEqual(plan({ record }), result);
});

test("all rows consume their stated costs and an exact lapis payment clears the slot", () => {
  for (let index = 0; index < 3; index++) {
    const result = plan({
      index,
      record: enchantingRecord(input(), materialStack(ITEM.LAPIS, index + 1)),
    });
    assert.equal(result.ok, true);
    assert.equal(result.experienceAfter, experienceForLevel(29 - index));
    assert.equal(result.after.record.lapis, null);
    assert.equal(result.lapisCost, index + 1);
  }
});

test("insufficient levels/lapis and stale offers cannot pay costs or reroll", () => {
  const record = enchantingRecord(input(), materialStack(ITEM.LAPIS, 2));
  const before = JSON.stringify({ record, playerState });
  assert.equal(plan({ record }).reason, "insufficient_lapis");
  assert.equal(
    plan({ experienceTotal: experienceForLevel(30) - 1 }).reason,
    "required_level"
  );
  assert.equal(
    plan({ record: enchantingRecord(input(), materialStack(ITEM.DIAMOND, 3)) })
      .reason,
    "invalid_lapis"
  );
  assert.equal(
    plan({ record: enchantingRecord(input(), null) }).reason,
    "invalid_lapis"
  );
  assert.equal(plan({ offerKey: "stale" }).reason, "stale_offer");
  assert.equal(plan({ offerKey: undefined }).reason, "stale_offer");
  assert.equal(plan({ experienceTotal: -1 }).reason, "invalid_experience");
  assert.equal(JSON.stringify({ record, playerState }), before);
});

test("Creative bypasses XP/lapis payment but not input validity and still advances the seed", () => {
  const result = plan({
    record: enchantingRecord(input(), null),
    experienceTotal: 0,
    mode: "creative",
  });
  assert.equal(result.ok, true);
  assert.equal(result.chargedLevels, 0);
  assert.equal(result.lapisCost, 0);
  assert.equal(result.experienceAfter, 0);
  assert.equal(result.after.record.lapis, null);
  assert.equal(
    result.after.playerState.seed,
    nextEnchantingSeed(playerState.seed)
  );
});

test("books require an explicit registered carrier output; plain books/paper are never invented carriers", () => {
  const book = materialStack(ITEM.BOOK);
  assert.equal(offers({ input: book }).reason, "unregistered_enchanted_book");
  for (const id of [ITEM.BOOK, ITEM.PAPER, ITEM.APPLE, -1])
    assert.equal(
      offers({ input: book, resources: { enchantedBook: id } }).reason,
      "unregistered_enchanted_book"
    );
});

test("registered book conversion retains the name and produces bounded compatible non-treasure payloads", () => {
  const resources = { enchantedBook: registeredEnchantedBook() };
  const record = enchantingRecord(
    materialStack(ITEM.BOOK, 1, { name: "Ocean notes" })
  );
  const result = plan({ record, resources });
  assert.equal(result.ok, true);
  assert.equal(result.output.id, resources.enchantedBook);
  assert.equal(result.output.count, 1);
  assert.equal(result.output.durability, undefined);
  assert.equal(result.output.data.name, "Ocean notes");
  assert.ok(Object.keys(result.output.data.enchantments).length > 0);
  assert.deepEqual(
    normalizeEnchantments(result.output.data.enchantments),
    result.output.data.enchantments
  );
  for (const name of Object.keys(result.output.data.enchantments))
    assert.equal(getEnchantmentRule(name).treasure, false);
  assert.equal(
    offers({ input: result.output, resources }).reason,
    "already_enchanted"
  );
});

test("fishing registrations activate only the finite effect-backed rod rules", () => {
  const rod = registeredFishingRod();
  const candidates = enchantmentCandidates(getItem(rod.id), 33).map(
    (entry) => entry.name
  );
  assert.deepEqual(candidates, ["luck_of_the_sea", "lure", "unbreaking"]);
  assert.equal(tableEligible("mending", getItem(rod.id)), false);
  assert.equal(equipmentProfile(rod.id, bindings).enchantability, 1);
});

test("bookshelves sample exactly the two-height ring and cap power at fifteen", () => {
  const world = library();
  assert.equal(world.sample().power, 0);
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++)
        if (Math.max(Math.abs(dx), Math.abs(dz)) === 2)
          world.set(dx, dy, dz, BLOCK.BOOKSHELF);
    }
  }
  const result = world.sample();
  assert.equal(result.ok, true);
  assert.equal(result.providers.length, 32);
  assert.equal(result.power, 15);
  assert.equal(result.reads.length, 48);
  const irrelevant = library();
  for (const offset of [
    [3, 0, 0],
    [2, -1, 0],
    [2, 2, 0],
    [0, 0, 0],
  ])
    irrelevant.set(...offset, BLOCK.BOOKSHELF);
  assert.equal(irrelevant.sample().power, 0);
});

test("a shelf uses the gap at its own height; blocking one layer does not block the other", () => {
  const world = library({ x: -10, y: -60, z: -20 });
  world.set(2, 0, 0, BLOCK.BOOKSHELF);
  world.set(2, 1, 0, BLOCK.BOOKSHELF);
  assert.equal(world.sample().power, 2);
  world.set(1, 0, 0, BLOCK.DIRT);
  assert.equal(world.sample().power, 1);
  assert.equal(world.sample().providers[0].y, -59);
  world.set(1, 1, 0, BLOCK.DIRT);
  assert.equal(world.sample().power, 0);
});

test("non-corner shelves use side gaps, while true corner shelves use diagonal gaps", () => {
  for (const sign of [-1, 1]) {
    const world = library();
    world.set(2 * sign, 0, sign, BLOCK.BOOKSHELF);
    world.set(2 * sign, 0, 2 * sign, BLOCK.BOOKSHELF);
    world.set(sign, 0, sign, BLOCK.DIRT);
    assert.equal(world.sample().power, 1);
    assert.equal(world.sample().providers[0].z, world.position.z + sign);
    world.set(sign, 0, 0, BLOCK.DIRT);
    assert.equal(world.sample().power, 0);
  }
});

test("Java transmitter tags are not transparency/air-only tests; unloaded reads fail closed", () => {
  const world = library();
  world.set(2, 0, 0, BLOCK.BOOKSHELF);
  for (const id of [BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA]) {
    world.set(1, 0, 0, id);
    assert.equal(world.sample().power, 1);
  }
  for (const id of [BLOCK.TORCH, BLOCK.GLASS]) {
    world.set(1, 0, 0, id);
    assert.equal(world.sample().power, 0);
  }
  assert.equal(
    sampleBookshelfPower(() => null, world.position).reason,
    "unloaded_bookshelves"
  );
  assert.equal(
    sampleBookshelfPower(
      async () => normalizeCell({ id: BLOCK.AIR }),
      world.position
    ).ok,
    false
  );
});

test("level spending preserves bar fraction with bounded integer-XP quantization", () => {
  assert.equal(spendExperienceLevels(experienceForLevel(30), 3), 1089);
  assert.equal(spendExperienceLevels(1395 + 56, 3), 1137);
  assert.equal(spendExperienceLevels(1507 + 120, 2), 1394);
  assert.equal(experienceState(spendExperienceLevels(1507 + 120, 2)).level, 29);
  assert.equal(spendExperienceLevels(6, 0), 6);
  assert.equal(spendExperienceLevels(experienceForLevel(2), 3), null);
  assert.equal(spendExperienceLevels(MAX_EXPERIENCE, 0), MAX_EXPERIENCE);
  for (const total of [-1, 0.1, NaN, Infinity, MAX_EXPERIENCE + 1])
    assert.throws(() => spendExperienceLevels(total, 1), RangeError);
  for (const cost of [-1, 1.1, NaN])
    assert.throws(() => spendExperienceLevels(100, cost), RangeError);
});

test("seed advancement is uint32-bounded and zero never means regenerate-on-load", () => {
  assert.equal(nextEnchantingSeed(0), 1013904223);
  assert.equal(nextEnchantingSeed(0xffffffff), 1012239698);
  assert.deepEqual(
    offers({ playerState: createEnchantingPlayer(0) }),
    offers({
      playerState: normalizeEnchantingPlayer({ version: 1, seed: 0 }),
    })
  );
  for (const seed of [-1, 0x100000000, 0.5, NaN])
    assert.throws(() => nextEnchantingSeed(seed), RangeError);
});
