import {
  freezeProgressData,
  MAX_STRUCTURE_MEMBER_ID_LENGTH,
  normalizeProgressContext,
  progressArray,
  progressPosition,
  progressRecord,
  progressStructureId,
} from "./progression-common.js";
import { getStructureMarkers, STRUCTURE_LIMITS } from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";

export const MAX_MAP_CANDIDATES = 4096;
export const MAX_STRUCTURE_PROGRESS_MARKERS = 64;

const lootRole = (kind, role, loot, guarantees = []) => ({
  kind,
  role,
  loot,
  guarantees,
});

/** Finite catalog adapter, not a slash/underscore rewrite or fallback table. */
export const STRUCTURE_LOOT_ROLES = freezeProgressData({
  "shipwreck/supply": lootRole("shipwreck", "supply", "shipwreck_supply"),
  "shipwreck/treasure": lootRole("shipwreck", "treasure", "shipwreck_treasure"),
  "shipwreck/map": lootRole("shipwreck", "map", "shipwreck_map"),
  "ocean_ruin/warm_shrine": lootRole("ocean_ruin", "shrine", "ocean_ruin_warm"),
  "ocean_ruin/cold_crypt": lootRole("ocean_ruin", "crypt", "ocean_ruin_cold"),
  "ocean_ruin/annex": lootRole("ocean_ruin", "annex", "ocean_ruin_annex"),
  "buried_treasure/heart_of_sea": lootRole(
    "buried_treasure",
    "buried_treasure",
    "buried_treasure",
    ["heart_of_sea"]
  ),
  "village/farmstead": lootRole("village", "farmstead_stock", "village_farm"),
  "village/library": lootRole("village", "library_stock", "village_house"),
  "village/smithy": lootRole("village", "smithy_stock", "village_smith"),
  "nether_fortress/garden": lootRole(
    "nether_fortress",
    "wart_store",
    "nether_fortress"
  ),
  "nether_fortress/crossing": lootRole(
    "nether_fortress",
    "crossing_store",
    "nether_fortress"
  ),
  "bastion/treasure": lootRole(
    "bastion_remnant",
    "treasure",
    "bastion_treasure",
    ["netherite_upgrade_template"]
  ),
  "bastion/armory": lootRole("bastion_remnant", "armory", "bastion_armory"),
  "bastion/bridge": lootRole(
    "bastion_remnant",
    "bridge_cache",
    "bastion_bridge"
  ),
  "dungeon/cache": lootRole("dungeon", "cellar_cache", "dungeon_cache"),
});

export function lootRoleForStructureMarker(descriptor, marker) {
  const binding =
    typeof marker?.table === "string" &&
    Object.hasOwn(STRUCTURE_LOOT_ROLES, marker.table)
      ? STRUCTURE_LOOT_ROLES[marker.table]
      : null;
  if (
    !binding ||
    marker.type !== "container" ||
    marker.block !== "CHEST" ||
    descriptor?.kind !== binding.kind ||
    marker.role !== binding.role
  )
    throw new RangeError("Unknown or mismatched catalog container loot role");
  const guarantees = progressArray(
    marker.tableGuarantees === undefined ? [] : marker.tableGuarantees,
    8
  );
  if (
    guarantees.length !== binding.guarantees.length ||
    guarantees.some((value, index) => value !== binding.guarantees[index])
  )
    throw new RangeError("Unknown catalog loot guarantee");
  return binding.loot;
}

function validateCatalogSite(value, context) {
  if (
    !value ||
    typeof value.kind !== "string" ||
    !Number.isSafeInteger(value.gx) ||
    !Number.isSafeInteger(value.gz)
  )
    throw new RangeError("Invalid catalog structure owner");
  const id = progressStructureId(value.id, value.dimension, context);
  if (
    value.layoutVersion !== STRUCTURE_LAYOUT_VERSION ||
    (value.seed !== undefined && value.seed !== context.seed) ||
    (value.generatorVersion !== undefined &&
      value.generatorVersion !== context.generatorVersion) ||
    id !==
      `structure:v${value.layoutVersion}:${encodeURIComponent(JSON.stringify(context.seed))}:${value.dimension}:${value.kind}:${value.gx}:${value.gz}`
  )
    throw new RangeError("Structure belongs to another catalog identity");
  return id;
}

function structurePosition(value, structureId, dimension, context) {
  const position = progressPosition(value, dimension, context);
  if (structureId.startsWith("structure:")) {
    const [, , , , , gx, gz] = structureId.split(":");
    if (
      Math.floor(position.x / STRUCTURE_LIMITS.spacing) !== Number(gx) ||
      Math.floor(position.z / STRUCTURE_LIMITS.spacing) !== Number(gz)
    )
      throw new RangeError("Structure position is outside its canonical owner");
  }
  return position;
}

