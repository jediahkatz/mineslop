import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { paintNaturalMaterial } from "../src/material-art.js";
import { grain, painter, rgb } from "../src/pixel-art.js";
import { blockTexturePixels } from "../src/textures.js";

const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const rgbAt = (pixels, i) => Array.from(pixels.subarray(i * 4, i * 4 + 3));
const ores = BLOCKS.filter((block) => block.texture === "ore");
const oreHost = (block, face = "side") =>
  blockTexturePixels(
    block.oreHost === "deepslate"
      ? BLOCK.DEEPSLATE
      : block.oreHost === "netherrack"
        ? BLOCK.NETHERRACK
        : BLOCK.STONE,
    face
  );

function components(mask) {
  const visited = new Set();
  const result = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited.has(start)) continue;
    const group = [];
    const queue = [start];
    visited.add(start);
    for (let index = 0; index < queue.length; index++) {
      const at = queue[index];
      const x = at % 16;
      const y = Math.floor(at / 16);
      group.push(at);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= 16 || ny < 0 || ny >= 16) continue;
        const next = ny * 16 + nx;
        if (mask[next] && !visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    result.push(group);
  }
  return result;
}

function mineralMask(pixels, stone) {
  return Uint8Array.from({ length: 256 }, (_, i) =>
    Number(
      [0, 1, 2].some(
        (channel) => pixels[i * 4 + channel] !== stone[i * 4 + channel]
      )
    )
  );
}

test("periodic grain and tiled pixel stamps preserve hard edges and transparent ink", () => {
  for (let y = -1; y < 16; y++) {
    for (let x = -1; x < 16; x++) {
      const value = grain(x, y, 311, 4, 5);
      assert.ok(value >= 0 && value <= 1);
      assert.equal(value, grain(x + 16, y, 311, 4, 5));
      assert.equal(value, grain(x, y + 16, 311, 4, 5));
    }
  }
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  const p = painter(pixels);
  p.stamp(15, 15, ["01", ".0"], ["#123456", "#abcdef"], true);
  assert.deepEqual(Array.from(pixels.subarray(255 * 4)), [18, 52, 86, 255]);
  assert.deepEqual(
    Array.from(pixels.subarray(240 * 4, 241 * 4)),
    [171, 205, 239, 255]
  );
  assert.deepEqual(Array.from(pixels.subarray(0, 4)), [18, 52, 86, 255]);
  p.stamp(0, 0, ["0"], [[0, 0, 0, 0]]);
  assert.ok(pixels.subarray(0, 4).every((value) => value === 0));
});

test("each ore keeps its declared natural host around a few connected deposits", () => {
  for (const block of ores) {
    for (const face of ["side", "top", "bottom"]) {
      const pixels = blockTexturePixels(block.id, face);
      const mask = mineralMask(pixels, oreHost(block, face));
      const covered = mask.reduce((sum, value) => sum + value, 0);
      // The old independent-cell confetti also repainted the entire host.
      assert.ok(
        covered >= 36 && covered <= 76,
        `${block.name}: ${covered}/256 mineral pixels`
      );
      const groups = components(mask);
      assert.ok(groups.length >= 3 && groups.length <= 5, block.name);
      for (const group of groups) {
        assert.ok(
          group.length >= 6 && group.length <= 32,
          `${block.name}: connected mineral masses, not specks`
        );
        const brightness = group.map(
          (i) => rgbAt(pixels, i).reduce((sum, value) => sum + value, 0) / 3
        );
        assert.ok(
          Math.max(...brightness) - Math.min(...brightness) >= 30,
          `${block.name}: shaded facets`
        );
      }
      for (let i = 0; i < 256; i++) assert.equal(pixels[i * 4 + 3], 255);
    }
  }
});

test("ore silhouettes and restrained palettes distinguish minerals without white sparkle noise", () => {
  const silhouettes = new Set();
  const minerals = new Map();
  for (const block of ores) {
    const pixels = blockTexturePixels(block.id);
    const mask = mineralMask(pixels, oreHost(block));
    const identity = block.oreArt ?? block.id;
    const silhouette = digest(mask);
    if (minerals.has(identity))
      assert.equal(
        silhouette,
        minerals.get(identity),
        `${block.name}: host changes preserve the mineral pattern`
      );
    else {
      minerals.set(identity, silhouette);
      silhouettes.add(silhouette);
    }
    const colors = new Set();
    for (let i = 0; i < 256; i++) {
      if (!mask[i]) continue;
      const color = rgbAt(pixels, i);
      colors.add(color.join(","));
      assert.ok(
        color.every((channel) => channel < 245),
        `${block.name}: no clipped highlights`
      );
    }
    assert.ok(
      colors.size >= 4 && colors.size <= 6,
      `${block.name}: cavity, body and facet palette`
    );
  }
  assert.equal(
    silhouettes.size,
    minerals.size,
    "different minerals have distinct silhouettes; the same mineral may occur in multiple hosts"
  );
});

