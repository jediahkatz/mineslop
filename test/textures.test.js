import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import * as THREE from "three";
import { BLOCK, BLOCK_CATALOG } from "../src/blocks.js";
import { ITEM, ITEMS } from "../src/items.js";
import {
  blockEmissionPixels,
  blockTexturePixels,
  createAtlas,
  itemTexturePixels,
  tileFor,
} from "../src/textures.js";

const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const alpha = (pixels) =>
  Array.from({ length: pixels.length / 4 }, (_, i) => pixels[i * 4 + 3]);

test("every registered block has its own atlas tile and a deterministic nonempty texture", () => {
  const tiles = new Set();
  const textures = new Map();
  const declaredSources = new Set();
  for (const block of BLOCK_CATALOG) {
    const side = tileFor(block.id);
    assert.equal(
      tiles.has(side),
      false,
      `${block.name} must not use another block's fallback`
    );
    tiles.add(side);
    for (const face of ["side", "top", "bottom"]) {
      const pixels = blockTexturePixels(block.id, face);
      assert.equal(pixels.length, 16 * 16 * 4);
      assert.deepEqual(pixels, blockTexturePixels(block.id, face));
      assert.ok(Number.isInteger(tileFor(block.id, face)));
      if (block.id)
        assert.ok(
          alpha(pixels).some((value) => value > 0),
          `${block.name} ${face} is visible`
        );
      else assert.ok(alpha(pixels).every((value) => value === 0));
      if (block.solid && !block.transparent)
        assert.ok(
          alpha(pixels).every((value) => value === 255),
          `${block.name} ${face} must not acquire alpha holes`
        );
    }
    assert.deepEqual(itemTexturePixels(block.id), blockTexturePixels(block.id));
    if (block.id) {
      const hash = digest(blockTexturePixels(block.id));
      const previous = textures.get(hash);
      if (previous) {
        assert.ok(
          previous.art && block.art,
          `${block.name} must not inherit an unrelated procedural fallback`
        );
        assert.deepEqual(
          block.art,
          previous.art,
          "only explicitly shared material descriptors may reuse pixels"
        );
      } else textures.set(hash, block);
      declaredSources.add(
        block.art ? JSON.stringify(block.art) : `legacy:${block.id}`
      );
    }
  }
  assert.equal(
    textures.size,
    declaredSources.size,
    "unrelated materials have distinct sources; declared shape families may share art"
  );
  assert.throws(() => tileFor(9999), RangeError);
  assert.throws(() => blockTexturePixels(9999), RangeError);
});

test("logs have distinct bark and end grain while plants and foliage use alpha cutouts", () => {
  for (const block of BLOCK_CATALOG) {
    if (block.texture === "log" && block.shape === "cube") {
      assert.notEqual(tileFor(block.id, "side"), tileFor(block.id, "top"));
      assert.notDeepEqual(
        blockTexturePixels(block.id),
        blockTexturePixels(block.id, "top")
      );
    }
    if (block.texture === "leaves" || block.shape === "cross") {
      const values = alpha(blockTexturePixels(block.id));
      assert.ok(
        values.some((value) => value === 0),
        block.name
      );
      assert.ok(
        values.some((value) => value === 255),
        block.name
      );
    }
  }
});

test("hanging vine cutouts attach at the top and berries have their own small silhouette", () => {
  const vine = blockTexturePixels(BLOCK.CAVE_VINE);
  const berries = blockTexturePixels(BLOCK.GLOW_BERRIES);
  for (const pixels of [vine, berries]) {
    const values = alpha(pixels);
    assert.equal(values[7], 255, "the hanging stem reaches the ceiling edge");
    assert.ok(values.filter((value) => value === 255).length < 128);
    assert.ok(values.slice(0, 16).filter((value) => value === 255).length <= 2);
  }
  assert.notDeepEqual(alpha(vine), alpha(berries));
  assert.notDeepEqual(berries, blockTexturePixels(BLOCK.GLOWSTONE));
});

