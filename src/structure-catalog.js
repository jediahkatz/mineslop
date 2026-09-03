import { squareSpiral } from "./noise.js";
import { NETHER_STRUCTURE_DEFINITIONS } from "./nether-structures.js";
import { OCEAN_STRUCTURE_DEFINITIONS } from "./ocean-structures.js";
import {
  requireStructureContent,
  STRUCTURE_CONTENT_PROPERTIES,
} from "./structure-content.js";
import {
  createStructureBrush,
  freezeStructureData,
  transformStructureMarkers,
  STRUCTURE_LAYOUT_VERSION,
  structureBounds,
  structurePoint,
} from "./structure-layouts.js";
import {
  createStructureSite,
  selectStructureKind,
  STRUCTURE_MAX_SAMPLES,
  STRUCTURE_SPACING,
  validateStructureContext,
} from "./structure-placement.js";
import { UNDERGROUND_STRUCTURE_DEFINITION } from "./underground-structures.js";
import { VILLAGE_STRUCTURE_DEFINITION } from "./village-structures.js";

const definitions = [
  ...OCEAN_STRUCTURE_DEFINITIONS,
  VILLAGE_STRUCTURE_DEFINITION,
  ...NETHER_STRUCTURE_DEFINITIONS,
  UNDERGROUND_STRUCTURE_DEFINITION,
];
const byKind = new Map(
  definitions.map((definition) => [
    definition.kind,
    freezeStructureData(definition),
  ])
);

export const STRUCTURE_KINDS = Object.freeze(definitions.map((d) => d.kind));
export const STRUCTURE_REQUIRED_CONTENT = Object.freeze(
  [...new Set(definitions.flatMap((d) => d.requiredContent))].sort()
);
export const STRUCTURE_CONTENT_REQUIREMENTS = freezeStructureData(
  STRUCTURE_REQUIRED_CONTENT.map((name) => ({
    name,
    properties: STRUCTURE_CONTENT_PROPERTIES[name],
  }))
);
export const STRUCTURE_LIMITS = Object.freeze({
  spacing: STRUCTURE_SPACING,
  reach: 0,
  describeSamples: STRUCTURE_MAX_SAMPLES,
  locatorRadius: 32,
  locatorCells: 2048,
  locatorSamples: 65536,
});
export const STRUCTURE_MAP_SEARCH = Object.freeze({
  radius: 12,
  maxCells: 625,
  maxSamples: 16384,
});

function definitionFor(kind) {
  const definition = byKind.get(kind);
  if (!definition) throw new RangeError(`Unknown structure kind: ${kind}`);
  return definition;
}

function contains(bounds, x, y, z) {
  return (
    x >= bounds.minX &&
    x < bounds.maxX &&
    y >= bounds.minY &&
    y < bounds.maxY &&
    z >= bounds.minZ &&
    z < bounds.maxZ
  );
}

/**
 * Pure global-owner query. It uses only seed + dimension + bare column samples,
 * never requested chunk bounds, mutable world cells, emitted voxels or loot.
 * Descriptors are frozen, structured-cloneable data; no callback is serialized.
 */
