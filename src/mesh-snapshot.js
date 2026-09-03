import { defaultFluidFor } from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { readChunkCell } from "./chunk-data.js";
import {
  geometryEpoch,
  geometryWorldSpec,
  readGeometryCell,
} from "./geometry-world.js";
import { opaqueCube } from "./mesh-palette.js";
import { CHUNK_SIZE } from "./terrain.js";

export const SECTION_HEIGHT = 16;
// The second apron cell resolves a neighboring stair's corner/fence connection.
export const MESH_APRON = 2;
export const SNAPSHOT_WIDTH = CHUNK_SIZE + MESH_APRON * 2;
const LAYER = CHUNK_SIZE * CHUNK_SIZE;
const lightingCache = new WeakMap();

export function sectionYs(world) {
  const { minY, maxY } = geometryWorldSpec(world);
  return Array.from(
    { length: Math.ceil(maxY / 16) - Math.floor(minY / 16) },
    (_, i) => Math.floor(minY / 16) + i
  );
}

/** Shared column lighting inputs, never one full-column copy per section.
 * topOpaque is a conservative full-cube skylight ceiling. Partial shapes use
 * local AO/coverage instead; this cache does not change historical face light.
 */
export function getColumnLighting(world, cx, cz) {
  const chunk = world.chunks?.get(`${cx},${cz}`);
  if (!chunk?.blocks) return null;
  const previous = lightingCache.get(chunk);
  if (
    previous &&
    previous.revision === chunk.revision &&
    previous.incarnation === chunk.incarnation
  )
    return previous;
  const spec = geometryWorldSpec(world);
  const minY = chunk.minY ?? spec.minY;
  const maxY = chunk.maxY ?? spec.maxY;
  const topOpaque = new Int16Array(LAYER);
  topOpaque.fill(minY - 1);
  for (let column = 0; column < LAYER; column++) {
    for (let y = maxY - 1; y >= minY; y--) {
      if (opaqueCube[chunk.blocks[(y - minY) * LAYER + column]]) {
        topOpaque[column] = y;
        break;
      }
    }
  }
  const result = Object.freeze({
    incarnation: chunk.incarnation,
    revision: chunk.revision,
    topOpaque,
    biomes: chunk.biomes?.slice(),
    bytes: topOpaque.byteLength + (chunk.biomes?.byteLength ?? 0),
  });
  lightingCache.set(chunk, result);
  return result;
}

export function captureMeshRevision(world, cx, cz, sy) {
  const neighbors = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const key = `${cx + dx},${cz + dz}`;
      const chunk = world.chunks?.get(key);
      neighbors.push({
        key,
        chunk,
        incarnation: chunk?.incarnation,
        revision: chunk?.revision,
        sections: [sy - 1, sy, sy + 1].map((section) => [
          section,
          chunk?.sectionRevisions?.get(section) ?? 0,
        ]),
      });
    }
  }
  return Object.freeze({
    cx,
    cz,
    sy,
    epoch: geometryEpoch(world),
    dimension: world.dimension,
    generator: world.generator,
    ticket: world.dirtySectionRevisions?.get(`${cx},${cz},${sy}`),
    neighbors,
  });
}

export function meshRevisionCurrent(world, stamp) {
  if (
    geometryEpoch(world) !== stamp.epoch ||
    world.dimension !== stamp.dimension ||
    world.generator !== stamp.generator ||
    world.dirtySectionRevisions?.get(`${stamp.cx},${stamp.cz},${stamp.sy}`) !==
      stamp.ticket
  )
    return false;
  for (const sampled of stamp.neighbors) {
    const current = world.chunks?.get(sampled.key);
    if (
      current !== sampled.chunk ||
      current?.incarnation !== sampled.incarnation
    )
      return false;
    if (current?.sectionRevisions) {
      for (const [sy, revision] of sampled.sections)
        if ((current.sectionRevisions.get(sy) ?? 0) !== revision) return false;
    } else if (current?.revision !== sampled.revision) return false;
  }
  return true;
}

