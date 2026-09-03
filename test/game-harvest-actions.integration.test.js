import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { createFurnace } from "../src/furnace.js";
import { getItem, ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { CROP_GROW_SECONDS } from "../src/settlement.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { interactionSnapshot } from "./interaction-fixture.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";

const named = (id, count, name, durability) => ({
  id,
  count,
  ...(durability === undefined ? {} : { durability }),
  data: { version: 1, name },
});
const tool = (id = ITEM.IRON_PICKAXE, durability = 30) =>
  named(id, 1, "<kept|tool>", durability);
const countDrops = (drops, id) =>
  drops
    .filter((drop) => drop.id === id)
    .reduce((sum, drop) => sum + drop.count, 0);
const experienceTotal = (entries) =>
  entries.reduce((sum, entry) => sum + entry.amount, 0);

function target(game, id, x = 2, y = 9, z = 0, state = 0, fluid) {
  assert.equal(game.world.setCell(x, y, z, { id, state, fluid }), true);
  game.target = { x, y, z, ...game.world.getCell(x, y, z) };
  return game.target;
}

function miningGame(
  id = BLOCK.DEEPSLATE_DIAMOND_ORE,
  held = tool(),
  options = {}
) {
  const f = parityGame("survival", { generatorVersion: 4, ...options });
  setOwnedSlots(f.game, held ? [[0, held]] : []);
  target(f.game, id);
  return f;
}

function fullOverflow(game) {
  game.overflow.dispose();
  game.overflow = new DropOverflow({
    coordinator: game.coordinator,
    context: game.worldContext,
    maxEntries: 1,
  });
  assert.equal(
    game.overflow.enqueue(
      [{ id: BLOCK.DIRT, count: 1 }],
      { x: 10, y: 12, z: 10 },
      game.world.dimension
    ),
    true
  );
  game.pickups.accept = false;
}

function chestWithContents(game, hit, contents) {
  const save = game.settlement.serialize();
  const slots = Array(27).fill(null);
  contents.forEach((stack, index) => (slots[index] = stack));
  save.chests.push({
    dimension: game.world.dimension,
    x: hit.x,
    y: hit.y,
    z: hit.z,
    slots,
  });
  assert.equal(
    game.settlement.load(save, {
      context: game.worldContext,
      world: game.world,
    }),
    true
  );
}

function furnaceWithReward(game, hit, count = 3) {
  const save = game.settlement.serialize();
  save.furnaces.push({
    dimension: game.world.dimension,
    x: hit.x,
    y: hit.y,
    z: hit.z,
    ...createFurnace(),
    slots: [null, null, named(ITEM.IRON_INGOT, count, "Stored output")],
    experience: count,
  });
  assert.equal(
    game.settlement.load(save, {
      context: game.worldContext,
      world: game.world,
    }),
    true
  );
}

test("prepared mining is read-only; World, wear, metadata, loot and XP publish before observers", () => {
  const { game, drops, experience } = miningGame();
  const before = interactionSnapshot(game);
  const plan = game.harvestActions.prepareBreak(game.target);
  assert.ok(plan);
  assert.equal(
    new Set(plan.participants.map(({ owner }) => owner)).size,
    plan.participants.length
  );
  assert.deepEqual(interactionSnapshot(game), before);
  let observations = 0;
  game.gameplay.onChange = () => {
    observations++;
    assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
    assert.equal(game.gameplay.getHandStack().durability, 29);
    assert.equal(
      game.overflow.size,
      1,
      "retention precedes the deferred visible flush"
    );
    assert.equal(experience.length, 1);
  };
  const committed = game.harvestActions.commit(plan);
  assert.equal(committed.ok, true);
  assert.equal(committed.dropsCommitted, true);
  assert.equal(committed.experienceCommitted, true);
  assert.deepEqual(committed.observerErrors, []);
  assert.equal(observations, 1);
  assert.equal(countDrops(drops, ITEM.DIAMOND), 1);
  assert.deepEqual(game.gameplay.getHandStack().data, tool().data);
  assert.equal(game.harvestActions.commit(plan).ok, false);
  assert.equal(countDrops(drops, ITEM.DIAMOND), 1);
  assert.equal(experience.length, 1);
});

for (const refusal of ["overflow", "experience", "world", "budget"]) {
  test(`actual primary mining ${refusal} refusal leaves every resource owner unchanged`, () => {
    const { game } = miningGame();
    if (refusal === "overflow") fullOverflow(game);
    if (refusal === "experience") game.experienceOrbs.accept = false;
    if (refusal === "world") game.world.blocked.add(game.world.key(2, 9, 0));
    if (refusal === "budget")
      assert.equal(
        game.coordinator.register(
          {},
          MAX_RESERVED_BYTES - game.coordinator.budget.totalBytes
        ),
        true
      );
    const before = interactionSnapshot(game);
    game.primary(100);
    assert.deepEqual(interactionSnapshot(game), before);
  });
}

test("a hand replacement or newly stale World plan cannot publish mining loot or XP", () => {
  for (const stale of ["hand", "world"]) {
    const { game } = miningGame();
    const plan = game.harvestActions.prepareBreak(game.target);
    assert.ok(plan);
    if (stale === "hand") game.gameplay.select(1);
    else game.world.setLoaded(2, 0, false);
    const before = interactionSnapshot(game);
    assert.equal(game.harvestActions.commit(plan).ok, false);
    assert.deepEqual(interactionSnapshot(game), before);
  }
});

test("deepslate ore aliases enforce original material tiers and final-use tools still earn their loot", () => {
  const wrong = miningGame(
    BLOCK.DEEPSLATE_DIAMOND_ORE,
    tool(ITEM.WOOD_PICKAXE)
  );
  wrong.game.primary(100);
  assert.equal(wrong.game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(wrong.drops.length, 0);
  assert.equal(wrong.experience.length, 0);
  assert.equal(wrong.game.gameplay.getHandStack().durability, 29);
  const last = miningGame(
    BLOCK.DEEPSLATE_DIAMOND_ORE,
    tool(ITEM.IRON_PICKAXE, 1)
  );
  last.game.primary(100);
  assert.equal(last.game.gameplay.getHandStack(), null);
  assert.equal(countDrops(last.drops, ITEM.DIAMOND), 1);
  assert.ok(experienceTotal(last.experience) > 0);
  assert.equal(
    last.messages.filter((message) => /broke/.test(message)).length,
    1
  );
});

test("new range metadata and legacy alias counts produce bounded, reachable raw drops", () => {
  for (const [id, dropId, count] of [
    [BLOCK.DEEPSLATE_COPPER_ORE, ITEM.RAW_COPPER, 2],
    [BLOCK.NETHER_GOLD_ORE, ITEM.GOLD_NUGGET, 6],
    [BLOCK.NETHER_QUARTZ_ORE, ITEM.QUARTZ, 1],
    [BLOCK.SEA_LANTERN, ITEM.PRISMARINE_CRYSTALS, 3],
  ]) {
    const { game, drops } = miningGame(id);
    game.primary(100);
    assert.equal(countDrops(drops, dropId), count, `authored block ${id}`);
  }
});

test("silk drops preserve intact ore and suppress XP without removing the held enchantment", () => {
  for (const id of [
    BLOCK.DIAMOND_ORE,
    BLOCK.DEEPSLATE_DIAMOND_ORE,
    BLOCK.NETHER_QUARTZ_ORE,
  ]) {
    const held = tool(ITEM.DIAMOND_PICKAXE);
    held.data.enchantments = { silk_touch: 1 };
    const { game, drops, experience } = miningGame(id, held);
    game.primary(100);
    assert.equal(countDrops(drops, id), 1);
    assert.equal(experience.length, 0);
    assert.deepEqual(game.gameplay.getHandStack().data, held.data);
    assert.equal(game.gameplay.getHandStack().durability, 29);
  }
});

test("double slabs pay two items once and waterlogged breaks restore source water", () => {
  for (const [state, fluid, count, replacement] of [
    [S.DOUBLE, FLUID.NONE, 2, BLOCK.AIR],
    [S.TOP, FLUID.WATER_SOURCE, 1, BLOCK.WATER],
  ]) {
    const { game, drops } = parityGame("survival", { generatorVersion: 4 });
    setOwnedSlots(game, [[0, tool(ITEM.WOOD_AXE)]]);
    target(game, BLOCK.OAK_SLAB, 2, 9, 0, state, fluid);
    game.primary(100);
    assert.equal(countDrops(drops, BLOCK.OAK_SLAB), count);
    assert.equal(game.world.get(2, 9, 0), replacement);
    assert.equal(game.gameplay.getHandStack().durability, 29);
    game.primary(100);
    assert.equal(countDrops(drops, BLOCK.OAK_SLAB), count);
  }
});

test("linked upper-half mining removes both halves for one drop and one tool use", () => {
  const { game, drops } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, tool(ITEM.WOOD_AXE)]]);
  target(game, BLOCK.OAK_DOOR, 2, 9, 0, 0);
  target(game, BLOCK.OAK_DOOR, 2, 10, 0, S.PART);
  const plan = game.harvestActions.prepareBreak(game.target);
  assert.ok(plan);
  assert.equal(plan.result.rootKey, "overworld:2,9,0");
  assert.equal(game.harvestActions.commit(plan).ok, true);
  assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
  assert.equal(countDrops(drops, BLOCK.OAK_DOOR), 1);
  assert.equal(game.gameplay.getHandStack().durability, 29);
});

