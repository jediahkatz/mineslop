import { BLOCK, BLOCKS } from "./blocks.js";
import {
  MAX_STRUCTURE_ID_LENGTH,
  parseStructureIdentity,
} from "./canonical-structure-identity.js";
import { STRUCTURE_LIMITS } from "./structure-catalog.js";
import { structureBounds } from "./structure-layouts.js";
import { V4_MAX_XZ, V4_MIN_XZ } from "./terrain-v4-config.js";
import { V4_GENERATION_MANIFEST } from "./terrain-v4-manifest.js";
import { V5_GENERATION_MANIFEST } from "./terrain-v5-manifest.js";
import { V6_GENERATION_MANIFEST } from "./terrain-v6-manifest.js";
import { V7_GENERATION_MANIFEST } from "./terrain-v7-manifest.js";

function manifestFor(job) {
  switch (job.generatorVersion) {
    // Historical packets may transport opaque fixture metadata, but have no
    // native generation manifest and cannot declare canonical structures.
    case 1:
    case 2:
    case 3: return null;
    case 4: return V4_GENERATION_MANIFEST;
    case 5: return V5_GENERATION_MANIFEST;
    case 6: return V6_GENERATION_MANIFEST;
    case 7: return V7_GENERATION_MANIFEST;
    default: throw new RangeError("Unsupported native structure generator version");
  }
}

// Bounds on the declaration plane, not permission to expand generation work.
// Native layout-v1 has at most one selected family per 192x192 owner; the
// transport also retains bounded opaque data from explicit decorator fixtures.
export const TERRAIN_STRUCTURE_LIMITS = Object.freeze({
  descriptors: 64,
  markers: 64,
  entries: 8,
  depth: 16,
  values: 16384,
  bytes: 256 * 1024,
});

const record = (value) =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const boundsKeys = ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"];
const markerTypes = new Set([
  "container",
  "encounter",
  "home",
  "member",
  "bed",
  "job_site",
  "crop_plot",
]);
const facing = (value) => Number.isInteger(value) && value >= 0 && value <= 3;
const memberKey = (value) =>
  typeof value === "string" && /^[a-zA-Z0-9_-]{1,48}$/.test(value);
const role = (value) =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(value);

function invalid(message) {
  throw new RangeError(`Invalid terrain structures: ${message}`);
}

/** Account before cloning, including shared binary buffers exactly once. */
function validateData(root) {
  let values = 0;
  let bytes = 0;
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (
      ++values > TERRAIN_STRUCTURE_LIMITS.values ||
      depth > TERRAIN_STRUCTURE_LIMITS.depth
    )
      invalid("declaration complexity budget exceeded");
    bytes += 8;
    if (typeof value === "string") bytes += value.length * 2;
    else if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid("non-finite declaration value");
    } else if (value !== null && typeof value === "object") {
      if (seen.has(value)) return;
      seen.add(value);
      if (value instanceof ArrayBuffer) bytes += value.byteLength;
      else if (ArrayBuffer.isView(value)) {
        if (!(value.buffer instanceof ArrayBuffer))
          invalid("shared declaration buffer");
        visit(value.buffer, depth + 1);
      } else if (value instanceof Map) {
        if (value.size > TERRAIN_STRUCTURE_LIMITS.values)
          invalid("oversized declaration map");
        for (const [key, entry] of value) {
          visit(key, depth + 1);
          visit(entry, depth + 1);
        }
      } else if (value instanceof Set) {
        if (value.size > TERRAIN_STRUCTURE_LIMITS.values)
          invalid("oversized declaration set");
        for (const entry of value) visit(entry, depth + 1);
      } else if (Array.isArray(value)) {
        if (value.length > TERRAIN_STRUCTURE_LIMITS.values)
          invalid("oversized declaration array");
        for (const entry of value) visit(entry, depth + 1);
      } else if (record(value)) {
        for (const [key, entry] of Object.entries(value)) {
          visit(key, depth + 1);
          visit(entry, depth + 1);
        }
      } else invalid("unsupported declaration object");
    } else if (
      value !== undefined &&
      value !== null &&
      typeof value !== "boolean"
    )
      invalid("uncloneable declaration value");
    if (bytes > TERRAIN_STRUCTURE_LIMITS.bytes)
      invalid("declaration byte budget exceeded");
  };
  visit(root);
}

function validBounds(bounds, spec) {
  return (
    record(bounds) &&
    boundsKeys.every((key) => Number.isSafeInteger(bounds[key])) &&
    bounds.minX < bounds.maxX &&
    bounds.minY < bounds.maxY &&
    bounds.minZ < bounds.maxZ &&
    bounds.minX >= V4_MIN_XZ &&
    bounds.maxX <= V4_MAX_XZ &&
    bounds.minZ >= V4_MIN_XZ &&
    bounds.maxZ <= V4_MAX_XZ &&
    bounds.minY >= spec.minY &&
    bounds.maxY <= spec.maxY
  );
}