test("berry emission covers only small fruit pixels, never green leaves, stems or transparent space", () => {
  const diffuse = blockTexturePixels(BLOCK.GLOW_BERRIES);
  const emission = blockEmissionPixels(BLOCK.GLOW_BERRIES);
  let glowing = 0;
  let green = 0;
  for (let at = 0; at < diffuse.length; at += 4) {
    const emits = emission[at] + emission[at + 1] + emission[at + 2] > 0;
    if (emits) {
      glowing++;
      assert.equal(diffuse[at + 3], 255);
      assert.deepEqual(
        emission.subarray(at, at + 4),
        diffuse.subarray(at, at + 4),
        "fruit and emission paint the same actual pixels"
      );
      assert.ok(diffuse[at] > diffuse[at + 1]);
    }
    if (diffuse[at + 1] > diffuse[at] && diffuse[at + 3]) {
      green++;
      assert.equal(emits, false, "green foliage must respond to light");
    }
    if (!diffuse[at + 3]) assert.equal(emits, false);
  }
  // The regression was a whole full-bright sprig, not a small fruit accent.
  assert.ok(green > 20);
  assert.ok(glowing > 0 && glowing <= 16);
  for (const block of BLOCK_CATALOG) {
    if (block.id !== BLOCK.GLOW_BERRIES)
      assert.ok(
        blockEmissionPixels(block.id).every((value) => value === 0),
        `${block.name} must not leak into the fruit-only emission atlas`
      );
  }
  assert.throws(() => blockEmissionPixels(9999), RangeError);
});

test("CPU atlases preserve every texel, gutter and UV with fruit-only emission", () => {
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      const canvas = { width: 0, height: 0, draws: [] };
      const context = {
        createImageData: (width, height) => ({
          data: new Uint8ClampedArray(width * height * 4),
        }),
        putImageData: (image) => {
          canvas.pixels = image.data;
        },
        drawImage: (...args) => canvas.draws.push(args),
      };
      canvas.getContext = () => context;
      return canvas;
    },
  };
  let atlas;
  let second;
  try {
    atlas = createAtlas();
    second = createAtlas();
    assert.equal(atlas.texture.isDataTexture, true);
    assert.equal(atlas.texture.flipY, false);
    assert.equal(second.texture.image.data, atlas.texture.image.data);
    assert.equal(
      second.emissiveTexture.image.data,
      atlas.emissiveTexture.image.data
    );
    assert.notEqual(
      second.texture, atlas.texture, "renderer owners dispose their own textures"
    );
    assert.equal(atlas.texture.colorSpace, THREE.SRGBColorSpace);
    assert.equal(atlas.texture.magFilter, THREE.NearestFilter);
    assert.equal(atlas.texture.minFilter, THREE.NearestFilter);
    assert.equal(atlas.texture.generateMipmaps, false);
    const { width, height, data } = atlas.texture.image;
    assert.equal(data.byteLength, width * height * 4);
    const checked = new Set();
    for (const block of BLOCK_CATALOG) {
      for (const part of block.textureParts ?? [undefined]) {
        for (const face of ["side", "top", "bottom"]) {
          const tile = tileFor(block.id, face, part);
          const first = tile * 9;
          const draws = atlas.canvas.draws.slice(first, first + 9);
          assert.equal(draws.length, 9, "each tile has eight edge/corner copies");
          const [source, x, y] = draws[0];
          const pixels = blockTexturePixels(block.id, face, part);
          assert.deepEqual(source.pixels, pixels);
          source.pixels = null; // Model a cleared icon-source canvas.
          source.oncontextrestored();
          assert.deepEqual(source.pixels, pixels, "uncached icons recover too");
          for (const gutter of draws.slice(1))
            assert.equal(gutter[0], source, "gutters sample their own material");
          const [u0, v0, u1, v1] = atlas.uvFor(block.id, face, part);
          assert.ok(Math.abs(u0 * atlas.canvas.width - x) < 0.00001);
          assert.ok(Math.abs((1 - v1) * atlas.canvas.height - y) < 0.00001);
          assert.ok(Math.abs((u1 - u0) * atlas.canvas.width - 16) < 0.00001);
          assert.ok(Math.abs((v1 - v0) * atlas.canvas.height - 16) < 0.00001);
          if (checked.has(tile)) continue;
          checked.add(tile);
          for (let dy = -2; dy < 18; dy++) {
            for (let dx = -2; dx < 18; dx++) {
              const sx = Math.max(0, Math.min(15, dx));
              const sy = Math.max(0, Math.min(15, dy));
              const from = (sy * 16 + sx) * 4;
              const to = ((height - 1 - y - dy) * width + x + dx) * 4;
              assert.deepEqual(
                Array.from(data.subarray(to, to + 4)),
                Array.from(pixels.subarray(from, from + 4)),
                `${block.name} ${part ?? ""} ${face} ${dx},${dy}: texel or gutter`
              );
            }
          }
        }
      }
    }
    const emission = atlas.emissiveTexture;
    assert.equal(emission.isDataTexture, true);
    assert.equal(emission.image.width, atlas.texture.image.width);
    assert.equal(emission.image.height, atlas.texture.image.height);
    assert.equal(emission.flipY, atlas.texture.flipY);
    assert.equal(emission.colorSpace, THREE.SRGBColorSpace);
    assert.equal(emission.magFilter, THREE.NearestFilter);
    assert.equal(emission.minFilter, THREE.NearestFilter);
    assert.equal(emission.generateMipmaps, false);
    const [u0, , , v1] = atlas.uvFor(BLOCK.GLOW_BERRIES);
    const x = Math.round(u0 * width);
    const y = Math.round((1 - v1) * height);
    const expected = new Uint8Array(data.byteLength);
    const pixels = blockEmissionPixels(BLOCK.GLOW_BERRIES);
    for (let row = 0; row < 16; row++)
      expected.set(
        pixels.subarray(row * 64, (row + 1) * 64),
        ((height - 1 - y - row) * width + x) * 4
      );
    assert.deepEqual(
      emission.image.data, expected, "only fruit emits, including every gutter"
    );
  } finally {
    atlas?.texture.dispose();
    atlas?.emissiveTexture.dispose();
    second?.texture.dispose();
    second?.emissiveTexture.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

test("glass, ice and water retain different transparency and surface treatment", () => {
  const glass = alpha(blockTexturePixels(BLOCK.GLASS));
  const ice = alpha(blockTexturePixels(BLOCK.ICE));
  const water = alpha(blockTexturePixels(BLOCK.WATER));
  assert.ok(
    new Set(glass).size > 1,
    "window borders are less transparent than their interior"
  );
  assert.ok(ice.every((value) => value > 0 && value < 255));
  assert.ok(
    water.every((value) => value === 255),
    "the water material controls surface opacity"
  );
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.ICE),
    blockTexturePixels(BLOCK.BLUE_ICE)
  );
});

