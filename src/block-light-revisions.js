import { columnLoaded } from "./geometry-world.js";
import { benignBlockLightChange, BLOCK_LIGHT_MUTATION_CELLS } from "./block-light-mutations.js";

// A bounded metadata grid, never a scan of the resident world or its voxels.
// Prefix sums let invalidation query a section's dependency apron in O(1).
export class BlockLightRevisions {
  constructor() {
    this.ids = new WeakMap();
    this.nextId = 0;
    this.tokens = new Map();
    this.semantic = new Map();
    this.mutationCells = this.benignCells = 0;
  }

  observeMutation(world, event) {
    // Only the current synchronous native publication can certify a raw
    // revision. Missing, replayed, oversized or out-of-order events fall back
    // to ordinary invalidation; none may bless an unseen removal/closure.
    if (world !== this.world || event?.epoch !== this.epoch ||
      event.dimension !== world.dimension || event.revision !== world._editRevision ||
      !Number.isSafeInteger(event.revision) || !Array.isArray(event.changes)) return;
    if (this.mutationCells + event.changes.length > BLOCK_LIGHT_MUTATION_CELLS) return;
    this.mutationCells += event.changes.length;
    const sections = new Map(), columns = new Map();
    for (const change of event.changes) {
      const x = Math.floor(change.x / 16), z = Math.floor(change.z / 16), y = Math.floor(change.y / 16);
      const key = `${x},${z},${y}`, columnKey = `${x},${z}`;
      let column = columns.get(columnKey);
      if (!column) columns.set(columnKey, column = { benign: true });
      if (!this.semantic.has(key)) { column.benign = false; continue; }
      let section = sections.get(key);
      if (!section) sections.set(key, section = { x, z, y, column, benign: true, cells: 0 });
      section.benign &&= benignBlockLightChange(change);
      section.cells++;
    }
    for (const [key, section] of sections) {
      if (!section.benign) { section.column.benign = false; continue; }
      const previous = this.semantic.get(key), chunk = world.chunks.get(`${section.x},${section.z}`);
      const revision = chunk?.sectionRevisions?.get(section.y) ?? 0;
      if (!chunk?.sectionRevisions || previous.identity !== `${this.ids.get(chunk)}:${chunk.incarnation ?? 0}` ||
        revision !== previous.raw + 1) { section.column.benign = false; continue; }
      previous.raw = revision;
      this.benignCells += section.cells;
    }
    // Certifying the complete column increment also avoids rebuilding the
    // metadata prefix on every harmless tick. A gap/unsafe sibling section
    // prevents this fast path, even if this event's own sections are benign.
    for (const [key, column] of columns) {
      if (!column.benign) continue;
      const chunk = world.chunks.get(key), identity = `${this.ids.get(chunk)}:${chunk.incarnation ?? 0}`;
      if (this.columns.get(key) === `${identity}:${chunk.revision - 1}`)
        this.columns.set(key, `${identity}:${chunk.revision}`);
    }
  }

  token(world, x, z, y) {
    if (y < this.minY || y >= this.minY + this.height) return "0";
    const chunk = world.chunks?.get(`${x},${z}`);
    if (!chunk || !columnLoaded(world, x * 16, z * 16)) return "0";
    if (!this.ids.has(chunk)) this.ids.set(chunk, ++this.nextId);
    const identity = `${this.ids.get(chunk)}:${chunk.incarnation ?? 0}`;
    if (!chunk.sectionRevisions) return `${identity}:c${chunk.revision ?? 0}`;
    const key = `${x},${z},${y}`, raw = chunk.sectionRevisions.get(y) ?? 0;
    let entry = this.semantic.get(key);
    if (!entry || entry.identity !== identity) {
      entry = { identity, raw, stamp: 0 };
      this.semantic.set(key, entry);
    } else if (entry.raw !== raw) {
      entry.raw = raw;
      entry.stamp++;
    }
    return `${identity}:s${entry.stamp}`;
  }

