// Wire-format limits, not truncation thresholds. An 80-code-unit seed needs at
// most 726 URI characters after JSON quoting; the complete ID remains intact.
export const MAX_STRUCTURE_ID_LENGTH = 1024;
export const MAX_STRUCTURE_MEMBER_ID_LENGTH =
  MAX_STRUCTURE_ID_LENGTH + 1 + 9 + 1 + 48;

// Explicit layout-v1 grammar. These are historical format constants, not live
// generator imports: a future layout must not reinterpret an existing owner ID.
const V1_SPACING = 192;
const V1_WORLD_LIMIT = 30_000_000;
const V1_DIMENSIONS = Object.freeze({
  shipwreck: "overworld",
  ocean_ruin: "overworld",
  ocean_monument: "overworld",
  buried_treasure: "overworld",
  village: "overworld",
  dungeon: "overworld",
  nether_fortress: "nether",
  bastion_remnant: "nether",
});
function ownerCoordinate(text) {
  const coordinate = Number(text);
  if (
    !Number.isSafeInteger(coordinate) ||
    String(coordinate) !== text ||
    coordinate < Math.floor(-V1_WORLD_LIMIT / V1_SPACING) ||
    coordinate >= Math.ceil(V1_WORLD_LIMIT / V1_SPACING)
  )
    throw new RangeError("Invalid canonical structure owner coordinate");
  return coordinate;
}

/**
 * Dependency-free identity validation shared by progression and stack metadata.
 * Inputs are primitives. Canonical IDs require their seed/generator/dimension;
 * the encoded seed must match verbatim, without URI/Unicode normalization.
 *
 * Returns the canonical owner, or null for a valid short legacy opaque ID.
 * Legacy IDs retain their 128-character ASCII grammar and encode no trusted
 * owner/world. The reserved "structure:" namespace NEVER falls back to legacy.
 * Invalid input throws RangeError. This neither asserts structure existence nor
 * validates a target's position: callers check world bounds and, for canonical
 * owners, floor(x / spacing) === gx and floor(z / spacing) === gz.
 */
export function parseStructureIdentity(id, seed, generatorVersion, dimension) {
  if (typeof id !== "string")
    throw new RangeError("Invalid structure identity");
  if (!id.startsWith("structure:")) {
    if (id.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9_.:/,-]*$/.test(id))
      throw new RangeError("Invalid legacy structure identity");
    return null;
  }
  if (id.length > MAX_STRUCTURE_ID_LENGTH)
    throw new RangeError("Canonical structure identity exceeds its bound");
  const parts = id.split(":");
  const [namespace, layout, encodedSeed, ownerDimension, kind, gx, gz] = parts;
  if (
    parts.length !== 7 ||
    namespace !== "structure" ||
    layout !== "v1" ||
    (generatorVersion !== 4 && generatorVersion !== 5 && generatorVersion !== 6 && generatorVersion !== 7) ||
    typeof seed !== "string" ||
    seed.length > 80 ||
    // World seeds are opaque UTF-16 strings. JSON quoting makes even control
    // characters and lone surrogates safe before URI encoding, without edits.
    encodedSeed !== encodeURIComponent(JSON.stringify(seed)) ||
    ownerDimension !== dimension ||
    !Object.hasOwn(V1_DIMENSIONS, kind) ||
    V1_DIMENSIONS[kind] !== dimension
  )
    throw new RangeError("Invalid canonical structure identity");
  return {
    layoutVersion: 1,
    generatorVersion,
    dimension,
    kind,
    gx: ownerCoordinate(gx),
    gz: ownerCoordinate(gz),
    spacing: V1_SPACING,
  };
}
