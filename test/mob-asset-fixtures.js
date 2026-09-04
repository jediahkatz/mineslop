import { AQUATIC_KINDS } from "../src/aquatic-skins.js";
import { createMobModel, createProjectileModel } from "../src/mob-models.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { NPC_KINDS } from "../src/npc-skins.js";

// Authored legacy registry at aquatic integration 0db1f7091d22, before Ecology.
// Keep explicit: filtering today's registry would silently lose legacy coverage.
export const LEGACY_MOB_KINDS = Object.freeze([
  "sheep", "pig", "cow", "chicken", "horse", "rabbit", "wolf", "fox",
  "goat", "polar_bear", "panda", "camel", "frog", "mooshroom", "zombie",
  "skeleton", "creeper", "spider", "enderman", "slime", "sulfur_cube",
  "husk", "stray", "piglin", "ghast", "cod", "squid",
]);

export function catalogSkins() {
  const kinds = new Set([
    ...Object.keys(MOB_SPECIES), ...AQUATIC_KINDS, ...NPC_KINDS,
  ]);
  const models = [...kinds].map(createMobModel);
  models.push(createProjectileModel("arrow"), createProjectileModel("fireball"));
  return models.flatMap((model) => model.parts.map((part) => part.skin));
}