test("a loaded orphan linked half can be cleaned up without inventing another item", () => {
  const { game, drops } = parityGame("survival", { generatorVersion: 4 });
  setOwnedSlots(game, [[0, tool(ITEM.WOOD_AXE)]]);
  target(game, BLOCK.OAK_DOOR, 2, 10, 0, S.PART);
  game.primary(100);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
  assert.equal(drops.length, 0);
});

test("empty and populated chest breaks prepare exactly one combined block/content sink", () => {
  for (const contents of [
    [],
    [named(ITEM.WOOD_PICKAXE, 1, "<chest tool>", 7)],
  ]) {
    const { game, drops } = miningGame(BLOCK.CHEST, tool(ITEM.WOOD_AXE));
    if (contents.length) chestWithContents(game, game.target, contents);
    const prepare = game.prepareDropItems.bind(game);
    const proposals = [];
    game.prepareDropItems = (stacks, ...args) => {
      proposals.push(structuredClone(stacks));
      return prepare(stacks, ...args);
    };
    game.primary(100);
    assert.deepEqual(proposals, [[{ id: BLOCK.CHEST, count: 1 }, ...contents]]);
    assert.equal(countDrops(drops, BLOCK.CHEST), 1);
    if (contents.length) {
      const saved = drops.find((drop) => drop.id === ITEM.WOOD_PICKAXE);
      assert.deepEqual(saved.data, contents[0].data);
      assert.equal(saved.durability, 7);
    }
    assert.equal(game.settlement.chests.size, 0);
    assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
    assert.equal(game.releaseContainer(game.target), false);
    assert.equal(countDrops(drops, BLOCK.CHEST), 1);
  }
});

