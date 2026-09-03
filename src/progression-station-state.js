import { createAnvilRecord, normalizeAnvilRecord } from "./anvil.js";
import { BLOCKS } from "./blocks.js";
import {
  BREWING_FUEL_SLOT, BREWING_INGREDIENT_SLOT, brewingRecordBytes,
  createBrewingStand, getBrewingResult, normalizeBrewingStand,
} from "./brewing.js";
import { dataRecord, immutable, integer } from "./enchantment-domain.js";
import {
  createEnchantingPlayer, createEnchantingRecord,
  normalizeEnchantingPlayer, normalizeEnchantingRecord,
} from "./enchanting.js";
import { cloneSlots } from "./inventory-slots.js";
import { seedHash } from "./noise.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { progressArray } from "./progression-common.js";
import { encodedBytes } from "./save-budget.js";
import { createSmithingRecord, normalizeSmithingRecord } from "./smithing.js";
import { DIMENSIONS, inWorldBounds } from "./world-spec.js";

export const PROGRESSION_STATIONS_VERSION = 1;
export const MAX_PROGRESSION_STATIONS = 16384;
export const MAX_PROGRESSION_STATION_BYTES = 32768;
// Bound active work, not retained escrow. A 65th recipe refuses its insertion
// atomically; no paid batch is silently truncated or advanced at a slower rate.
export const MAX_ACTIVE_BREWING_STANDS = 64;
export const PROGRESSION_STATION_KINDS = Object.freeze([
  "enchanting", "anvil", "brewing", "smithing",
]);

export function progressionStationKind(id) {
  const kind = BLOCKS[id]?.station;
  return PROGRESSION_STATION_KINDS.includes(kind) ? kind : null;
}

export function stationPosition(value, context) {
  if (!value || !DIMENSIONS.includes(value.dimension) || !inWorldBounds(
    value.x, value.y, value.z, context.specForDimension(value.dimension)
  ))
    throw new RangeError("Station is outside its dimension");
  return { dimension: value.dimension, x: value.x, y: value.y, z: value.z };
}

export const progressionStationKey = ({ dimension, x, y, z }) =>
  `${dimension}:${x},${y},${z}`;

export function stationCanBrew(entry, catalog, context) {
  if (entry?.kind !== "brewing") return false;
  const record = entry.record;
  return record.batch !== null || Boolean(
    (record.fuelOperations || record.slots[BREWING_FUEL_SLOT]) &&
    record.slots.slice(0, 3).some((bottle) => getBrewingResult(
      bottle, record.slots[BREWING_INGREDIENT_SLOT], catalog, context
    ))
  );
}

export function normalizeStationRecord(kind, value, catalog, context) {
  if (kind === "enchanting") return normalizeEnchantingRecord(value, context);
  if (kind === "anvil") return normalizeAnvilRecord(value, context);
  if (kind === "brewing") return normalizeBrewingStand(value, catalog, context);
  if (kind === "smithing") return normalizeSmithingRecord(value, context);
  throw new RangeError("Unknown progression station");
}

export function createStationRecord(kind) {
  if (kind === "enchanting") return createEnchantingRecord();
  if (kind === "anvil") return createAnvilRecord();
  if (kind === "brewing") return createBrewingStand();
  if (kind === "smithing") return createSmithingRecord();
  throw new RangeError("Unknown progression station");
}

/** This detached projection is the complete physical escrow, never a result. */
export function stationSlots(kind, record, context) {
  const slots = kind === "enchanting" ? [record.input, record.lapis] :
    kind === "anvil" ? [record.left, record.right] :
      kind === "smithing" ? [record.template, record.base, record.addition] :
        kind === "brewing" ? record.slots : null;
  if (!slots) throw new RangeError("Unknown station slots");
  return cloneSlots(slots, context);
}

export function normalizeStationEntry(value, catalog, context) {
  dataRecord(value, ["dimension", "x", "y", "z", "kind", "record"], "station entry");
  const entry = {
    ...stationPosition(value, context), kind: value.kind,
    record: normalizeStationRecord(value.kind, value.record, catalog, context),
  };
  stationEntryBytes(entry, catalog, context);
  return entry;
}

/**
 * Exact position/envelope and variable slot bytes. Only the bounded brewing
 * timers/revisions and pending completion are reserved at their maxima.
 */
export function stationEntryBytes(entry, catalog, context) {
  const bytes = entry.kind === "brewing"
    ? encodedBytes({ ...entry, record: null }) - 4 +
      brewingRecordBytes(entry.record, catalog, context)
    : encodedBytes(entry);
  if (bytes > MAX_PROGRESSION_STATION_BYTES)
    throw new RangeError("Station record exceeds its byte bound");
  return bytes + 1;
}

/** Explicit legacy migration; closing/reloading never invokes a random source. */
export function createProgressionStationsSnapshot(value) {
  const context = normalizeProgressionContext(value);
  return {
    version: PROGRESSION_STATIONS_VERSION,
    seed: context.seed, generatorVersion: context.generatorVersion,
    player: createEnchantingPlayer(seedHash(JSON.stringify([
      "player-enchanting-v1", context.seed, context.generatorVersion,
    ])) >>> 0),
    randomState: seedHash(JSON.stringify([
      "equipment-effects-v1", context.seed, context.generatorVersion,
    ])) >>> 0,
    stations: [],
  };
}

export function normalizeProgressionStationsSnapshot(value, catalog, worldContext) {
  const context = normalizeProgressionContext(worldContext);
  dataRecord(value, [
    "version", "seed", "generatorVersion", "player", "randomState", "stations",
  ], "progression station snapshot");
  if (
    value.version !== PROGRESSION_STATIONS_VERSION ||
    value.seed !== context.seed || value.generatorVersion !== context.generatorVersion
  )
    throw new RangeError("Mismatched progression station identity");
  const player = normalizeEnchantingPlayer(value.player);
  const randomState = integer(value.randomState, "equipment random state", 0, 0xffffffff);
  const seen = new Set();
  let activeBrewing = 0;
  const stations = progressArray(value.stations, MAX_PROGRESSION_STATIONS).map((entry) => {
    const next = normalizeStationEntry(entry, catalog, context);
    const key = progressionStationKey(next);
    if (seen.has(key)) throw new RangeError("Duplicate progression station");
    seen.add(key);
    if (stationCanBrew(next, catalog, context) &&
        ++activeBrewing > MAX_ACTIVE_BREWING_STANDS)
      throw new RangeError("Too many active brewing stands");
    return next;
  });
  return {
    version: PROGRESSION_STATIONS_VERSION, seed: context.seed,
    generatorVersion: context.generatorVersion, player, randomState, stations,
  };
}

export function stationHeaderBytes(context) {
  return encodedBytes({
    ...createProgressionStationsSnapshot(context),
    player: { version: 1, seed: 0xffffffff }, randomState: 0xffffffff,
  });
}

export const freezeStationEntry = (entry) => immutable(entry);
