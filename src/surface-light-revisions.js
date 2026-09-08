import { BLOCK } from "./blocks.js";
import { columnLoaded, geometryEpoch } from "./geometry-world.js";
import { benignBlockLightChange, BLOCK_LIGHT_MUTATION_CELLS } from "./block-light-mutations.js";

// Only exact, current native transactions can skip raw-revision verification.
// Missing/replayed events and unsafe shapes keep the ordinary fail-closed path.
export class SurfaceLightRevisions {
  constructor() {
    this.ids = new WeakMap();
    this.nextId = 0;
    this.serial = 0;
    this.columns = new Map();
    this.cells = 0;
  }

  token(world, x, z) {
    const key = `${x},${z}`, chunk = world.chunks?.get(key);
    if (!chunk || !columnLoaded(world, x * 16, z * 16)) return "0";
    if (!this.ids.has(chunk)) this.ids.set(chunk, ++this.nextId);
    const identity = this.ids.get(chunk), incarnation = chunk.incarnation ?? 0, raw = chunk.revision ?? 0;
    let entry = this.columns.get(key);
    if (!entry || entry.identity !== identity || entry.incarnation !== incarnation) {
      entry = { identity, incarnation, raw, stamp: ++this.serial };
      this.columns.set(key, entry);
    } else if (entry.raw !== raw) {
      entry.raw = raw; entry.stamp = ++this.serial;
    }
    return `${identity}:${entry.stamp}:${incarnation}`;
  }

  observe(world, event) {
    if (world !== this.world || event?.epoch !== geometryEpoch(world) || event.epoch !== this.epoch ||
      event.dimension !== world.dimension || event.revision !== world._editRevision ||
      !Number.isSafeInteger(event.revision) || !Array.isArray(event.changes)) return;
    if (this.cells + event.changes.length > BLOCK_LIGHT_MUTATION_CELLS) return;
    this.cells += event.changes.length;
    const changed = new Map();
    // Bamboo's crossed sprite has no occlusion or support, like air. Keep
    // this proof explicit: transparent cubes can still connect nearby fences.
    const transparent = (cell) => cell &&
      (cell.id === BLOCK.AIR || cell.id === BLOCK.WATER || cell.id === BLOCK.BAMBOO);
    for (const change of event.changes) {
      const key = `${Math.floor(change.x / 16)},${Math.floor(change.z / 16)}`;
      const benign = benignBlockLightChange(change) ||
        (transparent(change.before) && transparent(change.after));
      changed.set(key, (changed.get(key) ?? true) && benign);
    }
    for (const [key, benign] of changed) {
      if (!benign) continue;
      const chunk = world.chunks.get(key), entry = this.columns.get(key);
      if (!entry || entry.identity !== this.ids.get(chunk) || entry.incarnation !== (chunk.incarnation ?? 0) ||
        entry.raw + 1 !== chunk.revision) continue;
      entry.raw = chunk.revision;
    }
  }

  begin(world) {
    this.world = world;
    this.epoch = geometryEpoch(world);
    this.cells = 0;
  }

  prune(cx, cz, radius) {
    for (const key of this.columns.keys()) {
      const [x, z] = key.split(",").map(Number);
      if (Math.abs(x - cx) > radius || Math.abs(z - cz) > radius) this.columns.delete(key);
    }
  }
}
