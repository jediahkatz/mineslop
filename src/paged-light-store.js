import * as THREE from "three";
import { LIGHT_PHYSICAL_HANDLE, LIGHT_UPLOAD_PUBLICATIONS, lightUploadBudget } from "./light-page-layout.js";
import { checkedLightTransfer } from "./light-transfer.js";

function configure(texture) {
  texture.magFilter = texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.source.dataReady = false;
  texture.needsUpdate = true;
  return texture;
}

/** Pinned receiver pages, without an LRU or a GPU-bank-sized CPU mirror.
 * Invalidations are a mandatory pre-draw barrier; data always precedes handles.
 */
export class PagedLightStore {
  constructor(layout, columns, sections, { tableColumns = columns, extraRows = 0 } = {}) {
    this.layout = layout;
    this.columns = columns;
    this.sections = sections;
    this.tableColumns = tableColumns;
    this.tableRows = sections + extraRows;
    this.capacity = layout.across * layout.down * layout.layers * layout.banks;
    if (columns * sections > this.capacity) throw new RangeError("Required lighting pages exceed pinned capacity");
    this.context = 1;
    this.identity = Symbol("paged-light-store");
    this.mapping = new Uint16Array(tableColumns * this.tableRows);
    this.generations = new Uint32Array(this.mapping.length);
    this.owners = Array(this.mapping.length).fill(null);
    this.pages = new Map();
    this.queue = new Map();
    this.free = [];
    this.nextPhysical = 0;
    this.mappingDirty = true;
    this.makeTextures();
  }

  makeTextures() {
    this.table = configure(new THREE.DataTexture(this.mapping, this.tableColumns, this.tableRows,
      THREE.RedIntegerFormat, THREE.UnsignedShortType));
    this.table.internalFormat = "R16UI";
    this.placeholder = configure(new THREE.DataArrayTexture(null, 1, 1, 1));
    this.placeholder.format = THREE.RedFormat;
    this.banks = Array(this.layout.banks).fill(this.placeholder);
    this.staging = new THREE.DataTexture(null, this.layout.width, this.layout.height, THREE.RedFormat);
    this.staging.unpackAlignment = 1;
    // Never initTexture() staging: that selects Three's GPU framebuffer branch.
    this.tableStaging = new THREE.DataTexture(this.mapping, this.tableColumns, this.tableRows,
      THREE.RedIntegerFormat, THREE.UnsignedShortType);
    this.tableStaging.unpackAlignment = 1;
  }

  claim(index, owner) {
    if (this.disposed) throw new Error("Cannot claim a disposed lighting store");
    if (index < 0 || index >= this.mapping.length || !Number.isInteger(index))
      throw new RangeError("Invalid logical light address");
    if (this.owners[index] !== owner) {
      this.invalidate(index);
      this.owners[index] = owner;
    }
    return { index, owner, generation: this.generations[index], context: this.context, store: this.identity };
  }

  current(ticket) {
    return !this.disposed && ticket.store === this.identity && ticket.context === this.context && ticket.generation === this.generations[ticket.index] &&
      ticket.owner === this.owners[ticket.index];
  }

  invalidate(index) {
    this.generations[index]++;
    this.owners[index] = null;
    this.mapping[index] = 0;
    this.mappingDirty = true;
    const page = this.pages.get(index);
    if (page?.physical !== undefined) this.free.push(page.physical);
    this.pages.delete(index);
    this.queue.delete(index);
    if (this.generations[index] === 0) this.restoreGPU();
  }

  invalidateAll() {
    // Fixed-capacity typed clears are the emergency barrier. Do not walk
    // every page/owner or dispose/reallocate banks on a global revision.
    this.context++;
    this.mapping.fill(0);
    this.owners.fill(null);
    this.pages.clear();
    this.queue.clear();
    this.free = [];
    this.nextPhysical = 0;
    this.mappingDirty = true;
  }

