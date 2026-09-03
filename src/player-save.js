import {
  collidesWithWorld,
  MAX_LOOK_PITCH,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SNEAK_HEIGHT,
} from "./player.js";
import { validBodyPosition } from "./geometry-world.js";

/** Validate against the same body bounds as movement, including high flight. */
export function restorePlayerSave(
  player,
  world,
  saved,
  { fallbackPosition } = {}
) {
  if (!saved) return false;
  const { x, y, z, yaw, pitch } = saved;
  const validPosition = (position) =>
    validBodyPosition(position, world, {
      radius: PLAYER_WIDTH / 2,
      height: PLAYER_HEIGHT,
      floorInclusive: false,
      dimension: world.dimension ?? "overworld",
    });
  if (![x, y, z, yaw, pitch].every(Number.isFinite) || !validPosition(saved))
    return false;
  let position = { x, y, z };
  let usedFallback = false;
  let crouched =
    collidesWithWorld(world, position) &&
    !collidesWithWorld(world, position, SNEAK_HEIGHT);
  if (
    collidesWithWorld(world, position, crouched ? SNEAK_HEIGHT : PLAYER_HEIGHT)
  ) {
    if (
      !validPosition(fallbackPosition) ||
      collidesWithWorld(world, fallbackPosition)
    )
      return false;
    position = {
      x: fallbackPosition.x,
      y: fallbackPosition.y,
      z: fallbackPosition.z,
    };
    usedFallback = true;
    crouched = false;
  }
  player.sneaking = crouched;
  player.setPosition(position);
  player.yaw = yaw;
  player.pitch = Math.max(-MAX_LOOK_PITCH, Math.min(MAX_LOOK_PITCH, pitch));
  player.flying =
    saved.flying === true ||
    (usedFallback && fallbackPosition?.flying === true);
  return true;
}