test("container destination and late World veto preserve contents, block, held metadata and wear", () => {
  for (const refusal of ["overflow", "late-world"]) {
    const { game } = miningGame(BLOCK.CHEST, tool(ITEM.WOOD_AXE));
    chestWithContents(game, game.target, [named(ITEM.APPLE, 4, "Saved lunch")]);
    if (refusal === "overflow") fullOverflow(game);
    else {
      const prepare = game.prepareDropItems.bind(game);
      game.prepareDropItems = (...args) => {
        const participant = prepare(...args);
        game.world.blocked.add(game.world.key(2, 9, 0));
        return participant;
      };
    }
    const before = interactionSnapshot(game);
    game.primary(100);
    assert.deepEqual(interactionSnapshot(game), before);
  }
});

test("furnace break retains the block, named output and stored XP together, exactly once", () => {
  const { game, drops, experience } = miningGame(BLOCK.FURNACE);
  furnaceWithReward(game, game.target);
  game.experienceOrbs.accept = false;
  const before = interactionSnapshot(game);
  game.primary(100);
  assert.deepEqual(interactionSnapshot(game), before);
  game.experienceOrbs.accept = true;
  game.primary(100);
  assert.equal(game.settlement.furnaces.size, 0);
  assert.equal(countDrops(drops, BLOCK.FURNACE), 1);
  assert.equal(countDrops(drops, ITEM.IRON_INGOT), 3);
  assert.equal(
    drops.find((drop) => drop.id === ITEM.IRON_INGOT).data.name,
    "Stored output"
  );
  assert.equal(experienceTotal(experience), 3);
  game.primary(100);
  assert.equal(experienceTotal(experience), 3);
  assert.equal(countDrops(drops, ITEM.IRON_INGOT), 3);
});

