import {
  createMeshData,
  finishMeshData,
  MAX_SECTION_VERTICES,
  MeshBudgetError,
} from "./mesh-geometry.js";
import { blockBatch, disposeBatches, selectEmitters } from "./mesh-palette.js";

export const MESH_PART_LIMITS = Object.freeze({
  maxVertices: MAX_SECTION_VERTICES,
  maxBytes: 8 * 1024 * 1024,
});

// Four unshared vertices and six indices per quad. Three promotes the entire
// batch's index buffer when an index reaches 65535 (primitive restart).
const quadBytes = (vertices) =>
  vertices * 11 * 4 + (vertices / 4) * 6 * (vertices > 65535 ? 4 : 2);

/** A section result owns all its parts, including every material in each part. */
export function disposeMeshPartitions(result) {
  for (const part of result?.parts ?? []) disposeBatches(part);
}

class PartitionedMeshData {
  constructor({
    maxVertices = MESH_PART_LIMITS.maxVertices,
    maxBytes = MESH_PART_LIMITS.maxBytes,
    maxTotalBytes = Infinity,
    maxDrawCalls = Infinity,
  } = {}) {
    Object.assign(this, {
      maxVertices,
      maxBytes,
      maxTotalBytes,
      maxDrawCalls,
    });
    this.batches = createMeshData().batches;
    this.emitters = [];
    this.vertices = 0;
    this.parts = [];
    this.bytes = 0;
    this.draws = 0;
    this.partVertices = 0;
    this.partBytes = 0;
    this.partDraws = 0;
  }

  bytesAfterQuad(batch) {
    const vertices = this.batches[batch].positions.length / 3;
    return this.partBytes + quadBytes(vertices + 4) - quadBytes(vertices);
  }

  /** Called before appendQuad mutates any arrays. Rollover never retries a cell:
   * even a single complex cell may span parts without duplicating its faces.
   */
  reserveQuad(batch) {
    let bytes = this.bytesAfterQuad(batch);
    if (
      this.partVertices &&
      (this.partVertices + 4 > this.maxVertices || bytes > this.maxBytes)
    ) {
      this.sealPart();
      bytes = this.bytesAfterQuad(batch);
    }
    const draws =
      this.partDraws + Number(this.batches[batch].positions.length === 0);
    if (
      this.partVertices + 4 > this.maxVertices ||
      bytes > this.maxBytes ||
      this.bytes + bytes > this.maxTotalBytes ||
      this.draws + draws > this.maxDrawCalls
    )
      throw new MeshBudgetError();
    this.partVertices += 4;
    this.partBytes = bytes;
    this.partDraws = draws;
  }

  sealPart() {
    if (!this.partVertices) return;
    // Finalize bounded buffers as we go, not one unbounded array at section end.
    // Emitters are selected once, after the complete section has been scanned.
    const part = finishMeshData({ batches: this.batches, emitters: [] });
    this.parts.push(part);
    this.bytes += this.partBytes;
    this.draws += this.partDraws;
    this.batches = createMeshData().batches;
    this.partVertices = 0;
    this.partBytes = 0;
    this.partDraws = 0;
  }

  /** Transfer every completed part together. No partial result is publishable. */
  finish() {
    this.sealPart();
    for (const emitter of selectEmitters(this.emitters)) {
      const batch = blockBatch[emitter.id];
      const geometry = this.parts.find((part) => part[batch])?.[batch];
      geometry?.userData.emitters.push(emitter);
    }
    const result = { parts: this.parts };
    this.parts = [];
    return result;
  }

  dispose() {
    disposeMeshPartitions({ parts: this.parts });
    this.parts = [];
    this.batches = {};
    this.emitters = [];
    this.partVertices = 0;
    this.partBytes = 0;
    this.partDraws = 0;
  }
}

/** appendQuad-compatible context with per-part limits and optional whole-result
 * bounds. The renderer still admits the complete replacement against live usage.
 */
export function createPartitionedMeshData(limits) {
  return new PartitionedMeshData(limits);
}
