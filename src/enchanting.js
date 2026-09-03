import { BLOCK, BLOCKS } from "./blocks.js";
import { normalizeCell } from "./block-state.js";
import {
  dataRecord,
  enchantedBookOutput,
  enchantingRandom,
  equipmentMode,
  equipmentProfile,
  immutable,
  integer,
  isEnchantmentCarrier,
  isPlainEnchantableBook,
  nextEnchantingSeed,
  refusal,
  spendExperienceLevels,
  synchronous,
  withEnchantmentData,
} from "./enchantment-domain.js";
import {
  enchantmentCandidates,
  enchantmentsCompatible,
} from "./enchantment-rules.js";
import { prepareEquipmentStationTransaction } from "./equipment-station-transactions.js";
import { experienceState, isValidExperience } from "./experience.js";
import { normalizeStack } from "./inventory-slots.js";
import { normalizeEnchantments } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";

export const ENCHANTING_RECORD_VERSION = 1;
export const ENCHANTING_PLAYER_VERSION = 1;
export const MAX_BOOKSHELF_POWER = 15;

/**
 * Persist ONE player record across every table, close, reload and dimension.
 * Initialization is an explicit archive-migration decision; missing/corrupt
 * records must not silently reroll. Version 1 uses a project-owned uint32 RNG,
 * not exact Mojang seed parity. Offers are derived, transient, unpaid previews.
 */
export function normalizeEnchantingPlayer(value) {
  dataRecord(value, ["version", "seed"], "enchanting player");
  if (value.version !== ENCHANTING_PLAYER_VERSION)
    throw new RangeError("Unsupported enchanting player version");
  integer(value.seed, "enchanting seed", 0, 0xffffffff);
  return immutable({ version: ENCHANTING_PLAYER_VERSION, seed: value.seed });
}

export const createEnchantingPlayer = (seed) =>
  normalizeEnchantingPlayer({ version: ENCHANTING_PLAYER_VERSION, seed });

/**
 * Persist the actual input/lapis escrow, not offers or an extra result item.
 * Structurally valid but ineligible inputs remain owned and withdrawable.
 * Closing the UI must retain this record, or return its stacks using one
 * prepared inventory/retained-drop transaction; never clear on failed capacity.
 */
export function normalizeEnchantingRecord(value, context) {
  dataRecord(value, ["version", "input", "lapis"], "enchanting escrow");
  if (value.version !== ENCHANTING_RECORD_VERSION)
    throw new RangeError("Unsupported enchanting escrow version");
  return immutable({
    version: ENCHANTING_RECORD_VERSION,
    input: value.input === null ? null : normalizeStack(value.input, context),
    lapis: value.lapis === null ? null : normalizeStack(value.lapis, context),
  });
}

export const createEnchantingRecord = () =>
  normalizeEnchantingRecord({
    version: ENCHANTING_RECORD_VERSION,
    input: null,
    lapis: null,
  });

const defaultPower = (cell) => BLOCKS[cell.id]?.enchantingPower ?? 0;
const defaultTransmitter = (cell) =>
  BLOCKS[cell.id]?.enchantingTransmitter === true ||
  [BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA].includes(cell.id);

/**
 * Pure bounded sampler over a caller's NON-GENERATING cell reader.
 * Java 26.2: max(|dx|,|dz|)=2, dy=0 or 1; the gap at that SAME height is
 * (trunc(dx/2), dy, trunc(dz/2)). In particular (2,1) uses the side gap (1,0),
 * not the corner (1,1). Neither two-high air nor generic transparency is correct.
 *
 * Providers use the existing enchantingPower:1 capability. Transmitters use
 * enchantingTransmitter:true; AIR/WATER/LAVA are known defaults. The actual
 * 26.2 #enchantment_power_transmitter tag is #replaceable, including those
 * fluids, short grass and snow layers, but not torches/carpet or full snow blocks.
 * https://minecraft.wiki/w/Enchanting_mechanics#Bookshelf_placement
 * https://raw.githubusercontent.com/misode/mcmeta/26.2-data/data/minecraft/tags/block/replaceable.json
 *
 * Null cells reject rather than assume air. Returned reads are data only: the
 * parent must attach a validator that also pins world/chunk admission/revisions
 * (cell equality alone does not detect remove/reinsert or unload/readmit).
 */
