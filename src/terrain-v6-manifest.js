import { createStructureDecorators, describeStructure } from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";

export const V6_GENERATION_MANIFEST = Object.freeze({
  id: "native-v6/all-structures-v1",
  generatorVersion: 6,
  structureLayoutVersion: 1,
  structureKinds: Object.freeze([
    "shipwreck", "ocean_ruin", "ocean_monument", "buried_treasure", "village",
    "nether_fortress", "bastion_remnant", "dungeon",
  ]),
});

function checkContext(context) {
  if (context.generatorVersion !== 6)
    throw new RangeError("Native v6 requires a version-6 sampling context");
}
const asV6 = (descriptor) =>
  descriptor ? Object.freeze({ ...descriptor, generatorVersion: 6 }) : null;

export function describeV6Structure(kind, context, gx, gz) {
  checkContext(context);
  if (!V6_GENERATION_MANIFEST.structureKinds.includes(kind))
    throw new RangeError("Unknown v6 structure family");
  return asV6(describeStructure(kind, context, gx, gz));
}

let decorators;
export function getNativeV6Decorators() {
  if (STRUCTURE_LAYOUT_VERSION !== V6_GENERATION_MANIFEST.structureLayoutVersion)
    throw new RangeError("Native v6 requires its frozen structure layout version");
  decorators ??= Object.freeze(
    createStructureDecorators({ kinds: V6_GENERATION_MANIFEST.structureKinds })
      .map((entry) => Object.freeze({
        ...entry,
        describe(context) {
          checkContext(context);
          return entry.describe(context).map(asV6);
        },
      }))
  );
  return decorators;
}
