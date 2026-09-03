import { BLOCK } from "./blocks.js";
import { MAX_STRUCTURE_PROGRESS_MARKERS } from "./exploration-markers.js";
import { freezeProgressData } from "./progression-common.js";

const finite = (point) => point && [point.x, point.y, point.z].every(Number.isFinite);
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/**
 * Read-only rich view of the existing canonical resident cache. There is no
 * generator/structure discovery here, and no use of index.list() (which clones
 * the complete cache). Only an admitted, still-current column can supply data.
 */
export class GameEcologyMarkers {
  constructor(index) {
    this.index = index;
    this._markers = new WeakMap();
    this._richColumns = new WeakMap();
    this._structures = new Map();
  }

  _columnCurrent(column) {
    return !!column?.complete && this.index.columns.get(column.key) === column &&
      this.index.current(column);
  }

  _richMarkers(column) {
    let cached = this._richColumns.get(column);
    if (cached) return cached;
    cached = new Map();
    for (const structure of (column.chunk.structures ?? [])
      .slice(0, this.index.limits.descriptorsPerColumn)) {
      for (const raw of (structure.markers ?? []).slice(0, MAX_STRUCTURE_PROGRESS_MARKERS)) {
        if (cached.size >= this.index.limits.markersPerColumn) break;
        if (!finite(raw.position) || ["container", "encounter"].includes(raw.type) ||
            raw.structureId !== structure.id ||
            `${Math.floor(raw.position.x / 16)},${Math.floor(raw.position.z / 16)}` !== column.key)
          continue;
        const block = raw.block ?? (Number.isInteger(structure.waterLevel) &&
          raw.position.y <= structure.waterLevel ? "WATER" : "AIR");
        if (Number.isInteger(BLOCK[block]))
          cached.set(raw.id, { marker: freezeProgressData(structuredClone(raw)), block: BLOCK[block] });
      }
    }
    this._richColumns.set(column, cached);
    return cached;
  }

  _richCurrent(column, entry) {
    const index = this.index, marker = entry.marker, at = marker.position;
    return this._columnCurrent(column) && marker.dimension === index.world.dimension &&
      !index.world.edits.has(`${marker.dimension}:${at.x},${at.y},${at.z}`) &&
      index.world.getCell(at.x, at.y, at.z)?.id === entry.block;
  }

  getMarker(id) {
    const index = this.index;
    if (!index || typeof id !== "string") return null;
    const entry = index.byId(id);
    if (entry) {
      if (!index.eligible(entry) || entry.declaration?.id !== id) return null;
      let marker = this._markers.get(entry);
      if (!marker) {
        marker = freezeProgressData(structuredClone(entry.declaration));
        this._markers.set(entry, marker);
      }
      return marker;
    }
    // Claim ledgers intentionally exclude member/home/job_site markers. Their
    // descriptor has still passed canonicalColumnStructure in this same index.
    let scanned = 0;
    for (const column of index.columns.values()) {
      if (++scanned > index.limits.columns) break;
      if (!this._columnCurrent(column)) continue;
      const rich = this._richMarkers(column).get(id);
      if (rich) return this._richCurrent(column, rich) ? rich.marker : null;
    }
    return null;
  }

  getStructure(id) {
    const index = this.index;
    if (!index) return null;
    const cached = this._structures.get(id);
    if (cached && this._columnCurrent(cached.column)) return cached.value;
    this._structures.delete(id);
    let scanned = 0;
    for (const column of index.columns.values()) {
      if (++scanned > index.limits.columns) break;
      if (!this._columnCurrent(column)) continue;
      const descriptor = column.chunk.structures
        ?.slice(0, index.limits.descriptorsPerColumn).find((entry) => entry.id === id);
      if (!descriptor) continue;
      // FIFO is bounded by the existing cache, not the world's visited sites.
      while (this._structures.size >= index.limits.columns)
        this._structures.delete(this._structures.keys().next().value);
      const value = freezeProgressData(structuredClone(descriptor));
      this._structures.set(id, { column, value });
      return value;
    }
    return null;
  }

  nearbyMarkers(position, { dimension, entities, radius = 48, limit = 12 } = {}) {
    const index = this.index;
    if (!index || !finite(position) || dimension !== index.world.dimension ||
        !Array.isArray(entities) || !Number.isFinite(radius) || radius < 0 ||
        !Number.isSafeInteger(limit) || limit < 0) return [];
    const result = [];
    let scanned = 0;
    for (const column of index.columns.values()) {
      if (++scanned > index.limits.columns || result.length >= Math.min(limit, 12)) break;
      if (!this._columnCurrent(column)) continue;
      const [cx, cz] = column.key.split(",").map(Number);
      if (Math.abs(cx * 16 + 8 - position.x) > Math.min(radius, 64) + 8 ||
          Math.abs(cz * 16 + 8 - position.z) > Math.min(radius, 64) + 8) continue;
      for (const entry of column.entries) {
        if (result.length >= Math.min(limit, 12)) break;
        const raw = entry.declaration;
        if (!raw || !entities.includes(raw.entity) || !finite(raw.position) ||
            distance(raw.position, position) > Math.min(radius, 64)) continue;
        const marker = this.getMarker(raw.id);
        if (marker) result.push(marker);
      }
      for (const rich of this._richMarkers(column).values()) {
        if (result.length >= Math.min(limit, 12)) break;
        const marker = rich.marker;
        if (entities.includes(marker.entity) && distance(marker.position, position) <= Math.min(radius, 64) &&
            this._richCurrent(column, rich)) result.push(marker);
      }
    }
    return result;
  }

  nearbyStructures(position, { dimension, kinds, radius = 48, limit = 4 } = {}) {
    const index = this.index;
    if (!index || !finite(position) || dimension !== index.world.dimension ||
        !Array.isArray(kinds) || !Number.isFinite(radius) || radius < 0 ||
        !Number.isSafeInteger(limit) || limit < 0) return [];
    const result = [], seen = new Set();
    let scanned = 0;
    for (const column of index.columns.values()) {
      if (++scanned > index.limits.columns || result.length >= Math.min(limit, 4)) break;
      if (!this._columnCurrent(column)) continue;
      for (const raw of (column.chunk.structures ?? []).slice(0, index.limits.descriptorsPerColumn)) {
        if (result.length >= Math.min(limit, 4)) break;
        if (seen.has(raw.id) || !kinds.includes(raw.kind) || !finite(raw.origin) ||
            distance(raw.origin, position) > Math.min(radius, 64)) continue;
        seen.add(raw.id);
        const descriptor = this.getStructure(raw.id);
        if (descriptor) result.push(descriptor);
      }
    }
    return result;
  }
}
