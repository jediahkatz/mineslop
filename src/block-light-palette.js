import * as THREE from "three";
import { BLOCKS } from "./blocks.js";
import { localLightStyle } from "./local-lighting.js";

/** Exact palette, with an explicit error instead of silent quantization.
 * Built from the same emission colors, including every possible attenuated
 * level. Solver selection, water cost and packed-color ties remain unchanged.
 */
export class ExactLightPalette {
  constructor() {
    this.colors = new Map();
    this.bytes = new Uint8Array(256 * 4);
    this.add(0, 0, 0);
  }

  add(r, g, b) {
    const key = r * 65536 + g * 256 + b;
    if (this.colors.has(key)) return this.colors.get(key);
    const index = this.colors.size;
    if (index >= 256) throw new RangeError("Exact block-light RGB palette exceeds R8 capacity");
    this.colors.set(key, index);
    this.bytes.set([r, g, b, 255], index * 4);
    return index;
  }

  encode(rgba) {
    const out = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < out.length; i++) {
      const at = i * 4, key = rgba[at] * 65536 + rgba[at + 1] * 256 + rgba[at + 2];
      const code = this.colors.get(key);
      if (code === undefined) throw new RangeError(`Unregistered exact block-light RGB ${key}`);
      out[i] = code;
    }
    return out;
  }

  decode(code) {
    return Array.from(this.bytes.subarray(code * 4, code * 4 + 3));
  }
}

export const blockLightPalette = new ExactLightPalette();
for (const id of Object.keys(BLOCKS)) {
  const style = localLightStyle(Number(id));
  if (!style) continue;
  const color = new THREE.Color(style.color);
  const rgb = [color.r, color.g, color.b].map((v) => Math.round(v * 255));
  for (let level = 1; level <= style.level; level++) {
    const weight = (level / 15) ** 2;
    blockLightPalette.add(...rgb.map((v) => Math.round(v * weight)));
  }
}

export function blockPaletteTexture() {
  const texture = new THREE.DataTexture(blockLightPalette.bytes, 256, 1);
  texture.source.dataReady = false;
  texture.needsUpdate = true;
  return texture;
}
