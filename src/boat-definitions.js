import { EXPANSION_WOOD_PALETTES } from "./expansion-art-common.js";
import { getItem } from "./items.js";

export const BOAT_RADIUS = 11 / 16;
export const BOAT_HEIGHT = 9 / 16;
export const BOAT_DRAFT = 0.3;
export const BOAT_SEAT_HEIGHT = 0.4;
export const MAX_BOATS = 512;
export const MAX_ACTIVE_BOATS = 32;
export const BOAT_ACTIVE_DISTANCE = 96;
export const BOAT_RECORD_RESERVED_BYTES = 2048;
export const BOAT_HEADER_RESERVED_BYTES = 1024;
export const BOAT_MAX_SPEED = 12;
export const BOAT_MAX_VERTICAL_SPEED = 12;
export const BOAT_SUBMERGE_SECONDS = 3;
export const BOAT_BUBBLE_SECONDS = 3;

export const BOAT_WOODS = Object.freeze(
  Object.keys(EXPANSION_WOOD_PALETTES).filter(
    (wood) => wood !== "crimson" && wood !== "warped"
  )
);

/** Semantic requirements for the registry owner; this module allocates no IDs. */
export const BOAT_ITEM_REQUIREMENTS = Object.freeze(
  BOAT_WOODS.map((wood) =>
    Object.freeze({
      key: `${wood.toUpperCase()}_${wood === "bamboo" ? "RAFT" : "BOAT"}`,
      name: `${wood.replaceAll("_", " ")} ${wood === "bamboo" ? "raft" : "boat"}`,
      kind: "vehicle",
      vehicle: wood === "bamboo" ? "raft" : "boat",
      wood,
      stackSize: 1,
      art: Object.freeze({
        kind: wood === "bamboo" ? "raft" : "boat",
        variant: wood,
      }),
      recipe: Object.freeze({
        station: "table",
        pattern: Object.freeze(["# #", "###"]),
        ingredient: wood === "oak" ? "PLANKS" : `${wood.toUpperCase()}_PLANKS`,
        count: 1,
      }),
    })
  )
);

export function boatWoodForItem(id) {
  const item = getItem(id);
  if (
    !item ||
    !BOAT_WOODS.includes(item.wood) ||
    item.vehicle !== (item.wood === "bamboo" ? "raft" : "boat") ||
    item.stackSize !== 1 ||
    item.durability !== undefined
  )
    return null;
  return item.wood;
}

export const validPassengerId = (id) =>
  typeof id === "string" && /^[a-zA-Z0-9_.:-]{1,64}$/.test(id);

export const boatHeading = (yaw) => Math.atan2(Math.sin(yaw), Math.cos(yaw));

/** Forward is local -Z, matching Player's physical aim convention. */
export function boatSeat(boat, slot = 0) {
  const forward = slot === 0 ? 0.27 : -0.27;
  return {
    x: boat.x - Math.sin(boat.yaw) * forward,
    y: boat.y + BOAT_SEAT_HEIGHT,
    z: boat.z - Math.cos(boat.yaw) * forward,
    dimension: boat.dimension,
  };
}

/** Mouse yaw is deliberately absent: A/D steer the hull, W/S supply thrust. */
export function boatInput(keys, out = {}) {
  const down = (key) => keys?.has?.(key) === true;
  out.forward = Number(down("KeyW")) - Number(down("KeyS"));
  out.turn = Number(down("KeyA")) - Number(down("KeyD"));
  out.dismount = down("ShiftLeft") || down("ShiftRight");
  return out;
}