/**
 * Compatible with transformStructureMarkers' id = structureId/type/key.
 * A member key is permanent within its structure/type. Role/position changes
 * do not create a second entitlement for the same member.
 */
export function normalizeExplorationMarker(value, context) {
  context = normalizeProgressContext(context);
  progressRecord(value, [
    "id",
    "structureId",
    "type",
    "key",
    "role",
    "dimension",
    "position",
  ]);
  const structureId = progressStructureId(
    value.structureId,
    value.dimension,
    context
  );
  const id = value.id;
  if (
    typeof id !== "string" ||
    id.length > MAX_STRUCTURE_MEMBER_ID_LENGTH ||
    !["container", "encounter"].includes(value.type) ||
    typeof value.key !== "string" ||
    !/^[a-zA-Z0-9_-]{1,48}$/.test(value.key) ||
    typeof value.role !== "string" ||
    !/^[a-z][a-z0-9_]{0,47}$/.test(value.role) ||
    id !== `${structureId}/${value.type}/${value.key}`
  )
    throw new RangeError("Invalid structure member identity");
  return {
    id,
    structureId,
    type: value.type,
    key: value.key,
    role: value.role,
    dimension: value.dimension,
    position: structurePosition(
      value.position,
      structureId,
      value.dimension,
      context
    ),
  };
}

/** Explicit projection of a generator marker; archive normalizers remain strict. */
export function explorationMarkerFromStructure(descriptor, marker, context) {
  context = normalizeProgressContext(context);
  if (
    !descriptor ||
    !marker ||
    typeof descriptor.id !== "string" ||
    descriptor?.id !== marker?.structureId ||
    descriptor?.dimension !== marker?.dimension ||
    (descriptor.seed !== undefined && descriptor.seed !== context.seed) ||
    (descriptor.generatorVersion !== undefined &&
      descriptor.generatorVersion !== context.generatorVersion)
  )
    throw new RangeError("Structure marker does not belong to this descriptor");
  let role = marker.role;
  if (descriptor.id.startsWith("structure:")) {
    validateCatalogSite(descriptor, context);
    const original = progressArray(
      descriptor.markers,
      MAX_STRUCTURE_PROGRESS_MARKERS
    ).find((entry) => entry.id === marker.id);
    if (
      !original ||
      [
        "structureId",
        "dimension",
        "type",
        "key",
        "role",
        "table",
        "block",
        "unique",
      ].some((field) => original[field] !== marker[field]) ||
      ["x", "y", "z"].some(
        (axis) => original.position[axis] !== marker.position?.[axis]
      )
    )
      throw new RangeError("Marker is not the declared catalog member");
    if (marker.type === "container")
      role = lootRoleForStructureMarker(descriptor, marker);
    else if (marker.type !== "encounter" || marker.unique !== true)
      throw new RangeError(
        "Only containers and unique encounters own exploration claims"
      );
  }
  return normalizeExplorationMarker(
    {
      id: marker.id,
      structureId: marker.structureId,
      type: marker.type,
      key: marker.key,
      role,
      dimension: marker.dimension,
      position: marker.position,
    },
    context
  );
}

/**
 * Call for EVERY descriptor packet with that packet's bounds. Do not cache a
 * "seen descriptor" before anchor filtering: an earlier chunk may own no markers.
 * This pure projection never rolls/materializes loot or records a claim. The
 * permanent ledger dedupes the complete marker.id after successful publication.
 */
export function explorationMarkersFromStructure(
  descriptor,
  context,
  { bounds } = {}
) {
  context = normalizeProgressContext(context);
  validateCatalogSite(descriptor, context);
  progressArray(descriptor.markers, MAX_STRUCTURE_PROGRESS_MARKERS);
  return getStructureMarkers(descriptor, { bounds })
    .filter(
      (marker) => marker.type === "container" || marker.type === "encounter"
    )
    .map((marker) =>
      explorationMarkerFromStructure(descriptor, marker, context)
    );
}

export function structureIdentity(descriptor, context) {
  context = normalizeProgressContext(context);
  context.specForDimension(descriptor.dimension);
  if (
    (descriptor.seed !== undefined && descriptor.seed !== context.seed) ||
    (descriptor.generatorVersion !== undefined &&
      descriptor.generatorVersion !== context.generatorVersion)
  )
    throw new RangeError("Structure belongs to another progression world");
  return JSON.stringify([
    context.seed,
    context.generatorVersion,
    descriptor.dimension,
    progressStructureId(descriptor.id, descriptor.dimension, context),
  ]);
}

export function memberIdentity(marker, context) {
  const normalized = normalizeExplorationMarker(marker, context);
  return JSON.stringify([
    context.seed,
    context.generatorVersion,
    normalized.dimension,
    normalized.id,
  ]);
}

/**
 * Progression's semantic destination schema, not a bypass of item metadata.
 * Real map stacks MUST still pass normalizeStack()/normalizeMapTarget() in the
 * canonical inventory owner; its catalog-ID admission is a parent-owned hook.
 */
