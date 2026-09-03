import * as THREE from "three";
import { painter } from "./pixel-art.js";

const segments = [
  [8, 8, 6, 6],
  [8, 8, 10, 6],
  [8, 8, 10, 10],
  [8, 8, 5, 10],
  [6, 6, 5, 3],
  [10, 6, 12, 5],
  [10, 10, 11, 13],
  [5, 10, 3, 12],
  [6, 6, 3, 7],
  [10, 6, 10, 3],
  [10, 10, 13, 9],
  [5, 10, 5, 13],
  [5, 3, 2, 1],
  [12, 5, 15, 3],
  [11, 13, 13, 15],
  [3, 12, 0, 14],
  [3, 7, 0, 5],
  [10, 3, 12, 0],
  [13, 9, 15, 11],
  [5, 13, 6, 15],
  [5, 3, 7, 1],
  [12, 5, 14, 6],
  [11, 13, 8, 14],
  [3, 12, 1, 10],
  [3, 7, 1, 8],
  [10, 3, 8, 2],
  [13, 9, 14, 7],
  [5, 13, 3, 15],
  [2, 1, 0, 1],
  [15, 3, 15, 0],
  [13, 15, 15, 15],
  [1, 10, 0, 9],
];

/** Ten original connected crack stages, transparent outside the fractures. */
export function miningTexturePixels(stage) {
  if (!Number.isInteger(stage) || stage < 0 || stage > 9)
    throw new RangeError("Mining texture stage must be 0–9");
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  const { line } = painter(pixels);
  const count = Math.ceil(((stage + 1) / 10) * segments.length);
  for (let i = 0; i < count; i++) {
    const [x0, y0, x1, y1] = segments[i];
    line(x0, y0 + 1, x1, y1 + 1, [65, 65, 65, 110]);
  }
  for (let i = 0; i < count; i++) {
    const [x0, y0, x1, y1] = segments[i];
    line(x0, y0, x1, y1, [12, 12, 12, 230]);
  }
  return pixels;
}

export function createMiningTextures() {
  return Array.from({ length: 10 }, (_, stage) => {
    const texture = new THREE.DataTexture(miningTexturePixels(stage), 16, 16);
    texture.name = `Original mining cracks ${stage + 1}`;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  });
}