export function describeStructure(kind, context, gx, gz) {
  const definition = definitionFor(kind);
  validateStructureContext(context);
  if (context.dimension !== definition.dimension) return null;
  const site = createStructureSite(context, gx, gz);
  if (selectStructureKind(site) !== kind) return null;
  const prepared = definition.prepare(site);
  if (!prepared) return null;
  const descriptor = {
    id: `structure:v${STRUCTURE_LAYOUT_VERSION}:${encodeURIComponent(JSON.stringify(site.seed))}:${site.dimension}:${kind}:${gx}:${gz}`,
    generatorVersion: 4,
    layoutVersion: STRUCTURE_LAYOUT_VERSION,
    seed: site.seed,
    kind,
    dimension: site.dimension,
    gx,
    gz,
    origin: { ...site.origin, y: prepared.y },
    rotation: site.rotation,
    variant: prepared.variant,
    waterLevel: prepared.waterLevel,
    localBounds: prepared.localBounds,
    plan: prepared.plan,
  };
  descriptor.bounds = structureBounds(descriptor, prepared.localBounds);
  const { bounds } = descriptor;
  if (
    !Object.values(bounds).every(Number.isSafeInteger) ||
    bounds.minX < gx * STRUCTURE_SPACING ||
    bounds.maxX > (gx + 1) * STRUCTURE_SPACING ||
    bounds.minZ < gz * STRUCTURE_SPACING ||
    bounds.maxZ > (gz + 1) * STRUCTURE_SPACING ||
    bounds.minY < context.spec.minY ||
    bounds.maxY > context.spec.maxY
  )
    throw new RangeError(`${kind} description exceeded its world/owner bounds`);
  descriptor.entries = prepared.entries.map(([x, y, z, facing]) => ({
    ...structurePoint(descriptor, x, y, z),
    facing: (facing + site.rotation) & 3,
  }));
  descriptor.markers = transformStructureMarkers(
    descriptor,
    definition.markers(descriptor)
  );
  for (const marker of descriptor.markers) {
    if (
      !contains(bounds, marker.position.x, marker.position.y, marker.position.z)
    )
      throw new RangeError(`${kind} marker is outside its structure`);
    if (marker.mapTarget)
      marker.mapTarget = {
        ...marker.mapTarget,
        seed: site.seed,
        layoutVersion: STRUCTURE_LAYOUT_VERSION,
        sourceMarkerId: marker.id,
        from: { ...marker.position },
        search: { ...STRUCTURE_MAP_SEARCH },
      };
  }
  if (
    new Set(descriptor.markers.map((m) => m.id)).size !==
    descriptor.markers.length
  )
    throw new Error(`${kind} has duplicate declarative marker identities`);
  return freezeStructureData(descriptor);
}

/**
 * Original named voxel layout; useful for authored fixture inspection without
 * registering fake IDs. This does not materialize any marker or gameplay state.
 * The return value is the real attempted write count, including clipped writes.
 */
export function emitStructureNamed(descriptor, put) {
  const definition = definitionFor(descriptor?.kind);
  if (
    descriptor.layoutVersion !== STRUCTURE_LAYOUT_VERSION ||
    typeof put !== "function"
  )
    throw new TypeError("Invalid structure descriptor or emission callback");
  const materials = new Set(definition.requiredContent);
  let writes = 0;
  const brush = createStructureBrush(descriptor, (x, y, z, block, options) => {
    if (++writes > definition.maxWrites)
      throw new RangeError(`${definition.kind} exceeded its write budget`);
    if (
      ![x, y, z].every(Number.isSafeInteger) ||
      !contains(descriptor.bounds, x, y, z)
    )
      throw new RangeError(`${definition.kind} wrote outside its descriptor`);
    if (!materials.has(block))
      throw new Error(`${definition.kind} uses undeclared content: ${block}`);
    put(x, y, z, block, options);
  });
  definition.emit(descriptor, brush);
  return writes;
}

/**
 * Registration hook for createTerrainV4(seed, dimension, { decorators }).
 * All eight entries fit the real v4 seam. Construct on the main thread AND in
 * terrain workers; functions must not be posted through structured-clone.
 *
 * Missing content is an intentional eager registration error. Describe/locate
 * remain available before registration, without silently substituting blocks.
 */
export function createStructureDecorators({ kinds = STRUCTURE_KINDS } = {}) {
  if (!Array.isArray(kinds) || new Set(kinds).size !== kinds.length)
    throw new TypeError("Structure kinds must be a unique array");
  const selected = kinds.map(definitionFor);
  const ids = requireStructureContent(
    selected.flatMap((d) => d.requiredContent)
  );
  return selected.map((definition) =>
    Object.freeze({
      id: `structure:${definition.kind}:v${STRUCTURE_LAYOUT_VERSION}`,
      spacing: STRUCTURE_SPACING,
      reach: 0,
      maxWrites: definition.maxWrites,
      maxSamples: STRUCTURE_MAX_SAMPLES,
      dimensions: Object.freeze([definition.dimension]),
      describe(context) {
        const descriptor = describeStructure(
          definition.kind,
          context,
          context.gx,
          context.gz
        );
        return descriptor ? [descriptor] : [];
      },
      emit(descriptor, put) {
        if (descriptor.kind !== definition.kind)
          throw new TypeError("Mismatched structure decorator");
        emitStructureNamed(descriptor, (x, y, z, name, options) => {
          put(x, y, z, ids[name], options);
        });
      },
    })
  );
}

