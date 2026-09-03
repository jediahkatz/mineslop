import { BLOCK, BLOCKS } from "./blocks.js";
import {
  cellAfterBreaking,
  FLUID,
  isSourceWater,
  isValidCell,
  normalizeCell,
} from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { readGeometryCell, SOLID_CELL } from "./geometry-world.js";
import { raycast } from "./raycast.js";
import { WATER_LEVEL, WORLD_HEIGHT } from "./terrain.js";

const historicalBounds = Object.freeze({
  minY: 0,
  maxY: WORLD_HEIGHT,
  seaLevel: WATER_LEVEL,
});
const boundsFor = (world) => world.spec ?? historicalBounds;
const validNormal = (normal) =>
  normal &&
  [normal.x, normal.y, normal.z].every(Number.isInteger) &&
  Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z) === 1;

/** Standard 4×5 frame; all six cells and supporting reads prepare together. */
export function prepareIgnitePortal(world, hit) {
  if (
    !hit ||
    ![hit.x, hit.y, hit.z].every(Number.isSafeInteger) ||
    typeof world.prepareMutation !== "function"
  )
    return null;
  const { minY, maxY } = boundsFor(world);
  for (const axis of ["x", "z"]) {
    for (let offset = 0; offset < 4; offset++) {
      for (let bottom = hit.y - 4; bottom <= hit.y; bottom++) {
        if (bottom <= minY || bottom + 4 >= maxY) continue;
        const origin = { x: hit.x, z: hit.z };
        origin[axis] -= offset;
        const changes = [];
        const reads = [];
        let valid = true;
        for (let width = 0; width < 4 && valid; width++) {
          for (let height = 0; height < 5; height++) {
            const x = origin.x + (axis === "x" ? width : 0);
            const z = origin.z + (axis === "z" ? width : 0);
            const y = bottom + height;
            const before = world.getCell(x, y, z);
            if (!before) {
              valid = false;
              break;
            }
            reads.push({ x, y, z, before });
            const boundary =
              width === 0 || width === 3 || height === 0 || height === 4;
            const corner =
              (width === 0 || width === 3) && (height === 0 || height === 4);
            const id = before.id;
            if (boundary && !corner && id !== BLOCK.OBSIDIAN) {
              valid = false;
              break;
            }
            if (!boundary) {
              // Clear plants through harvesting first, including tracked crops.
              if (id !== BLOCK.AIR && id !== BLOCK.NETHER_PORTAL) {
                valid = false;
                break;
              }
              changes.push({
                x,
                y,
                z,
                before,
                after: normalizeCell({ id: BLOCK.NETHER_PORTAL }),
              });
            }
          }
        }
        if (valid && changes.length === 6)
          return world.prepareMutation(changes, { reads });
      }
    }
  }
  return null;
}

/** Single-owner adapter. Item use composes prepareIgnitePortal with hand wear. */
export function ignitePortal(world, hit) {
  const participant = prepareIgnitePortal(world, hit);
  return participant !== null && world.coordinator.commit([participant]).ok;
}

export function createReturnPortal(world, position, endPortal = false) {
  const { minY, maxY } = boundsFor(world);
  const x = Math.floor(position.x) + 2;
  const z = Math.floor(position.z);
  const y = Math.min(maxY - 6, Math.max(minY + 1, Math.floor(position.y) - 1));
  if (endPortal) {
    for (let dx = 0; dx < 3; dx++)
      for (let dz = 0; dz < 3; dz++) {
        world.set(x + dx, y, z + dz, BLOCK.OBSIDIAN);
        world.set(x + dx, y + 1, z + dz, BLOCK.END_PORTAL);
        world.set(x + dx, y + 2, z + dz, 0);
      }
  } else {
    for (let dx = 0; dx < 4; dx++)
      for (let dy = 0; dy < 5; dy++) {
        world.set(
          x + dx,
          y + dy,
          z,
          dx === 0 || dx === 3 || dy === 0 || dy === 4
            ? BLOCK.OBSIDIAN
            : BLOCK.NETHER_PORTAL
        );
      }
    for (let dx = -1; dx <= 2; dx++) {
      world.set(x + dx, y, z - 1, BLOCK.OBSIDIAN);
      world.set(x + dx, y + 1, z - 1, 0);
      world.set(x + dx, y + 2, z - 1, 0);
    }
  }
}

