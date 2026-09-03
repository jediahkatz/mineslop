import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import {
  createMiningTextures,
  miningTexturePixels,
} from "../src/mining-art.js";

test("mining cracks grow through ten deterministic transparent stages", () => {
  let previous = new Set();
  const frames = new Set();
  for (let stage = 0; stage < 10; stage++) {
    const pixels = miningTexturePixels(stage);
    assert.equal(pixels.length, 16 * 16 * 4);
    assert.deepEqual(pixels, miningTexturePixels(stage));
    frames.add(createHash("sha256").update(pixels).digest("hex"));
    const ink = new Set();
    let empty = 0;
    for (let pixel = 0; pixel < 256; pixel++) {
      const alpha = pixels[pixel * 4 + 3];
      if (alpha > 200) ink.add(pixel);
      if (alpha === 0) empty++;
    }
    assert.ok(
      ink.size > previous.size,
      `stage ${stage}: new connected fractures`
    );
    assert.ok(empty > 0, "cracks never become a solid colored fill");
    for (const pixel of previous)
      assert.ok(ink.has(pixel), "existing cracks remain");
    previous = ink;
  }
  assert.equal(frames.size, 10);
  for (const stage of [-1, 10, 0.5, NaN])
    assert.throws(() => miningTexturePixels(stage), /0–9/);
});

test("crack maps are small nearest-filtered GPU textures with explicit ownership", () => {
  const textures = createMiningTextures();
  assert.equal(textures.length, 10);
  for (const [stage, texture] of textures.entries()) {
    assert.equal(texture.image.width, 16);
    assert.equal(texture.image.height, 16);
    assert.equal(texture.magFilter, THREE.NearestFilter);
    assert.equal(texture.minFilter, THREE.NearestFilter);
    assert.equal(texture.generateMipmaps, false);
    assert.deepEqual(texture.image.data, miningTexturePixels(stage));
    texture.dispose();
  }
});