export function sampleBookshelfPower(
  readCell,
  position,
  { powerOf = defaultPower, transmits = defaultTransmitter } = {}
) {
  try {
    if (![readCell, powerOf, transmits].every(synchronous))
      return refusal("invalid_bookshelf_reader");
    for (const axis of ["x", "y", "z"])
      integer(position?.[axis], axis, -30_000_000, 30_000_000);
    const reads = new Map();
    const read = (dx, dy, dz) => {
      const x = position.x + dx,
        y = position.y + dy,
        z = position.z + dz;
      const key = `${x},${y},${z}`;
      if (!reads.has(key)) {
        const cell = readCell(x, y, z);
        reads.set(key, {
          x,
          y,
          z,
          cell: cell === null ? null : normalizeCell(cell),
        });
      }
      return reads.get(key).cell;
    };
    const providers = [];
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
          const shelf = read(dx, dy, dz);
          const gap = read(Math.trunc(dx / 2), dy, Math.trunc(dz / 2));
          if (shelf === null || gap === null)
            return refusal("unloaded_bookshelves");
          const power = integer(powerOf(shelf), "provider power", 0, 1);
          const transmitted = transmits(gap);
          if (typeof transmitted !== "boolean")
            return refusal("invalid_transmitter");
          if (power && transmitted)
            providers.push({
              x: position.x + dx,
              y: position.y + dy,
              z: position.z + dz,
            });
        }
      }
    }
    return immutable({
      ok: true,
      power: Math.min(MAX_BOOKSHELF_POWER, providers.length),
      providers,
      reads: [...reads.values()],
    });
  } catch {
    return refusal("invalid_bookshelf_input");
  }
}

function selectEnchantments(item, requirement, enchantability, random) {
  const quarter = Math.floor(enchantability / 4);
  const base = requirement + 1 + random.int(quarter) + random.int(quarter);
  const variation = (random.next() + random.next() - 1) * 0.15;
  let power = Math.max(1, Math.round(base * (1 + variation)));
  let candidates = [...enchantmentCandidates(item, power)];
  const selected = {};
  while (candidates.length) {
    let weight =
      random.next() * candidates.reduce((sum, entry) => sum + entry.weight, 0);
    const chosen = candidates.find((entry) => (weight -= entry.weight) < 0);
    selected[chosen.name] = chosen.level;
    candidates = candidates.filter(
      (entry) =>
        entry.name !== chosen.name &&
        enchantmentsCompatible(entry.name, chosen.name)
    );
    if (!candidates.length || random.int(49) > power) break;
    power = Math.floor(power / 2);
  }
  const names = Object.keys(selected);
  if (isPlainEnchantableBook(item) && names.length > 1)
    delete selected[names[random.int(names.length - 1)]];
  return normalizeEnchantments(selected);
}

/**
 * Three deterministic offers independent of current XP/lapis, name, or wear.
 * Requirements use Java's bookshelf formula, followed by material enchantability,
 * triangular +/-15% variation, weighted compatible selection and book removal.
 * Selection is restricted to our effect-backed subset, so neither full vanilla
 * probabilities nor exact Mojang RNG/seed parity are claimed.
 */
export function getEnchantingOffers({
  input,
  playerState,
  bookshelfPower,
  resources = {},
  bindings = {},
  context,
}) {
  try {
    const player = normalizeEnchantingPlayer(playerState);
    integer(bookshelfPower, "bookshelf power");
    const power = Math.min(MAX_BOOKSHELF_POWER, bookshelfPower);
    if (input === null) return refusal("missing_input");
    const stack = normalizeStack(input, context);
    const item = getItem(stack.id);
    if (stack.count !== 1) return refusal("input_count");
    if (Object.keys(stack.data?.enchantments ?? {}).length)
      return refusal("already_enchanted");
    if (isEnchantmentCarrier(item)) return refusal("not_enchantable");
    const book = isPlainEnchantableBook(item);
    const profile = equipmentProfile(item.id, bindings);
    if ((!book && !item.durability) || profile.enchantability < 1)
      return refusal("not_enchantable");
    const outputId = book ? enchantedBookOutput(resources) : stack.id;
    if (outputId === null) return refusal("unregistered_enchanted_book");
    const costs = enchantingRandom(player.seed);
    const offers = [];
    for (let index = 0; index < 3; index++) {
      const base = 1 + costs.int(7) + Math.floor(power / 2) + costs.int(power);
      const requiredLevel =
        index === 0
          ? Math.max(1, Math.floor(base / 3))
          : index === 1
            ? Math.floor((base * 2) / 3) + 1
            : Math.max(base, 2 * power);
      const random = enchantingRandom(
        (player.seed + (index + 1) * 0x9e3779b9) >>> 0
      );
      const enchantments =
        requiredLevel < index + 1
          ? {}
          : selectEnchantments(
              item,
              requiredLevel,
              profile.enchantability,
              random
            );
      const names = Object.keys(enchantments);
      const name = names.length ? names[random.int(names.length - 1)] : null;
      offers.push({
        index,
        requiredLevel,
        levelCost: index + 1,
        lapisCost: index + 1,
        available: names.length > 0,
        enchantments,
        clue: name === null ? null : { name, level: enchantments[name] },
        key: JSON.stringify([
          1,
          player.seed,
          power,
          stack,
          outputId,
          index,
          requiredLevel,
          enchantments,
        ]),
      });
    }
    return immutable({ ok: true, seed: player.seed, power, offers });
  } catch {
    return refusal("invalid_enchanting_input");
  }
}

