import * as THREE from "three";
import { defaultFluidFor, FLUID, isWaterFluid } from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { BLOCK } from "./blocks.js";
import { readChunkCell } from "./chunk-data.js";
import { readGeometryCell } from "./geometry-world.js";
import { localLightStyle } from "./local-lighting.js";
import { opaqueCube } from "./mesh-palette.js";

export const LIGHT_BLOCKED = 16;
export const LIGHT_WATER = 32;
const emission = new Uint32Array(65536);
const knownEmission = new Uint8Array(65536);
export const BLOCK_LIGHT_PALETTE_BYTES = emission.byteLength + knownEmission.byteLength;

function lightCode(id) {
  if (knownEmission[id]) return emission[id];
  const style = localLightStyle(id);
  let value = 0;
  if (style) {
    const color = new THREE.Color(style.color);
    value = ((Math.round(color.r * 255) << 24) |
      (Math.round(color.g * 255) << 16) |
      (Math.round(color.b * 255) << 8) | style.level) >>> 0;
  }
  emission[id] = value;
  knownEmission[id] = 1;
  return value;
}

// Detached, complete section input. No mesh emitter limit and no dependency
// on mesh visibility. Partial opaque shapes conservatively block their cell.
export class BlockLightTopologyJob {
  constructor(field, target) {
    Object.assign(this, target);
    this.signature = field.revisions.signature(field.world, this.x, this.z, this.y, 1);
    this.values = null;
    this.cursor = 0;
    this.emitters = 0;
    this.uniform = undefined;
  }

  step(field, budget) {
    const chunk = field.world.chunks.get(`${this.x},${this.z}`);
    const section = chunk.sections?.get(this.y);
    while (this.cursor < 4096 && budget.scan()) {
      const i = this.cursor++, at = (this.y * 16 - field.spec.minY) * 256 + i;
      const id = chunk.blocks[at];
      const fluid = section?.fluids?.[i] ?? (id === BLOCK.AIR ? FLUID.NONE : defaultFluidFor(id));
      let code = id === BLOCK.AIR ? 0 : lightCode(id);
      if (fluid === FLUID.LAVA_SOURCE) code = lightCode(BLOCK.LAVA);
      if (code & 15) this.emitters++;
      let blocked = opaqueCube[id];
      if (id !== BLOCK.AIR && id !== BLOCK.WATER && id !== BLOCK.LAVA && !blocked) {
        const cell = readChunkCell(chunk, at);
        const x = this.x * 16 + i % 16;
        const y = this.y * 16 + Math.floor(i / 256);
        const z = this.z * 16 + Math.floor(i / 16) % 16;
        blocked = resolveShape(cell, (dx, dy, dz) => {
          field.stats.shapeReads++;
          return readGeometryCell(field.world, x + dx, y + dy, z + dz);
        }).occlusion.length > 0;
      }
      code = (code | (blocked ? LIGHT_BLOCKED : 0) | (isWaterFluid(fluid) ? LIGHT_WATER : 0)) >>> 0;
      if (i === 0) this.uniform = code;
      else if (this.uniform !== code && !this.values) {
        this.values = new Uint32Array(4096);
        this.values.fill(this.uniform, 0, i);
        this.uniform = null;
      }
      if (this.values) this.values[i] = code;
    }
    if (this.cursor !== 4096) return null;
    if (this.signature !== field.revisions.signature(field.world, this.x, this.z, this.y, 1))
      return { stale: true };
    return { x: this.x, z: this.z, y: this.y, emitters: this.emitters,
      uniform: this.uniform, values: this.uniform === null ? this.values : null };
  }
}