  signature(world, x, z, y, radius) {
    const values = [];
    for (let dy = -radius; dy <= radius; dy++)
      for (let dz = -radius; dz <= radius; dz++)
        for (let dx = -radius; dx <= radius; dx++)
          values.push(this.token(world, x + dx, z + dz, y + dy));
    return values.join("|");
  }

  update(world, cx, cz, radius, spec, stats) {
    this.world = world;
    this.epoch = world.epoch;
    stats.mutationCells = this.mutationCells;
    stats.benignCells = this.benignCells;
    this.mutationCells = this.benignCells = 0;
    const layout = `${cx},${cz},${radius},${spec.minY},${spec.maxY}`;
    const columns = new Map();
    const layoutChanged = layout !== this.layout;
    let changed = layoutChanged;
    for (let z = cz - radius - 2; z <= cz + radius + 2; z++)
      for (let x = cx - radius - 2; x <= cx + radius + 2; x++) {
        const id = `${x},${z}`, chunk = world.chunks?.get(id);
        let stamp = "0";
        if (chunk && columnLoaded(world, x * 16, z * 16)) {
          if (!this.ids.has(chunk)) this.ids.set(chunk, ++this.nextId);
          stamp = `${this.ids.get(chunk)}:${chunk.incarnation ?? 0}:${chunk.revision ?? 0}`;
        }
        columns.set(id, stamp);
        changed ||= this.columns?.get(id) !== stamp;
        stats.columnChecks++;
      }
    this.columns = columns;
    this.layout = layout;
    this.anyChanged = changed;
    if (!changed) return false;
    this.minY = spec.minY / 16;
    this.height = (spec.maxY - spec.minY) / 16;
    this.x = cx - radius - 2;
    this.z = cz - radius - 2;
    this.size = radius * 2 + 5;
    const stride = this.size + 1, plane = stride * stride;
    const length = plane * (this.height + 1);
    if (this.prefix?.length !== length) this.prefix = new Uint32Array(length);
    else this.prefix.fill(0);
    const next = new Map(), p = this.prefix;
    for (let y = 0; y < this.height; y++)
      for (let z = 0; z < this.size; z++)
        for (let x = 0; x < this.size; x++) {
          const key = `${x + this.x},${z + this.z},${y + this.minY}`;
          const token = this.token(world, x + this.x, z + this.z, y + this.minY);
          next.set(key, token);
          const dirty = Number((this.tokens.get(key) ?? "0") !== token);
          const i = (y + 1) * plane + (z + 1) * stride + x + 1;
          p[i] = dirty + p[i - 1] + p[i - stride] + p[i - plane]
            - p[i - 1 - stride] - p[i - 1 - plane] - p[i - stride - plane]
            + p[i - 1 - stride - plane];
          stats.stampChecks++;
        }
    this.tokens = next;
    for (const key of this.semantic.keys()) if (!next.has(key)) this.semantic.delete(key);
    this.anyChanged = layoutChanged || p[p.length - 1] > 0;
    return this.anyChanged;
  }

  changed(cx, cz, sy, radius) {
    if (!this.anyChanged) return false;
    const x0 = cx - radius - this.x, x1 = cx + radius + 1 - this.x;
    const z0 = cz - radius - this.z, z1 = cz + radius + 1 - this.z;
    if (x0 < 0 || z0 < 0 || x1 > this.size || z1 > this.size) return true;
    const y0 = Math.max(0, sy - radius - this.minY);
    const y1 = Math.min(this.height, sy + radius + 1 - this.minY);
    const n = this.size + 1, p = this.prefix;
    const at = (x, z, y) => p[(y * n + z) * n + x];
    return at(x1, z1, y1) - at(x0, z1, y1) - at(x1, z0, y1) - at(x1, z1, y0)
      + at(x0, z0, y1) + at(x0, z1, y0) + at(x1, z0, y0) - at(x0, z0, y0) > 0;
  }
}
