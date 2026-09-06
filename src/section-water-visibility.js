import { watchWaterHostField as watch } from "./section-water-resources.js";

/** Bit counters permit camera-layer changes and generation invalidation in
 * constant work. Mutation callbacks update only the affected source/subtree.
 * Ancestor layers never participate in Three's mesh-layer test. */
export class SectionWaterVisibility {
  constructor(host) {
    this.host = host;
    this.entries = new Map();
    this.eligible = new Int32Array(32);
    this.ready = new Map();
  }
  counts(mask, array, direction) {
    for (let i = 0; i < 32; i++) if (mask & (1 << i)) array[i] += direction;
  }
  account(state, direction) {
    this.counts(state.mask, this.eligible, direction);
    if (!state.ready || !state.mask) return;
    let generation = this.ready.get(state.generation);
    if (!generation) {
      generation = { counts: new Int32Array(32), refs: 0 };
      this.ready.set(state.generation, generation);
    }
    this.counts(state.mask, generation.counts, direction);
    generation.refs += direction;
    if (!generation.refs) this.ready.delete(state.generation);
  }
  add(entry) {
    if (this.entries.has(entry)) return;
    this.entries.set(entry, { stops: [], mask: 0, ready: false, generation: 0, updating: false });
    this.update(entry);
  }
  update(entry) {
    const state = this.entries.get(entry);
    if (!state || state.updating) return;
    state.updating = true;
    this.account(state, -1);
    for (const stop of state.stops) stop();
    state.stops = [];
    const changed = () => this.update(entry), { mesh } = entry;
    let visible = true, attached = false;
    for (let node = mesh; node; node = node.parent) {
      visible &&= node.visible !== false;
      attached ||= node === this.host.renderer.scene;
      node.addEventListener("added", changed); node.addEventListener("removed", changed);
      state.stops.push(() => {
        node.removeEventListener("added", changed); node.removeEventListener("removed", changed);
      }, watch(node, "visible", changed));
    }
    state.stops.push(watch(mesh, "material", changed), watch(mesh, "geometry", changed),
      watch(mesh, "layers", changed), watch(mesh.layers, "mask", changed));
    const material = mesh.material;
    if (material) state.stops.push(watch(material, "visible", changed));
    const r = this.host.owner.records.get(mesh);
    const range = r?.range ?? mesh.geometry?.drawRange;
    const count = r?.indices?.length ?? mesh.geometry?.index?.count ?? 0;
    // An unrequested source is about to transfer range ownership to the core.
    // Only untouched permanent fallbacks need host-owned range observers.
    if (!r && entry.fallback && range) state.stops.push(watch(range, "start", changed), watch(range, "count", changed));
    const nonempty = range && Math.min(count, range.start + range.count) - Math.max(0, range.start) >= 3;
    state.mask = attached && visible && material?.visible !== false && nonempty ? mesh.layers.mask : 0;
    state.generation = entry.materialGeneration;
    state.ready = !this.host.dirty.has(entry) && this.host.current(entry) &&
      (r ? !!r.ready && !r.phase && !r.error && mesh.geometry === r.drawGeometry &&
        mesh.material === r.renderMaterial && !!r.indexBuffer &&
        (r.mode === "original" ? !!r.vbo : !!r.textureAllocated) : !!entry.fallback);
    this.account(state, 1);
    state.updating = false;
  }
  remove(entry) {
    const state = this.entries.get(entry);
    if (!state) return;
    this.account(state, -1);
    state.stops.forEach(stop => stop());
    this.entries.delete(entry);
  }
  canRender() {
    const mask = this.host.renderer.camera.layers.mask;
    const ready = this.ready.get(this.host.materialGeneration)?.counts;
    for (let i = 0; i < 32; i++)
      if ((mask & (1 << i)) && this.eligible[i] > (ready?.[i] ?? 0)) return false;
    return true;
  }
  dispose() { for (const entry of this.entries.keys()) this.remove(entry); }
}
