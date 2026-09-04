import { overlaps } from "./aabb.js";
import { bodyBox } from "./collision.js";
import { horseBounds } from "./horse-collision.js";

/**
 * Fail closed until all live physical owners are installed.
 * Never serialize owners or read their private stores on the frame path.
 */
export function gameGravityOccupied(game, bounds) {
  const player = game?.player;
  const wildlife = game?.wildlife;
  const boats = game?.boats;
  if (!player || player.world !== game.world || !player.position ||
      !Number.isFinite(player.height) || !wildlife || wildlife.disposed ||
      wildlife.world !== game.world || wildlife.dimension !== game.world.dimension ||
      !Array.isArray(wildlife.entities) || !game.vehicleServices?.active ||
      typeof boats?.intersectsBounds !== "function") return true;
  if (overlaps(bounds, bodyBox(player.position, 0.3, player.height))) return true;
  if (boats.intersectsBounds(bounds) !== false) return true;
  for (const mob of wildlife.entities) {
    if (mob.dead) continue;
    // No crushing is consistent across passive, hostile and aquatic species.
    // Dormant residents still own a body at their saved position.
    if (!mob.position ||
        ![mob.position.x, mob.position.y, mob.position.z].every(Number.isFinite))
      return true;
    if (mob.kind !== "horse" &&
        (!Number.isFinite(mob.spec?.radius) || !Number.isFinite(mob.spec?.height)))
      return true;
    const occupied = mob.kind === "horse"
      ? horseBounds(mob.position, true)
      : bodyBox(mob.position, mob.spec.radius, mob.spec.height);
    if (overlaps(bounds, occupied)) return true;
  }
  return false;
}
