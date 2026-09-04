import { BLOCK, BLOCKS } from "./blocks.js";
import { cellsEqual, normalizeCell } from "./block-state.js";
import { explorationMarkersFromStructure } from "./exploration-markers.js";
import { nativeExplorationContext } from "./exploration-host-state.js";
import { hasExpandedTerrain } from "./generator-version.js";
import {
  freezeProgressData,
  progressArray,
  progressPositionKey,
  progressRecord,
} from "./progression-common.js";
import {
  describeStructure,
  STRUCTURE_KINDS,
  STRUCTURE_LIMITS,
} from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";
import {
  createStructureSite,
  selectStructureKind,
} from "./structure-placement.js";
import { CHUNK_SIZE } from "./terrain.js";
import { describeV5Structure } from "./terrain-v5-manifest.js";
import { describeV6Structure } from "./terrain-v6-manifest.js";
import { describeV7Structure } from "./terrain-v7-manifest.js";

function describeCanonicalStructure(version, kind, terrain, gx, gz) {
  switch (version) {
    case 4: return describeStructure(kind, terrain, gx, gz);
    case 5: return describeV5Structure(kind, terrain, gx, gz);
    case 6: return describeV6Structure(kind, { ...terrain, generatorVersion: 6 }, gx, gz);
    case 7: return describeV7Structure(kind, { ...terrain, generatorVersion: 7 }, gx, gz);
    default: throw new RangeError("Unsupported native structure generator version");
  }
}

const DESCRIPTOR_FIELDS = [
  "id",
  "generatorVersion",
  "layoutVersion",
  "seed",
  "kind",
  "dimension",
  "gx",
  "gz",
  "origin",
  "rotation",
  "variant",
  "waterLevel",
  "localBounds",
  "plan",
  "bounds",
  "entries",
  "markers",
  "owner",
];

/** Compare canonical data without invoking untrusted getters or walking extras. */
function canonicalData(value, expected) {
  if (expected === null || typeof expected !== "object")
    return value === expected;
  if (!value || typeof value !== "object") return false;
  const keys = Reflect.ownKeys(expected);
  if (Reflect.ownKeys(value).length !== keys.length) return false;
  if (
    Array.isArray(expected)
      ? !Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  return keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return (
      field &&
      Object.hasOwn(field, "value") &&
      field.enumerable ===
        Object.getOwnPropertyDescriptor(expected, key).enumerable &&
      canonicalData(field.value, expected[key])
    );
  });
}

export function currentExplorationAdmission(world, event) {
  if (
    !Object.isFrozen(event) ||
    event?.world !== world ||
    world._disposed ||
    event.seed !== world.seed ||
    event.generatorVersion !== world.generatorVersion ||
    event.epoch !== world.epoch ||
    event.dimension !== world.dimension ||
    ![event.cx, event.cz, event.incarnation, event.revision].every(
      Number.isSafeInteger
    ) ||
    event.incarnation < 1 ||
    event.revision < 0 ||
    event.key !== `${event.cx},${event.cz}`
  )
    return false;
  const chunk = world.chunks.get(event.key);
  return (
    !!chunk &&
    event.chunk === chunk &&
    chunk.incarnation === event.incarnation &&
    event.revision <= chunk.revision &&
    chunk.minY === world.spec.minY &&
    chunk.maxY === world.spec.maxY
  );
}

export function explorationEntryLive(world, entry) {
  const { x, y, z } = entry.marker.position;
  return cellsEqual(world.getCell(x, y, z), entry.expected);
}

export function explorationEntryEdited(world, entry) {
  return world.edits.has(progressPositionKey(entry.marker));
}

