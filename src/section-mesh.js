import { MeshBudgetError } from "./mesh-geometry.js";
import {
  createPartitionedMeshData,
  disposeMeshPartitions,
  MESH_PART_LIMITS,
} from "./mesh-partitions.js";
import {
  captureMeshRevision,
  meshRevisionCurrent,
  snapshotSection,
} from "./mesh-snapshot.js";
import { createRangeMesher } from "./resolved-mesh.js";

export const SECTION_MESH_LIMITS = Object.freeze({
  ...MESH_PART_LIMITS,
  maxCellsPerSlice: 512,
  maxSliceMs: 4,
});

/** One immutable section/apron and dirty ticket. The result is { parts }, an
 * ordered array of material-batch maps, transferred only when every part is ready.
 * maxVertices/maxBytes bound each part, not the complete section.
 */
export class SectionMeshJob {
  constructor(world, cx, cz, sy, atlas, limits = {}) {
    if (!world.chunks?.has(`${cx},${cz}`))
      throw new RangeError("Cannot mesh an unloaded column");
    this.world = world;
    this.stamp = captureMeshRevision(world, cx, cz, sy);
    this.limits = { ...SECTION_MESH_LIMITS, ...limits };
    this.snapshot = snapshotSection(world, cx, cz, sy);
    this.snapshotBytes = this.snapshot.bytes;
    this.lightingBytes = this.snapshot.lighting?.bytes ?? 0;
    this.mesher = createRangeMesher(
      this.snapshot,
      atlas,
      world,
      createPartitionedMeshData(this.limits)
    );
    this.status = "pending";
    this.result = null;
    this.bytes = 0;
    this.draws = 0;
    this.lastSlice = { cells: 0, ms: 0 };
  }

  current() {
    return meshRevisionCurrent(this.world, this.stamp);
  }
  get done() {
    return this.status !== "pending";
  }

  step({
    budgetMs = 2,
    maxCells = this.limits.maxCellsPerSlice,
    flush = false,
  } = {}) {
    if (this.status !== "pending") return this.status;
    if (!this.current()) {
      this.status = "stale";
      this.releaseCpu();
      return this.status;
    }
    const budget = flush
      ? Infinity
      : Math.max(0, Math.min(this.limits.maxSliceMs, budgetMs));
    const limit = flush
      ? Infinity
      : Math.max(
          0,
          Math.min(this.limits.maxCellsPerSlice, Math.floor(maxCells))
        );
    const started = performance.now();
    const mesher = this.mesher;
    const context = mesher.context;
    const before = mesher.cursor;
    try {
      while (
        !mesher.done &&
        mesher.cursor - before < limit &&
        performance.now() - started < budget
      ) {
        mesher.stepCells(Math.min(32, limit - (mesher.cursor - before)));
      }
      if (!this.current()) {
        this.status = "stale";
      } else if (mesher.done) {
        this.result = context.finish();
        this.status = this.current() ? "ready" : "stale";
      }
    } catch (error) {
      if (!(error instanceof MeshBudgetError)) {
        this.dispose();
        throw error;
      }
      this.status = "budget";
    } finally {
      this.lastSlice = {
        cells: mesher.cursor - before,
        ms: performance.now() - started,
      };
      this.bytes = context.bytes + context.partBytes;
      this.draws = context.draws + context.partDraws;
    }
    if (this.done) {
      if (this.status !== "ready") {
        disposeMeshPartitions(this.result);
        this.result = null;
      }
      this.releaseCpu();
    }
    return this.status;
  }

  releaseCpu() {
    this.mesher?.context.dispose();
    this.snapshot = null;
    this.mesher = null;
    this.snapshotBytes = 0;
  }

  /** Ownership transfers only after a final stale check. Caller must install
   * successfully before acknowledge(); failed admission leaves the dirty ticket.
   */
  takeResult() {
    if (this.status !== "ready") return null;
    if (!this.current()) {
      disposeMeshPartitions(this.result);
      this.result = null;
      this.status = "stale";
      return null;
    }
    const result = this.result;
    this.result = null;
    this.status = "published";
    return result;
  }

  acknowledge() {
    if (this.status !== "published" || !this.current()) return false;
    const { cx, cz, sy, ticket } = this.stamp;
    if (ticket === undefined) return true;
    return this.world.acknowledgeSectionMesh(cx, cz, sy, ticket);
  }

  dispose() {
    disposeMeshPartitions(this.result);
    this.result = null;
    this.releaseCpu();
    if (this.status !== "published") this.status = "disposed";
  }
}

export function createSectionMeshJob(world, cx, cz, sy, atlas, limits) {
  return new SectionMeshJob(world, cx, cz, sy, atlas, limits);
}
