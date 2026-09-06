import * as THREE from "three";
import { MeshBudgetError } from "./mesh-geometry.js";

export class GeometryPaletteError extends MeshBudgetError {
  constructor(reason = "palette-overflow") {
    super();
    this.name = "GeometryPaletteError";
    this.reason = reason;
  }
}

/** Fixed-capacity exact Float32 RGB dictionary. All variable-size metadata is
 * typed storage: no unbounded string keys/Maps. References belong to vertices
 * in live AND private replacement pages; zero references make a slot reusable.
 */
export class GeometryColorPalette {
  static allocation(capacity = 16384) {
    return { cpuBytes: capacity * 30 + 12 + 4096, gpuBytes: capacity * 16 };
  }

  constructor(capacity = 16384) {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 65536 ||
        (capacity & (capacity - 1))) throw new RangeError("Palette capacity must be a power of two <= 65536");
    this.capacity = capacity;
    this.data = new Float32Array(capacity * 4);
    this.bits = new Uint32Array(this.data.buffer);
    this.refs = new Uint32Array(capacity);
    this.table = new Int32Array(capacity * 2);
    this.free = new Uint16Array(capacity);
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - i - 1;
    this.freeCount = capacity;
    this.scratch = new Float32Array(3);
    this.scratchBits = new Uint32Array(this.scratch.buffer);
    this.entries = 0;
    this.references = 0;
    this.revision = 0;
    this.uploadedBytes = 0;
    this.uploadCalls = 0;
    const width = Math.min(256, capacity);
    this.texture = new THREE.DataTexture(this.data, width, capacity / width,
      THREE.RGBAFormat, THREE.FloatType);
    this.texture.internalFormat = "RGBA32F";
    this.texture.minFilter = this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.colorSpace = THREE.NoColorSpace;
    this.pendingUploadBytes = this.data.byteLength;
    this.texture.onUpdate = () => {
      this.uploadedBytes += this.data.byteLength;
      this.uploadCalls++;
      this.pendingUploadBytes = 0;
    };
    this.texture.needsUpdate = true;
  }

  hash(a, b, c) {
    return (Math.imul(a ^ (a >>> 16), 0x45d9f3b) ^
      Math.imul(b ^ (b >>> 16), 0x119de1f3) ^ Math.imul(c, 0x27d4eb2d)) >>> 0;
  }

  locate(a, b, c) {
    const mask = this.table.length - 1;
    let at = this.hash(a, b, c) & mask;
    for (let n = 0; n < this.table.length; n++, at = (at + 1) & mask) {
      const entry = this.table[at];
      if (!entry) return ~at;
      const slot = entry - 1, offset = slot * 4;
      if (this.bits[offset] === a && this.bits[offset + 1] === b && this.bits[offset + 2] === c)
        return at;
    }
    throw new GeometryPaletteError("palette-table-full");
  }

  acquire(r, g, b) {
    if (this.disposed) throw new GeometryPaletteError("palette-disposed");
    this.scratch[0] = r; this.scratch[1] = g; this.scratch[2] = b;
    if (!Number.isFinite(this.scratch[0]) || !Number.isFinite(this.scratch[1]) ||
        !Number.isFinite(this.scratch[2])) throw new GeometryPaletteError("nonfinite-color");
    const a = this.scratchBits[0], bb = this.scratchBits[1], c = this.scratchBits[2];
    const found = this.locate(a, bb, c);
    let slot = found < 0 ? -1 : this.table[found] - 1;
    if (found < 0) {
      if (!this.freeCount) throw new GeometryPaletteError();
      slot = this.free[--this.freeCount];
      this.table[~found] = slot + 1;
      this.bits.set(this.scratchBits, slot * 4);
      this.data[slot * 4 + 3] = 1;
      this.entries++;
      this.pendingUploadBytes = this.data.byteLength;
      this.texture.needsUpdate = true;
      this.refs[slot] = 1;
      this.references++;
      return slot;
    }
    return this.retain(slot);
  }

  retain(slot) {
    if (this.disposed || !Number.isInteger(slot) || slot < 0 || slot >= this.capacity || !this.refs[slot])
      throw new GeometryPaletteError("invalid-slot");
    this.refs[slot]++;
    this.references++;
    return slot;
  }

  release(slot) {
    if (!this.refs[slot]) throw new Error("Palette reference underflow");
    this.references--;
    if (--this.refs[slot]) return;
    const offset = slot * 4;
    const found = this.locate(this.bits[offset], this.bits[offset + 1], this.bits[offset + 2]);
    // Backward-shift deletion prevents long travel from filling the fixed
    // dictionary with tombstones and turning every lookup into a full scan.
    const mask = this.table.length - 1;
    let gap = found;
    this.table[gap] = 0;
    for (let at = (gap + 1) & mask; this.table[at]; at = (at + 1) & mask) {
      const entry = this.table[at], base = (entry - 1) * 4;
      const home = this.hash(this.bits[base], this.bits[base + 1], this.bits[base + 2]) & mask;
      if (((at - home) & mask) >= ((gap - home) & mask)) {
        this.table[gap] = entry;
        this.table[at] = 0;
        gap = at;
      }
    }
    this.free[this.freeCount++] = slot;
    this.entries--;
    this.revision++;
    // No upload on free: nobody can sample this slot. Reuse marks it dirty
    // before the replacement page can be published or drawn.
  }

  component(slot, channel) { return this.data[slot * 4 + channel]; }
  restoreGPU() {
    this.pendingUploadBytes = this.data.byteLength;
    this.texture.needsUpdate = true;
  }
  resources() {
    return { ...GeometryColorPalette.allocation(this.capacity), entries: this.entries,
      references: this.references, capacity: this.capacity,
      metadataBytes: this.refs.byteLength + this.table.byteLength + this.free.byteLength + 12 + 4096,
      pendingUploadBytes: this.pendingUploadBytes, uploadedBytes: this.uploadedBytes,
      uploadCalls: this.uploadCalls };
  }
  dispose() {
    if (this.references) throw new Error("Cannot dispose a palette with live page references");
    this.disposed = true;
    this.texture.dispose();
  }
}
