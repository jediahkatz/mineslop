import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXPANSION_WOOD_FAMILIES,
  EXPANSION_WOOD_PALETTES,
} from "../src/expansion-art-common.js";
import {
  BUILDING_MATERIAL_DESCRIPTORS,
  BUILDING_MATERIAL_FACES,
  BUILDING_MATERIAL_PARTS,
  BUILDING_MATERIAL_VARIANTS,
  BUILDING_WOOL_COLORS,
  paintBuildingMaterial,
} from "../src/expansion-building-art.js";
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

function render(options) {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(
    paintBuildingMaterial(pixels, Object.freeze({ ...options })),
    true,
    JSON.stringify(options)
  );
  return pixels;
}

function colorsOf(pixels) {
  const colors = new Map();
  for (let i = 0; i < COUNT; i++) {
    if (!pixels[i * 4 + 3]) continue;
    const color = [...pixels.subarray(i * 4, i * 4 + 3)].join(",");
    colors.set(color, (colors.get(color) ?? 0) + 1);
  }
  return colors;
}

function components(ink) {
  const seen = new Set();
  const groups = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    for (let at = 0; at < queue.length; at++) {
      const x = queue[at] % SIZE;
      const y = Math.floor(queue[at] / SIZE);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE) continue;
        const next = ny * SIZE + nx;
        if (ink[next] && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    groups.push(queue);
  }
  return groups;
}

test("frozen building descriptors enumerate deterministic, complete, bounded RGBA tiles", () => {
  const keys = new Set();
  assert.ok(Object.isFrozen(BUILDING_MATERIAL_DESCRIPTORS));
  assert.ok(Object.isFrozen(BUILDING_MATERIAL_VARIANTS));
  assert.ok(Object.isFrozen(BUILDING_MATERIAL_PARTS));
  assert.ok(Object.isFrozen(BUILDING_MATERIAL_FACES));
  assert.ok(Object.isFrozen(BUILDING_WOOL_COLORS));
  for (const descriptor of BUILDING_MATERIAL_DESCRIPTORS) {
    assert.ok(Object.isFrozen(descriptor));
    assert.ok(Object.isFrozen(BUILDING_MATERIAL_VARIANTS[descriptor.kind]));
    if (descriptor.part)
      assert.ok(Object.isFrozen(BUILDING_MATERIAL_PARTS[descriptor.kind]));
    const key = JSON.stringify(descriptor);
    assert.ok(!keys.has(key), "no duplicate fully specified descriptors");
    keys.add(key);
    const expected = render(descriptor);
    const guarded = new Uint8Array(BYTES + 16).fill(79);
    const target = guarded.subarray(8, BYTES + 8);
    assert.equal(paintBuildingMaterial(target, descriptor), true, key);
    assert.deepEqual([...target], [...expected], `${key}: replaces stale ink`);
    assert.ok(guarded.subarray(0, 8).every((value) => value === 79));
    assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 79));
    const alpha = mask(target);
    assert.ok(
      alpha.every((value) => value === 0 || value === 255),
      key
    );
    for (let i = 0; i < COUNT; i++) {
      if (!alpha[i])
        assert.ok(
          target.subarray(i * 4, i * 4 + 4).every((value) => value === 0)
        );
    }
    const colors = colorsOf(target);
    assert.ok(
      colors.size >= 3 && colors.size <= 24,
      `${key}: deliberate ramps`
    );
  }
});

test("documented defaults do not guess a wood family, wool color, or two-part state", () => {
  assert.deepEqual(
    render({ kind: "copper_block" }),
    render({ kind: "copper_block", variant: "default", face: "side" })
  );
  assert.deepEqual(
    render({ kind: "bookshelf", variant: "oak" }),
    render({ kind: "bookshelf", variant: "oak", face: "side" })
  );
  const pixels = new Uint8ClampedArray(BYTES).fill(51);
  for (const options of [
    { kind: "bookshelf" },
    { kind: "door", variant: "oak" },
    { kind: "bed", part: "head" },
    { kind: "bed", variant: "red" },
  ]) {
    assert.equal(paintBuildingMaterial(pixels, options), false);
    assert.ok(pixels.every((value) => value === 51));
  }
});

test("only ladders, upper door windows, and trapdoor panels contain optical holes", () => {
  for (const descriptor of BUILDING_MATERIAL_DESCRIPTORS) {
    const { kind, face, part } = descriptor;
    const alpha = mask(render(descriptor));
    const holes = alpha.filter((value) => value === 0).length;
    const cutout =
      kind === "ladder" ||
      (kind === "door" && face === "side" && part === "upper") ||
      (kind === "trapdoor" && face !== "side");
    if (cutout) assert.ok(holes > 0 && holes < 200, JSON.stringify(descriptor));
    else assert.equal(holes, 0, JSON.stringify(descriptor));
  }
});