test("mushroom caps, cactus ends, striped terracotta and ore inclusions do not reuse stone pixels", () => {
  const stone = blockTexturePixels(BLOCK.STONE);
  for (const id of [
    BLOCK.RED_MUSHROOM,
    BLOCK.BROWN_MUSHROOM,
    BLOCK.CACTUS,
    BLOCK.ORANGE_TERRACOTTA,
    BLOCK.DIAMOND_ORE,
    BLOCK.GOLD_ORE,
    BLOCK.NETHERRACK,
    BLOCK.END_STONE,
  ]) {
    assert.notDeepEqual(blockTexturePixels(id), stone);
  }
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.RED_MUSHROOM, "top"),
    blockTexturePixels(BLOCK.RED_MUSHROOM, "bottom")
  );
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.CACTUS, "side"),
    blockTexturePixels(BLOCK.CACTUS, "top")
  );
});

test("every extra item has a bounded local sprite with visible pixels and a transparent background", () => {
  const sources = new Set();
  for (const item of ITEMS.filter((entry) => entry.kind !== "block")) {
    const pixels = itemTexturePixels(item.id);
    assert.equal(pixels.length, 16 * 16 * 4);
    assert.deepEqual(pixels, itemTexturePixels(item.id));
    const hash = digest(pixels);
    assert.equal(sources.has(hash), false, `${item.name} has its own sprite`);
    sources.add(hash);
    const values = alpha(pixels);
    assert.ok(
      values.some((value) => value === 255),
      `${item.name} is visible`
    );
    assert.ok(
      values.some((value) => value === 0),
      `${item.name} has a silhouette`
    );
  }
  assert.throws(() => itemTexturePixels(9999), RangeError);
});

test("pickaxe, axe, sword and shovel silhouettes differ independently of material", () => {
  const shapes = [
    ITEM.WOOD_PICKAXE,
    ITEM.WOOD_AXE,
    ITEM.WOOD_SWORD,
    ITEM.WOOD_SHOVEL,
  ].map((id) => digest(Uint8Array.from(alpha(itemTexturePixels(id)))));
  assert.equal(new Set(shapes).size, 4);
  assert.deepEqual(
    alpha(itemTexturePixels(ITEM.WOOD_PICKAXE)),
    alpha(itemTexturePixels(ITEM.DIAMOND_PICKAXE))
  );
  assert.notDeepEqual(
    itemTexturePixels(ITEM.WOOD_PICKAXE),
    itemTexturePixels(ITEM.DIAMOND_PICKAXE)
  );
});

test("food and ingots have distinct recognizable sprite sources", () => {
  const ids = [
    ITEM.APPLE,
    ITEM.BREAD,
    ITEM.RAW_BEEF,
    ITEM.STEAK,
    ITEM.EGG,
    ITEM.IRON_INGOT,
    ITEM.GOLD_INGOT,
    ITEM.COPPER_INGOT,
  ];
  assert.equal(
    new Set(ids.map((id) => digest(itemTexturePixels(id)))).size,
    ids.length
  );
  assert.deepEqual(
    itemTexturePixels(BLOCK.GRASS),
    blockTexturePixels(BLOCK.GRASS)
  );
});
