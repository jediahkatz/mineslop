import assert from "node:assert/strict";
import test from "node:test";
import {
  anvilWear,
  combineAnvilEnchantments,
  createAnvilRecord,
  normalizeAnvilRecord,
  planAnvil,
  previewAnvil,
} from "../src/anvil.js";
import { BLOCK } from "../src/blocks.js";
import { experienceForLevel } from "../src/experience.js";
import {
  MAX_REPAIR_COST,
  MAX_STACK_NAME_LENGTH,
} from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import {
  anvilRecord,
  bindings,
  enchantedBook,
  materialStack,
  tool,
} from "./enchantment-fixture.js";

const preview = (record, options = {}) =>
  previewAnvil({ record, bindings, ...options });

test("anvil escrow is detached, versioned and serializes inputs but never a preview/output", () => {
  const record = anvilRecord(
    tool(ITEM.IRON_PICKAXE, 17, {
      name: "North mine",
      enchantments: { efficiency: 3 },
      repairCost: 3,
    }),
    materialStack(ITEM.IRON_INGOT, 4, { name: "Reserve" })
  );
  const clean = normalizeAnvilRecord(record);
  record.left.data.name = "Caller changed";
  record.right.count = 1;
  assert.equal(clean.left.data.name, "North mine");
  assert.equal(clean.right.count, 4);
  assert.ok(Object.isFrozen(clean.left.data.enchantments));
  assert.deepEqual(
    normalizeAnvilRecord(JSON.parse(JSON.stringify(clean))),
    clean
  );
  assert.deepEqual(createAnvilRecord(), {
    version: 1,
    left: null,
    right: null,
  });
  for (const field of ["output", "preview", "rename", "experienceTotal"])
    assert.throws(
      () => normalizeAnvilRecord({ ...clean, [field]: null }),
      RangeError
    );
  for (const bad of [
    { ...clean, version: 2 },
    { version: 1, left: null },
    null,
  ])
    assert.throws(() => normalizeAnvilRecord(bad), RangeError);
});

test("material repair uses floor(max/4), charges per consumed unit, and retains excess materials", () => {
  const left = tool(ITEM.IRON_PICKAXE, 17, {
    name: "North mine",
    enchantments: { efficiency: 4 },
    repairCost: 3,
  });
  const right = materialStack(ITEM.IRON_INGOT, 8, { name: "Reserve" });
  const record = anvilRecord(left, right);
  const before = JSON.stringify(record);
  const result = preview(record);
  assert.equal(result.ok, true);
  assert.equal(result.operation, "material_repair");
  assert.equal(result.output.id, ITEM.IRON_PICKAXE);
  assert.equal(result.output.durability, 250);
  assert.equal(result.repaired, 233);
  assert.equal(result.rightConsumed, 4);
  assert.equal(result.levelCost, 7);
  assert.deepEqual(result.costs, {
    priorWork: 3,
    repair: 4,
    enchantments: 0,
    conflicts: 0,
    rename: 0,
  });
  assert.equal(result.output.data.repairCost, 7);
  assert.equal(result.output.data.name, "North mine");
  assert.deepEqual(result.output.data.enchantments, { efficiency: 4 });
  assert.equal(result.after.record.left, null);
  assert.deepEqual(
    result.after.record.right,
    materialStack(ITEM.IRON_INGOT, 4, { name: "Reserve" })
  );
  assert.equal(JSON.stringify(record), before);
  assert.deepEqual(preview(record), result);
});

test("four iron repair units can leave one missing point due to quarter rounding", () => {
  const four = preview(
    anvilRecord(tool(ITEM.IRON_PICKAXE, 1), materialStack(ITEM.IRON_INGOT, 4))
  );
  assert.equal(four.ok, true);
  assert.equal(four.output.durability, 249);
  assert.equal(four.levelCost, 4);
  assert.equal(four.after.record.right, null);
  const five = preview(
    anvilRecord(tool(ITEM.IRON_PICKAXE, 1), materialStack(ITEM.IRON_INGOT, 5))
  );
  assert.equal(five.output.durability, 250);
  assert.equal(five.rightConsumed, 5);
  assert.equal(five.levelCost, 5);
  const almost = preview(
    anvilRecord(tool(ITEM.IRON_PICKAXE, 249), materialStack(ITEM.IRON_INGOT, 5))
  );
  assert.equal(almost.repaired, 1);
  assert.equal(almost.rightConsumed, 1);
  assert.equal(almost.after.record.right.count, 4);
});