test("deepslate keeps quiet neutral grains instead of broad camouflage contours", () => {
  for (const face of BUILDING_MATERIAL_FACES) {
    const pixels = render({ kind: "deepslate", face });
    const colors = colorsOf(pixels);
    assert.ok(Math.max(...colors.values()) >= 100, "quiet dominant midtone");
    for (let channel = 0; channel < 3; channel++) {
      const values = Array.from(
        { length: COUNT },
        (_, i) => pixels[i * 4 + channel]
      );
      assert.ok(Math.max(...values) - Math.min(...values) <= 30);
    }
    const patchMeans = [];
    for (let y = 0; y < SIZE; y += 4) {
      for (let x = 0; x < SIZE; x += 4) {
        let sum = 0;
        for (let dy = 0; dy < 4; dy++)
          for (let dx = 0; dx < 4; dx++)
            sum += brightness(pixel(pixels, x + dx, y + dy));
        patchMeans.push(sum / 16);
      }
    }
    assert.ok(Math.max(...patchMeans) - Math.min(...patchMeans) < 12);
    for (const color of colors.keys()) {
      const channels = color.split(",").map(Number);
      assert.ok(Math.max(...channels) - Math.min(...channels) <= 16);
    }
  }
  assert.notDeepEqual(
    render({ kind: "deepslate", face: "side" }),
    render({ kind: "deepslate", face: "top" })
  );
});

test("cobbled deepslate uses angular lit ledges in a restrained dark stone palette", () => {
  const cobble = render({ kind: "cobbled_deepslate" });
  assert.notDeepEqual(cobble, render({ kind: "deepslate" }));
  const colors = [...colorsOf(cobble).keys()].map((color) =>
    color.split(",").map(Number)
  );
  const values = colors.map(brightness);
  assert.ok(colors.length >= 4 && colors.length <= 6);
  assert.ok(Math.max(...values) - Math.min(...values) > 35);
  assert.ok(Math.max(...values) - Math.min(...values) < 80);
  for (const color of colors)
    assert.ok(
      Math.max(...color) - Math.min(...color) < 20,
      "no colored camouflage"
    );
  assert.ok(
    brightness(pixel(cobble, 5, 5)) > brightness(pixel(cobble, 5, 8)) + 20
  );
  assert.ok(
    brightness(pixel(cobble, 5, 6)) > brightness(pixel(cobble, 2, 6)) + 15
  );
});

test("copper panels have broad metal bodies, aligned bevels, and shaded rivets", () => {
  const copper = render({ kind: "copper_block" });
  assert.deepEqual(pixel(copper, 2, 1), pixel(copper, 10, 9));
  assert.ok(
    brightness(pixel(copper, 2, 1)) > brightness(pixel(copper, 4, 4)) + 35
  );
  assert.ok(
    brightness(pixel(copper, 5, 3)) > brightness(pixel(copper, 6, 4)) + 60
  );
  assert.ok(Math.max(...colorsOf(copper).values()) >= 100, "broad calm panels");
  for (const color of colorsOf(copper).keys()) {
    const [r, g, b] = color.split(",").map(Number);
    assert.ok(r > g + 30 && g > b + 15, "warm copper pigment");
  }
});

test("wood families reuse their ramps and keep bookshelf spines off the wooden caps", () => {
  const woodImages = new Set();
  for (const variant of EXPANSION_WOOD_FAMILIES) {
    const palette = EXPANSION_WOOD_PALETTES[variant].map((color) =>
      rgb(color).join(",")
    );
    const top = render({ kind: "bookshelf", variant, face: "top" });
    const bottom = render({ kind: "bookshelf", variant, face: "bottom" });
    const side = render({ kind: "bookshelf", variant, face: "side" });
    woodImages.add(digest(top));
    assert.deepEqual(bottom, top);
    assert.ok(
      [...colorsOf(top).keys()].every((color) => palette.includes(color))
    );
    assert.ok(
      [...colorsOf(side).keys()].some((color) => !palette.includes(color))
    );
    assert.notDeepEqual(
      pixel(side, 3, 4),
      pixel(side, 5, 4),
      "separate colored spines"
    );
    assert.deepEqual(
      pixel(side, 7, 7).slice(0, 3),
      rgb(EXPANSION_WOOD_PALETTES[variant][3]),
      "wooden shelf between the two rows"
    );
    for (const options of [
      { kind: "ladder", face: "side" },
      { kind: "door", face: "top", part: "upper" },
      { kind: "trapdoor", face: "side" },
    ]) {
      const pixels = render({ ...options, variant });
      assert.ok(
        [...colorsOf(pixels).keys()].every((color) => palette.includes(color))
      );
    }
  }
  assert.equal(woodImages.size, EXPANSION_WOOD_FAMILIES.length);
});