function cropGame(full = false) {
  const f = parityGame("survival", { generatorVersion: 4 });
  const { game } = f;
  setOwnedSlots(game, [[0, { id: ITEM.SEEDS, count: 1 }]]);
  game.world.set(2, 8, 0, BLOCK.DIRT);
  assert.equal(
    game.plantFromHand("main", { x: 2, y: 8, z: 0, id: BLOCK.DIRT }),
    true
  );
  assert.equal(game.settlement.update(CROP_GROW_SECONDS, game.world), true);
  game.target = { x: 2, y: 9, z: 0, ...game.world.getCell(2, 9, 0) };
  assert.equal(game.target.id, BLOCK.WHEAT_CROP);
  setOwnedSlots(
    game,
    full
      ? Array.from({ length: 36 }, (_, index) => [
          index,
          index === 0 ? tool() : { id: BLOCK.DIRT, count: 64 },
        ])
      : [[0, tool()]]
  );
  return f;
}

test("tracked crops use one existing source/player/World plan, with no duplicate generic loot or wear", () => {
  const { game, drops } = cropGame();
  const plan = game.harvestActions.prepareBreak(game.target);
  assert.ok(plan);
  assert.equal(
    plan.participants.filter(({ owner }) => owner === game.gameplay).length,
    1
  );
  assert.equal(
    plan.participants.filter(({ owner }) => owner === game.world).length,
    1
  );
  assert.equal(game.harvestActions.commit(plan).ok, true);
  assert.equal(game.gameplay.count(ITEM.WHEAT), 2);
  assert.equal(game.gameplay.count(ITEM.SEEDS), 1);
  assert.equal(game.gameplay.getHandStack().durability, 30);
  assert.equal(game.settlement.crops.size, 0);
  assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(drops.length, 0);
});

test("a full crop inventory plus a refused overflow destination leaves crop and inventory untouched", () => {
  const { game } = cropGame(true);
  fullOverflow(game);
  const before = interactionSnapshot(game);
  game.primary(100);
  assert.deepEqual(interactionSnapshot(game), before);
});

test("explosions are per-block atomic: a refused chest stays whole while unrelated terrain breaks", () => {
  const { game, drops } = miningGame(BLOCK.CHEST, tool(), { floor: null });
  chestWithContents(game, game.target, [
    named(ITEM.APPLE, 4, "Keep this chest"),
  ]);
  game.world.set(3, 9, 0, BLOCK.DIRT);
  game.world.set(2, 10, 0, BLOCK.OBSIDIAN);
  game.world.set(2, 9, 1, BLOCK.ANCIENT_DEBRIS);
  const beforePlayer = game.gameplay.serialize();
  const beforeStation = game.settlement.serialize();
  const prepare = game.prepareDropItems.bind(game);
  game.prepareDropItems = (stacks, ...args) =>
    stacks.some((stack) => stack.data?.name === "Keep this chest")
      ? null
      : prepare(stacks, ...args);
  const changed = game.explode({ x: 2.5, y: 9.5, z: 0.5 }, 2, false);
  assert.deepEqual(
    changed.map((hit) => hit.id),
    [BLOCK.DIRT]
  );
  assert.equal(game.world.get(2, 9, 0), BLOCK.CHEST);
  assert.equal(game.world.get(2, 10, 0), BLOCK.OBSIDIAN);
  assert.equal(game.world.get(2, 9, 1), BLOCK.ANCIENT_DEBRIS);
  assert.equal(countDrops(drops, BLOCK.DIRT), 1);
  assert.equal(countDrops(drops, BLOCK.CHEST), 0);
  assert.deepEqual(game.settlement.serialize(), beforeStation);
  assert.deepEqual(game.gameplay.serialize(), beforePlayer);
});