/**
 * Detached declarations. With bounds, the marker's canonical anchor cell owns
 * it; a large home/encounter AABB does not yield one new marker per chunk.
 * Repeated packet ingestion must STILL dedupe by marker.id in the state ledger.
 */
export function getStructureMarkers(descriptor, { type, bounds } = {}) {
  return structuredClone(
    descriptor.markers.filter(
      (marker) =>
        (type === undefined || marker.type === type) &&
        (!bounds ||
          contains(
            bounds,
            marker.position.x,
            marker.position.y,
            marker.position.z
          ))
    )
  );
}

export function structureTarget(descriptor) {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    dimension: descriptor.dimension,
    layoutVersion: descriptor.layoutVersion,
    gx: descriptor.gx,
    gz: descriptor.gz,
    position: { ...descriptor.origin },
    entry: { ...descriptor.entries[0] },
    bounds: { ...descriptor.bounds },
  };
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new RangeError(
      `${label} must be an integer in [${minimum}, ${maximum}]`
    );
  return value;
}

/**
 * Bounded nearest-among-examined locator. No chunk generation, caches, loot
 * rolls or mutable counters live here. Exhaustion is explicit; null is a real
 * "not found in this search", never a fabricated structure at the last probe.
 */
export function locateStructure(
  kind,
  context,
  from = { x: 0, z: 0 },
  { radius = 8, maxCells = 289, maxSamples = 8192 } = {}
) {
  const definition = definitionFor(kind);
  validateStructureContext(context);
  if (!Number.isFinite(from.x) || !Number.isFinite(from.z))
    throw new RangeError("Structure locator origin must be finite");
  boundedInteger(radius, 0, STRUCTURE_LIMITS.locatorRadius, "Locator radius");
  boundedInteger(maxCells, 1, STRUCTURE_LIMITS.locatorCells, "Locator cells");
  boundedInteger(
    maxSamples,
    1,
    STRUCTURE_LIMITS.locatorSamples,
    "Locator samples"
  );
  let examinedCells = 0;
  let sampledColumns = 0;
  let exhausted = false;
  let target = null;
  let distance = Infinity;
  const sampleLimit = new Error("Structure locator sample budget reached");
  const limited = {
    ...context,
    sampleColumn(x, z) {
      if (sampledColumns >= maxSamples) throw sampleLimit;
      sampledColumns++;
      return context.sampleColumn(x, z);
    },
  };
  if (context.dimension === definition.dimension) {
    const gx = Math.floor(from.x / STRUCTURE_SPACING);
    const gz = Math.floor(from.z / STRUCTURE_SPACING);
    for (const [dx, dz] of squareSpiral(radius)) {
      if (examinedCells >= maxCells) {
        exhausted = true;
        break;
      }
      examinedCells++;
      let descriptor;
      try {
        descriptor = describeStructure(kind, limited, gx + dx, gz + dz);
      } catch (error) {
        if (error !== sampleLimit) throw error;
        exhausted = true;
        break;
      }
      if (!descriptor) continue;
      const candidate = structureTarget(descriptor);
      const squared =
        (candidate.position.x - from.x) ** 2 +
        (candidate.position.z - from.z) ** 2;
      if (
        squared < distance ||
        (squared === distance && candidate.id < target.id)
      ) {
        target = candidate;
        distance = squared;
      }
    }
  }
  return {
    target,
    examinedCells,
    sampledColumns,
    exhausted,
    complete: !exhausted,
  };
}

/**
 * Explicit map resolution, never called by describe/emit. Persist the returned
 * target (or absence) with the first materialization of the source table. A map
 * lookup does not create a container, reserve loot, or mark encounters consumed.
 */
export function resolveStructureMapTarget(query, context) {
  if (
    !query ||
    query.layoutVersion !== STRUCTURE_LAYOUT_VERSION ||
    String(context.seed) !== query.seed ||
    context.dimension !== query.dimension
  )
    throw new TypeError(
      "Map query requires its original seed, dimension and layout version"
    );
  return locateStructure(query.kind, context, query.from, query.search);
}
