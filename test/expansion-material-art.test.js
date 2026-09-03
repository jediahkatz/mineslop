import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  expansionArtKeys,
  expansionArtVariants,
  expansionPainter,
  resolveExpansionVariant,
} from "../src/expansion-art-common.js";
import {
  EXPANSION_CORAL_FAMILIES,
  EXPANSION_MATERIAL_CUTOUT_KINDS,
  EXPANSION_MATERIAL_KEYS,
  EXPANSION_MATERIAL_VARIANTS,
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
  paintExpansionMaterial,
} from "../src/expansion-material-art.js";
import { rgb, TEXTURE_SIZE } from "../src/pixel-art.js";

const SIZE = TEXTURE_SIZE;
const COUNT = SIZE * SIZE;
const BYTES = COUNT * 4;
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const pixel = (pixels, x, y) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x + 1) * 4));
const mask = (pixels) =>
  Uint8Array.from({ length: COUNT }, (_, i) => pixels[i * 4 + 3]);
const brightness = (color) => (color[0] + color[1] + color[2]) / 3;

function render(kind, variant, face = "side") {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(
    paintExpansionMaterial(pixels, Object.freeze({ kind, variant, face })),
    true,
    `${kind}/${variant}/${face}`
  );
  return pixels;
}

function meanColor(pixels) {
  const result = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < COUNT; i++) {
    if (!pixels[i * 4 + 3]) continue;
    for (let c = 0; c < 3; c++) result[c] += pixels[i * 4 + c];
    count++;
  }
  return result.map((value) => value / count);
}

// Diagonally touching pixels belong to the same stair-stepped plant or vein.
function connectedSizes(ink) {
  const seen = new Set();
  const sizes = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    for (let at = 0; at < queue.length; at++) {
      const x = queue[at] % SIZE;
      const y = Math.floor(queue[at] / SIZE);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
          const next = ny * SIZE + nx;
          if (ink[next] && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
    }
    sizes.push(queue.length);
  }
  return sizes;
}

test("every semantic material key paints deterministic bounded RGBA without a catalog", () => {
  const hashes = new Set();
  for (const key of EXPANSION_MATERIAL_KEYS) {
    const [kind, variant] = key.split("/");
    for (const face of ["side", "top", "bottom"]) {
      const expected = render(kind, variant, face);
      const guarded = new Uint8ClampedArray(BYTES + 16).fill(73);
      const target = guarded.subarray(8, BYTES + 8);
      assert.equal(
        paintExpansionMaterial(target, { kind, variant, face }),
        true
      );
      assert.deepEqual(
        target,
        expected,
        `${key}/${face}: no prior-pixel residue`
      );
      assert.ok(guarded.subarray(0, 8).every((value) => value === 73));
      assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 73));
      assert.ok(mask(target).every((alpha) => alpha === 0 || alpha === 255));
      const colors = new Set();
      for (let i = 0; i < COUNT; i++) {
        if (target[i * 4 + 3])
          colors.add([...target.subarray(i * 4, i * 4 + 3)].join(","));
        else assert.ok(target.subarray(i * 4, i * 4 + 4).every((v) => v === 0));
      }
      assert.ok(
        colors.size >= 3 && colors.size <= 12,
        `${key}: compact palette`
      );
      if (face === "side") hashes.add(digest(target));
    }
  }
  assert.equal(hashes.size, EXPANSION_MATERIAL_KEYS.length);
});

test("plank families retain distinct natural hues and staggered connected board seams", () => {
  const hashes = new Set();
  const means = {};
  for (const family of EXPANSION_WOOD_FAMILIES) {
    const pixels = render("planks", family);
    const palette = EXPANSION_WOOD_PALETTES[family];
    hashes.add(digest(pixels));
    means[family] = meanColor(pixels);
    assert.ok(Object.isFrozen(palette));
    if (family === "bamboo") {
      for (const x of [0, 4, 8, 12])
        for (let y = 0; y < SIZE; y++)
          assert.deepEqual(pixel(pixels, x, y).slice(0, 3), rgb(palette[0]));
    } else {
      for (let row = 0; row < 4; row++) {
        for (let x = 0; x < SIZE; x++)
          assert.deepEqual(
            pixel(pixels, x, row * 4).slice(0, 3),
            rgb(palette[0])
          );
        for (let y = row * 4 + 1; y < row * 4 + 4; y++)
          assert.deepEqual(
            pixel(pixels, row % 2 ? 11 : 4, y).slice(0, 3),
            rgb(palette[0])
          );
      }
    }
  }
  assert.equal(hashes.size, EXPANSION_WOOD_FAMILIES.length);
  assert.ok(brightness(means.birch) > brightness(means.spruce) + 60);
  assert.ok(brightness(means.dark_oak) < brightness(means.spruce));
  assert.ok(means.acacia[0] > means.acacia[1] + 35, "warm orange acacia");
  assert.ok(means.mangrove[0] > means.mangrove[1] + 30, "red mangrove");
  assert.ok(means.warped[1] > means.warped[0] + 30, "cool teal warped wood");
  assert.ok(means.crimson[2] > means.crimson[1] + 10, "violet crimson wood");
  assert.ok(means.cherry[0] > means.cherry[1] + 20, "soft pink cherry");
  assert.ok(Math.max(...means.pale_oak) - Math.min(...means.pale_oak) < 25);
});

