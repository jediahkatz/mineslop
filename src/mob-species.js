import { BLOCK } from "./blocks.js";
import { ECOLOGY_SPECIES } from "./expansion-ecology.js";
import { ITEM } from "./items.js";

export const MAX_MOBS = 28;
// Saved ecology residents may be dormant. Only MAX_MOBS are ever simulated
// or uploaded; this separate bound never enlarges the legacy spawn/GPU pool.
export const MAX_ECOLOGY_RESIDENTS = 512;
export const MAX_HOSTILES = 10;
export const MAX_PROJECTILES = 12;
export const MAX_KILLED_MOBS = 1024;
export const DESPAWN_DISTANCE = 58;
export const MIN_HOSTILE_SPAWN_DISTANCE = 24;
export const SPAWN_GRACE_SECONDS = 8;

const meadow = /plains|meadow|forest|cherry|grove/;
const woodland = /forest|taiga|grove|pale_garden/;
const cold = /snow|frozen|ice|grove|taiga/;
const dry = /desert|badlands/;
const wet = /swamp|mangrove|river/;
const ocean = /ocean|river/;
const nonOcean = (id) => !/ocean|river|beach|mushroom|the_void/.test(id);
const drop = (id, min = 1, max = min, chance = 1) => ({ id, min, max, chance });
const passive = (name, habitat, extra) => ({
  name,
  habitat,
  dimension: "overworld",
  temperament: "passive",
  health: 10,
  speed: 0.65,
  radius: 0.55,
  height: 1.4,
  stepHeight: 1,
  vision: 16,
  reach: 1.5,
  damage: 2,
  cooldown: 1.5,
  drops: [],
  ...extra,
});
const hostile = (name, habitat, extra) =>
  passive(name, habitat, {
    temperament: "hostile",
    nocturnal: true,
    health: 20,
    speed: 1.45,
    radius: 0.4,
    height: 1.95,
    damage: 3,
    vision: 22,
    ...extra,
  });

