import { DISTANT_GRID_LIMITS } from "./distant-grid.js";

// A stitched cell has at most eight boundary segments and one center. Each
// segment can emit one four-vertex riser, never a voxel-height-sized stack.
export const DISTANT_TERRACE_LIMITS = Object.freeze({
  vertices: DISTANT_GRID_LIMITS.vertices + DISTANT_GRID_LIMITS.cells * 41,
  indices: DISTANT_GRID_LIMITS.indices + DISTANT_GRID_LIMITS.cells * 48,
});

function edgeKey(a, b) {
  return Math.min(a, b) * 65536 + Math.max(a, b);
}

/**
 * Render-only terraces over the existing stitched grid. Each cell uses its
 * native anchor's integer top (coarse badlands choose a representative corner).
 * Fine/coarse boundaries already
 * share segmented edges, so their vertical risers meet without diagonal walls,
 * skirts below the world, new generator queries, or per-cell meshes.
 */
export class DistantTerraces {
  constructor(source) {
    this.source = source;
    // Material IDs cannot interpolate across biome boundaries, even when the
    // lattice is flat. Atlas caps use the same bounded owner slots as risers.
    this.flat = !source.blockData && source.allValid && source.minHeight === source.maxHeight;
    this.edges = new Map();
    this.tops = null;
    this.walls = null;
    this.extraVertices = 0;
    this.vertexCount = 0;
    this.indexCount = 0;
    this.indices = null;
    this.positions = null;
    this.normals = null;
    this.colors = null;
    this.ranges = [];
  }

  range(cell, start, count) {
    if (!count) return;
    const previous = this.ranges.at(-1);
    if (previous && previous.key === cell.key) previous.count += count;
    else this.ranges.push({ key: cell.key, start, count });
  }

  link(cell) {
    if (this.flat) {
      cell.terraceStart = cell.start;
      cell.terraceCount = cell.count;
      this.range(cell, cell.start, cell.count);
      return;
    }
    const ring = cell.ring;
    this.extraVertices += ring.length + Number(ring.length > 4);
    for (let i = 0; i < ring.length; i++) {
      const key = edgeKey(ring[i], ring[(i + 1) % ring.length]);
      const pair = this.edges.get(key);
      if (pair) pair.push(cell);
      else {
        this.edges.set(key, [cell]);
        this.extraVertices += 4;
      }
    }
  }

  begin() {
    if (this.flat) return;
    // Emit only referenced vertices; the native sample lattice is input data,
    // not an unused prefix in the rendered terrain buffer.
    const capacity = this.extraVertices;
    const indices = this.source.indexCount + this.edges.size * 6;
    if (
      capacity > DISTANT_TERRACE_LIMITS.vertices ||
      indices > DISTANT_TERRACE_LIMITS.indices
    )
      throw new RangeError("Distant terraces exceeded their topology budget");
    // Allocate bounded typed storage once instead of growing boxed-number
    // arrays or copying every vertex during the final publication frame.
    this.positions = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.surfaceData = new Float32Array(capacity * 3);
    this.blockData = this.source.blockData ? new Uint16Array(capacity * 3) : null;
    this.normals = new Float32Array(capacity * 3);
    this.indices = new Uint32Array(indices);
    // At a grid point at most four rectangular cells meet. For any wall
    // normal, at most two segments meet (four endpoint/owner combinations).
    // Fixed slots avoid a per-vertex Map while retaining hard normals and owners.
    this.tops = new Int32Array(this.source.count * 4);
    this.walls = new Int32Array(this.source.count * 16);
  }

  vertex(point, y, normal, wall = false, owner = point) {
    if (this.vertexCount >= this.positions.length / 3)
      throw new RangeError("Distant terraces exceeded their vertex budget");
    const at = this.vertexCount++;
    const target = at * 3;
    const offset = point * 3;
    const source = this.source;
    this.positions[target] = source.positions[offset];
    this.positions[target + 1] = y;
    this.positions[target + 2] = source.positions[offset + 2];
    this.normals[target] = normal[0];
    this.normals[target + 1] = normal[1];
    this.normals[target + 2] = normal[2];
    const colors = wall && !this.blockData ? source.rockColors : source.colors;
    const colorOffset = this.blockData ? owner * 3 : offset;
    this.colors[target] = colors[colorOffset];
    this.colors[target + 1] = colors[colorOffset + 1];
    this.colors[target + 2] = colors[colorOffset + 2];
    this.surfaceData.set(source.surfaceData.subarray(owner * 3, owner * 3 + 3), target);
    if (this.blockData)
      this.blockData.set(source.blockData.subarray(owner * 3, owner * 3 + 3), target);
    return at;
  }

