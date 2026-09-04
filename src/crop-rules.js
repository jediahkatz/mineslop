import { BLOCK } from "./blocks.js";
import { ITEM } from "./items.js";

export const CROP_RECORD_VERSION = 1;
export const CROP_GROW_SECONDS = 45;
export const CROP_SPECIES = Object.freeze({
  wheat: Object.freeze({
    item: ITEM.SEEDS, soil: BLOCK.FARMLAND, young: BLOCK.TALL_GRASS,
    mature: BLOCK.WHEAT_CROP, maxAge: CROP_GROW_SECONDS, hydrated: true,
  }),
  carrot: Object.freeze({
    item: ITEM.CARROT, soil: BLOCK.FARMLAND, young: BLOCK.CARROT_CROP,
    mature: BLOCK.CARROT_CROP, maxAge: 40, hydrated: true,
  }),
  nether_wart: Object.freeze({
    item: ITEM.NETHER_WART, soil: BLOCK.SOUL_SAND, young: BLOCK.NETHER_WART_CROP,
    mature: BLOCK.NETHER_WART_CROP, maxAge: 30, hydrated: false,
  }),
});

export const cropSpeciesForItem = (id) =>
  Object.keys(CROP_SPECIES).find((species) => CROP_SPECIES[species].item === id);

export const cropRule = (crop) =>
  crop?.version === CROP_RECORD_VERSION && Object.hasOwn(CROP_SPECIES, crop.species)
    ? CROP_SPECIES[crop.species] : null;

export function validCrop(crop) {
  const rule = cropRule(crop);
  return Boolean(rule && Number.isFinite(crop.age) &&
    crop.age >= 0 && crop.age <= rule.maxAge);
}

export const cropBlock = (crop) => {
  const rule = cropRule(crop);
  return rule && (crop.age >= rule.maxAge ? rule.mature : rule.young);
};

/** Fixed owned yields: retries never sample RNG and cannot reroll a harvest. */
export function cropDrops(crop) {
  const rule = cropRule(crop);
  if (!validCrop(crop)) return null;
  if (crop.age < rule.maxAge) return [{ id: rule.item, count: 1 }];
  return crop.species === "wheat"
    ? [{ id: ITEM.WHEAT, count: 2 }, { id: ITEM.SEEDS, count: 1 }]
    : [{ id: rule.item, count: crop.species === "carrot" ? 3 : 2 }];
}

export function acceptsCropSoil(species, id) {
  // Preserve the original seed-to-farmland interaction for old worlds.
  return species === "wheat"
    ? [BLOCK.GRASS, BLOCK.DIRT, BLOCK.FARMLAND].includes(id)
    : Object.hasOwn(CROP_SPECIES, species) && CROP_SPECIES[species].soil === id;
}