test("iron chestplate retains max 240 and uses 60 durability per material", () => {
  const result = preview(
    anvilRecord(tool(ITEM.IRON_ARMOR, 1), materialStack(ITEM.IRON_INGOT, 4))
  );
  assert.equal(result.ok, true);
  assert.equal(result.output.durability, 240);
  assert.equal(result.rightConsumed, 4);
  assert.equal(result.repaired, 239);
});

test("wood tags and all three symbolic stone alternatives repair without name/ID-range inference", () => {
  const wooden = preview(
    anvilRecord(tool(ITEM.WOOD_PICKAXE, 1), materialStack(BLOCK.PLANKS, 2))
  );
  assert.equal(wooden.ok, true);
  assert.equal(wooden.output.durability, 29);
  for (const id of [
    BLOCK.COBBLESTONE,
    BLOCK.COBBLED_DEEPSLATE,
    BLOCK.BLACKSTONE,
  ]) {
    const stone = preview(
      anvilRecord(tool(ITEM.STONE_PICKAXE, 1), materialStack(id))
    );
    assert.equal(stone.ok, true);
    assert.equal(stone.output.durability, 33);
  }
  const namedWrong = materialStack(ITEM.GOLD_INGOT, 4, { name: "Iron ingot" });
  assert.equal(
    preview(anvilRecord(tool(ITEM.IRON_PICKAXE, 1), namedWrong)).ok,
    false
  );
  assert.equal(
    getItem(ITEM.IRON_INGOT).resourceLocation,
    "minecraft:iron_ingot"
  );
  assert.ok(getItem(BLOCK.PLANKS).tags.includes("minecraft:planks"));
});

test("repairing a full item with material and combining unrelated items are deterministic refusals", () => {
  const record = anvilRecord(tool(), materialStack(ITEM.IRON_INGOT, 4));
  const before = JSON.stringify(record);
  assert.equal(preview(record).reason, "no_repair_needed");
  assert.equal(
    preview(record, { rename: "Cannot spend useless repair material" }).ok,
    false
  );
  assert.equal(JSON.stringify(record), before);
  assert.equal(
    preview(anvilRecord(tool(), tool(ITEM.DIAMOND_PICKAXE))).reason,
    "incompatible_sacrifice"
  );
  assert.equal(
    preview(anvilRecord(tool(), tool(ITEM.IRON_AXE))).reason,
    "incompatible_sacrifice"
  );
  assert.equal(preview(anvilRecord(null, null)).reason, "missing_target");
});

test("same-item repair adds remaining durability plus floor(12% max), never the sacrifice's name", () => {
  const left = tool(ITEM.IRON_PICKAXE, 10, { name: "Left survives" });
  const right = tool(ITEM.IRON_PICKAXE, 20, { name: "Right consumed" });
  const result = preview(anvilRecord(left, right));
  assert.equal(result.ok, true);
  assert.equal(result.output.durability, 60);
  assert.equal(result.repaired, 50);
  assert.equal(result.levelCost, 2);
  assert.equal(result.output.data.name, "Left survives");
  assert.equal(result.output.data.repairCost, 1);
  assert.equal(result.after.record.left, null);
  assert.equal(result.after.record.right, null);
  assert.equal(result.rightConsumed, 1);
  const wood = preview(
    anvilRecord(tool(ITEM.WOOD_PICKAXE, 1), tool(ITEM.WOOD_PICKAXE, 1))
  );
  assert.equal(wood.output.durability, 9);
  const capped = preview(anvilRecord(tool(ITEM.IRON_PICKAXE, 240), tool()));
  assert.equal(capped.output.durability, 250);
});

