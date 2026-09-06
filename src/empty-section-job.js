import { captureMeshRevision, meshRevisionCurrent } from "./mesh-snapshot.js";
import { opaqueCube } from "./mesh-palette.js";
import { BLOCKS } from "./blocks.js";

const summaries = new WeakMap();

/** Revision-keyed proof of no renderable cells, not visibility/underground
 * culling. Unknown storage or any fluid metadata takes the full mesher path.
 */
export function emptySectionJob(world, cx, cz, sy, limits) {
  const chunk = world.chunks.get(`${cx},${cz}`);
  if (!chunk?.blocks || !Number.isInteger(chunk.minY)) return null;
  const start = (sy * 16 - chunk.minY) * 256;
  if (start < 0 || start + 4096 > chunk.blocks.length) return null;
  let cache = summaries.get(chunk);
  if (!cache) summaries.set(chunk, cache = new Map());
  const revision = chunk.sectionRevisions?.get(sy) ?? chunk.revision;
  let entry = cache.get(sy);
  if (!entry || entry.revision !== revision || entry.incarnation !== chunk.incarnation) {
    let empty = true, solid = true;
    for (let i = start; i < start + 4096; i++) {
      const id = chunk.blocks[i];
      empty &&= id === 0;
      solid &&= !!opaqueCube[id] && !BLOCKS[id]?.emissive;
      if (!empty && !solid) break;
    }
    const extra = chunk.sections?.get(sy);
    if (extra?.fluids?.some((value) => value !== 0) || extra?.states?.some((value) => value !== 0))
      empty = solid = false;
    entry = { revision, incarnation: chunk.incarnation, empty, solid };
    cache.set(sy, entry);
  }
  if (!entry.empty && !(entry.solid && solidBoundary(world, chunk, cx, cz, start))) return null;
  return new EmptySectionJob(world, captureMeshRevision(world, cx, cz, sy), limits);
}

function solidBoundary(world, chunk, cx, cz, start) {
  const blocks = chunk.blocks;
  if (start < 256 || start + 4096 + 256 > blocks.length) return false;
  for (let i = 0; i < 256; i++)
    if (!opaqueCube[blocks[start - 256 + i]] || !opaqueCube[blocks[start + 4096 + i]]) return false;
  const neighbors = [[cx - 1, cz], [cx + 1, cz], [cx, cz - 1], [cx, cz + 1]]
    .map(([x, z]) => world.chunks.get(`${x},${z}`));
  if (neighbors.some((n) => !n?.blocks || n.minY !== chunk.minY)) return false;
  for (let y = 0; y < 16; y++)
    for (let i = 0; i < 16; i++) {
      const at = start + y * 256;
      if (!opaqueCube[neighbors[0].blocks[at + i * 16 + 15]] ||
          !opaqueCube[neighbors[1].blocks[at + i * 16]] ||
          !opaqueCube[neighbors[2].blocks[at + 240 + i]] ||
          !opaqueCube[neighbors[3].blocks[at + i]]) return false;
    }
  return true;
}

class EmptySectionJob {
  constructor(world, stamp, limits) {
    Object.assign(this, { world, stamp, limits, status: "ready", result: { parts: [] },
      bytes: 0, draws: 0, snapshotBytes: 0, lastSlice: { cells: 0, ms: 0 } });
  }
  get done() { return true; }
  current() { return meshRevisionCurrent(this.world, this.stamp); }
  takeResult() {
    if (this.status !== "ready" || !this.current()) {
      this.status = "stale"; this.result = null; return null;
    }
    const result = this.result;
    this.result = null;
    this.status = "published";
    return result;
  }
  acknowledge() {
    if (this.status !== "published" || !this.current()) return false;
    const { cx, cz, sy, ticket } = this.stamp;
    return ticket === undefined || this.world.acknowledgeSectionMesh(cx, cz, sy, ticket);
  }
  dispose() {
    this.result = null;
    if (this.status !== "published") this.status = "disposed";
  }
}
