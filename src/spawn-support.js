import { overlaps } from "./aabb.js";
import { BLOCK } from "./blocks.js";
import {
  bodyBox,
  boxCollides,
  supportContacts,
  visitWorldBoxes,
} from "./collision.js";
import { columnLoaded, geometryWorldSpec } from "./geometry-world.js";

/** World.getSpawn's geometry-only delegate. x/z are integer cell coordinates;
 * return feet height (+ the historical .01 clearance), or null. No generation.
 */
export function spawnStandingHeight(
  world,
  x,
  z,
  preferredY,
  { nearest = world.dimension === "nether", radius = 0.3, height = 1.8 } = {}
) {
  if (!columnLoaded(world, x, z)) return null;
  const spec = geometryWorldSpec(world);
  const center = { x: x + 0.5, y: spec.maxY + 1.5, z: z + 0.5 };
  const contacts = supportContacts(world, center, {
    radius,
    maxDrop: spec.maxY - spec.minY + 1.5,
    filter: ({ cell }) =>
      cell.id !== BLOCK.CACTUS && cell.id !== BLOCK.MAGMA_BLOCK,
  });
  const candidates = [
    ...new Set(contacts.map((contact) => contact.height + 0.01)),
  ];
  candidates.sort(
    nearest && Number.isFinite(preferredY)
      ? (a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY)
      : (a, b) => b - a
  );
  for (const feet of candidates) {
    const bounds = bodyBox({ ...center, y: feet }, radius, height);
    if (boxCollides(world, bounds)) continue;
    let wet = false;
    visitWorldBoxes(
      world,
      bounds,
      "fluidVolume",
      ({ box }) => {
        if (overlaps(bounds, box)) wet = true;
      },
      { unloaded: "empty", borders: false }
    );
    if (!wet) return feet;
  }
  return null;
}