  cachedVertex(slots, start, point, y, normal, wall, owner = point) {
    for (let slot = start; slot < start + 4; slot++) {
      const existing = slots[slot] - 1;
      if (existing >= 0) {
        const at = existing * 3, from = owner * 3;
        if (
          this.positions[at + 1] === y &&
          this.surfaceData[at] === this.source.surfaceData[from] &&
          this.surfaceData[at + 1] === this.source.surfaceData[from + 1] &&
          this.surfaceData[at + 2] === this.source.surfaceData[from + 2] &&
          (!this.blockData || (
            this.blockData[at] === this.source.blockData[from] &&
            this.blockData[at + 1] === this.source.blockData[from + 1] &&
            this.blockData[at + 2] === this.source.blockData[from + 2] &&
            this.colors[at] === this.source.colors[from] &&
            this.colors[at + 1] === this.source.colors[from + 1] &&
            this.colors[at + 2] === this.source.colors[from + 2]))
        ) return existing;
      } else {
        const vertex = this.vertex(point, y, normal, wall, owner);
        slots[slot] = vertex + 1;
        return vertex;
      }
    }
    throw new RangeError("Distant grid exceeded four incident cap levels");
  }

  top(point, y, owner = point) {
    return this.cachedVertex(this.tops, point * 4, point, y, [0, 1, 0], false, owner);
  }

  wall(point, y, normal, owner) {
    const direction = normal[0] === -1 ? 0 : normal[0] === 1 ? 1 : normal[2] === -1 ? 2 : 3;
    return this.cachedVertex(this.walls, point * 16 + direction * 4, point, y, normal, true, owner);
  }

  emit(cell) {
    cell.terraceStart = this.indexCount;
    cell.terraceCount = 0;
    if (!cell.valid) return;
    const source = this.source;
    const owner = cell.anchor ?? cell.ring[0];
    const height = source.heights[owner];
    for (let i = cell.start; i < cell.start + cell.count; i++)
      this.indices[this.indexCount++] = this.top(source.indices[i], height,
        this.blockData ? owner : source.indices[i]);
    for (let i = 0; i < cell.ring.length; i++) {
      const a = cell.ring[i];
      const b = cell.ring[(i + 1) % cell.ring.length];
      const pair = this.edges.get(edgeKey(a, b));
      const neighbor = pair[0] === cell ? pair[1] : pair[0];
      // Outside the sampled view is fogged out. Unknown Overworld cells retain
      // their existing conservative fog frontier; End void gets an island side.
      if (
        !neighbor ||
        (!neighbor.valid && source.request.dimension !== "end")
      )
        continue;
      const bottom = neighbor.valid
        ? source.heights[neighbor.anchor ?? neighbor.ring[0]]
        : source.spec.minY;
      if (bottom >= height) continue;
      const dx = source.positions[b * 3] - source.positions[a * 3];
      const dz = source.positions[b * 3 + 2] - source.positions[a * 3 + 2];
      const normal = [-Math.sign(dz), 0, Math.sign(dx)];
      // The higher cell owns the entire riser. Endpoint samples can belong to
      // lower/different biomes; interpolating them clips or shifts its strata.
      // Include this shader metadata in cache identity at shared endpoints.
      const ah = this.wall(a, height, normal, owner);
      const al = this.wall(a, bottom, normal, owner);
      const bl = this.wall(b, bottom, normal, owner);
      const bh = this.wall(b, height, normal, owner);
      this.indices.set(
        [ah, al, bl, ah, bl, bh],
        this.indexCount
      );
      this.indexCount += 6;
    }
    cell.terraceCount = this.indexCount - cell.terraceStart;
    this.range(cell, cell.terraceStart, cell.terraceCount);
    if (this.indexCount > this.indices.length)
      throw new RangeError("Distant terraces exceeded their index budget");
  }

  finish() {
    if (this.flat) {
      const count = this.source.count * 3;
      return {
        positions: this.source.positions.subarray(0, count),
        normals: this.source.normals.subarray(0, count),
        colors: this.source.colors.subarray(0, count),
        surfaceData: this.source.surfaceData.subarray(0, count),
        indices: this.source.indices.subarray(0, this.source.indexCount),
        ranges: this.ranges,
      };
    }
    const indices = this.indices.subarray(0, this.indexCount);
    // No full-buffer copy, compaction, or conversion at publication. The draw
    // index has its own appropriately sized integer type; _cutout copies only
    // the currently visible cells into it.
    const result = {
      positions: this.positions.subarray(0, this.vertexCount * 3),
      normals: this.normals.subarray(0, this.vertexCount * 3),
      colors: this.colors.subarray(0, this.vertexCount * 3),
      surfaceData: this.surfaceData.subarray(0, this.vertexCount * 3),
      blockData: this.blockData?.subarray(0, this.vertexCount * 3) ?? null,
      indices,
      ranges: this.ranges,
    };
    return result;
  }
}