/** Bounded, read-only blast candidates; Game commits each logical block with loot. */
export function explosionTargets(world, position, radius = 3) {
  if (
    !position ||
    ![position.x, position.y, position.z, radius].every(Number.isFinite) ||
    ![position.x, position.y, position.z].every(
      (value) => Math.abs(value) <= Number.MAX_SAFE_INTEGER - 8
    )
  )
    return [];
  const { minY, maxY } = boundsFor(world);
  const targets = [];
  const r = Math.min(6, Math.max(1, radius));
  for (let x = Math.floor(position.x - r); x <= position.x + r; x++) {
    for (let z = Math.floor(position.z - r); z <= position.z + r; z++) {
      if (!world.isLoaded(x, z)) continue;
      for (
        let y = Math.max(minY, Math.floor(position.y - r));
        y <= Math.min(maxY - 1, position.y + r);
        y++
      ) {
        if (
          Math.hypot(
            x + 0.5 - position.x,
            y + 0.5 - position.y,
            z + 0.5 - position.z
          ) > r
        )
          continue;
        const cell = readGeometryCell(world, x, y, z);
        const id = cell?.id;
        if (
          !cell ||
          BLOCKS[id]?.blastProof ||
          [
            BLOCK.AIR,
            BLOCK.BEDROCK,
            BLOCK.OBSIDIAN,
            BLOCK.WATER,
            BLOCK.LAVA,
            BLOCK.NETHER_PORTAL,
            BLOCK.END_PORTAL,
          ].includes(id)
        )
          continue;
        targets.push({ x, y, z, id, state: cell.state, fluid: cell.fluid });
      }
    }
  }
  return targets;
}

/** Terrain-only compatibility helper; owned stations must use Game's break plan. */
export function explodeBlocks(world, position, radius = 3) {
  if (typeof world.prepareMutation !== "function") return [];
  return explosionTargets(world, position, radius).filter((hit) => {
    if (
      [BLOCK.CHEST, BLOCK.FURNACE, BLOCK.WHEAT_CROP, BLOCK.TALL_GRASS].includes(
        hit.id
      )
    )
      return false;
    const before = world.getCell(hit.x, hit.y, hit.z);
    const participant = world.prepareMutation([
      {
        x: hit.x,
        y: hit.y,
        z: hit.z,
        before,
        after: cellAfterBreaking(before),
      },
    ]);
    return participant !== null && world.coordinator.commit([participant]).ok;
  });
}

export function findWaterSource(world, origin, direction, reach = 5) {
  const reads = new Map();
  const query = {
    spec: boundsFor(world),
    isLoaded: () => true,
    getCell(x, y, z) {
      const before = readGeometryCell(world, x, y, z);
      reads.set(`${x},${y},${z}`, { x, y, z, before });
      // An unavailable cell is an occluder, never permission to reach through it.
      return before ?? SOLID_CELL;
    },
  };
  const hit = raycast(query, origin, direction, Math.min(reach, 6), {
    channel: "bucket",
    resolve(cell, neighborhood) {
      const shape = resolveShape(cell, neighborhood);
      return {
        bucket: isSourceWater(cell.fluid)
          ? [...shape.fluidVolume, ...shape.selection]
          : shape.collision,
      };
    },
  });
  if (!hit || !isSourceWater(hit.fluid)) return null;
  const cell = readGeometryCell(world, hit.x, hit.y, hit.z);
  return cell && isSourceWater(cell.fluid)
    ? { x: hit.x, y: hit.y, z: hit.z, cell, reads: [...reads.values()] }
    : null;
}

/** Aquatic-only plants cannot become invalid dry cells or disappear for free. */
export function drainedSourceCell(cell) {
  if (!cell || !isSourceWater(cell.fluid)) return null;
  const after =
    cell.id === BLOCK.WATER
      ? normalizeCell({ id: BLOCK.AIR })
      : { ...cell, fluid: FLUID.NONE };
  return isValidCell(after) ? after : null;
}

/** Exact loaded source/target reads for pouring, including dry waterlogged hosts. */
export function bucketPourChange(world, hit) {
  if (!validNormal(hit?.normal)) return null;
  const target = readGeometryCell(world, hit.x, hit.y, hit.z);
  if (
    !target ||
    target.id !== hit.id ||
    (hit.state !== undefined && target.state !== hit.state) ||
    (hit.fluid !== undefined && target.fluid !== hit.fluid)
  )
    return null;
  const canFill = (cell) =>
    cell?.fluid === FLUID.NONE &&
    BLOCKS[cell.id]?.waterloggable === true &&
    isValidCell({ ...cell, fluid: FLUID.WATER_SOURCE });
  const onHost = canFill(target);
  const x = hit.x + (onHost ? 0 : hit.normal.x);
  const y = hit.y + (onHost ? 0 : hit.normal.y);
  const z = hit.z + (onHost ? 0 : hit.normal.z);
  const before = readGeometryCell(world, x, y, z);
  if (!before) return null;
  const after = canFill(before)
    ? { ...before, fluid: FLUID.WATER_SOURCE }
    : before.id === BLOCK.LAVA
      ? normalizeCell({ id: BLOCK.OBSIDIAN })
      : before.id === BLOCK.AIR ||
          (before.id === BLOCK.WATER && !isSourceWater(before.fluid))
        ? normalizeCell({ id: BLOCK.WATER })
        : null;
  return after
    ? {
        changes: [{ x, y, z, before, after }],
        reads: [
          { x: hit.x, y: hit.y, z: hit.z, before: target },
          { x, y, z, before },
        ],
      }
    : null;
}