test("full identical unenchanted tools cannot combine unless renamed", () => {
  const record = anvilRecord(tool(), tool());
  assert.equal(preview(record).reason, "no_change");
  const renamed = preview(record, { rename: "Named full tool" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.renameOnly, true);
  assert.equal(renamed.levelCost, 1);
  assert.equal(renamed.rightConsumed, 1);
  assert.equal(renamed.output.data.repairCost, undefined);
});

test("equal levels upgrade once; maximum and higher-left levels still incur Java result-level cost", () => {
  for (const [leftLevel, rightLevel, expected] of [
    [3, 3, 4],
    [5, 5, 5],
    [5, 1, 5],
    [1, 4, 4],
  ]) {
    const record = anvilRecord(
      tool(ITEM.IRON_PICKAXE, 250, { enchantments: { efficiency: leftLevel } }),
      tool(ITEM.IRON_PICKAXE, 250, { enchantments: { efficiency: rightLevel } })
    );
    const result = preview(record);
    assert.equal(result.ok, true);
    assert.equal(result.output.data.enchantments.efficiency, expected);
    assert.equal(result.levelCost, expected);
    assert.equal(result.output.data.repairCost, 1);
  }
  const invalid = anvilRecord(tool(), {
    ...tool(),
    data: { version: 1, enchantments: { efficiency: 6 } },
  });
  assert.equal(preview(invalid).ok, false);
});

test("all-conflicting combinations reject, while a compatible partial transfer reports the lost conflict", () => {
  const left = tool(ITEM.IRON_PICKAXE, 250, { enchantments: { fortune: 3 } });
  const conflict = tool(ITEM.IRON_PICKAXE, 250, {
    enchantments: { silk_touch: 1 },
  });
  const record = anvilRecord(left, conflict);
  const before = JSON.stringify(record);
  assert.equal(preview(record).reason, "no_compatible_enchantments");
  assert.equal(JSON.stringify(record), before);
  const partial = preview(
    anvilRecord(
      left,
      tool(ITEM.IRON_PICKAXE, 250, {
        enchantments: { silk_touch: 1, unbreaking: 2 },
      })
    )
  );
  assert.equal(partial.ok, true);
  assert.deepEqual(partial.output.data.enchantments, {
    fortune: 3,
    unbreaking: 2,
  });
  assert.equal(partial.costs.conflicts, 1);
  assert.equal(partial.costs.enchantments, 4);
  assert.equal(partial.levelCost, 5);
  assert.deepEqual(partial.skipped, [
    { name: "silk_touch", reason: "conflict", conflicts: ["fortune"] },
  ]);
});

test("unsupported effects cannot be newly transferred, but existing left metadata survives repair", () => {
  const left = tool(ITEM.IRON_ARMOR, 100, {
    enchantments: { thorns: 3 },
    name: "Legacy",
  });
  const repaired = preview(anvilRecord(left, materialStack(ITEM.IRON_INGOT)));
  assert.equal(repaired.ok, true);
  assert.deepEqual(repaired.output.data.enchantments, { thorns: 3 });
  assert.equal(repaired.output.data.name, "Legacy");
  const incoming = preview(anvilRecord(tool(ITEM.IRON_ARMOR), left));
  assert.equal(incoming.reason, "unsupported_enchantment");
  assert.equal(incoming.enchantment, "thorns");
});

test("both input penalties are charged but only their maximum determines next prior work", () => {
  const result = preview(
    anvilRecord(
      tool(ITEM.IRON_PICKAXE, 250, {
        enchantments: { efficiency: 3 },
        repairCost: 1,
      }),
      tool(ITEM.IRON_PICKAXE, 250, {
        enchantments: { efficiency: 3 },
        repairCost: 3,
      })
    )
  );
  assert.equal(result.ok, true);
  assert.equal(result.levelCost, 8);
  assert.equal(result.costs.priorWork, 4);
  assert.equal(result.output.data.repairCost, 7);
  let penalty = 0;
  for (const expected of [1, 3, 7, 15, 31, 63]) {
    const next = preview(
      anvilRecord(tool(ITEM.IRON_PICKAXE, 10, { repairCost: penalty }), tool()),
      { mode: "creative" }
    );
    assert.equal(next.ok, true);
    assert.equal(next.output.data.repairCost, expected);
    penalty = expected;
  }
});

test("Survival allows cost 39 and rejects cost 40; Creative has no 40-level limit", () => {
  const record = anvilRecord(
    tool(ITEM.IRON_PICKAXE, 250, { repairCost: 31 }),
    tool(ITEM.IRON_PICKAXE, 250, {
      repairCost: 7,
      enchantments: { efficiency: 1 },
    })
  );
  const allowed = preview(record);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.levelCost, 39);
  assert.equal(allowed.output.data.repairCost, 63);
  const denied = preview(record, { rename: "Adds one" });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "too_expensive");
  assert.equal(denied.levelCost, 40);
  const creative = preview(record, { rename: "Adds one", mode: "creative" });
  assert.equal(creative.ok, true);
  assert.equal(creative.levelCost, 40);
  const plan = planAnvil({
    record,
    rename: "Adds one",
    mode: "creative",
    bindings,
    experienceTotal: 0,
    previewKey: creative.key,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.chargedLevels, 0);
  assert.equal(plan.experienceAfter, 0);
});