function canonicalColumnStructure(world, terrain, bounds) {
  const manifest = world.generator.generationManifest;
  if (
    !hasExpandedTerrain(world.generatorVersion) ||
    manifest?.generatorVersion !== world.generatorVersion ||
    manifest.structureLayoutVersion !== STRUCTURE_LAYOUT_VERSION
  )
    throw new RangeError("Native structure generation manifest is unavailable");
  const kinds = progressArray(manifest.structureKinds, STRUCTURE_KINDS.length);
  if (
    new Set(kinds).size !== kinds.length ||
    kinds.some((kind) => !STRUCTURE_KINDS.includes(kind))
  )
    throw new RangeError("Unknown native structure manifest");
  // Current layouts never cross their 192-cell owner, which aligns with the
  // 16-cell column grid. One bounded description also detects omitted packets:
  // missing metadata must not authorize lazy empty ownership of a real chest.
  const gx = Math.floor(bounds.minX / STRUCTURE_LIMITS.spacing);
  const gz = Math.floor(bounds.minZ / STRUCTURE_LIMITS.spacing);
  const kind = selectStructureKind(createStructureSite(terrain, gx, gz));
  if (!kind || !kinds.includes(kind)) return null;
  const descriptor = describeCanonicalStructure(world.generatorVersion, kind, terrain, gx, gz);
  return descriptor &&
    descriptor.bounds.minX < bounds.maxX &&
    descriptor.bounds.maxX > bounds.minX &&
    descriptor.bounds.minZ < bounds.maxZ &&
    descriptor.bounds.maxZ > bounds.minZ
    ? descriptor
    : null;
}

/**
 * Canonical membership is re-described with the real bare sampler, not inferred
 * from a packet's self-consistent IDs. There are no voxel generations or rolls.
 * Filter each declaration by the anchor column BEFORE any member deduplication.
 */
export function admittedExplorationEntries(world, event, context, limits) {
  const descriptors = progressArray(
    event.chunk.structures ?? [],
    limits.descriptorsPerColumn
  );
  if (!hasExpandedTerrain(world.generatorVersion)) {
    if (descriptors.length)
      throw new RangeError("Historical terrain has no native markers");
    return [];
  }
  const terrain = nativeExplorationContext(world);
  const bounds = {
    minX: event.cx * CHUNK_SIZE,
    maxX: (event.cx + 1) * CHUNK_SIZE,
    minZ: event.cz * CHUNK_SIZE,
    maxZ: (event.cz + 1) * CHUNK_SIZE,
    minY: world.spec.minY,
    maxY: world.spec.maxY,
  };
  const canonical = canonicalColumnStructure(world, terrain, bounds);
  if (canonical && !descriptors.length)
    throw new RangeError("Native structure metadata is missing");
  const entries = new Map();
  const positions = new Set();
  for (const declaration of descriptors) {
    progressRecord(declaration, DESCRIPTOR_FIELDS);
    if (
      !STRUCTURE_KINDS.includes(declaration.kind) ||
      declaration.seed !== world.seed ||
      declaration.generatorVersion !== world.generatorVersion ||
      declaration.dimension !== world.dimension ||
      (declaration.owner !== undefined &&
        declaration.owner !==
          `structure:${declaration.kind}:v${STRUCTURE_LAYOUT_VERSION}`)
    )
      throw new RangeError("Unknown native structure declaration");
    if (
      !canonical ||
      !Object.keys(canonical).every((key) =>
        canonicalData(declaration[key], canonical[key])
      )
    )
      throw new RangeError("Packet is not the canonical native structure");
    // In particular, an anchor-free neighboring packet never enters a seen-site set.
    const projected = explorationMarkersFromStructure(declaration, context, {
      bounds,
    });
    const raw = new Map(canonical.markers.map((marker) => [marker.id, marker]));
    for (const marker of projected) {
      if (entries.has(marker.id)) continue;
      if (entries.size >= limits.markersPerColumn)
        throw new RangeError("Too many resident marker anchors");
      const declared = raw.get(marker.id);
      const name =
        declared.block ??
        (Number.isInteger(canonical.waterLevel) &&
        marker.position.y <= canonical.waterLevel
          ? "WATER"
          : "AIR");
      if (!Number.isInteger(BLOCK[name]) || !BLOCKS[BLOCK[name]])
        throw new RangeError(`Missing canonical marker block ${name}`);
      const position = progressPositionKey(marker);
      if (positions.has(position))
        throw new RangeError("Overlapping native markers");
      positions.add(position);
      const entry = {
        marker: freezeProgressData(marker),
        declaration: declared,
        kind: canonical.kind,
        expected: Object.freeze(normalizeCell({ id: BLOCK[name] })),
        invalidated: false,
        mapResolution: undefined,
      };
      entry.invalidated =
        !explorationEntryLive(world, entry) ||
        explorationEntryEdited(world, entry);
      entries.set(marker.id, entry);
    }
  }
  return [...entries.values()];
}