test("solid sea and utility surfaces are opaque while plants have actual bounded cutouts", () => {
  for (const [kind, variants] of Object.entries(EXPANSION_MATERIAL_VARIANTS)) {
    for (const variant of variants) {
      const pixels = render(kind, variant);
      const alpha = mask(pixels);
      if (!EXPANSION_MATERIAL_CUTOUT_KINDS.includes(kind)) {
        assert.ok(
          alpha.every((value) => value === 255),
          `${kind}/${variant}`
        );
        continue;
      }
      const filled = alpha.filter(Boolean).length;
      assert.ok(filled >= 35 && filled <= 180, `${kind}/${variant}: ${filled}`);
      assert.deepEqual(connectedSizes(alpha), [filled], "one attached plant");
      for (let y = 0; y < SIZE; y++) {
        assert.equal(pixel(pixels, 0, y)[3], 0, "left cutout margin");
        assert.equal(pixel(pixels, SIZE - 1, y)[3], 0, "right cutout margin");
      }
      assert.equal(pixel(pixels, 7, 15)[3], 255, "root reaches the substrate");
      assert.equal(
        pixel(pixels, 8, 15)[3],
        255,
        "root has a two-pixel footing"
      );
    }
  }
});

test("kelp segments join vertically but the growing tip ends in a closed blade", () => {
  const plant = render("kelp", "plant");
  const tip = render("kelp", "tip");
  assert.equal(pixel(plant, 7, 0)[3], 255);
  assert.equal(pixel(plant, 8, 0)[3], 255);
  assert.ok(
    mask(tip)
      .subarray(0, SIZE)
      .every((alpha) => alpha === 0)
  );
  assert.equal(pixel(tip, 7, 1)[3], 255);
  assert.deepEqual(plant.subarray(7 * SIZE * 4), tip.subarray(7 * SIZE * 4));
});

test("coral families preserve their anatomy after death instead of becoming recolored squares", () => {
  for (const kind of ["coral_block", "coral", "coral_fan"]) {
    const aliveImages = new Set();
    const deadImages = new Set();
    const silhouettes = new Set();
    for (const family of EXPANSION_CORAL_FAMILIES) {
      const alive = render(kind, family);
      const dead = render(`dead_${kind}`, family);
      aliveImages.add(digest(alive));
      deadImages.add(digest(dead));
      silhouettes.add(digest(mask(alive)));
      assert.deepEqual(
        mask(dead),
        mask(alive),
        `${kind}/${family}: same anatomy`
      );
      const liveMean = meanColor(alive);
      const deadMean = meanColor(dead);
      const chroma = (color) => Math.max(...color) - Math.min(...color);
      assert.ok(chroma(deadMean) < 25, "dead coral is muted mineral gray");
      assert.ok(chroma(liveMean) > chroma(deadMean) + 20, `${kind}/${family}`);
    }
    assert.equal(aliveImages.size, EXPANSION_CORAL_FAMILIES.length);
    assert.equal(deadImages.size, EXPANSION_CORAL_FAMILIES.length);
    if (kind !== "coral_block")
      assert.equal(silhouettes.size, EXPANSION_CORAL_FAMILIES.length);
  }
});

test("prismarine masonry, sponge pores, lantern lens, and magma fissures remain readable", () => {
  const rough = render("prismarine", "rough");
  const bricks = render("prismarine", "bricks");
  const dark = render("prismarine", "dark");
  assert.equal(new Set([rough, bricks, dark].map(digest)).size, 3);
  assert.ok(brightness(meanColor(dark)) < brightness(meanColor(rough)) - 25);
  assert.ok(
    brightness(pixel(bricks, 2, 1)) > brightness(pixel(bricks, 2, 7)) + 30
  );
  const lantern = render("sea_lantern");
  assert.ok(
    brightness(pixel(lantern, 7, 7)) > brightness(pixel(lantern, 0, 0)) + 80
  );
  const dry = render("sponge", "dry");
  const wet = render("sponge", "wet");
  assert.ok(brightness(meanColor(wet)) < brightness(meanColor(dry)) - 15);
  for (const sponge of [dry, wet]) {
    const values = Array.from({ length: COUNT }, (_, i) =>
      brightness(sponge.subarray(i * 4, i * 4 + 3))
    );
    const darkest = Math.min(...values);
    const pores = Uint8Array.from(values, (value) => Number(value === darkest));
    assert.ok(pores.filter(Boolean).length >= 10);
    assert.ok(pores.filter(Boolean).length <= 35);
    assert.ok(connectedSizes(pores).length >= 4, "several shaded pores");
  }
  const magma = render("magma");
  const hot = Uint8Array.from({ length: COUNT }, (_, i) =>
    Number(magma[i * 4] >= 175)
  );
  const hotCount = hot.filter(Boolean).length;
  assert.ok(
    hotCount >= 40 && hotCount <= 155,
    "glowing cracks between dark crust"
  );
  assert.deepEqual(
    connectedSizes(hot),
    [hotCount],
    "one branching fissure network"
  );
});