// Models and decisions are shared where anatomy warrants it, not just recolored.
export const MOB_SPECIES = Object.freeze({
  sheep: passive("Sheep", meadow, {
    drops: [drop(ITEM.RAW_MUTTON, 1, 2), drop(BLOCK.WOOL)],
    food: [ITEM.WHEAT],
    radius: 0.66,
  }),
  pig: passive("Pig", /plains|forest|jungle|savanna/, {
    drops: [drop(ITEM.RAW_PORK, 1, 3)],
    radius: 0.62,
    height: 1.1,
  }),
  cow: passive("Cow", /plains|forest|savanna|meadow/, {
    health: 14,
    radius: 0.74,
    height: 1.85,
    drops: [drop(ITEM.RAW_BEEF, 1, 3), drop(ITEM.LEATHER, 1, 2)],
    food: [ITEM.WHEAT],
  }),
  chicken: passive("Chicken", /plains|forest|jungle|savanna/, {
    health: 4,
    radius: 0.3,
    height: 1.05,
    speed: 0.8,
    light: true,
    drops: [drop(ITEM.RAW_CHICKEN), drop(ITEM.FEATHER, 1, 2)],
    food: [ITEM.SEEDS],
  }),
  horse: passive("Horse", /plains|savanna/, {
    health: 24,
    height: 2.45,
    radius: 0.88,
    speed: 1.2,
    drops: [drop(ITEM.LEATHER, 1, 2)],
    food: [ITEM.APPLE, ITEM.WHEAT],
  }),
  rabbit: passive("Rabbit", /desert|meadow|snow|taiga|cherry/, {
    health: 4,
    height: 1.08,
    radius: 0.27,
    speed: 1.1,
    hop: 3.5,
  }),
  wolf: passive("Wolf", woodland, {
    temperament: "neutral",
    health: 16,
    radius: 0.6,
    height: 1.2,
    speed: 1.55,
    damage: 4,
    cooldown: 1.1,
    food: [
      ITEM.RAW_BEEF,
      ITEM.STEAK,
      ITEM.RAW_PORK,
      ITEM.COOKED_PORK,
      ITEM.RAW_CHICKEN,
      ITEM.COOKED_CHICKEN,
      ITEM.RAW_MUTTON,
      ITEM.COOKED_MUTTON,
    ],
  }),
  fox: passive("Fox", /taiga|grove/, {
    health: 8,
    radius: 0.56,
    height: 0.95,
    speed: 1.25,
    shy: true,
    nocturnalPassive: true,
  }),
  goat: passive("Goat", /peaks|mountain|slope|stony|meadow/, {
    health: 12,
    radius: 0.59,
    height: 1.85,
    speed: 0.9,
    stepHeight: 2,
    food: [ITEM.WHEAT],
    drops: [drop(ITEM.RAW_MUTTON, 1, 2)],
  }),
  polar_bear: passive("Polar bear", cold, {
    temperament: "neutral",
    health: 30,
    radius: 0.92,
    height: 1.65,
    speed: 1.2,
    damage: 6,
    reach: 2,
  }),
  panda: passive("Panda", /jungle/, {
    health: 24,
    radius: 0.78,
    height: 1.5,
    speed: 0.45,
    food: [BLOCK.BAMBOO],
  }),
  camel: passive("Camel", dry, {
    health: 30,
    radius: 0.9,
    height: 2.7,
    speed: 0.95,
    stepHeight: 1.5,
    food: [BLOCK.CACTUS],
    drops: [drop(ITEM.LEATHER, 1, 2)],
  }),
  frog: passive("Frog", wet, {
    health: 6,
    radius: 0.35,
    height: 0.52,
    speed: 0.6,
    hop: 2.8,
  }),
  mooshroom: passive("Mooshroom", /mushroom_fields/, {
    health: 14,
    radius: 0.74,
    height: 2.1,
    drops: [drop(ITEM.RAW_BEEF, 1, 3), drop(BLOCK.RED_MUSHROOM, 1, 2)],
    food: [ITEM.WHEAT],
  }),
  zombie: hostile("Zombie", (id) => nonOcean(id) && !dry.test(id), {
    sunburn: true,
    drops: [drop(ITEM.BONE, 1, 2)],
  }),
  skeleton: hostile("Skeleton", (id) => nonOcean(id) && !cold.test(id), {
    sunburn: true,
    ranged: "arrow",
    reach: 12,
    cooldown: 2.4,
    speed: 1.25,
    drops: [drop(ITEM.BONE, 1, 2), drop(ITEM.ARROW, 1, 3)],
  }),
  creeper: hostile("Creeper", nonOcean, {
    speed: 1.2,
    height: 1.65,
    limit: 2,
    drops: [drop(ITEM.GUNPOWDER, 1, 2)],
  }),
  spider: hostile("Spider", nonOcean, {
    health: 16,
    speed: 2.2,
    radius: 0.92,
    height: 0.85,
    reach: 1.9,
    dayNeutral: true,
    drops: [drop(ITEM.STRING, 1, 3)],
  }),
  enderman: hostile("Enderman", nonOcean, {
    dimension: ["overworld", "nether", "end"],
    health: 40,
    height: 3.15,
    eyeHeight: 2.855,
    radius: 0.36,
    speed: 2.4,
    damage: 6,
    reach: 2,
    temperament: "watchful",
    limit: 3,
    drops: [drop(ITEM.ENDER_PEARL)],
  }),
  slime: hostile("Slime", /swamp|mangrove|lush_caves/, {
    health: 12,
    height: 1.15,
    radius: 0.55,
    speed: 1.05,
    hop: 4,
    drops: [drop(ITEM.SLIME_BALL, 1, 2)],
  }),
  sulfur_cube: passive("Sulfur cube", /^sulfur_caves$/, {
    health: 12,
    height: 1.32,
    radius: 0.6,
    speed: 0.8,
    hop: 3.6,
    damage: 0,
    harmless: true,
    nocturnal: false,
    undergroundOnly: true,
    limit: 5,
  }),
  husk: hostile("Husk", dry, {
    health: 24,
    speed: 1.2,
    damage: 4,
    drops: [drop(ITEM.BONE, 1, 2)],
  }),
  stray: hostile("Stray", cold, {
    sunburn: true,
    height: 2.1,
    ranged: "arrow",
    reach: 15,
    cooldown: 2.8,
    speed: 1,
    damage: 4,
    drops: [drop(ITEM.BONE, 1, 2), drop(ITEM.ARROW, 2, 4)],
  }),
  piglin: hostile("Piglin", /nether_wastes|crimson|basalt/, {
    dimension: "nether",
    health: 24,
    height: 2.05,
    speed: 1.8,
    damage: 5,
    drops: [drop(ITEM.GOLD_INGOT)],
  }),
  ghast: hostile("Ghast", /nether_wastes|soul_sand|basalt/, {
    dimension: "nether",
    health: 16,
    height: 3,
    radius: 1.05,
    speed: 1.1,
    flying: true,
    ranged: "fireball",
    reach: 23,
    vision: 30,
    damage: 6,
    cooldown: 4,
    limit: 2,
    drops: [drop(ITEM.GUNPOWDER, 1, 3)],
  }),
  cod: passive("Cod", ocean, {
    health: 3,
    radius: 0.68,
    height: 0.46,
    speed: 1,
    aquatic: true,
    minWaterDepth: 3,
    shy: true,
  }),
  squid: passive("Squid", ocean, {
    health: 10,
    radius: 0.64,
    height: 1.85,
    speed: 0.55,
    aquatic: true,
    minWaterDepth: 4,
  }),
  ...ECOLOGY_SPECIES,
});

export function isDaylight(timeOfDay) {
  const time = ((timeOfDay % 1) + 1) % 1;
  return time > 0.27 && time < 0.73;
}

export function isHostileSpecies(spec) {
  return spec.temperament === "hostile" || spec.temperament === "watchful";
}

export function speciesForBiome(
  biome,
  {
    timeOfDay = 0.3,
    dimension = "overworld",
    water = false,
    hostile: wantHostile = false,
  } = {}
) {
  const id = biome?.id ?? "plains";
  return Object.entries(MOB_SPECIES)
    .filter(([, spec]) => {
      // These require exact cell-volume habitat / canonical marker admission,
      // not legacy waterHome or the generic hostile/peaceful site heuristic.
      if (spec.ecology) return false;
      const dimensions = Array.isArray(spec.dimension)
        ? spec.dimension
        : [spec.dimension];
      if (!dimensions.includes(dimension) || !!spec.aquatic !== water)
        return false;
      if (isHostileSpecies(spec) !== wantHostile) return false;
      if (spec.nocturnal && dimension === "overworld" && isDaylight(timeOfDay))
        return false;
      if (spec.nocturnalPassive && isDaylight(timeOfDay)) return false;
      if (spec.temperament === "watchful" && dimension !== "overworld")
        return dimension === "end" || /warped/.test(id);
      return typeof spec.habitat === "function"
        ? spec.habitat(id)
        : spec.habitat.test(id);
    })
    .map(([kind]) => kind);
}