/** A fully funded pure plan; no escrow, XP, or seed changes occur here. */
export function planEnchanting({
  record,
  playerState,
  bookshelfPower,
  index,
  offerKey,
  experienceTotal,
  mode = "survival",
  resources = {},
  bindings = {},
  context,
}) {
  try {
    equipmentMode(mode);
    if (!isValidExperience(experienceTotal))
      return refusal("invalid_experience");
    const beforeRecord = normalizeEnchantingRecord(record, context);
    const beforePlayer = normalizeEnchantingPlayer(playerState);
    integer(index, "offer index", 0, 2);
    const menu = getEnchantingOffers({
      input: beforeRecord.input,
      playerState: beforePlayer,
      bookshelfPower,
      resources,
      bindings,
      context,
    });
    if (!menu.ok) return menu;
    const offer = menu.offers[index];
    if (!offer.available) return refusal("empty_offer");
    if (typeof offerKey !== "string" || offerKey !== offer.key)
      return refusal("stale_offer");
    const creative = mode === "creative";
    if (
      !creative &&
      experienceState(experienceTotal).level < offer.requiredLevel
    )
      return refusal("required_level", { requiredLevel: offer.requiredLevel });
    const lapisId = resources.lapis ?? ITEM.LAPIS;
    if (
      lapisId !== ITEM.LAPIS &&
      getItem(lapisId)?.enchantingReagent !== "lapis"
    )
      return refusal("invalid_lapis_resource");
    const lapisCost = creative ? 0 : offer.lapisCost;
    if (!creative && beforeRecord.lapis?.id !== lapisId)
      return refusal("invalid_lapis");
    if (!creative && beforeRecord.lapis.count < lapisCost)
      return refusal("insufficient_lapis");
    const chargedLevels = creative ? 0 : offer.levelCost;
    const experienceAfter = spendExperienceLevels(
      experienceTotal,
      chargedLevels
    );
    if (experienceAfter === null) return refusal("insufficient_levels");
    const inputItem = getItem(beforeRecord.input.id);
    const output = withEnchantmentData(
      beforeRecord.input,
      { enchantments: offer.enchantments },
      {
        id: isPlainEnchantableBook(inputItem)
          ? enchantedBookOutput(resources)
          : beforeRecord.input.id,
        context,
      }
    );
    const lapis = !lapisCost
      ? beforeRecord.lapis
      : beforeRecord.lapis.count === lapisCost
        ? null
        : {
            ...beforeRecord.lapis,
            count: beforeRecord.lapis.count - lapisCost,
          };
    const afterRecord = normalizeEnchantingRecord(
      {
        version: ENCHANTING_RECORD_VERSION,
        input: output,
        lapis,
      },
      context
    );
    const afterPlayer = createEnchantingPlayer(
      nextEnchantingSeed(beforePlayer.seed)
    );
    return immutable({
      ok: true,
      before: { record: beforeRecord, playerState: beforePlayer },
      after: { record: afterRecord, playerState: afterPlayer },
      output,
      requiredLevel: offer.requiredLevel,
      levelCost: offer.levelCost,
      chargedLevels,
      lapisCost,
      experienceBefore: experienceTotal,
      experienceAfter,
      offerKey: offer.key,
    });
  } catch {
    return refusal("invalid_enchanting_input");
  }
}

/**
 * shelves must be a successful sampleBookshelfPower result with an attached
 * synchronous validate() pinning the complete world read set. prepareStation
 * must cover BOTH escrow and the persisted player seed (possibly separate
 * participants). XP shares the existing Gameplay participant. No commit here.
 */
export function prepareEnchantingTransaction({
  gameplay,
  record,
  playerState,
  shelves,
  index,
  offerKey,
  resources,
  bindings,
  prepareStation,
  validateAccess,
  participants = [],
  context = gameplay?.context,
}) {
  if (
    shelves?.ok !== true ||
    !synchronous(shelves.validate) ||
    !synchronous(validateAccess)
  )
    return refusal("missing_shelf_reads");
  const power = shelves.power;
  const validateShelves = shelves.validate;
  return prepareEquipmentStationTransaction({
    gameplay,
    prepareStation,
    participants,
    validateAccess: () =>
      shelves.power === power &&
      shelves.validate === validateShelves &&
      validateShelves.call(shelves) === true &&
      validateAccess() === true,
    preview: (experienceTotal, mode) =>
      planEnchanting({
        record,
        playerState,
        bookshelfPower: power,
        index,
        offerKey,
        experienceTotal,
        mode,
        resources,
        bindings,
        context,
      }),
  });
}
