import { BIOMES } from "./biomes.js";
import { FLUID, isWaterFluid } from "./block-state.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { geometryWorldSpec } from "./geometry-world.js";
import {
  appendPlant,
  createMeshData,
  finishMeshData,
} from "./mesh-geometry.js";
import { getBiomeTint, MESH_EMITTER_LIMIT } from "./mesh-palette.js";
import {
  sectionYs,
  snapshotMeshRange,
  snapshotSection,
} from "./mesh-snapshot.js";
import { appendShape } from "./shape-mesh.js";
import { CHUNK_SIZE } from "./terrain.js";

function addEmitter(context, emitter) {
  if (context.emitters.length < MESH_EMITTER_LIMIT)
    context.emitters.push(emitter);
  else if (emitter.id === BLOCK.TORCH) {
    const at = context.emitters.findIndex(
      (source) => source.id !== BLOCK.TORCH
    );
    if (at !== -1) context.emitters[at] = emitter;
  }
}

export function createRangeMesher(
  snapshot,
  atlas,
  world,
  context = createMeshData()
) {
  const height = snapshot.top - snapshot.bottom;
  const total = height * CHUNK_SIZE * CHUNK_SIZE;
  const tintCache = new Map();
  const biomeCache = new Map();
  const tintFor = (id, face, biome) => {
    let colors = tintCache.get(biome);
    if (!colors) tintCache.set(biome, (colors = new Map()));
    const key = `${id}:${face}`;
    if (!colors.has(key)) colors.set(key, getBiomeTint(id, face, biome));
    return colors.get(key);
  };
  let cursor = 0;
  return {
    context,
    get done() {
      return cursor === total;
    },
    get cursor() {
      return cursor;
    },
    get total() {
      return total;
    },
    stepCells(maxCells) {
      const end = Math.min(total, cursor + maxCells);
      for (; cursor < end; cursor++) {
        // Keep the legacy z/x/y iteration order within each bounded interval.
        const y = snapshot.bottom + (cursor % height);
        const x = Math.floor(cursor / height) % CHUNK_SIZE;
        const z = Math.floor(cursor / (height * CHUNK_SIZE));
        const cell = snapshot.cellAt(x, y, z);
        if (!cell?.id || !BLOCKS[cell.id]) continue;
        const id = cell.id;
        const block = BLOCKS[id];
        const column = z * CHUNK_SIZE + x;
        if (!biomeCache.has(column))
          biomeCache.set(
            column,
            snapshot.biomes
              ? BIOMES[snapshot.biomes[column]]
              : world.getBiome?.(
                  snapshot.cx * CHUNK_SIZE + x,
                  snapshot.cz * CHUNK_SIZE + z
                )
          );
        const biome = biomeCache.get(column);
        if (
          block.emissive &&
          (id === BLOCK.TORCH ||
            id === BLOCK.GLOW_BERRIES ||
            (x % 8 === 0 &&
              z % 8 === 0 &&
              snapshot.cellAt(x, y + 1, z)?.id !== id))
        )
          addEmitter(context, {
            x: snapshot.cx * CHUNK_SIZE + x + 0.5,
            y: y + (id === BLOCK.GLOW_BERRIES ? 0.3 : 0.7),
            z: snapshot.cz * CHUNK_SIZE + z + 0.5,
            id,
          });
        const shape = snapshot.shapeAt(x, y, z);
        if (block.shape === "cross")
          appendPlant(context, x, y, z, id, atlas, tintFor(id, "side", biome));
        else
          appendShape(
            context,
            snapshot,
            x,
            y,
            z,
            id,
            shape,
            atlas,
            tintFor,
            id === BLOCK.WATER
              ? (world.getBiome?.(
                  snapshot.cx * CHUNK_SIZE + x,
                  snapshot.cz * CHUNK_SIZE + z,
                  y
                ) ?? biome)
              : biome
          );
        // The fluid plane is not encoded by replacing a waterlogged host ID.
        if (
          id !== BLOCK.WATER &&
          id !== BLOCK.LAVA &&
          shape.fluid !== FLUID.NONE
        )
          appendShape(
            context,
            snapshot,
            x,
            y,
            z,
            id,
            shape,
            atlas,
            tintFor,
            biome,
            {
              channel: "fluidVolume",
              materialId: isWaterFluid(shape.fluid) ? BLOCK.WATER : BLOCK.LAVA,
            }
          );
      }
      return this.done;
    },
  };
}

export function buildResolvedColumnGeometry(world, cx, cz, atlas) {
  const context = createMeshData();
  const spec = geometryWorldSpec(world);
  if (spec.maxY - spec.minY <= 96) {
    const snapshot = snapshotMeshRange(world, cx, cz, spec.minY, spec.maxY);
    createRangeMesher(snapshot, atlas, world, context).stepCells(Infinity);
  } else {
    // Release each section/apron before taking the next. This synchronous
    // compatibility entry point never retains 24 full-column snapshots.
    for (const sy of sectionYs(world)) {
      const snapshot = snapshotSection(world, cx, cz, sy);
      createRangeMesher(snapshot, atlas, world, context).stepCells(Infinity);
    }
  }
  return finishMeshData(context);
}
