import { cellsEqual, normalizeCell } from "./block-state.js";
import {
  CHEST_SLOTS,
  migrateChestItems,
  validSlotArray,
} from "./container-slots.js";
import { cloneFurnace, isValidFurnace } from "./furnace.js";
import { cloneSlots } from "./inventory-slots.js";
import { RECIPES } from "./recipes.js";
import { encodedBytes } from "./save-budget.js";
import { CHUNK_SIZE, GENERATOR_VERSION } from "./terrain.js";
import {
  createWorldContext,
  DIMENSIONS,
  getWorldSpec,
  inWorldBounds,
} from "./world-spec.js";

export const SETTLEMENT_VERSION = 3;
export const CROP_GROW_SECONDS = 45;
export const MAX_SETTLEMENT_ENTRIES = 16384;
export const STATION_KINDS = Object.freeze(["chest", "furnace", "crop"]);
export const stationKey = (dimension, x, y, z) => `${dimension}:${x},${y},${z}`;
export const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function stationPosition(key) {
  const [dimension, coordinates] = key.split(":");
  const [x, y, z] = coordinates.split(",").map(Number);
  return { dimension, x, y, z };
}

/** Snapshot and validate every dimension, never just the current world's spec. */
export function normalizeSettlementContext(context) {
  if (context === undefined) return undefined;
  if (
    !isRecord(context) ||
    typeof context.seed !== "string" ||
    context.seed.length > 80 ||
    typeof context.specForDimension !== "function" ||
    Object.prototype.toString.call(context.specForDimension) !==
      "[object Function]"
  )
    throw new RangeError("Invalid settlement world context");
  for (const dimension of DIMENSIONS) {
    const canonical = getWorldSpec(context.generatorVersion, dimension);
    const spec = context.specForDimension(dimension);
    if (
      !isRecord(spec) ||
      ["minY", "maxY", "seaLevel", "voidY"].some(
        (field) => spec[field] !== canonical[field]
      )
    )
      throw new RangeError("Invalid settlement dimension bounds");
  }
  return createWorldContext(context);
}

export function settlementPositionValid(
  dimension,
  x,
  y,
  z,
  context,
  crop = false
) {
  if (!DIMENSIONS.includes(dimension)) return false;
  const version = context?.generatorVersion ?? GENERATOR_VERSION;
  const spec = getWorldSpec(version, dimension);
  const minimum = spec.minY + (version === 4 ? 0 : 1) + (crop ? 1 : 0);
  return inWorldBounds(x, y, z, spec) && y >= minimum;
}

export function cloneStationRecord(kind, value, context) {
  if (kind === "chest") return cloneSlots(value, context);
  if (kind === "furnace") return cloneFurnace(value, context);
  const { dimension, x, y, z, age } = value;
  return { dimension, x, y, z, age };
}

function freezeData(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

export function ownStationRecord(kind, value, context) {
  return freezeData(cloneStationRecord(kind, value, context));
}

// Each finite JSON number needs at most 25 characters; 32 also covers future
// bounded timer precision. Variable slots/metadata are accounted exactly.
const NUMBER_BYTES = 32;
const longestRecipe = Math.max(
  encodedBytes(null),
  ...RECIPES.map(({ id }) => encodedBytes(id))
);
const FURNACE_PROGRESS_BYTES =
  encodedBytes({
    burnTime: 0,
    burnDuration: 0,
    cookTime: 0,
    recipeId: null,
    experience: 0,
  }) -
  2 +
  1 +
  4 * (NUMBER_BYTES - 1) +
  longestRecipe -
  encodedBytes(null);
const CROP_PROGRESS_BYTES = ',"age":'.length + NUMBER_BYTES;

/** Includes one array separator; the owner subtracts each nonempty array's last. */
export function stationRecordBytes(kind, key, value) {
  const position = stationPosition(key);
  if (kind === "crop") return encodedBytes(position) + CROP_PROGRESS_BYTES + 1;
  return (
    encodedBytes({
      ...position,
      slots: kind === "chest" ? value : value.slots,
    }) +
    (kind === "furnace" ? FURNACE_PROGRESS_BYTES : 0) +
    1
  );
}

/**
 * Pins a live cell and its admission/revision while other owners prepare. The
 * cell comparison alone would miss removing and replacing the same block.
 */
export function captureStationRead(world, x, y, z) {
  if (!world.isLoaded(x, z)) return null;
  const cell = world.getCell(x, y, z);
  if (cell === null) return null;
  const before = normalizeCell(cell);
  const { seed, generatorVersion, dimension, epoch } = world;
  const key = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
  const chunk = world.chunks?.get(key);
  const incarnation = chunk?.incarnation;
  const revision = chunk?.revision;
  const editRevision = world._editRevision;
  return {
    before,
    validate: () =>
      world.seed === seed &&
      world.generatorVersion === generatorVersion &&
      world.dimension === dimension &&
      world.epoch === epoch &&
      world._editRevision === editRevision &&
      world.isLoaded(x, z) &&
      world.chunks?.get(key) === chunk &&
      chunk?.incarnation === incarnation &&
      chunk?.revision === revision &&
      cellsEqual(world.getCell(x, y, z), before),
  };
}

/** Pure detached migration for preflight; does not register a temporary owner. */
export function normalizeSettlementSnapshot(data, context) {
  try {
    context = normalizeSettlementContext(context);
    if (
      !isRecord(data) ||
      ![1, 2, SETTLEMENT_VERSION].includes(data.version) ||
      !Array.isArray(data.chests) ||
      !Array.isArray(data.crops) ||
      data.chests.length > MAX_SETTLEMENT_ENTRIES ||
      data.crops.length > MAX_SETTLEMENT_ENTRIES
    )
      return null;
    const savedFurnaces = data.version === 1 ? [] : data.furnaces;
    if (
      !Array.isArray(savedFurnaces) ||
      savedFurnaces.length > MAX_SETTLEMENT_ENTRIES ||
      (data.version === 1 &&
        data.furnaces !== undefined &&
        (!Array.isArray(data.furnaces) || data.furnaces.length !== 0))
    )
      return null;
    const seen = new Set();
    const chests = [];
    const furnaces = [];
    const crops = [];
    const position = (entry, crop = false) => {
      if (!isRecord(entry)) return null;
      const { dimension, x, y, z } = entry;
      if (!settlementPositionValid(dimension, x, y, z, context, crop))
        return null;
      const key = stationKey(dimension, x, y, z);
      if (seen.has(key)) return null;
      seen.add(key);
      return { dimension, x, y, z };
    };
    for (const chest of data.chests) {
      const at = position(chest);
      if (!at) return null;
      const slots =
        data.version === 1
          ? migrateChestItems(chest.items, context)
          : validSlotArray(chest.slots, CHEST_SLOTS, context)
            ? cloneSlots(chest.slots, context)
            : null;
      if (!slots) return null;
      chests.push({ ...at, slots });
    }
    for (const furnace of savedFurnaces) {
      const at = position(furnace);
      if (!at || !isValidFurnace(furnace, context)) return null;
      furnaces.push({ ...at, ...cloneFurnace(furnace, context) });
    }
    for (const crop of data.crops) {
      const at = position(crop, true);
      if (
        !at ||
        !Number.isFinite(crop.age) ||
        crop.age < 0 ||
        crop.age > CROP_GROW_SECONDS
      )
        return null;
      crops.push({ ...at, age: crop.age });
    }
    return { version: SETTLEMENT_VERSION, chests, furnaces, crops };
  } catch {
    return null;
  }
}
