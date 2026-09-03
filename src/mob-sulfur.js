import { BLOCK, BLOCKS } from "./blocks.js";
import { MOB_SPECIES } from "./mob-species.js";

// A small playable approximation: these affect AI speed and hop impulse only,
// not the release's rigid-body collisions, buoyancy, TNT, or other special effects.
const MATERIALS = {
  regular: { speed: 1, hop: 1, description: "Steady, medium hops" },
  wood: { speed: 1.45, hop: 1.4, description: "Quick, springy hops" },
  stone: { speed: 0.55, hop: 1.12, description: "Slow, springy hops" },
  wool: { speed: 0.65, hop: 1.55, description: "Light, high hops" },
  ice: { speed: 1.7, hop: 0, description: "Fast, without hopping" },
  organic: { speed: 1.3, hop: 0.45, description: "Quick, low hops" },
};

const feedable = (id) => Number.isInteger(id) && BLOCKS[id]?.solid === true;

function materialOf(id) {
  const block = BLOCKS[id];
  if (id === BLOCK.WOOL) return "wool";
  if ([BLOCK.ICE, BLOCK.PACKED_ICE, BLOCK.BLUE_ICE].includes(id)) return "ice";
  if (["leaves", "cactus"].includes(block?.texture)) return "organic";
  if (block?.tool === "axe" && ["log", "planks"].includes(block.texture))
    return "wood";
  if (block?.tool === "pickaxe") return "stone";
  return "regular";
}

export function validSulfurState(entry) {
  return (
    entry.absorbedBlock === null ||
    entry.absorbedBlock === undefined ||
    (entry.kind === "sulfur_cube" && feedable(entry.absorbedBlock))
  );
}

/** Derive all motion and color from a validated block ID; loading emits no loot. */
export function setSulfurBlock(mob, id = null) {
  if (mob.kind !== "sulfur_cube") return;
  mob.absorbedBlock = id;
  mob.absorbedMaterial = id === null ? null : materialOf(id);
  const profile = MATERIALS[mob.absorbedMaterial ?? "regular"];
  const base = MOB_SPECIES.sulfur_cube;
  mob.spec = {
    ...base,
    speed: base.speed * profile.speed,
    hop: base.hop * profile.hop,
  };
  for (const color of mob.model.absorbedColors)
    color.set(id === null ? "#e1bd37" : BLOCKS[id].color);
  return profile;
}

/** Ownership is checked by the caller, which consumes one block after true. */
export function feedSulfurCube(mob, itemId, callbacks) {
  if (!feedable(itemId) || mob.absorbedBlock === itemId) return false;
  const previous = mob.absorbedBlock;
  const profile = setSulfurBlock(mob, itemId);
  mob.followTime = 20;
  mob.fleeTime = mob.hopCooldown = 0;
  if (previous !== null) {
    callbacks.onDrop(previous, 1, {
      x: mob.position.x,
      y: mob.position.y,
      z: mob.position.z,
    });
  }
  callbacks.onToast(
    `Sulfur cube absorbed ${BLOCKS[itemId].name}. ${profile.description}.`
  );
  return true;
}

/** Only replacement/death release a paid-for block, never spawn, load, or cull. */
export function releaseSulfurBlock(mob) {
  if (mob.kind !== "sulfur_cube" || mob.absorbedBlock === null) return null;
  const drop = { id: mob.absorbedBlock, count: 1 };
  setSulfurBlock(mob);
  return drop;
}