/** Copy only this vertical interval and its apron, preserving all 16 ID bits. */
export function snapshotMeshRange(world, cx, cz, bottom, top) {
  const spec = geometryWorldSpec(world);
  const minY = bottom - MESH_APRON;
  const maxY = top + MESH_APRON;
  const plane = SNAPSHOT_WIDTH * SNAPSHOT_WIDTH;
  const count = plane * (maxY - minY);
  const ids = new Uint16Array(count);
  const states = new Uint16Array(count);
  const fluids = new Uint8Array(count);
  const available = new Uint8Array(SNAPSHOT_WIDTH * SNAPSHOT_WIDTH);
  const originX = cx * CHUNK_SIZE;
  const originZ = cz * CHUNK_SIZE;
  const columns = new Map();
  if (world.chunks) {
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        columns.set(`${dx},${dz}`, world.chunks.get(`${cx + dx},${cz + dz}`));
  }
  const index = (x, y, z) =>
    (y - minY) * plane + (z + MESH_APRON) * SNAPSHOT_WIDTH + x + MESH_APRON;
  for (let z = -MESH_APRON; z < CHUNK_SIZE + MESH_APRON; z++) {
    for (let x = -MESH_APRON; x < CHUNK_SIZE + MESH_APRON; x++) {
      const column = (z + MESH_APRON) * SNAPSHOT_WIDTH + x + MESH_APRON;
      const dx = Math.floor(x / CHUNK_SIZE),
        dz = Math.floor(z / CHUNK_SIZE);
      const source = columns.get(`${dx},${dz}`);
      if (world.chunks && !source?.blocks) continue;
      available[column] = 1;
      const local = (z - dz * CHUNK_SIZE) * CHUNK_SIZE + x - dx * CHUNK_SIZE;
      for (
        let y = Math.max(minY, spec.minY);
        y < Math.min(maxY, spec.maxY);
        y++
      ) {
        const at = index(x, y, z);
        if (world.chunks) {
          const sourceAt = (y - (source.minY ?? spec.minY)) * LAYER + local;
          const id = source.blocks[sourceAt];
          ids[at] = id;
          const cell =
            source.sections instanceof Map
              ? readChunkCell(source, sourceAt)
              : null;
          // Use the world's resident-cell decoder; legacy minimal chunk
          // adapters can still supply non-generating scalar accessors.
          states[at] =
            cell?.state ??
            world.getBlockState?.(originX + x, y, originZ + z) ??
            0;
          fluids[at] =
            cell?.fluid ??
            world.getFluid?.(originX + x, y, originZ + z) ??
            defaultFluidFor(id);
        } else {
          const cell = readGeometryCell(world, originX + x, y, originZ + z);
          if (!cell) continue;
          ids[at] = cell.id;
          states[at] = cell.state ?? 0;
          fluids[at] = cell.fluid ?? defaultFluidFor(cell.id);
        }
      }
    }
  }
  const lighting = getColumnLighting(world, cx, cz);
  const shapes = new Map();
  const cellAt = (x, y, z) => {
    if (
      x < -MESH_APRON ||
      x >= CHUNK_SIZE + MESH_APRON ||
      z < -MESH_APRON ||
      z >= CHUNK_SIZE + MESH_APRON ||
      y < minY ||
      y >= maxY ||
      y < spec.minY ||
      y >= spec.maxY ||
      !available[(z + MESH_APRON) * SNAPSHOT_WIDTH + x + MESH_APRON]
    )
      return null;
    const at = index(x, y, z);
    return { id: ids[at], state: states[at], fluid: fluids[at] };
  };
  return {
    cx,
    cz,
    bottom,
    top,
    minY,
    maxY,
    ids,
    states,
    fluids,
    index,
    lighting,
    biomes:
      lighting?.biomes ?? world.chunks?.get(`${cx},${cz}`)?.biomes?.slice(),
    bytes:
      ids.byteLength +
      states.byteLength +
      fluids.byteLength +
      available.byteLength,
    cellAt,
    shapeAt(x, y, z) {
      const cell = cellAt(x, y, z);
      if (!cell) return null;
      const at = index(x, y, z);
      if (!shapes.has(at))
        shapes.set(
          at,
          resolveShape(cell, (dx, dy, dz) => cellAt(x + dx, y + dy, z + dz))
        );
      return shapes.get(at);
    },
  };
}

export function snapshotSection(world, cx, cz, sy) {
  const spec = geometryWorldSpec(world);
  if (
    !Number.isInteger(sy) ||
    sy * 16 >= spec.maxY ||
    (sy + 1) * 16 <= spec.minY
  )
    throw new RangeError("Section is outside this world's vertical spec");
  return snapshotMeshRange(
    world,
    cx,
    cz,
    Math.max(spec.minY, sy * 16),
    Math.min(spec.maxY, (sy + 1) * 16)
  );
}