test("ground art uses recurring connected tones rather than a new noise color per pixel", () => {
  for (const [id, face] of [
    [BLOCK.STONE, "side"],
    [BLOCK.DIRT, "side"],
    [BLOCK.GRASS, "top"],
    [BLOCK.MOSS, "side"],
    [BLOCK.DRIPSTONE, "side"],
  ]) {
    const pixels = blockTexturePixels(id, face);
    const colors = new Map();
    for (let i = 0; i < 256; i++) {
      const color = rgbAt(pixels, i).join(",");
      colors.set(color, (colors.get(color) ?? 0) + 1);
    }
    assert.ok(colors.size >= 4 && colors.size <= 16, BLOCKS[id].name);
    assert.ok(Math.max(...colors.values()) >= 20, BLOCKS[id].name);
  }
});

test("stone stays neutral and close to its distant color without broad contrast", () => {
  const pixels = blockTexturePixels(BLOCK.STONE);
  const base = rgb(BLOCKS[BLOCK.STONE].color);
  const means = [];
  for (let channel = 0; channel < 3; channel++) {
    const values = Array.from(
      { length: 256 },
      (_, i) => pixels[i * 4 + channel]
    );
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    means.push(mean);
    assert.ok(
      Math.abs(mean - base[channel]) <= 8,
      "retain the distant LOD mean"
    );
    assert.ok(
      Math.max(...values) - Math.min(...values) <= 30,
      "grain must not create high-contrast cave camouflage"
    );
  }
  assert.ok(Math.max(...means) - Math.min(...means) <= 6, "neutral gray host");
  const patches = [];
  for (let y = 0; y < 16; y += 4) {
    for (let x = 0; x < 16; x += 4) {
      let brightness = 0;
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 4; dx++) {
          const color = rgbAt(pixels, (y + dy) * 16 + x + dx);
          brightness += (color[0] + color[1] + color[2]) / 3;
        }
      patches.push(brightness / 16);
    }
  }
  assert.ok(
    Math.max(...patches) - Math.min(...patches) <= 8,
    "small grains must not collect into a large light/dark emblem"
  );
});

test("moss is a low-contrast opaque mat rather than dark-edged foliage", () => {
  const pixels = blockTexturePixels(BLOCK.MOSS);
  for (let i = 0; i < 256; i++) assert.equal(pixels[i * 4 + 3], 255);
  for (let channel = 0; channel < 3; channel++) {
    const values = Array.from(
      { length: 256 },
      (_, i) => pixels[i * 4 + channel]
    );
    assert.ok(
      Math.max(...values) - Math.min(...values) <= 40,
      "moss fibers must not have the deep outlines of separate leaves"
    );
  }
});

test("leaf cutouts are small connected gaps between opaque foliage clumps", () => {
  for (const block of BLOCKS.filter(
    (entry) => entry.texture === "leaves" && entry.shape === "cube"
  )) {
    const pixels = blockTexturePixels(block.id);
    const holes = Uint8Array.from({ length: 256 }, (_, i) =>
      Number(pixels[i * 4 + 3] === 0)
    );
    const count = holes.reduce((sum, value) => sum + value, 0);
    assert.ok(count >= 12 && count <= 32, block.name);
    for (const group of components(holes))
      assert.ok(
        group.length >= 2 && group.length <= 6,
        `${block.name}: grouped cutouts, not pinholes`
      );
    for (let i = 0; i < 256; i++)
      assert.ok(pixels[i * 4 + 3] === 0 || pixels[i * 4 + 3] === 255);
  }
});

test("surface caps share actual dirt underneath without tinting the whole block", () => {
  const dirt = blockTexturePixels(BLOCK.DIRT);
  for (const id of [BLOCK.GRASS, BLOCK.SNOW, BLOCK.PODZOL, BLOCK.MYCELIUM]) {
    const side = blockTexturePixels(id);
    assert.deepEqual(blockTexturePixels(id, "bottom"), dirt);
    assert.notDeepEqual(blockTexturePixels(id, "top"), dirt);
    assert.deepEqual(side.subarray(6 * 16 * 4), dirt.subarray(6 * 16 * 4));
    assert.notDeepEqual(side, dirt);
  }
});

test("natural-material dispatch does not replace utility graphics", () => {
  const pixels = new Uint8ClampedArray(16 * 16 * 4).fill(17);
  assert.equal(
    paintNaturalMaterial(pixels, BLOCKS[BLOCK.CRAFTING_TABLE], "top"),
    false
  );
  assert.ok(pixels.every((value) => value === 17));
});
