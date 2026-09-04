import { createStructureDecorators, describeStructure } from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";

export const V7_GENERATION_MANIFEST = Object.freeze({
  id: "native-v7/all-structures-v1",
  generatorVersion: 7,
  structureLayoutVersion: 1,
  structureKinds: Object.freeze([
    "shipwreck", "ocean_ruin", "ocean_monument", "buried_treasure", "village",
    "nether_fortress", "bastion_remnant", "dungeon",
  ]),
  // Terrain landmarks are pure generator metadata, not loot/exploration
  // declarations. No packet/archive schema or layout-v1 identity changes.
  endLandmarks: Object.freeze({ kind: "end_pillar", count: 10, geometryVersion: 1 }),
});

function checkContext(context) {
  if (context.generatorVersion !== 7)
    throw new RangeError("Native v7 requires a version-7 sampling context");
}
const asV7 = (descriptor) =>
  descriptor ? Object.freeze({ ...descriptor, generatorVersion: 7 }) : null;

export function describeV7Structure(kind, context, gx, gz) {
  checkContext(context);
  if (!V7_GENERATION_MANIFEST.structureKinds.includes(kind))
    throw new RangeError("Unknown v7 structure family");
  return asV7(describeStructure(kind, context, gx, gz));
}

let decorators;
export function getNativeV7Decorators() {
  if (STRUCTURE_LAYOUT_VERSION !== V7_GENERATION_MANIFEST.structureLayoutVersion)
    throw new RangeError("Native v7 requires its frozen structure layout version");
  decorators ??= Object.freeze(
    createStructureDecorators({ kinds: V7_GENERATION_MANIFEST.structureKinds })
      .map((entry) => Object.freeze({
        ...entry,
        describe(context) {
          checkContext(context);
          return entry.describe(context).map(asV7);
        },
      }))
  );
  return decorators;
}
