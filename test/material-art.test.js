import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../src/blocks.js";
import { paintNaturalMaterial } from "../src/material-art.js";
import { grain, painter, rgb } from "../src/pixel-art.js";
import { blockEmissionPixels, blockTexturePixels } from "../src/textures.js";

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
    block.oreHost === "deepslate" ? "side" : face
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

test("each ore keeps its declared host around bounded mineral pockets and grains", () => {
  for (const block of ores) {
    for (const face of ["side", "top", "bottom"]) {
      const pixels = blockTexturePixels(block.id, face);
      const mask = mineralMask(pixels, oreHost(block, face));
      const covered = mask.reduce((sum, value) => sum + value, 0);
      // Java 26.2 Nether gold is a sparser small-nugget family (33 colored
      // reference pixels), not the ordinary-gold pocket layout.
      const [minimum, maximum] =
        block.id === BLOCK.NETHER_GOLD_ORE ? [24, 48] : [36, 76];
      assert.ok(
        covered >= minimum && covered <= maximum,
        `${block.name}: ${covered}/256 mineral pixels`
      );
      const groups = components(mask);
      // Vanilla Java 26.2 includes fine grains and more than five pockets.
      // The old large-island rule described our earlier art, not a safety limit.
      assert.ok(groups.length >= 2 && groups.length <= 16, block.name);
      assert.ok(groups.some((group) => group.length >= 4), `${block.name}: not only isolated noise`);
      for (const group of groups) {
        assert.ok(
          group.length <= 32,
          `${block.name}: bounded mineral groups`
        );
        const brightness = group.map(
          (i) => rgbAt(pixels, i).reduce((sum, value) => sum + value, 0) / 3
        );
        if (group.length >= 4)
          assert.ok(
            Math.max(...brightness) - Math.min(...brightness) >= 30,
            `${block.name}: shaded larger fragments`
          );
      }
      for (let i = 0; i < 256; i++) assert.equal(pixels[i * 4 + 3], 255);
    }
  }
});

test("ore silhouettes retain distinct bounded palettes without enabling emission", () => {
  const silhouettes = new Set();
  const minerals = new Map();
  for (const block of ores) {
    const pixels = blockTexturePixels(block.id);
    const mask = mineralMask(pixels, oreHost(block));
    const identity =
      block.id === BLOCK.NETHER_GOLD_ORE ? block.id : (block.oreArt ?? block.id);
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
    }
    // Pale/high-RGB gold and gem facets occur in the vanilla reference.
    // They are diffuse texture colors, not permission to make ores glow.
    assert.ok(blockEmissionPixels(block.id).every((value) => value === 0), `${block.name}: no default emission`);
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

test("reference host ramps stay bounded, opaque, non-emissive and coherent with distant colors", () => {
  // Vanilla stone spans 39 gray levels and deepslate sides span 74.
  // The old <=30 range and <=8 patch-span caps encoded our quiet-host design,
  // not fidelity. Keep bounded ramps and the actual distant-color contract.
  for (const id of [BLOCK.STONE, BLOCK.DEEPSLATE, BLOCK.NETHERRACK]) {
    const base = rgb(BLOCKS[id].color);
    assert.equal(Boolean(BLOCKS[id].emissive), false);
    assert.ok(blockEmissionPixels(id).every((value) => value === 0));
    for (const face of ["side", "top", "bottom"]) {
      const pixels = blockTexturePixels(id, face);
      assert.equal(pixels.length, 1024);
      assert.deepEqual(pixels, blockTexturePixels(id, face));
      const colors = new Set();
      for (let i = 0; i < 256; i++) {
        assert.equal(pixels[i * 4 + 3], 255);
        const [r, g, b] = rgbAt(pixels, i);
        colors.add(`${r},${g},${b}`);
        if (id === BLOCK.NETHERRACK)
          assert.ok(r > g + 32 && Math.abs(g - b) <= 8, "red host matrix");
        else
          assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 8, "neutral gray");
      }
      assert.ok(colors.size >= 4 && colors.size <= 8, "bounded authored ramp");
      for (let channel = 0; channel < 3; channel++) {
        const values = Array.from(
          { length: 256 },
          (_, i) => pixels[i * 4 + channel]
        );
        const mean = values.reduce((sum, value) => sum + value, 0) / 256;
        // Distant terrain reads BLOCKS[id].color, including exposed rock.
        const tolerance = id === BLOCK.STONE ? 8 : 10;
        assert.ok(
          Math.abs(mean - base[channel]) <= tolerance,
          `${id}/${face}: LOD mean`
        );
        const maximumRange = id === BLOCK.STONE ? 48 : 80;
        assert.ok(Math.max(...values) - Math.min(...values) <= maximumRange);
      }
    }
  }
});

test("stone and netherrack painters replace a bounded view deterministically", () => {
  for (const id of [BLOCK.STONE, BLOCK.NETHERRACK]) {
    for (const face of ["side", "top", "bottom"]) {
      const expected = blockTexturePixels(id, face);
      for (const BufferType of [Uint8Array, Uint8ClampedArray]) {
        const guarded = new BufferType(1056).fill(73);
        const target = guarded.subarray(16, 1040);
        assert.equal(paintNaturalMaterial(target, BLOCKS[id], face), true);
        assert.deepEqual([...target], [...expected]);
        assert.equal(paintNaturalMaterial(target, BLOCKS[id], face), true);
        assert.deepEqual([...target], [...expected], "idempotent full-tile paint");
        assert.ok(guarded.subarray(0, 16).every((value) => value === 73));
        assert.ok(guarded.subarray(1040).every((value) => value === 73));
      }
    }
  }
});

test("host refinements leave every unrelated natural-material face byte-identical", () => {
  const hash = createHash("sha256");
  let faces = 0;
  for (const block of BLOCK_CATALOG) {
    if ([BLOCK.STONE, BLOCK.NETHERRACK].includes(block.id)) continue;
    for (const face of ["side", "top", "bottom"]) {
      const pixels = new Uint8ClampedArray(1024);
      if (!paintNaturalMaterial(pixels, block, face)) continue;
      hash.update(`${block.id}/${face}:`).update(pixels);
      faces++;
    }
  }
  assert.equal(faces, 108);
  assert.equal(
    hash.digest("hex"),
    "175d393e7e11cc596ee3ab316de443a4da5059c903b243652a2bfd433a58533b"
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