test("ladder rails and rungs form one transparent, vertically repeatable wooden assembly", () => {
  const ladder = render({ kind: "ladder", variant: "birch" });
  const alpha = mask(ladder);
  const filled = alpha.filter(Boolean).length;
  assert.ok(filled >= 80 && filled <= 144);
  assert.equal(components(alpha).length, 1);
  for (const x of [3, 4, 11, 12]) {
    assert.equal(pixel(ladder, x, 0)[3], 255);
    assert.equal(pixel(ladder, x, 15)[3], 255);
  }
  for (const y of [2, 6, 10, 14])
    assert.equal(pixel(ladder, 7, y)[3], 255, "attached rung");
  assert.equal(pixel(ladder, 7, 4)[3], 0, "clear space between rungs");
  for (let y = 0; y < SIZE; y++) {
    assert.equal(pixel(ladder, 0, y)[3], 0);
    assert.equal(pixel(ladder, 15, y)[3], 0);
  }
  for (const face of ["top", "bottom"])
    assert.deepEqual(
      render({ kind: "ladder", variant: "birch", face }),
      ladder
    );
});

test("door halves join at the rail, with bounded upper panes and a lower right-hand handle", () => {
  for (const variant of EXPANSION_WOOD_FAMILIES) {
    const upper = render({ kind: "door", variant, part: "upper" });
    const lower = render({ kind: "door", variant, part: "lower" });
    const holes = Uint8Array.from(mask(upper), (value) => Number(value === 0));
    const panes = components(holes);
    assert.equal(panes.length, 4);
    assert.ok(panes.every((pane) => pane.length >= 4 && pane.length <= 16));
    for (const pane of panes)
      for (const at of pane) {
        assert.ok(at % SIZE >= 4 && at % SIZE <= 11);
        assert.ok(Math.floor(at / SIZE) >= 4 && Math.floor(at / SIZE) <= 11);
      }
    assert.ok(mask(lower).every((value) => value === 255));
    for (let x = 0; x < SIZE; x++)
      assert.deepEqual(
        pixel(upper, x, 15),
        pixel(lower, x, 0),
        "joined middle rail"
      );
    assert.deepEqual(pixel(lower, 12, 3).slice(0, 3), rgb("#e0c784"));
    assert.notDeepEqual(pixel(upper, 12, 3), pixel(lower, 12, 3));
    for (const face of ["top", "bottom"])
      assert.ok(
        mask(render({ kind: "door", variant, face, part: "upper" })).every(
          (value) => value === 255
        )
      );
  }
});

test("trapdoor faces share two optical slots, while the edge is solid and the underside lacks hardware", () => {
  const top = render({ kind: "trapdoor", variant: "spruce", face: "top" });
  const bottom = render({
    kind: "trapdoor",
    variant: "spruce",
    face: "bottom",
  });
  const side = render({ kind: "trapdoor", variant: "spruce", face: "side" });
  assert.deepEqual(mask(top), mask(bottom));
  assert.notDeepEqual(top, bottom);
  assert.ok(mask(side).every((value) => value === 255));
  const holes = Uint8Array.from(mask(top), (value) => Number(value === 0));
  const slots = components(holes);
  assert.equal(slots.length, 2);
  assert.ok(slots.every((slot) => slot.length >= 16 && slot.length <= 40));
  assert.equal(pixel(top, 7, 5)[3], 0);
  assert.equal(pixel(top, 7, 10)[3], 0);
  assert.equal(pixel(top, 7, 7)[3], 255, "crossbar stays connected");
  assert.notDeepEqual(
    pixel(top, 1, 3),
    pixel(bottom, 1, 3),
    "hinge faces outward"
  );
});

