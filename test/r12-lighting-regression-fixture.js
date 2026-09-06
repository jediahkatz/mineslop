import { BLOCK } from "../src/blocks.js";

// Authored arrays only: no generator, worker, browser, or shared legacy fixture.
export function authoredLightingWorld(radius = 1, height = 16) {
  const air = new Uint16Array(height * 256);
  const world = {
    dimension: "overworld", epoch: 1, generatorVersion: 4, _editRevision: 0,
    spec: { minY: 0, maxY: height }, chunks: new Map(),
    getCell(x, y, z) {
      const chunk = this.chunks.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`);
      if (!chunk || y < 0 || y >= height) return null;
      return { id: chunk.blocks[y * 256 + ((z % 16 + 16) % 16) * 16 + ((x % 16 + 16) % 16)], state: 0, fluid: 0 };
    },
    toggle() {
      const chunk = this.chunks.get("0,0");
      if (chunk.blocks === air) chunk.blocks = air.slice();
      const before = this.getCell(8, 8, 8);
      chunk.blocks[8 * 256 + 8 * 16 + 8] = before.id === BLOCK.STONE ? BLOCK.AIR : BLOCK.STONE;
      chunk.revision++;
      chunk.sectionRevisions.set(0, chunk.revision);
      this._editRevision++;
      return { dimension: this.dimension, epoch: this.epoch, revision: this._editRevision,
        changes: [{ x: 8, y: 8, z: 8, before, after: this.getCell(8, 8, 8) }] };
    },
  };
  for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++)
    world.chunks.set(`${x},${z}`, { blocks: air, revision: 0, incarnation: 1, sectionRevisions: new Map() });
  return world;
}

// Explicit GPU mirror: a failed transfer does NOT modify GPU state, just as
// WebGL reports OUT_OF_MEMORY without throwing a JavaScript exception.
export function faultRenderer() {
  let error = 0;
  const gl = {
    NO_ERROR: 0, OUT_OF_MEMORY: 1285, MAX_TEXTURE_SIZE: 1, MAX_ARRAY_TEXTURE_LAYERS: 2,
    isContextLost: () => renderer.lost,
    getParameter: (p) => p === 1 ? 2048 : 256,
    getError() { const value = error; error = 0; return value; },
  };
  const renderer = {
    calls: [], gpu: new Map(), lost: false, fail: null, mode: "throw",
    getContext: () => gl,
    transfer(source, target, kind) {
      const call = { kind, target, bytes: source.image.data?.byteLength ?? 0 };
      this.calls.push(call);
      if (this.fail?.(call, source)) {
        this.fail = null;
        if (this.mode === "throw") throw new Error("Injected lighting transfer failure");
        if (this.mode === "loss") this.lost = true;
        else error = gl.OUT_OF_MEMORY;
        return;
      }
      if (source.image.data) this.gpu.set(target, source.image.data.slice());
    },
    initTexture(texture) { this.transfer(texture, texture, "init"); },
    copyTextureToTexture(source, target) { this.transfer(source, target, "copy"); },
  };
  return renderer;
}