test("utility faces distinguish the working top, decorated side, and solid underside", () => {
  for (const kind of ["enchanting_table", "anvil"]) {
    const faces = ["side", "top", "bottom"].map((face) =>
      render(kind, undefined, face)
    );
    assert.equal(new Set(faces.map(digest)).size, faces.length, kind);
    assert.ok(
      faces.every((pixels) => mask(pixels).every((alpha) => alpha === 255))
    );
  }
});

test("unsupported material descriptors are nonmutating, including absent future wood", () => {
  for (const options of [
    undefined,
    null,
    7,
    "planks/oak",
    {},
    { kind: 7 },
    { kind: { toString: () => "planks" }, variant: "oak" },
    { kind: "toString" },
    { kind: "__proto__" },
    { kind: "planks" },
    { kind: "planks", variant: null },
    // This leaf targets Java 26.2, not the upcoming 26.3 poplar family.
    { kind: "planks", variant: "poplar" },
    { kind: "coral", variant: "oak" },
    { kind: "sea_lantern", variant: "wet" },
    { kind: "sea_lantern", face: "front" },
    { kind: "sea_lantern", face: null },
  ]) {
    const pixels = new Uint8ClampedArray(BYTES).fill(61);
    assert.equal(paintExpansionMaterial(pixels, options), false);
    assert.ok(pixels.every((channel) => channel === 61));
  }
  assert.equal(paintExpansionMaterial(null, { kind: "unsupported" }), false);
});

test("shared descriptor helpers snapshot variants and do not guess multi-variant defaults", () => {
  const source = { many: ["first", "second"], single: ["default"] };
  const variants = expansionArtVariants(source);
  source.many.push("third");
  assert.deepEqual(expansionArtKeys(variants), [
    "many/first",
    "many/second",
    "single",
  ]);
  assert.equal(resolveExpansionVariant({ kind: "many" }, variants), null);
  assert.equal(
    resolveExpansionVariant({ kind: "many", variant: "first" }, variants),
    "first"
  );
  assert.equal(
    resolveExpansionVariant({ kind: "single" }, variants),
    "default"
  );
  assert.ok(Object.isFrozen(variants));
  assert.ok(Object.isFrozen(variants.many));
  assert.ok(Object.isFrozen(EXPANSION_MATERIAL_KEYS));
  assert.ok(Object.isFrozen(EXPANSION_WOOD_PALETTES));
  assert.throws(() => variants.many.push("third"), TypeError);
});

test("shared expansion painter clips primitives inside the tile and supports transparent ink", () => {
  const guarded = new Uint8Array(BYTES + 16).fill(91);
  const pixels = guarded.subarray(8, BYTES + 8);
  const p = expansionPainter(pixels);
  assert.ok(pixels.every((value) => value === 0));
  p.rect(-2, -2, 4, 4, "#123456");
  assert.deepEqual(pixel(pixels, 1, 1), [18, 52, 86, 255]);
  assert.deepEqual(pixel(pixels, 2, 2), [0, 0, 0, 0]);
  p.line(14, 14, 18, 18, "#abcdef", 2);
  assert.deepEqual(pixel(pixels, 15, 15), [171, 205, 239, 255]);
  p.stamp(15, 15, ["01", ".0"], ["#556677", [0, 0, 0, 0]], true);
  assert.deepEqual(pixel(pixels, 0, 0), [85, 102, 119, 255]);
  assert.deepEqual(pixel(pixels, 0, 15), [0, 0, 0, 0]);
  assert.ok(guarded.subarray(0, 8).every((value) => value === 91));
  assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 91));
});

test("known material keys reject invalid buffers before writing any channels", () => {
  for (const pixels of [
    new Uint8ClampedArray(BYTES - 4).fill(19),
    new Uint8Array(BYTES + 4).fill(19),
  ]) {
    assert.throws(
      () => paintExpansionMaterial(pixels, { kind: "magma" }),
      RangeError
    );
    assert.ok(pixels.every((value) => value === 19));
  }
  const floats = new Float32Array(BYTES).fill(19);
  assert.throws(
    () => paintExpansionMaterial(floats, { kind: "magma" }),
    TypeError
  );
  assert.ok(floats.every((value) => value === 19));
  assert.throws(
    () => paintExpansionMaterial(null, { kind: "magma" }),
    TypeError
  );
});