  publish(ticket, values) {
    if (!this.current(ticket)) return false;
    if (values != null && typeof values !== "number" &&
      (!(values instanceof Uint8Array) || values.length !== this.layout.width * this.layout.height))
      throw new RangeError("Incorrect canonical light page size");
    if (this.pages.has(ticket.index)) return true;
    let constant = typeof values === "number" ? values : values?.[0] ?? 0;
    if (values instanceof Uint8Array && !values.every((value) => value === constant)) constant = null;
    if (constant !== null && (!Number.isInteger(constant) || constant < 0 || constant > 255))
      throw new RangeError("Invalid constant light page");
    const page = { ticket, values: constant === null ? values : null, constant };
    if (constant === null) {
      page.physical = this.free.length ? this.free.pop() : this.nextPhysical++;
      if (page.physical >= this.capacity) throw new RangeError("Pinned lighting capacity exhausted");
    }
    this.pages.set(ticket.index, page);
    this.queue.set(ticket.index, page);
    return true;
  }

  address(physical) {
    const l = this.layout, perLayer = l.across * l.down, perBank = perLayer * l.layers;
    return { bank: Math.floor(physical / perBank), layer: Math.floor(physical / perLayer) % l.layers,
      x: physical % l.across * l.width, y: Math.floor(physical / l.across) % l.down * l.height };
  }

