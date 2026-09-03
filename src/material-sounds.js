import { BLOCK, BLOCKS } from "./blocks.js";
import { ITEM_IDS } from "./content-ids.js";
import { WOOD_FAMILIES } from "./wood-content.js";

const material = (duration, root, body, noise, cutoff, grains, decay, modes) =>
  Object.freeze({
    duration, root, body, noise, cutoff, grains, decay,
    modes: Object.freeze(modes),
  });

// Damped body modes plus low-passed contact grains, not broadband hiss.
export const MATERIAL_SOUNDS = Object.freeze({
  grass: material(0.20, 112, 0.48, 0.34, 1050, 5, 0.032, [1, 1.8]),
  dirt: material(0.18, 132, 0.62, 0.20, 720, 3, 0.028, [1, 1.7]),
  stone: material(0.16, 205, 0.76, 0.12, 1700, 3, 0.021, [1, 2.31, 3.77]),
  wood: material(0.22, 158, 0.72, 0.10, 900, 2, 0.048, [1, 1.79, 2.64]),
  sand: material(0.25, 96, 0.25, 0.56, 950, 9, 0.026, [1, 1.6]),
  snow: material(0.24, 285, 0.24, 0.46, 1450, 7, 0.030, [1, 1.42]),
  gravel: material(0.26, 230, 0.48, 0.30, 1950, 8, 0.018, [1, 2.17]),
  water: material(0.36, 92, 0.20, 0.60, 650, 4, 0.065, [1, 1.5]),
  cloth: material(0.18, 90, 0.34, 0.22, 420, 2, 0.025, [1, 1.6]),
  glass: material(0.23, 535, 0.46, 0.06, 1100, 2, 0.045, [1, 2.32, 3.08]),
  metal: material(0.27, 340, 0.56, 0.08, 1200, 2, 0.055, [1, 1.51, 2.36]),
});

const overrides = new Map([
  [BLOCK.SAND, "sand"],
  [BLOCK.RED_SAND, "sand"],
  [BLOCK.SOUL_SAND, "sand"],
  [BLOCK.SNOW, "snow"],
  [BLOCK.SNOW_BLOCK, "snow"],
  [BLOCK.GRAVEL, "gravel"],
  [BLOCK.WOOL, "cloth"],
  [BLOCK.WHITE_BED, "cloth"],
  [BLOCK.SPONGE, "cloth"],
  [BLOCK.WET_SPONGE, "cloth"],
]);
const boats = new Set(
  WOOD_FAMILIES.map(({ boat }) => boat).filter(Number.isInteger)
);

/** Use block metadata: basalt's log art is stone; terracotta's sand art is rock. */
export function materialForBlock(id) {
  if (!Number.isInteger(id)) return "stone";
  if (overrides.has(id)) return overrides.get(id);
  if (boats.has(id)) return "wood";
  const block = BLOCKS[id];
  if (!block) return "stone";
  if (["water", "lava"].includes(block.texture) || block.aquatic) return "water";
  if (block.texture === "glass" || id === BLOCK.GLOWSTONE || id === BLOCK.SEA_LANTERN)
    return "glass";
  if (block.texture === "metal" || block.station === "brewing") return "metal";
  if (block.texture === "bed" || block.texture === "wool") return "cloth";
  if (block.woodFamily || block.tool === "axe") return "wood";
  if (["grass", "leaves", "flower"].includes(block.texture)) return "grass";
  if (block.texture === "dirt" || block.tool === "shovel") return "dirt";
  return "stone";
}

const cue = (family, gain, interval, group, limit = 6, extra = {}) =>
  Object.freeze({ family, gain, interval, group, limit, rate: 1, ...extra });

const cues = Object.freeze({
  step: cue("step", 0.060, 0.055, "movement", 2),
  "horse-step": cue("hoof", 0.072, 0.110, "movement", 2),
  mine: cue("impact", 0.135, 0.045, "impact", 4, { rate: 1.1 }),
  place: cue("impact", 0.095, 0.045, "impact", 4, { rate: 0.88 }),
  block: cue("impact", 0.110, 0.060, "impact", 4, { material: "wood" }),
  hit: cue("hit", 0.140, 0.060, "hit", 3),
  eat: cue("eat", 0.065, 0.140, "eat", 2),
  shoot: cue("shoot", 0.085, 0.060, "shoot", 3),
  xp: cue("xp", 0.075, 0.045, "xp", 2),
  levelup: cue("levelup", 0.105, 0.550, "levelup", 1, { priority: true }),
  teleport: cue("teleport", 0.100, 0.180, "teleport", 2, { priority: true }),
  "fishing-splash": cue("step", 0.080, 0.090, "water", 2, { material: "water" }),
  "fishing-bite": cue("step", 0.080, 0.090, "water", 2, { material: "water", rate: 1.2 }),
  "fishing-catch": cue("xp", 0.080, 0.090, "xp", 2),
});

/** Canonical families keep arbitrary item IDs/XP levels out of the buffer cache. */
export function soundDefinition(kind = "mine", id = BLOCK.STONE) {
  if (
    (kind === "step" || kind === "horse-step") &&
    (id === BLOCK.AIR || !Number.isInteger(id))
  )
    return null;
  if (kind === "break") {
    kind = "mine";
    if (!Number.isInteger(id)) id = BLOCK.PLANKS;
  }
  if (typeof kind !== "string" || !Object.hasOwn(cues, kind)) return null;
  const definition = cues[kind];
  const family =
    kind === "shoot" && id === ITEM_IDS.ENDER_PEARL
      ? "throw"
      : definition.family;
  let rate = definition.rate;
  const amount = Number.isFinite(id) ? Math.max(1, Math.floor(id)) : 1;
  if (kind === "xp") rate *= 0.98 + Math.min(8, amount) * 0.025;
  if (kind === "levelup") rate *= 1 + (Math.min(99, amount) % 5) * 0.012;
  return {
    ...definition,
    kind,
    family,
    material: ["step", "impact", "hoof"].includes(family)
      ? definition.material ?? materialForBlock(id)
      : null,
    rate,
  };
}
