import { BLOCK, BLOCKS } from "./blocks.js";
import {
  wearDraftHand,
  withBrokenToolNotice,
} from "./gameplay-hand-actions.js";
import { enchantmentLevel, resolveItemStats } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";

export const MINING_TOOLS = new Set([
  "pickaxe",
  "axe",
  "shovel",
  "sword",
  "hoe",
  "shears",
]);
const leaves = new Set([
  BLOCK.LEAVES,
  BLOCK.BIRCH_LEAVES,
  BLOCK.SPRUCE_LEAVES,
  BLOCK.ACACIA_LEAVES,
  BLOCK.JUNGLE_LEAVES,
  BLOCK.CHERRY_LEAVES,
  BLOCK.DARK_OAK_LEAVES,
  BLOCK.PALE_LEAVES,
  BLOCK.MANGROVE_LEAVES,
  BLOCK.CRIMSON_LEAVES,
  BLOCK.WARPED_LEAVES,
]);
const oreDrops = new Map([
  [BLOCK.COAL_ORE, [ITEM.COAL, 1, 1]],
  [BLOCK.IRON_ORE, [ITEM.RAW_IRON, 1, 2]],
  [BLOCK.COPPER_ORE, [ITEM.RAW_COPPER, 2, 2]],
  [BLOCK.GOLD_ORE, [ITEM.RAW_GOLD, 1, 3]],
  [BLOCK.DIAMOND_ORE, [ITEM.DIAMOND, 1, 3]],
  [BLOCK.REDSTONE_ORE, [ITEM.REDSTONE, 4, 3]],
  [BLOCK.EMERALD_ORE, [ITEM.EMERALD, 1, 3]],
  [BLOCK.LAPIS_ORE, [ITEM.LAPIS, 4, 2]],
]);
const soil = new Set([
  BLOCK.GRASS,
  BLOCK.PODZOL,
  BLOCK.MYCELIUM,
  BLOCK.FARMLAND,
]);
const unbreakable = new Set([
  BLOCK.AIR,
  BLOCK.WATER,
  BLOCK.LAVA,
  BLOCK.BEDROCK,
  BLOCK.NETHER_PORTAL,
  BLOCK.END_PORTAL,
]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function miningProfile(id) {
  if (!Number.isInteger(id)) return null;
  const block = BLOCKS[id];
  if (!block || unbreakable.has(id)) return null;
  const ore = oreDrops.get(block.harvestAs ?? id);
  let tool = block.tool;
  let tier = tool === "pickaxe" ? Math.max(1, block.tier ?? 1) : 0;
  if (
    ore ||
    [BLOCK.STONE, BLOCK.COBBLESTONE, BLOCK.FURNACE, BLOCK.OBSIDIAN].includes(id)
  ) {
    tool = "pickaxe";
    tier = block.tier ?? ore?.[2] ?? (id === BLOCK.OBSIDIAN ? 4 : 1);
  }
  const hardness = block.hardness ?? (ore ? 3 : 1.5);
  if (!Number.isFinite(hardness) || hardness < 0) return null;
  return { block, tool, tier, hardness, ore };
}

const correctTool = (profile, item) =>
  item?.kind === "tool" && item.tool === profile.tool;
const canHarvest = (profile, item) =>
  !profile.tier || (correctTool(profile, item) && item.tier >= profile.tier);

export function miningDuration(gameplay, blockId, { modifySpeed } = {}) {
  const profile = miningProfile(blockId);
  if (!profile || gameplay.dead) return Infinity;
  if (gameplay.mode === "creative") return 0.08;
  const stack = gameplay.getHandStack();
  const held = getItem(stack?.id);
  const correct = correctTool(profile, held);
  const speed = modifySpeed ? modifySpeed(correct ? held.speed ?? 1 : 1, correct, stack) : correct
    ? resolveItemStats(stack, {
        context: gameplay.context,
        effectiveMiningTool: true,
      }).speed
    : 1;
  if (!Number.isFinite(speed) || speed <= 0) return Infinity;
  return Math.max(
    0.08,
    (profile.hardness * (canHarvest(profile, held) ? 1.5 : 5)) / speed
  );
}

function rangeCount(range, random) {
  const [minimum, maximum] = range;
  const sample = Number(random());
  const bounded = Number.isFinite(sample)
    ? Math.max(0, Math.min(1 - Number.EPSILON, sample))
    : 0;
  return minimum + Math.floor(bounded * (maximum - minimum + 1));
}

/**
 * Pure loot proposal. Geometry supplies a block-item override/multiplicity
 * (e.g. two slabs); material eligibility, ore ranges and silk belong here.
 * Explosions have no held tool and cannot borrow its silk touch or mining XP.
 */
export function harvestDrops(
  blockId,
  {
    stack = null,
    mode = "survival",
    context,
    random = Math.random,
    explosion = false,
    dropId,
    dropCount = 1,
  } = {}
) {
  const profile = miningProfile(blockId);
  if (
    !profile ||
    !Number.isSafeInteger(dropCount) ||
    dropCount < 0 ||
    dropCount > 64 ||
    (dropId !== undefined && !getItem(dropId))
  )
    return null;
  if (mode === "creative" || dropCount === 0) return [];
  if (!explosion && !canHarvest(profile, getItem(stack?.id))) return [];
  const silk =
    !explosion && stack && enchantmentLevel(stack, "silk_touch", context) > 0;
  const intact = profile.block.silkDrop ?? (profile.ore ? blockId : null);
  let drops = [];
  if (silk && intact) {
    drops = [{ id: intact, count: 1 }];
  } else if (profile.ore) {
    drops = [
      {
        id: profile.ore[0],
        count: profile.block.dropCount
          ? rangeCount(profile.block.dropCount, random)
          : profile.ore[1],
      },
    ];
  } else if (leaves.has(blockId)) {
    if (random() < 0.1) drops.push({ id: ITEM.STICK, count: 1 });
    if (
      [BLOCK.LEAVES, BLOCK.DARK_OAK_LEAVES].includes(blockId) &&
      random() < 0.05
    )
      drops.push({ id: ITEM.APPLE, count: 1 });
  } else if ([BLOCK.TALL_GRASS, BLOCK.FERN].includes(blockId)) {
    if (random() < 0.125) drops = [{ id: ITEM.SEEDS, count: 1 }];
  } else if (blockId === BLOCK.DEAD_BUSH) {
    drops = [{ id: ITEM.STICK, count: 2 }];
  } else if (blockId === BLOCK.WHEAT_CROP) {
    drops = [
      { id: ITEM.WHEAT, count: 1 },
      { id: ITEM.SEEDS, count: 1 },
    ];
  } else if (
    blockId !== BLOCK.GLASS &&
    ![BLOCK.ICE, BLOCK.PACKED_ICE, BLOCK.BLUE_ICE].includes(blockId)
  ) {
    let id = dropId ?? profile.block.drop ?? blockId;
    // Air is an explicit no-loot sentinel; the harvest still pays its costs.
    if (id === BLOCK.AIR) return [];
    if (soil.has(blockId)) id = BLOCK.DIRT;
    if (blockId === BLOCK.STONE) id = BLOCK.COBBLESTONE;
    if (blockId === BLOCK.GRAVEL && random() < 0.1) id = ITEM.FLINT;
    if (getItem(id))
      drops = [
        {
          id,
          count: profile.block.dropCount
            ? rangeCount(profile.block.dropCount, random)
            : 1,
        },
      ];
  }
  return drops.map((drop) => ({ ...drop, count: drop.count * dropCount }));
}

/** Hand wear, exhaustion and the loot proposal share one bounded player edit. */
export function prepareHarvest(gameplay, blockId, options = {}) {
  if (!record(options) || !miningProfile(blockId)) return null;
  const { notify = true, dropId, dropCount = 1 } = options;
  const stack = gameplay.getHandStack();
  const held = getItem(stack?.id);
  const selected = gameplay.selected;
  let drops;
  let broken = false;
  const participant = gameplay._prepareState(
    (state) => {
      drops = harvestDrops(blockId, {
        stack,
        mode: gameplay.mode,
        random: gameplay.random,
        context: gameplay.context,
        dropId,
        dropCount,
      });
      if (!drops) return false;
      if (gameplay.mode !== "creative") {
        if (MINING_TOOLS.has(held?.tool))
          broken = wearDraftHand(
            state.owned,
            "main",
            selected,
            held.tool === "sword" ? 2 : 1
          );
        state.exhaustion += 0.025;
        while (state.exhaustion >= 4) {
          state.exhaustion -= 4;
          if (state.saturation > 0)
            state.saturation = Math.max(0, state.saturation - 1);
          else state.hunger = Math.max(0, state.hunger - 1);
        }
      }
      return true;
    },
    { notify, selfUseHands: ["main"] }
  );
  return participant
    ? Object.freeze({
        participant: withBrokenToolNotice(participant, gameplay, stack, broken),
        drops: Object.freeze(drops.map((drop) => Object.freeze(drop))),
      })
    : null;
}
