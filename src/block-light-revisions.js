import { columnLoaded } from "./geometry-world.js";
import { benignBlockLightChange, BLOCK_LIGHT_MUTATION_CELLS } from "./block-light-mutations.js";

// Column identities are a bounded safety audit (at R12: 841 scalar checks).
// Section tokens are lazy, and changes are column bitmasks, not a rebuilt
// 20,184-entry prefix grid. Large changes fail closed and restart enumeration.
export const BLOCK_LIGHT_METADATA_LIMITS = Object.freeze({
  columns: 841, changedColumns: 8, invalidations: 2048, targets: 64, pruning: 64, sources: 128,
});

export class BlockLightRevisions {
  constructor() {
    this.ids = new WeakMap();
    this.nextId = 0;
    this.serial = 0;
    this.tokens = new Map();
    this.columnTokens = new Map();
    this.semantic = new Map();
    this.columns = new Map();
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
      if (!this.semantic.has(key)) {
        // Lazy/unread sections have no semantic stamp to advance. A benign
        // event there must not defeat an otherwise exact column increment.
        column.benign &&= benignBlockLightChange(change);
        continue;
      }
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
    // Certifying the complete column increment avoids even local raw-section
    // checks on a harmless tick. A gap/unsafe sibling section
    // prevents this fast path, even if this event's own sections are benign.
    for (const [key, column] of columns) {
      if (!column.benign) continue;
      const chunk = world.chunks.get(key), previous = this.columns.get(key);
      if (previous?.chunk === chunk && previous.incarnation === (chunk.incarnation ?? 0) &&
        previous.raw === chunk.revision - 1) previous.raw = chunk.revision;
    }
  }

  token(world, x, z, y) {
    if (y < this.minY || y >= this.minY + this.height) return "0";
    const columnKey = `${x},${z}`, key = `${columnKey},${y}`;
    if (!this.tokens.has(key)) this.columnTokens.set(columnKey, (this.columnTokens.get(columnKey) ?? 0) + 1);
    const chunk = world.chunks?.get(columnKey);
    if (!chunk || !columnLoaded(world, x * 16, z * 16)) {
      this.tokens.set(key, "0");
      return "0";
    }
    if (!this.ids.has(chunk)) this.ids.set(chunk, ++this.nextId);
    const identity = `${this.ids.get(chunk)}:${chunk.incarnation ?? 0}`;
    if (!chunk.sectionRevisions) {
      const token = `${identity}:c${chunk.revision ?? 0}`;
      this.tokens.set(key, token);
      return token;
    }
    const raw = chunk.sectionRevisions.get(y) ?? 0;
    let entry = this.semantic.get(key);
    if (!entry || entry.identity !== identity) {
      entry = { identity, raw, stamp: ++this.serial };
      this.semantic.set(key, entry);
    } else if (entry.raw !== raw) {
      entry.raw = raw;
      entry.stamp = ++this.serial;
    }
    const token = `${identity}:s${entry.stamp}`;
    this.tokens.set(key, token);
    return token;
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
    this.minY = spec.minY / 16;
    this.height = (spec.maxY - spec.minY) / 16;
    const layout = `${cx},${cz},${radius},${spec.minY},${spec.maxY}`;
    if (layout !== this.layout) {
      this.layout = layout;
      this.layoutVersion = (this.layoutVersion ?? 0) + 1;
      this.grid = [];
      const columns = new Map();
      for (let z = cz - radius - 2; z <= cz + radius + 2; z++)
        for (let x = cx - radius - 2; x <= cx + radius + 2; x++) {
          const key = `${x},${z}`;
          this.grid.push({ x, z, key });
          if (this.columns.has(key)) columns.set(key, this.columns.get(key));
        }
      this.columns = columns;
      this.pruneIterator ??= this.tokens.keys();
      this.pruneBounds = { cx, cz, radius: radius + 2 };
    }
    const changed = [];
    this.global = false;
    this.changes = [];
    for (const column of this.grid) {
      const { x, z, key } = column;
      const chunk = columnLoaded(world, x * 16, z * 16) ? world.chunks?.get(key) : undefined;
      const old = this.columns.get(key), raw = chunk?.revision ?? 0, incarnation = chunk?.incarnation ?? 0;
      stats.columnChecks++;
      if (old && old.chunk === chunk && old.raw === raw && old.incarnation === incarnation) continue;
      this.columns.set(key, { chunk, raw, incarnation });
      // New grid columns have no cached receivers; missing dependencies that
      // were actually used still have a lazy "0" token and are checked below.
      const used = this.columnTokens.has(key);
      // Unread revisions cannot affect cached light. A newly admitted column
      // inside the existing window still needs scheduling, even if no job has
      // queried it yet. Merely extending the observer grid is not a mutation.
      const admitted = !!old && !old.chunk && !!chunk;
      if (used || admitted) changed.push({ ...column, admitted });
    }
    if (changed.length > BLOCK_LIGHT_METADATA_LIMITS.changedColumns) {
      this.global = true;
      this.tokens.clear(); this.semantic.clear(); this.columnTokens.clear();
    } else {
      for (const { x, z, admitted } of changed) {
        let mask = admitted ? (1 << this.height) - 1 : 0;
        for (let y = this.minY; y < this.minY + this.height; y++) {
          const key = `${x},${z},${y}`;
          if (!this.tokens.has(key)) continue;
          const previous = this.tokens.get(key);
          if (this.token(world, x, z, y) !== previous) mask |= 1 << (y - this.minY);
          stats.stampChecks++;
        }
        if (mask) this.changes.push({ x, z, mask });
      }
    }
    for (let i = 0; this.pruneIterator && i < BLOCK_LIGHT_METADATA_LIMITS.pruning; i++) {
      const next = this.pruneIterator.next();
      if (next.done) { this.pruneIterator = null; break; }
      const [x, z] = next.value.split(",").map(Number), b = this.pruneBounds;
      if (Math.abs(x - b.cx) > b.radius || Math.abs(z - b.cz) > b.radius) {
        this.tokens.delete(next.value); this.semantic.delete(next.value);
        const columnKey = `${x},${z}`, count = this.columnTokens.get(columnKey) - 1;
        if (count) this.columnTokens.set(columnKey, count);
        else this.columnTokens.delete(columnKey);
      }
      stats.metadataPrunes++;
    }
    return this.global || this.changes.length > 0;
  }
}