test("all wool colors retain an oak frame, a head pillow, and aligned bed-half seams", () => {
  const blankets = new Set();
  const underside = render({
    kind: "bookshelf",
    variant: "oak",
    face: "bottom",
  });
  let pillow;
  for (const variant of BUILDING_WOOL_COLORS) {
    const head = render({ kind: "bed", variant, face: "top", part: "head" });
    const foot = render({ kind: "bed", variant, face: "top", part: "foot" });
    blankets.add(pixel(foot, 8, 10).join(","));
    pillow ??= pixel(head, 6, 3);
    assert.deepEqual(pixel(head, 6, 3), pillow, "pillow is not wool tinted");
    assert.notDeepEqual(pixel(head, 6, 3), pixel(foot, 6, 3));
    for (let x = 0; x < SIZE; x++)
      assert.deepEqual(
        pixel(head, x, 15),
        pixel(foot, x, 0),
        "top: head above foot"
      );
    const headSide = render({
      kind: "bed",
      variant,
      face: "side",
      part: "head",
    });
    const footSide = render({
      kind: "bed",
      variant,
      face: "side",
      part: "foot",
    });
    assert.notDeepEqual(pixel(headSide, 3, 2), pixel(footSide, 3, 2));
    for (let y = 0; y < SIZE; y++)
      assert.deepEqual(
        pixel(headSide, 15, y),
        pixel(footSide, 0, y),
        "side: head left of foot"
      );
    for (const part of ["head", "foot"])
      assert.deepEqual(
        render({ kind: "bed", variant, face: "bottom", part }),
        underside
      );
  }
  assert.equal(
    blankets.size,
    BUILDING_WOOL_COLORS.length,
    "distinct wool pigments"
  );
});

test("unknown keys, colors, parts, and extra options leave every pixel untouched", () => {
  for (const options of [
    undefined,
    null,
    {},
    "door/oak/upper",
    { kind: 1 },
    { kind: "constructor" },
    { kind: "__proto__" },
    { kind: "copper_block", variant: "oxidized" },
    { kind: "copper_block", part: "upper" },
    { kind: "copper_block", part: null },
    { kind: "deepslate", face: "front" },
    { kind: "deepslate", face: null },
    { kind: "deepslate", id: 1 },
    { kind: "deepslate", [Symbol("unexpected")]: true },
    { kind: "bookshelf", variant: "poplar" },
    { kind: "bookshelf", variant: "red" },
    { kind: "ladder", variant: "oak", part: "lower" },
    { kind: "door", variant: "oak", part: "head" },
    { kind: "door", variant: "oak", part: null },
    { kind: "trapdoor", variant: "oak", open: true },
    { kind: "bed", variant: "oak", part: "head" },
    { kind: "bed", variant: "RED", part: "head" },
    { kind: "bed", variant: "#ffffff", part: "head" },
    { kind: "bed", variant: "light_grey", part: "foot" },
    { kind: "bed", variant: "red", part: "upper" },
    { kind: "bed", variant: "red", part: "foot", wood: "spruce" },
  ]) {
    const pixels = new Uint8ClampedArray(BYTES).fill(63);
    assert.equal(paintBuildingMaterial(pixels, options), false);
    assert.ok(pixels.every((value) => value === 63));
  }
  assert.equal(paintBuildingMaterial(null, { kind: "unsupported" }), false);
});

test("invalid buffers fail before mutation and cutouts clear an earlier opaque texture", () => {
  for (const pixels of [
    new Uint8Array(BYTES - 1).fill(31),
    new Uint8ClampedArray(BYTES + 1).fill(31),
  ]) {
    assert.throws(
      () => paintBuildingMaterial(pixels, { kind: "copper_block" }),
      RangeError
    );
    assert.ok(pixels.every((value) => value === 31));
  }
  const floats = new Float32Array(BYTES).fill(31);
  assert.throws(
    () => paintBuildingMaterial(floats, { kind: "deepslate" }),
    TypeError
  );
  assert.ok(floats.every((value) => value === 31));
  assert.throws(
    () => paintBuildingMaterial(null, { kind: "deepslate" }),
    TypeError
  );
  const pixels = render({ kind: "copper_block" });
  const options = { kind: "ladder", variant: "warped" };
  assert.equal(paintBuildingMaterial(pixels, options), true);
  assert.deepEqual(pixels, render(options));
});

test("the building painter import graph contains only shared pixel and palette primitives", () => {
  const entry = new URL("../src/expansion-building-art.js", import.meta.url);
  const allowed = new Set([
    entry.href,
    new URL("../src/expansion-art-common.js", import.meta.url).href,
    new URL("../src/pixel-art.js", import.meta.url).href,
  ]);
  const queue = [entry];
  const visited = new Set();
  for (let at = 0; at < queue.length; at++) {
    const url = queue[at];
    if (visited.has(url.href)) continue;
    visited.add(url.href);
    const source = readFileSync(url, "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:import|require)\s*\(/,
      "no hidden dynamic dependencies"
    );
    const imports = [
      ...source.matchAll(
        /^\s*(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/gm
      ),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ];
    for (const match of imports) {
      const dependency = new URL(match[1], url);
      assert.ok(
        allowed.has(dependency.href),
        `${url.pathname}: no species, registry, renderer, or external dependency: ${match[1]}`
      );
      queue.push(dependency);
    }
  }
});