function contains(bounds, point) {
  return (
    record(point) &&
    ["x", "y", "z"].every((key) => Number.isSafeInteger(point[key])) &&
    point.x >= bounds.minX &&
    point.x < bounds.maxX &&
    point.y >= bounds.minY &&
    point.y < bounds.maxY &&
    point.z >= bounds.minZ &&
    point.z < bounds.maxZ
  );
}

function containsBounds(outer, inner, spec) {
  return (
    validBounds(inner, spec) &&
    boundsKeys.every((key) =>
      key.startsWith("min")
        ? inner[key] >= outer[key]
        : inner[key] <= outer[key]
    )
  );
}

function intersectsChunk(bounds, job) {
  return (
    bounds.minX < (job.cx + 1) * 16 &&
    bounds.maxX > job.cx * 16 &&
    bounds.minZ < (job.cz + 1) * 16 &&
    bounds.maxZ > job.cz * 16
  );
}

function registeredBlock(name) {
  if (
    typeof name !== "string" ||
    !Object.hasOwn(BLOCK, name) ||
    !BLOCKS[BLOCK[name]]
  )
    invalid("unknown declared block");
  return BLOCK[name];
}

function checkAnchoredBlock(name, position, blocks, job, spec) {
  const id = registeredBlock(name);
  if (
    Math.floor(position.x / 16) !== job.cx ||
    Math.floor(position.z / 16) !== job.cz
  )
    return;
  const at =
    (position.y - spec.minY) * 256 +
    (position.z - job.cz * 16) * 16 +
    position.x -
    job.cx * 16;
  if (blocks[at] !== id)
    invalid("declared anchor does not match generated blocks");
}

function validateMapQuery(query, marker, job) {
  const manifest = manifestFor(job);
  if (
    !record(query) ||
    !manifest.structureKinds.includes(query.kind) ||
    query.dimension !== job.dimension ||
    query.seed !== job.seed ||
    query.layoutVersion !== manifest.structureLayoutVersion ||
    query.sourceMarkerId !== marker.id ||
    !record(query.from) ||
    ["x", "y", "z"].some(
      (axis) => query.from[axis] !== marker.position[axis]
    ) ||
    !record(query.search)
  )
    invalid("mismatched structure map query");
  for (const [field, minimum, maximum] of [
    ["radius", 0, STRUCTURE_LIMITS.locatorRadius],
    ["maxCells", 1, STRUCTURE_LIMITS.locatorCells],
    ["maxSamples", 1, STRUCTURE_LIMITS.locatorSamples],
  ]) {
    const value = query.search[field];
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      invalid("unbounded structure map query");
  }
}

