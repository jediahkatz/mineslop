import { synchronous } from "./enchantment-domain.js";
import { createWorldContext, DIMENSIONS, getWorldSpec } from "./world-spec.js";

/**
 * Match World's identity contract, including the empty string, whitespace and
 * escaped seeds in valid legacy saves. Never trim, hash or silently replace it.
 * This is shared by the station and trading sidecars; structure-ID validation
 * remains the exploration owner's responsibility.
 */
export function normalizeProgressionContext(value) {
  if (
    !value || typeof value.seed !== "string" || value.seed.length > 80 ||
    (value.specForDimension !== undefined && !synchronous(value.specForDimension))
  )
    throw new RangeError("Invalid progression world context");
  for (const dimension of DIMENSIONS) {
    const expected = getWorldSpec(value.generatorVersion, dimension);
    const actual = value.specForDimension === undefined
      ? expected : value.specForDimension(dimension);
    if (!actual || ["minY", "maxY", "seaLevel", "voidY"].some(
      (field) => actual[field] !== expected[field]
    ))
      throw new RangeError("Mismatched progression world specification");
  }
  return createWorldContext(value);
}