export function normalizeTreasureMapTarget(value, context) {
  context = normalizeProgressContext(context);
  progressRecord(value, [
    "seed",
    "generatorVersion",
    "dimension",
    "structureId",
    "x",
    "y",
    "z",
  ]);
  const structureId = progressStructureId(
    value.structureId,
    value.dimension,
    context
  );
  if (
    value.seed !== context.seed ||
    value.generatorVersion !== context.generatorVersion ||
    value.dimension !== "overworld" ||
    (structureId.startsWith("structure:") &&
      structureId.split(":")[4] !== "buried_treasure")
  )
    throw new RangeError("Invalid contextual buried-treasure destination");
  return {
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    dimension: value.dimension,
    structureId,
    ...structurePosition(
      { x: value.x, y: value.y, z: value.z },
      structureId,
      value.dimension,
      context
    ),
  };
}

/**
 * structureTarget()/locator targets omit seed and use position, not origin.
 * The full canonical ID checks the supplied world context before we add
 * it. No new search, terrain generation, loot, or guessed coordinates occur here.
 * The candidate can then be passed to selectTreasureMapTarget().
 */
export function mapCandidateFromStructureTarget(value, context) {
  context = normalizeProgressContext(context);
  if (value === null) return null;
  progressRecord(value, [
    "id",
    "kind",
    "dimension",
    "layoutVersion",
    "gx",
    "gz",
    "position",
    "entry",
    "bounds",
  ]);
  const id = validateCatalogSite(value, context);
  const origin = structurePosition(
    value.position,
    id,
    value.dimension,
    context
  );
  return {
    id,
    kind: value.kind,
    dimension: value.dimension,
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    origin,
  };
}

/**
 * Preserve bounded-locator status, including a real target in an exhausted
 * search and null in either a complete or exhausted search. World identity stays
 * explicit even when there is no target. A found target is
 * nearest among examined cells, not a promise of globally nearest treasure.
 * Parent decides whether to admit that result before the one-time loot plan.
 */
export function mapResolutionFromStructure(value, context) {
  context = normalizeProgressContext(context);
  progressRecord(value, [
    "target",
    "examinedCells",
    "sampledColumns",
    "exhausted",
    "complete",
  ]);
  if (
    !Number.isSafeInteger(value.examinedCells) ||
    value.examinedCells < 0 ||
    value.examinedCells > STRUCTURE_LIMITS.locatorCells ||
    !Number.isSafeInteger(value.sampledColumns) ||
    value.sampledColumns < 0 ||
    value.sampledColumns > STRUCTURE_LIMITS.locatorSamples ||
    typeof value.exhausted !== "boolean" ||
    value.complete !== !value.exhausted
  )
    throw new RangeError("Invalid bounded structure locator result");
  return {
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    target: mapCandidateFromStructureTarget(value.target, context),
    examinedCells: value.examinedCells,
    sampledColumns: value.sampledColumns,
    exhausted: value.exhausted,
    complete: value.complete,
  };
}

/**
 * Candidates must come from a deterministic structure locator, NOT only the
 * currently loaded/discovered set. Never invent a coordinate as a fallback.
 * Selection is nearest to the fixed member, with an identity tie-breaker;
 * order, player position, chunk arrival and dimension travel do not reroll it.
 */
export function selectTreasureMapTarget(source, candidates, context) {
  context = normalizeProgressContext(context);
  const marker = normalizeExplorationMarker(source, context);
  if (marker.dimension !== "overworld")
    throw new RangeError("Buried treasure maps require an Overworld source");
  const seen = new Set();
  const targets = progressArray(candidates, MAX_MAP_CANDIDATES).map((site) => {
    if (
      !site ||
      site.kind !== "buried_treasure" ||
      site.dimension !== "overworld" ||
      site.seed !== context.seed ||
      (site.generatorVersion !== undefined &&
        site.generatorVersion !== context.generatorVersion)
    )
      throw new RangeError("Map candidate belongs to another world or kind");
    const target = normalizeTreasureMapTarget(
      {
        seed: context.seed,
        generatorVersion: context.generatorVersion,
        dimension: site.dimension,
        structureId: site.id,
        x: site.origin?.x,
        y: site.origin?.y,
        z: site.origin?.z,
      },
      context
    );
    if (seen.has(target.structureId))
      throw new RangeError("Duplicate treasure destination identity");
    seen.add(target.structureId);
    return target;
  });
  targets.sort((a, b) => {
    const distance = (target) =>
      (target.x - marker.position.x) ** 2 + (target.z - marker.position.z) ** 2;
    return (
      distance(a) - distance(b) ||
      (a.structureId < b.structureId
        ? -1
        : a.structureId > b.structureId
          ? 1
          : 0)
    );
  });
  if (!targets.length)
    throw new RangeError("No real buried treasure destination");
  return targets[0];
}