function validateCanonical(descriptor, job, spec, blocks) {
  const owner = parseStructureIdentity(
    descriptor.id,
    job.seed,
    job.generatorVersion,
    job.dimension
  );
  if (
    !owner ||
    !manifestFor(job).structureKinds.includes(owner.kind) ||
    descriptor.layoutVersion !== owner.layoutVersion ||
    descriptor.generatorVersion !== owner.generatorVersion ||
    descriptor.seed !== job.seed ||
    descriptor.dimension !== job.dimension ||
    descriptor.kind !== owner.kind ||
    descriptor.gx !== owner.gx ||
    descriptor.gz !== owner.gz ||
    descriptor.owner !== `structure:${owner.kind}:v${owner.layoutVersion}` ||
    !facing(descriptor.rotation) ||
    !role(descriptor.variant) ||
    !validBounds(descriptor.bounds, spec) ||
    !contains(descriptor.bounds, descriptor.origin) ||
    descriptor.bounds.minX < owner.gx * owner.spacing ||
    descriptor.bounds.maxX > (owner.gx + 1) * owner.spacing ||
    descriptor.bounds.minZ < owner.gz * owner.spacing ||
    descriptor.bounds.maxZ > (owner.gz + 1) * owner.spacing ||
    !intersectsChunk(descriptor.bounds, job)
  )
    invalid("mismatched canonical owner, layout or bounds");
  const local = descriptor.localBounds;
  if (
    !Array.isArray(local) ||
    local.length !== 6 ||
    !local.every(Number.isSafeInteger) ||
    local[0] >= local[3] ||
    local[1] >= local[4] ||
    local[2] >= local[5]
  )
    invalid("invalid local structure bounds");
  const expectedBounds = structureBounds(descriptor, local);
  if (boundsKeys.some((key) => descriptor.bounds[key] !== expectedBounds[key]))
    invalid("structure transform disagrees with its bounds");
  if (
    !record(descriptor.plan) ||
    !(
      descriptor.waterLevel === null ||
      (Number.isInteger(descriptor.waterLevel) &&
        descriptor.waterLevel >= spec.minY &&
        descriptor.waterLevel < spec.maxY)
    ) ||
    !Array.isArray(descriptor.entries) ||
    descriptor.entries.length < 1 ||
    descriptor.entries.length > TERRAIN_STRUCTURE_LIMITS.entries ||
    descriptor.entries.some(
      (entry) => !contains(descriptor.bounds, entry) || !facing(entry.facing)
    ) ||
    !Array.isArray(descriptor.markers) ||
    descriptor.markers.length < 1 ||
    descriptor.markers.length > TERRAIN_STRUCTURE_LIMITS.markers
  )
    invalid("invalid structure entries or declarations");

  const markers = new Map();
  for (const marker of descriptor.markers) {
    if (
      !record(marker) ||
      !markerTypes.has(marker.type) ||
      !memberKey(marker.key) ||
      !role(marker.role) ||
      marker.id !== `${descriptor.id}/${marker.type}/${marker.key}` ||
      marker.structureId !== descriptor.id ||
      marker.dimension !== job.dimension ||
      markers.has(marker.id) ||
      !contains(descriptor.bounds, marker.position) ||
      (marker.bounds !== undefined &&
        !containsBounds(descriptor.bounds, marker.bounds, spec)) ||
      (marker.entry !== undefined &&
        (!contains(descriptor.bounds, marker.entry) ||
          !facing(marker.entry.facing))) ||
      (marker.facing !== undefined && !facing(marker.facing)) ||
      ["slots", "items", "inventory", "loot"].some((field) =>
        Object.hasOwn(marker, field)
      )
    )
      invalid("invalid or duplicate canonical marker");
    markers.set(marker.id, marker);
    if (
      marker.type === "container" &&
      (marker.block !== "CHEST" ||
        typeof marker.table !== "string" ||
        !marker.table.length)
    )
      invalid("invalid container declaration");
    if (
      marker.type === "encounter" &&
      (marker.unique !== true || !role(marker.entity))
    )
      invalid("invalid encounter declaration");
    if (marker.block !== undefined)
      checkAnchoredBlock(marker.block, marker.position, blocks, job, spec);
    if (marker.type === "crop_plot") {
      checkAnchoredBlock(marker.crop, marker.position, blocks, job, spec);
      checkAnchoredBlock(
        marker.soil,
        { ...marker.position, y: marker.position.y - 1 },
        blocks,
        job,
        spec
      );
    }
    if (marker.mapTarget !== undefined)
      validateMapQuery(marker.mapTarget, marker, job);
  }
  for (const marker of markers.values())
    for (const [field, type] of [
      ["homeId", "home"],
      ["bedId", "bed"],
      ["jobSiteId", "job_site"],
      ["memberId", "member"],
    ])
      if (
        marker[field] !== undefined &&
        markers.get(marker[field])?.type !== type
      )
        invalid("dangling canonical member reference");
}

/**
 * Schema checks only; no generation, decoration, loot or ownership callbacks.
 * Keep FULL declarations in every intersecting chunk, including anchor-free
 * chunks. Exploration filters anchors before deduping and rechecks live edits.
 * Opaque explicit-fixture metadata is not promoted into a canonical identity.
 */
export function cloneTerrainStructures(structures, job, spec, blocks) {
  // Fail closed even when a future-version packet omits its declaration plane.
  const manifest = manifestFor(job);
  if (structures === undefined) return undefined;
  if (
    !Array.isArray(structures) ||
    structures.length > TERRAIN_STRUCTURE_LIMITS.descriptors
  )
    invalid("expected a bounded declaration array");
  validateData(structures);
  const identities = new Set();
  const owners = new Set();
  for (const descriptor of structures) {
    if (
      !record(descriptor) ||
      typeof descriptor.kind !== "string" ||
      !descriptor.kind.length
    )
      invalid("expected a structure descriptor");
    if (
      (manifest ?? V4_GENERATION_MANIFEST).structureKinds.includes(descriptor.kind) &&
      (typeof descriptor.id !== "string" ||
        !descriptor.id.startsWith("structure:"))
    )
      invalid("native families require their canonical identity");
    if (
      (descriptor.seed !== undefined && descriptor.seed !== job.seed) ||
      (descriptor.dimension !== undefined &&
        descriptor.dimension !== job.dimension) ||
      (descriptor.generatorVersion !== undefined &&
        descriptor.generatorVersion !== job.generatorVersion) ||
      (descriptor.bounds !== undefined &&
        (!validBounds(descriptor.bounds, spec) ||
          !intersectsChunk(descriptor.bounds, job)))
    )
      invalid("descriptor belongs to another job");
    if (descriptor.id !== undefined) {
      if (
        typeof descriptor.id !== "string" ||
        !descriptor.id.length ||
        descriptor.id.length > MAX_STRUCTURE_ID_LENGTH ||
        identities.has(descriptor.id)
      )
        invalid("invalid or duplicate descriptor identity");
      identities.add(descriptor.id);
      if (descriptor.id.startsWith("structure:")) {
        validateCanonical(descriptor, job, spec, blocks);
        const owner = `${descriptor.gx},${descriptor.gz}`;
        if (owners.has(owner))
          invalid("multiple canonical families in one owner");
        owners.add(owner);
      }
    }
  }
  try {
    return structuredClone(structures);
  } catch {
    invalid("declarations must be structured-cloneable");
  }
}
