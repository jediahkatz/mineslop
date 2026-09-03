import { bodyBox, boxCollides } from "./collision.js";
import { matchesEntityContext } from "./entity-context.js";
import { columnLoaded, validBodyPosition } from "./geometry-world.js";
import {
  finitePosition,
  hasLineOfSight,
  rayBoxDistance,
} from "./mob-navigation.js";
import { MAX_MOBS, MOB_SPECIES } from "./mob-species.js";
import { raycast } from "./raycast.js";

const MAX_MELEE_REACH = 5;
const liveEntity = (wildlife, entity) =>
  !!entity &&
  !entity.dead &&
  !entity.dormant &&
  wildlife.byId?.get(entity.id) === entity;

/**
 * Melee only: merge precise model hits with the Enderman's continuous physical
 * body. Keep Wildlife.raycast/isLookingAt unchanged for bows, use and staring.
 *
 * eye/direction must be the physical player's aim, never the F5 render camera.
 * Optional hits must come from this same world/eye/direction, synchronously.
 * undefined computes a query; null explicitly reuses a query that found nothing.
 * Game supplies its existing block hit (including the longer Survival block
 * reach) and raw precise mob hit, so neither query needs to run twice.
 */
export function raycastMelee(
  wildlife,
  world,
  eye,
  direction,
  reach,
  { preciseHit, blockHit } = {}
) {
  if (
    !wildlife ||
    !world ||
    wildlife.disposed ||
    wildlife.world !== world ||
    wildlife.dimension !== (world.dimension ?? "overworld") ||
    !matchesEntityContext(world, wildlife.worldContext) ||
    !Array.isArray(wildlife.entities) ||
    wildlife.entities.length > MAX_MOBS ||
    !finitePosition(eye) ||
    !finitePosition(direction) ||
    !Number.isFinite(reach) ||
    reach < 0 ||
    reach > MAX_MELEE_REACH ||
    !validBodyPosition(eye, world, { height: 0 })
  )
    return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < 1e-9) return null;
  if (!columnLoaded(world, Math.floor(eye.x), Math.floor(eye.z))) return null;
  const aim = {
    x: direction.x / length,
    y: direction.y / length,
    z: direction.z / length,
  };
  const block =
    blockHit === undefined ? raycast(world, eye, aim, reach) : blockHit;
  if (block && (!Number.isFinite(block.distance) || block.distance < 0))
    return null;
  const blockDistance = block?.distance ?? Infinity;
  const precise =
    preciseHit === undefined ? wildlife.raycast?.(eye, aim, reach) : preciseHit;
  const visible = (distance) => {
    const point = {
      x: eye.x + aim.x * distance,
      y: eye.y + aim.y * distance,
      z: eye.z + aim.z * distance,
    };
    return (
      columnLoaded(world, Math.floor(point.x), Math.floor(point.z)) &&
      (distance !== 0 || !boxCollides(world, bodyBox(eye, 0, 0))) &&
      hasLineOfSight(world, eye, point)
    );
  };
  // These are the same axis-aligned radius/height used by mob movement, not
  // pickRadius, animated limb bounds or a reach-increasing broad-phase box.
  const { radius, height } = MOB_SPECIES.enderman;
  const loadedBody = (entity) => {
    if (!validBodyPosition(entity.position, world, { radius, height }))
      return false;
    const { x, z } = entity.position;
    // Exact half-open body coverage, including tiny unloaded edge slivers.
    // The canonical collider is <1 block wide: at most four column checks.
    for (let bx = Math.floor(x - radius); bx < Math.ceil(x + radius); bx++)
      for (let bz = Math.floor(z - radius); bz < Math.ceil(z + radius); bz++)
        if (!columnLoaded(world, bx, bz)) return false;
    return true;
  };
  let nearest =
    liveEntity(wildlife, precise?.entity) &&
    Number.isFinite(precise.distance) &&
    precise.distance >= 0 &&
    precise.distance <= reach &&
    precise.distance < blockDistance &&
    (precise.entity.kind !== "enderman" || loadedBody(precise.entity)) &&
    visible(precise.distance)
      ? precise
      : null;

  for (const entity of wildlife.entities) {
    if (
      entity?.kind !== "enderman" ||
      !liveEntity(wildlife, entity) ||
      !finitePosition(entity.position)
    )
      continue;
    const distance = rayBoxDistance(
      eye,
      aim,
      entity.position,
      radius,
      height,
      Math.min(reach, nearest?.distance ?? reach)
    );
    if (
      distance === null ||
      distance >= blockDistance ||
      (nearest && distance >= nearest.distance) ||
      !loadedBody(entity) ||
      !visible(distance)
    )
      continue;
    // Distance zero deliberately wins when the eye starts inside the body.
    // Equal-distance blocks win; equal-distance precise hits retain precedence.
    nearest = { entity, distance, name: entity.name };
  }
  return nearest;
}
