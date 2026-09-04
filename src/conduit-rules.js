import { BLOCK } from "./blocks.js";
import { isWaterFluid } from "./block-state.js";

export const CONDUIT_FRAME = Object.freeze(
  Array.from({ length: 125 }, (_, i) => [
    i % 5 - 2, Math.floor(i / 25) - 2, Math.floor(i / 5) % 5 - 2,
  ]).filter((p) => Math.max(...p.map(Math.abs)) === 2 && p.includes(0))
    .map(Object.freeze),
);
export const CONDUIT_WATER = Object.freeze(
  Array.from({ length: 27 }, (_, i) => [
    i % 3 - 1, Math.floor(i / 9) - 1, Math.floor(i / 3) % 3 - 1,
  ]).map(Object.freeze),
);
const frameBlocks = new Set([
  BLOCK.PRISMARINE, BLOCK.PRISMARINE_BRICKS, BLOCK.DARK_PRISMARINE, BLOCK.SEA_LANTERN,
]);

export function conduitRadius(count) {
  return Number.isInteger(count) && count >= 16 && count <= 42
    ? Math.floor(count / 7) * 16 : 0;
}

/** readCell MUST be a resident-only, nullable read. Unknown fails closed. */
export function inspectConduit(position, readCell) {
  const { x, y, z } = position;
  if (![x, y, z].every(Number.isSafeInteger) ||
      readCell(x, y, z)?.id !== BLOCK.CONDUIT) return null;
  if (!CONDUIT_WATER.every(([dx, dy, dz]) =>
    isWaterFluid(readCell(x + dx, y + dy, z + dz)?.fluid))) return null;
  let count = 0;
  for (const [dx, dy, dz] of CONDUIT_FRAME) {
    const cell = readCell(x + dx, y + dy, z + dz);
    if (!cell) return null;
    if (frameBlocks.has(cell.id)) count++;
  }
  const radius = conduitRadius(count);
  return radius ? Object.freeze({
    position: Object.freeze({ x, y, z }),
    center: Object.freeze({ x: x + 0.5, y: y + 0.5, z: z + 0.5 }),
    count, radius, attacks: count === 42,
  }) : null;
}

export function inConduitRange(center, point, radius) {
  return !!point && [point.x, point.y, point.z].every(Number.isFinite) &&
    (point.x - center.x) ** 2 + (point.y - center.y) ** 2 +
      (point.z - center.z) ** 2 <= radius ** 2;
}