function clearBody(world, x, y, z) {
  return (
    world.isLoaded(x, z) &&
    !world.isSolid(x, y, z) &&
    !world.isSolid(x, y + 1, z) &&
    ![BLOCK.WATER, BLOCK.LAVA].includes(world.get(x, y, z))
  );
}

/**
 * Bounded coarse search; rejected candidates do not end it or change its order.
 * Validation is opt-in for legacy callers. Set allowPlatform=false for read-only use.
 */
export function findSafeLanding(
  world,
  destination,
  {
    allowFlying = false,
    preferUnderground = false,
    allowPlatform = true,
    validateLanding = () => true,
  } = {}
) {
  const { minY, maxY, seaLevel } = boundsFor(world);
  const baseX = Math.floor(destination.x);
  const baseZ = Math.floor(destination.z);
  const wantedY = Math.floor(destination.y);
  const cave =
    preferUnderground && Number.isFinite(wantedY)
      ? world.getBiome?.(baseX, baseZ, wantedY)
      : null;
  if (cave?.category === "cave") {
    // If a saved floor was obstructed or reshaped, keep the player in their
    // cave instead of selecting the highest tree canopy above it.
    const heights = Array.from(
      { length: maxY - minY - 2 },
      (_, index) => minY + index + 1
    ).sort((a, b) => Math.abs(a - wantedY) - Math.abs(b - wantedY) || b - a);
    for (let distance = 0; distance <= 12; distance++)
      for (let dz = -distance; dz <= distance; dz++)
        for (let dx = -distance; dx <= distance; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== distance) continue;
          const x = baseX + dx,
            z = baseZ + dz;
          if (!world.isLoaded(x, z)) continue;
          for (const y of heights)
            if (
              world.isSolid(x, y - 1, z) &&
              clearBody(world, x, y, z) &&
              world.getBiome(x, z, y)?.id === cave.id
            ) {
              const landing = { x: x + 0.5, y: y + 0.01, z: z + 0.5 };
              if (validateLanding(landing)) return landing;
            }
        }
  }
  if (
    allowFlying &&
    seaLevel !== null &&
    world.get(baseX, seaLevel, baseZ) === BLOCK.WATER
  ) {
    const landing = {
      x: baseX + 0.5,
      y: seaLevel + 4,
      z: baseZ + 0.5,
      flying: true,
    };
    if (validateLanding(landing)) return landing;
  }
  if (
    Number.isFinite(wantedY) &&
    clearBody(world, baseX, wantedY, baseZ) &&
    world.isSolid(baseX, wantedY - 1, baseZ)
  ) {
    const landing = { x: baseX + 0.5, y: wantedY + 0.01, z: baseZ + 0.5 };
    if (validateLanding(landing)) return landing;
  }
  for (let distance = 0; distance <= 12; distance++) {
    for (let dz = -distance; dz <= distance; dz++) {
      for (let dx = -distance; dx <= distance; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== distance) continue;
        const x = baseX + dx,
          z = baseZ + dz;
        if (!world.isLoaded(x, z)) continue;
        for (let y = maxY - 1; y >= minY; y--) {
          if (world.isSolid(x, y, z) && clearBody(world, x, y + 1, z)) {
            const landing = { x: x + 0.5, y: y + 1.01, z: z + 0.5 };
            if (validateLanding(landing)) return landing;
          }
        }
      }
    }
  }
  if (allowFlying) {
    const landing = {
      x: baseX + 0.5,
      y: Math.max((seaLevel ?? minY + 24) + 5, wantedY || minY + 40),
      z: baseZ + 0.5,
      flying: true,
    };
    if (validateLanding(landing)) return landing;
  }
  if (!allowPlatform) return null;
  // A tiny arrival platform prevents portal travel from depositing a survivor in lava/the void.
  const y = Math.max(
    (seaLevel ?? minY) + 4,
    Math.min(maxY - 4, wantedY || minY + 40)
  );
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      world.set(
        baseX + dx,
        y - 1,
        baseZ + dz,
        world.dimension === "end" ? BLOCK.END_STONE : BLOCK.OBSIDIAN
      );
      world.set(baseX + dx, y, baseZ + dz, 0);
      world.set(baseX + dx, y + 1, baseZ + dz, 0);
    }
  }
  const landing = { x: baseX + 0.5, y: y + 0.01, z: baseZ + 0.5 };
  return validateLanding(landing) ? landing : null;
}
