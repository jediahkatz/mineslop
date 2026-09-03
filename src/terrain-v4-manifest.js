import { createStructureDecorators } from "./structure-catalog.js";
import { STRUCTURE_LAYOUT_VERSION } from "./structure-layouts.js";

/**
 * The complete candidate-v4 baseline, not a gameplay activation allowlist.
 * Never derive this from the live catalog: adding a family later must not
 * silently change untouched columns of an existing version-4 save.
 * New-world selection remains version 3 until the parent activation gates pass.
 */
export const V4_GENERATION_MANIFEST = Object.freeze({
  id: "native-v4/all-structures-v1",
  generatorVersion: 4,
  structureLayoutVersion: 1,
  structureKinds: Object.freeze([
    "shipwreck",
    "ocean_ruin",
    "ocean_monument",
    "buried_treasure",
    "village",
    "nether_fortress",
    "bastion_remnant",
    "dungeon",
  ]),
});

let decorators;

/**
 * Resolve real registered content only on the explicit native-v4 factory path.
 * Historical imports/factories do not require expansion content. Each worker
 * resolves its own functions; no callbacks cross the transport boundary.
 */
export function getNativeV4Decorators() {
  if (
    STRUCTURE_LAYOUT_VERSION !== V4_GENERATION_MANIFEST.structureLayoutVersion
  )
    throw new RangeError(
      "Native v4 requires its frozen structure layout version"
    );
  decorators ??= Object.freeze(
    createStructureDecorators({ kinds: V4_GENERATION_MANIFEST.structureKinds })
  );
  return decorators;
}
