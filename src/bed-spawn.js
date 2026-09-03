import { overlaps } from "./aabb.js";
import { BLOCK } from "./blocks.js";
import {
  BuildingReads,
  linkedSupport,
  offsetPosition,
  readBuildingPair,
} from "./building-placement.js";
import { HORIZONTAL_DIRECTIONS } from "./block-shapes.js";
import {
  bodyBox,
  boxCollides,
  supportContacts,
  visitWorldBoxes,
} from "./collision.js";
import { geometryWorldSpec, inHorizontalBounds } from "./geometry-world.js";

const RADIUS = 0.3;
const HEIGHT = 1.8;
const HAZARDS = new Set([
  BLOCK.CACTUS,
  BLOCK.MAGMA_BLOCK,
  BLOCK.LAVA,
  BLOCK.NETHER_PORTAL,
  BLOCK.END_PORTAL,
]);
const safeSupport = ({ cell }) => cell && !HAZARDS.has(cell.id);
const finitePosition = (position) =>
  position && [position.x, position.y, position.z].every(Number.isFinite);

function wetOrHazardous(world, bounds) {
  let unsafe = false;
  for (const channel of ["fluidVolume", "selection"])
    visitWorldBoxes(
      world,
      bounds,
      channel,
      ({ box, cell }) => {
        if (
          (channel === "fluidVolume" || HAZARDS.has(cell?.id)) &&
          overlaps(bounds, box)
        )
          unsafe = true;
      },
      { unloaded: "empty", borders: false }
    );
  return unsafe;
}

/** Non-generating full-body check, shared by bed exits and the world-spawn fallback. */
export function isSafeRespawnPosition(world, position) {
  if (
    !finitePosition(position) ||
    !inHorizontalBounds(position.x - RADIUS, position.z - RADIUS) ||
    !inHorizontalBounds(position.x + RADIUS, position.z + RADIUS)
  )
    return false;
  const { minY, maxY } = geometryWorldSpec(world);
  if (position.y < minY || position.y > maxY + 1.51) return false;
  const bounds = bodyBox(position, RADIUS, HEIGHT);
  return (
    !boxCollides(world, bounds) &&
    supportContacts(world, position, {
      radius: RADIUS,
      maxDrop: 0.025,
      maxRise: 0,
      filter: safeSupport,
    }).length > 0 &&
    !wetOrHazardous(world, bounds)
  );
}

export function bedSleepClear(reads, pair) {
  return pair.cells.every(({ x, y, z }) => {
    const bounds = bodyBox(
      { x: x + 0.5, y: y + 9 / 16 + 0.01, z: z + 0.5 },
      0.45,
      0.64
    );
    return (
      !boxCollides(reads.view, bounds) && !wetOrHazardous(reads.view, bounds)
    );
  });
}

/** Ten neighboring columns, at most two blocks vertically; no terrain-wide search. */
function exitColumns(pair) {
  const forward = HORIZONTAL_DIRECTIONS[pair.facing];
  const right = HORIZONTAL_DIRECTIONS[(pair.facing + 1) & 3];
  const offsets = [
    right,
    right.map((v) => -v),
    forward,
    forward.map((v) => -v),
    [right[0] + forward[0], 0, right[2] + forward[2]],
    [-right[0] + forward[0], 0, -right[2] + forward[2]],
    [right[0] - forward[0], 0, right[2] - forward[2]],
    [-right[0] - forward[0], 0, -right[2] - forward[2]],
  ];
  const key = ({ x, z }) => `${x},${z}`;
  const seen = new Set([key(pair.root), key(pair.other)]);
  const result = [];
  for (const end of [pair.other, pair.root])
    for (const offset of offsets) {
      const at = offsetPosition(end, offset);
      if (seen.has(key(at))) continue;
      seen.add(key(at));
      result.push(at);
    }
  return result;
}

/**
 * The saved identity is the Overworld bed's foot, material and facing in this
 * seed/generator. Inspection never teleports the player, loads cells or writes
 * blocks. Missing halves, unavailable support and blocked exits return null.
 */
export function findBedRespawn(
  world,
  spawn,
  { reads = new BuildingReads(world) } = {}
) {
  if (
    !spawn ||
    spawn.dimension !== "overworld" ||
    world.dimension !== spawn.dimension ||
    world.seed !== spawn.seed ||
    world.generatorVersion !== spawn.generatorVersion
  )
    return null;
  const pair = readBuildingPair(reads, { ...spawn, state: spawn.facing });
  if (
    !pair ||
    pair.kind !== "bed" ||
    !pair.valid ||
    linkedSupport(reads, pair) !== true ||
    !bedSleepClear(reads, pair)
  )
    return null;
  for (const { x, z } of exitColumns(pair)) {
    const center = { x: x + 0.5, y: pair.root.y + 1.01, z: z + 0.5 };
    const contacts = supportContacts(reads.view, center, {
      radius: RADIUS,
      maxDrop: 2.05,
      maxRise: 0,
      filter: safeSupport,
    });
    const heights = [...new Set(contacts.map(({ height }) => height))].sort(
      (a, b) => Math.abs(a - pair.root.y) - Math.abs(b - pair.root.y) || a - b
    );
    for (const height of heights) {
      const position = { ...center, y: height + 0.01 };
      if (isSafeRespawnPosition(reads.view, position))
        return { ...position, dimension: world.dimension };
    }
  }
  return null;
}
