import {
  admittedExplorationEntries,
  currentExplorationAdmission,
  explorationEntryEdited,
  explorationEntryLive,
} from "./exploration-admission.js";
import { explorationAdmission } from "./exploration-host-state.js";
import { progressPositionKey } from "./progression-common.js";
import { CHUNK_SIZE } from "./terrain.js";

/**
 * Bounded reconstructible cache, NOT the permanent entitlement ledger. Cache
 * eviction may forget observations, never claims. FIFO reads are mutation-free,
 * including reads used by prepared participants and Settlement's lazy-read gate.
 */
export class ExplorationResidentIndex {
  constructor(world, context, limits) {
    this.world = world;
    this.context = context;
    this.limits = limits;
    this.columns = new Map();
    this.members = new Map();
    this.positions = new Map();
    this.reset();
  }

  reset() {
    this.columns.clear();
    this.members.clear();
    this.positions.clear();
    this.epoch = this.world.epoch;
    this.dimension = this.world.dimension;
    this.generator = this.world.generator;
    this.scan = null;
  }

  _sameWorld() {
    return (
      this.epoch === this.world.epoch &&
      this.dimension === this.world.dimension &&
      this.generator === this.world.generator
    );
  }

  current(column) {
    return (
      !!column &&
      this._sameWorld() &&
      this.world.chunks.get(column.key) === column.chunk &&
      column.chunk.incarnation === column.incarnation
    );
  }

  _remove(key) {
    const column = this.columns.get(key);
    if (!column) return;
    for (const entry of column.entries) {
      this.members.delete(entry.marker.id);
      this.positions.delete(progressPositionKey(entry.marker));
    }
    this.columns.delete(key);
  }

  prune() {
    if (!this._sameWorld()) this.reset();
    for (const [key, column] of this.columns)
      if (!this.current(column)) this._remove(key);
  }

  admit(event) {
    if (!currentExplorationAdmission(this.world, event)) return false;
    this.prune();
    const previous = this.columns.get(event.key);
    // Duplicate/replayed envelopes cannot resurrect a cell invalidated since
    // admission or undo a first-open/first-break race.
    if (previous?.complete && this.current(previous)) return true;
    let entries;
    try {
      entries = admittedExplorationEntries(
        this.world,
        event,
        this.context,
        this.limits
      );
    } catch {
      return false;
    }
    if (entries.length > this.limits.markers) return false;
    if (previous) this._remove(event.key);
    while (
      this.columns.size >= this.limits.columns ||
      this.members.size + entries.length > this.limits.markers
    )
      this._remove(this.columns.keys().next().value);
    const column = {
      key: event.key,
      chunk: event.chunk,
      incarnation: event.incarnation,
      complete: true,
      entries,
    };
    for (const entry of entries) {
      entry.column = column;
      this.members.set(entry.marker.id, entry);
      this.positions.set(progressPositionKey(entry.marker), entry);
    }
    this.columns.set(event.key, column);
    return true;
  }

  /** Action-time recovery uses the current post-edit World resident, not a packet. */
  ensure(position) {
    this.prune();
    const key = `${Math.floor(position.x / CHUNK_SIZE)},${Math.floor(position.z / CHUNK_SIZE)}`;
    const chunk = this.world.chunks.get(key);
    if (!chunk) return false;
    if (this.current(this.columns.get(key))) return true;
    return this.admit(explorationAdmission(this.world, chunk));
  }

  lookup(position) {
    const key = `${Math.floor(position.x / CHUNK_SIZE)},${Math.floor(position.z / CHUNK_SIZE)}`;
    const column = this.columns.get(key);
    if (!this.current(column)) return { status: "pending" };
    const entry = this.positions.get(
      progressPositionKey({ dimension: this.world.dimension, position })
    );
    return entry ? { status: "marker", entry } : { status: "ordinary" };
  }

  byId(id) {
    const entry = this.members.get(id);
    return entry && this.current(entry.column) ? entry : null;
  }

  live(entry) {
    return (
      this.byId(entry.marker.id) === entry &&
      explorationEntryLive(this.world, entry)
    );
  }

  eligible(entry) {
    return (
      this.live(entry) &&
      !entry.invalidated &&
      !explorationEntryEdited(this.world, entry)
    );
  }

  onMutation(event) {
    this.prune();
    if (event.changes.length <= this.limits.markersPerColumn) {
      for (const change of event.changes) {
        const { entry } = this.lookup(change);
        if (entry) entry.invalidated = true;
      }
    } else {
      // Large changes need work bounded by the resident cache, not edit count.
      for (const entry of this.members.values())
        if (
          !explorationEntryLive(this.world, entry) ||
          explorationEntryEdited(this.world, entry)
        )
          entry.invalidated = true;
    }
  }

  frame() {
    this.prune();
    this.scan ??= this.world.chunks.values();
    let scanned = 0;
    let admitted = 0;
    for (; scanned < this.limits.scanColumns; scanned++) {
      const next = this.scan.next();
      if (next.done) {
        this.scan = null;
        break;
      }
      const chunk = next.value;
      if (this.world.chunks.get(`${chunk.cx},${chunk.cz}`) !== chunk) continue;
      if (this.admit(explorationAdmission(this.world, chunk))) admitted++;
    }
    return { scanned, admitted };
  }

  list(type) {
    return [...this.members.values()]
      .filter(
        (entry) => (!type || entry.marker.type === type) && this.live(entry)
      )
      .map(({ marker, declaration, kind, invalidated }) =>
        structuredClone({ marker, declaration, kind, invalidated })
      );
  }

  diagnostics() {
    return {
      epoch: this.epoch,
      dimension: this.dimension,
      columns: this.columns.size,
      markers: this.members.size,
      scanning: this.scan !== null,
      limits: this.limits,
    };
  }
}
