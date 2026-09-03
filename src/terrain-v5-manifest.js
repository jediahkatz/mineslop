import { createStructureDecorators, describeStructure } from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";

export const V5_GENERATION_MANIFEST = Object.freeze({
  id: "native-v5/all-structures-v1",
  generatorVersion: 5,
  structureLayoutVersion: 1,
  structureKinds: Object.freeze([
    "shipwreck", "ocean_ruin", "ocean_monument", "buried_treasure", "village",
    "nether_fortress", "bastion_remnant", "dungeon",
  ]),
});

// Layout/marker identities remain layout-v1. World identity includes the
// generator version; transport rejects a v4 declaration in a v5 job and vice
// versa. Do not edit the historical catalog's v4 declaration in place.
const asV5 = (descriptor) =>
  descriptor ? Object.freeze({ ...descriptor, generatorVersion: 5 }) : null;

export function describeV5Structure(kind, context, gx, gz) {
  if (!V5_GENERATION_MANIFEST.structureKinds.includes(kind))
    throw new RangeError("Unknown v5 structure family");
  return asV5(describeStructure(kind, context, gx, gz));
}

let decorators;
export function getNativeV5Decorators() {
  if (STRUCTURE_LAYOUT_VERSION !== V5_GENERATION_MANIFEST.structureLayoutVersion)
    throw new RangeError("Native v5 requires its frozen structure layout version");
  decorators ??= Object.freeze(
    createStructureDecorators({ kinds: V5_GENERATION_MANIFEST.structureKinds })
      .map((entry) => Object.freeze({
        ...entry,
        describe(context) { return entry.describe(context).map(asV5); },
      }))
  );
  return decorators;
}