test("explosion furnace XP is retained once; blast ore drops never borrow held silk or mining XP", () => {
  const held = tool(ITEM.DIAMOND_PICKAXE);
  held.data.enchantments = { silk_touch: 1 };
  const { game, drops, experience } = miningGame(BLOCK.FURNACE, held, {
    floor: null,
  });
  furnaceWithReward(game, game.target);
  game.world.set(3, 9, 0, BLOCK.DEEPSLATE_DIAMOND_ORE);
  const before = game.gameplay.serialize();
  game.explode({ x: 2.5, y: 9.5, z: 0.5 }, 1, false);
  assert.equal(countDrops(drops, BLOCK.FURNACE), 1);
  assert.equal(countDrops(drops, ITEM.IRON_INGOT), 3);
  assert.equal(countDrops(drops, ITEM.DIAMOND), 1);
  assert.equal(countDrops(drops, BLOCK.DEEPSLATE_DIAMOND_ORE), 0);
  assert.equal(experienceTotal(experience), 3);
  assert.deepEqual(game.gameplay.serialize(), before);
  game.explode({ x: 2.5, y: 9.5, z: 0.5 }, 1, false);
  assert.equal(experienceTotal(experience), 3);
  assert.equal(countDrops(drops, ITEM.IRON_INGOT), 3);
});

test("an explosion touching both linked halves pays one logical item, with no tool debit", () => {
  const { game, drops } = parityGame("survival", {
    generatorVersion: 4,
    floor: null,
  });
  setOwnedSlots(game, [[0, tool(ITEM.WOOD_AXE)]]);
  target(game, BLOCK.OAK_DOOR, 2, 9, 0, 0);
  target(game, BLOCK.OAK_DOOR, 2, 10, 0, S.PART);
  const before = game.gameplay.serialize();
  game.explode({ x: 2.5, y: 9.5, z: 0.5 }, 1, false);
  assert.equal(countDrops(drops, BLOCK.OAK_DOOR), 1);
  assert.equal(game.world.get(2, 9, 0), BLOCK.AIR);
  assert.equal(game.world.get(2, 10, 0), BLOCK.AIR);
  assert.deepEqual(game.gameplay.serialize(), before);
});

test("contextual v3 loads retain decorated tools for high-ID mining at signed v4 coordinates", () => {
  const { game, drops } = miningGame(BLOCK.DEEPSLATE_DIAMOND_ORE);
  const save = game.gameplay.serialize();
  assert.equal(save.version, 3);
  assert.equal(game.gameplay.load(save, { context: game.worldContext }), true);
  target(game, BLOCK.DEEPSLATE_DIAMOND_ORE, -18, -20, 17);
  game.primary(100);
  assert.equal(game.world.get(-18, -20, 17), BLOCK.AIR);
  assert.equal(countDrops(drops, ITEM.DIAMOND), 1);
  assert.deepEqual(game.gameplay.getHandStack().data, tool().data);
  assert.ok(getItem(BLOCK.DEEPSLATE_DIAMOND_ORE));
});

test("a publication invariant during harvest propagates to the Game caller", () => {
  const { game } = miningGame();
  const prepare = game.world.prepareMutation.bind(game.world);
  game.world.prepareMutation = (...args) => {
    const participant = prepare(...args);
    return (
      participant && {
        ...participant,
        publish: () => {
          throw new Error("authored harvest publication invariant");
        },
      }
    );
  };
  assert.throws(() => game.primary(100), TransactionInvariantError);
});