test("rename-only caps at 39 and never escalates prior work, including maximum bounded metadata", () => {
  for (const penalty of [0, 1, 31, 63, MAX_REPAIR_COST]) {
    const record = anvilRecord(
      tool(ITEM.IRON_PICKAXE, 17, { repairCost: penalty }),
      null
    );
    const result = preview(record, { rename: "Named tool" });
    assert.equal(result.ok, true);
    assert.equal(result.renameOnly, true);
    assert.equal(result.levelCost, Math.min(39, penalty + 1));
    assert.equal(result.output.data.repairCost ?? 0, penalty);
    assert.equal(result.output.durability, 17);
  }
  const saturated = preview(
    anvilRecord(
      tool(ITEM.IRON_PICKAXE, 17, { repairCost: MAX_REPAIR_COST }),
      materialStack(ITEM.IRON_INGOT)
    ),
    { mode: "creative" }
  );
  assert.equal(saturated.ok, true);
  assert.equal(saturated.output.data.repairCost, MAX_REPAIR_COST);
  assert.equal(saturated.levelCost, MAX_REPAIR_COST);
});

test("rename/clear uses literal bounded canonical text and applies once to a whole stack", () => {
  const record = anvilRecord(materialStack(ITEM.APPLE, 64), null);
  const renamed = preview(record, { rename: "<b>Literal fruit</b>" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.levelCost, 1);
  assert.equal(renamed.output.count, 64);
  assert.equal(renamed.output.data.name, "<b>Literal fruit</b>");
  assert.equal(renamed.output.data.repairCost, undefined);
  for (const rename of ["", "   ", "\u00a0"])
    assert.equal(
      preview(anvilRecord(renamed.output, null), { rename }).output.data,
      undefined
    );
  assert.equal(
    preview(anvilRecord(renamed.output, null), {
      rename: "<b>Literal fruit</b>",
    }).reason,
    "no_change"
  );
  assert.equal(preview(record, { rename: "" }).reason, "no_change");
  assert.equal(preview(record).reason, "no_change");
  assert.equal(
    preview(record, { rename: "🪨".repeat(MAX_STACK_NAME_LENGTH) }).ok,
    true
  );
  for (const rename of ["x".repeat(51), "a\nb", "a\u202eb", "\ud800", 5, null])
    assert.equal(preview(record, { rename }).ok, false);
});

test("rename plus real work adds one level and does increase prior work", () => {
  const record = anvilRecord(
    tool(ITEM.IRON_PICKAXE, 17, { name: "Old", repairCost: 3 }),
    materialStack(ITEM.IRON_INGOT)
  );
  const result = preview(record, { rename: "New" });
  assert.equal(result.ok, true);
  assert.equal(result.renameOnly, false);
  assert.equal(result.levelCost, 5);
  assert.equal(result.output.data.name, "New");
  assert.equal(result.output.data.repairCost, 7);
});

test("book sacrifices use discounted multipliers, skip ineligible entries, and preserve left identity", () => {
  const left = tool(ITEM.IRON_SWORD, getItem(ITEM.IRON_SWORD).durability, {
    name: "Left blade",
  });
  const right = enchantedBook(
    { protection: 3, sharpness: 1, unbreaking: 2 },
    { name: "Right book" }
  );
  const result = preview(anvilRecord(left, right));
  assert.equal(result.ok, true);
  assert.equal(result.operation, "book_combination");
  assert.equal(result.output.id, left.id);
  assert.equal(result.output.data.name, "Left blade");
  assert.deepEqual(result.output.data.enchantments, {
    sharpness: 1,
    unbreaking: 2,
  });
  assert.equal(result.levelCost, 3);
  assert.deepEqual(result.skipped, [
    { name: "protection", reason: "ineligible" },
  ]);
  assert.equal(result.after.record.right, null);
  assert.equal(
    preview(anvilRecord(right, left)).reason,
    "incompatible_sacrifice"
  );
  assert.equal(
    preview(anvilRecord(materialStack(ITEM.BOOK), right)).reason,
    "incompatible_sacrifice"
  );
});

test("book-to-book equal-level combinations retain left metadata and apply result-level cost", () => {
  const left = enchantedBook(
    { unbreaking: 2 },
    { name: "Left book", repairCost: 1 }
  );
  const right = enchantedBook(
    { unbreaking: 2 },
    { name: "Right book", repairCost: 3 }
  );
  const result = preview(anvilRecord(left, right));
  assert.equal(result.ok, true);
  assert.equal(result.output.id, left.id);
  assert.equal(result.output.data.name, "Left book");
  assert.deepEqual(result.output.data.enchantments, { unbreaking: 3 });
  assert.equal(result.levelCost, 7);
  assert.equal(result.output.data.repairCost, 7);
});

test("Mending books work on durable gear but remain incompatible with Infinity", () => {
  const book = enchantedBook({ mending: 1 });
  const applied = preview(anvilRecord(tool(ITEM.BOW, 17), book));
  assert.equal(applied.ok, true);
  assert.equal(applied.output.durability, 17);
  assert.equal(applied.output.data.enchantments.mending, 1);
  assert.equal(applied.levelCost, 2);
  const conflict = preview(
    anvilRecord(
      tool(ITEM.BOW, 17, {
        enchantments: { infinity: 1 },
      }),
      book
    )
  );
  assert.equal(conflict.reason, "no_compatible_enchantments");
});

test("direct level helper uses canonical eligibility, conflicts and supported maxima", () => {
  const combined = combineAnvilEnchantments(
    ITEM.IRON_PICKAXE,
    { unbreaking: 2 },
    { unbreaking: 2 },
    { fromBook: true }
  );
  assert.equal(combined.ok, true);
  assert.equal(combined.levelCost, 3);
  assert.equal(combined.enchantments.unbreaking, 3);
  assert.equal(
    combineAnvilEnchantments(ITEM.APPLE, {}, { unbreaking: 1 }).ok,
    false
  );
  assert.equal(
    combineAnvilEnchantments(ITEM.IRON_PICKAXE, {}, { unbreaking: 4 }).ok,
    false
  );
  assert.equal(
    combineAnvilEnchantments(
      ITEM.IRON_PICKAXE,
      {},
      { fortune: 1, silk_touch: 1 }
    ).ok,
    false
  );
  assert.equal(
    combineAnvilEnchantments(ITEM.IRON_PICKAXE, { sharpness: 1 }, {}).reason,
    "ineligible_target_enchantments"
  );
  assert.equal(
    combineAnvilEnchantments(ITEM.APPLE, { unbreaking: 1 }, {}).reason,
    "ineligible_target_enchantments"
  );
});

test("funding uses levels and stale previews cannot spend XP or consume inputs", () => {
  const record = anvilRecord(
    tool(ITEM.IRON_PICKAXE, 17),
    materialStack(ITEM.IRON_INGOT, 4)
  );
  const shown = preview(record);
  assert.equal(shown.levelCost, 4);
  const before = JSON.stringify(record);
  const funded = planAnvil({
    record,
    bindings,
    previewKey: shown.key,
    experienceTotal: experienceForLevel(30),
  });
  assert.equal(funded.ok, true);
  assert.equal(funded.experienceAfter, experienceForLevel(26));
  assert.equal(
    planAnvil({
      record,
      bindings,
      previewKey: shown.key,
      experienceTotal: experienceForLevel(4) - 1,
    }).reason,
    "insufficient_levels"
  );
  assert.equal(
    planAnvil({
      record,
      bindings,
      previewKey: "stale",
      experienceTotal: experienceForLevel(30),
    }).reason,
    "stale_preview"
  );
  assert.equal(JSON.stringify(record), before);
});

test("optional anvil wear helper exposes the exact 12% boundary without allocating block IDs", () => {
  assert.deepEqual(anvilWear(0, 0.119), {
    stage: 1,
    damaged: true,
    broken: false,
  });
  assert.deepEqual(anvilWear(1, 0.12), {
    stage: 1,
    damaged: false,
    broken: false,
  });
  assert.deepEqual(anvilWear(2, 0), {
    stage: null,
    damaged: true,
    broken: true,
  });
  assert.deepEqual(anvilWear(2, 0.99), {
    stage: 2,
    damaged: false,
    broken: false,
  });
  assert.throws(() => anvilWear(3, 0), RangeError);
  assert.throws(() => anvilWear(1, 1), RangeError);
  assert.throws(() => anvilWear(1, NaN), RangeError);
});