  ensureBank(renderer, index) {
    if (this.banks[index] !== this.placeholder) return this.banks[index];
    const l = this.layout, gl = renderer.getContext();
    if (gl.getParameter(gl.MAX_TEXTURE_SIZE) < Math.max(2048, l.width * l.across, l.height * l.down) ||
      gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) < Math.max(256, l.layers))
      throw new RangeError("Insufficient WebGL2 dimensions for pinned lighting banks");
    const texture = configure(new THREE.DataArrayTexture(null, l.width * l.across, l.height * l.down, l.layers));
    texture.format = THREE.RedFormat;
    try {
      checkedLightTransfer(renderer, "bank allocation", () => renderer.initTexture(texture));
    } catch (error) {
      texture.dispose();
      throw error;
    }
    this.banks[index] = texture;
    return texture;
  }

  uploadMapping(renderer, budget, mapping = this.mapping) {
    const bytes = this.mapping.byteLength;
    if (budget.bytes < bytes || budget.copies < 1) throw new Error("Lighting invalidation barrier lacks reserved budget");
    this.mappingDirty = true;
    // Attempts consume budget too. In particular an OOM cannot permit an
    // unbounded retry loop inside a shared frame budget.
    budget.bytes -= bytes; budget.copies--; budget.uploadedBytes += bytes; budget.mappingBytes += bytes;
    this.tableStaging.image.data = mapping;
    try {
      checkedLightTransfer(renderer, "page table", () => renderer.copyTextureToTexture(this.tableStaging, this.table));
    } finally {
      this.tableStaging.image.data = this.mapping;
    }
    if (mapping !== this.mapping) this.mapping.set(mapping);
    this.mappingDirty = false;
  }

  flushInvalidations(renderer, budget) {
    this.transferFailed = true;
    if (this.disposed || renderer.getContext().isContextLost()) throw new Error("Lighting invalidation barrier unavailable");
    if (this.mappingDirty) this.uploadMapping(renderer, budget);
    this.transferFailed = false;
  }

  setAuxiliary(index, value) {
    if (this.mapping[index] === value) return;
    this.mapping[index] = value;
    this.mappingDirty = true;
  }

  publishAuxiliary(renderer, budget, entries) {
    const candidate = this.mapping.slice();
    for (const [index, value] of entries) candidate[index] = value;
    this.uploadMapping(renderer, budget, candidate);
  }

  flush(renderer, budget = lightUploadBudget()) {
    this.flushInvalidations(renderer, budget);
    this.transferFailed = true;
    budget.publications ??= LIGHT_UPLOAD_PUBLICATIONS;
    let candidate;
    const published = [];
    for (const [index, page] of this.queue) {
      if (!budget.publications) break;
      if (!this.current(page.ticket)) { this.queue.delete(index); continue; }
      const bytes = page.values?.byteLength ?? 0, copies = page.values ? 1 : 0;
      if (budget.bytes < bytes + this.mapping.byteLength || budget.copies < copies + 1) break;
      budget.publications--;
      if (page.values) {
        const at = this.address(page.physical), bank = this.ensureBank(renderer, at.bank);
        this.staging.image.data = page.values;
        budget.bytes -= bytes; budget.copies--; budget.uploadedBytes += bytes; budget.pageCopies++;
        try {
          checkedLightTransfer(renderer, "page data", () =>
            renderer.copyTextureToTexture(this.staging, bank, null, new THREE.Vector3(at.x, at.y, at.layer)));
        } finally {
          this.staging.image.data = null;
        }
      }
      candidate ??= this.mapping.slice();
      candidate[index] = page.constant === null ? LIGHT_PHYSICAL_HANDLE + page.physical :
        page.constant === 0 ? 1 : 2 + page.constant;
      published.push(index);
    }
    if (candidate) {
      this.uploadMapping(renderer, budget, candidate);
      for (const index of published) this.queue.delete(index);
    }
    this.transferFailed = false;
    return budget;
  }

  sample(index, cell) {
    if (!this.mapping[index]) return undefined;
    const page = this.pages.get(index);
    return page ? page.constant ?? page.values[cell] : undefined;
  }

  restoreGPU() {
    const retained = [...this.pages.values()];
    this.disposeTextures();
    this.context++;
    this.mapping.fill(0);
    this.mappingDirty = true;
    this.makeTextures();
    this.queue.clear();
    for (const page of retained) {
      page.ticket = { ...page.ticket, context: this.context };
      this.queue.set(page.ticket.index, page);
    }
  }

  resources() {
    const l = this.layout, bankBytes = l.width * l.across * l.height * l.down * l.layers;
    let readyPages = 0;
    for (let y = 0; !this.disposed && !this.mappingDirty && !this.transferFailed && y < this.sections; y++)
      for (let x = 0; x < this.columns; x++) readyPages += Number(this.mapping[y * this.tableColumns + x] !== 0);
    const requiredPages = this.disposed ? 0 : this.columns * this.sections;
    return { gpuBytes: this.disposed ? 0 : this.banks.filter((b) => b !== this.placeholder).length * bankBytes + this.mapping.byteLength + 1,
      maxGpuBytes: l.banks * bankBytes + this.mapping.byteLength + 1,
      tableBytes: this.mapping.byteLength, generationBytes: this.generations.byteLength,
      canonicalBytes: [...new Set([...this.pages.values()].filter((p) => p.values).map((p) => p.values.buffer))]
        .reduce((n, buffer) => n + buffer.byteLength, 0),
      cpuBankBytes: 0, stagingBytes: 0, capacity: this.capacity, requiredPages,
      pinnedPages: this.pages.size, readyPages, pendingRequired: requiredPages - readyPages,
      pendingUploads: this.queue.size, pendingBarriers: Number(!this.disposed && (this.mappingDirty || this.transferFailed)),
      banks: this.banks.filter((b) => b !== this.placeholder).length };
  }

  disposeTextures() {
    for (const texture of new Set([...this.banks, this.placeholder, this.table, this.staging, this.tableStaging])) texture.dispose();
  }

  dispose() {
    this.disposeTextures();
    this.disposed = true;
    this.context++;
    this.pages.clear(); this.queue.clear();
    this.mapping.fill(0);
    this.mapping = new Uint16Array(0);
    this.generations = new Uint32Array(0);
    this.owners = []; this.banks = []; this.free = [];
    this.table.image.data = this.tableStaging.image.data = this.staging.image.data = null;
  }
}
