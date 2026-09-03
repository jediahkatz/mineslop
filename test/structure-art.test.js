import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  STRUCTURE_ITEM_DESCRIPTORS,
  STRUCTURE_ITEM_KEYS,
  STRUCTURE_MATERIAL_DESCRIPTORS,
  STRUCTURE_MATERIAL_FACES,
  STRUCTURE_MATERIAL_KEYS,
  paintStructureItem,
  paintStructureMaterial,
} from "../src/structure-art.js";
import { TEXTURE_SIZE } from "../src/pixel-art.js";

const SIZE = TEXTURE_SIZE;
const COUNT = SIZE * SIZE;
const BYTES = COUNT * 4;
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const pixel = (pixels, x, y) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x + 1) * 4));
const mask = (pixels) =>
  Uint8Array.from({ length: COUNT }, (_, i) => pixels[i * 4 + 3]);
const brightness = (color) => (color[0] + color[1] + color[2]) / 3;

const PAINT_CASES = [
  ...STRUCTURE_MATERIAL_DESCRIPTORS.map((options) => [
    paintStructureMaterial,
    options,
  ]),
  ...STRUCTURE_ITEM_DESCRIPTORS.map((options) => [paintStructureItem, options]),
];

function render(paint, options) {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(paint(pixels, Object.freeze({ ...options })), true);
  return pixels;
}

const material = (kind, face = "side") =>
  render(paintStructureMaterial, { kind, face });
const item = (kind) => render(paintStructureItem, { kind });

function visibleColors(pixels) {
  const colors = [];
  for (let i = 0; i < COUNT; i++)
    if (pixels[i * 4 + 3]) colors.push([...pixels.subarray(i * 4, i * 4 + 3)]);
  return colors;
}

function meanBrightness(pixels) {
  const values = visibleColors(pixels).map(brightness);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function connectedSizes(ink) {
  const visited = new Set();
  const sizes = [];
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || visited.has(start)) continue;
    const queue = [start];
    visited.add(start);
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
        if (!ink[next] || visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    sizes.push(queue.length);
  }
  return sizes;
}

function bounds(ink) {
  const indices = [...ink.keys()].filter((i) => ink[i]);
  const xs = indices.map((i) => i % SIZE);
  const ys = indices.map((i) => Math.floor(i / SIZE));
  return {
    width: Math.max(...xs) - Math.min(...xs) + 1,
    height: Math.max(...ys) - Math.min(...ys) + 1,
  };
}

test("frozen structure descriptors cover every kind and face without duplicates", () => {
  for (const values of [
    STRUCTURE_ITEM_KEYS,
    STRUCTURE_MATERIAL_KEYS,
    STRUCTURE_MATERIAL_FACES,
    STRUCTURE_ITEM_DESCRIPTORS,
    STRUCTURE_MATERIAL_DESCRIPTORS,
  ])
    assert.ok(Object.isFrozen(values));
  for (const [, options] of PAINT_CASES) assert.ok(Object.isFrozen(options));
  const materialKeys = new Set(
    STRUCTURE_MATERIAL_DESCRIPTORS.map(({ kind, face }) => `${kind}/${face}`)
  );
  assert.equal(materialKeys.size, STRUCTURE_MATERIAL_DESCRIPTORS.length);
  assert.equal(
    materialKeys.size,
    STRUCTURE_MATERIAL_KEYS.length * STRUCTURE_MATERIAL_FACES.length
  );
  for (const kind of STRUCTURE_MATERIAL_KEYS)
    for (const face of STRUCTURE_MATERIAL_FACES)
      assert.ok(materialKeys.has(`${kind}/${face}`));
  const itemKeys = STRUCTURE_ITEM_DESCRIPTORS.map(({ kind }) => kind);
  assert.equal(new Set(itemKeys).size, itemKeys.length);
  assert.deepEqual(itemKeys, STRUCTURE_ITEM_KEYS);
});

test("all structure art replaces exactly one bounded tile, deterministically and idempotently", () => {
  for (const [paint, options] of PAINT_CASES) {
    const label = JSON.stringify(options);
    const expected = render(paint, options);
    for (const ArrayType of [Uint8Array, Uint8ClampedArray]) {
      // A non-RGBA-aligned byteOffset guards against writing the backing buffer.
      const guarded = new ArrayType(BYTES + 26).fill(79);
      const target = guarded.subarray(13, BYTES + 13);
      for (let repeat = 0; repeat < 2; repeat++) {
        assert.equal(paint(target, options), true, label);
        assert.deepEqual([...target], [...expected], `${label}: no stale ink`);
        assert.ok(guarded.subarray(0, 13).every((value) => value === 79));
        assert.ok(guarded.subarray(BYTES + 13).every((value) => value === 79));
      }
    }
    const alpha = mask(expected);
    assert.ok(
      alpha.every((value) => value === 0 || value === 255),
      label
    );
    for (let i = 0; i < COUNT; i++)
      if (!alpha[i])
        assert.ok(
          expected.subarray(i * 4, i * 4 + 4).every((value) => value === 0),
          `${label}: transparent RGB is also cleared`
        );
    const colors = new Set(
      visibleColors(expected).map((color) => color.join(","))
    );
    assert.ok(colors.size >= 4 && colors.size <= 24, `${label}: compact ramps`);
  }
});

test("side defaults and shared stone, metal, cage and crop faces are explicit", () => {
  for (const kind of STRUCTURE_MATERIAL_KEYS) {
    const side = material(kind);
    assert.deepEqual(render(paintStructureMaterial, { kind }), side);
    assert.deepEqual(
      render(paintStructureMaterial, { kind, face: undefined }),
      side
    );
  }
  for (const kind of [
    "gold_block",
    "mossy_cobblestone",
    "nether_bricks",
    "nether_wart_crop",
    "spawner",
  ])
    for (const face of ["top", "bottom"])
      assert.deepEqual(material(kind, face), material(kind), `${kind}/${face}`);
});

test("all materials read differently and each full-cube workstation has three distinct planes", () => {
  for (const face of STRUCTURE_MATERIAL_FACES) {
    const images = STRUCTURE_MATERIAL_KEYS.map((kind) =>
      digest(material(kind, face))
    );
    assert.equal(new Set(images).size, STRUCTURE_MATERIAL_KEYS.length, face);
  }
  for (const kind of [
    "composter",
    "lectern",
    "cartography_table",
    "smithing_table",
  ]) {
    const images = STRUCTURE_MATERIAL_FACES.map((face) =>
      digest(material(kind, face))
    );
    assert.equal(new Set(images).size, 3, kind);
  }
});

test("only cage windows and crop silhouettes have material cutouts", () => {
  for (const options of STRUCTURE_MATERIAL_DESCRIPTORS) {
    const alpha = mask(render(paintStructureMaterial, options));
    const holes = alpha.filter((value) => value === 0).length;
    if (options.kind === "spawner" || options.kind === "nether_wart_crop")
      assert.ok(holes > 0 && holes < COUNT, JSON.stringify(options));
    else
      assert.equal(holes, 0, `${options.kind}/${options.face}: solid cube art`);
  }
  for (const [paint, options] of [
    [paintStructureMaterial, { kind: "spawner" }],
    [paintStructureMaterial, { kind: "nether_wart_crop" }],
    ...STRUCTURE_ITEM_DESCRIPTORS.map((options) => [
      paintStructureItem,
      options,
    ]),
  ]) {
    const opaque = material("gold_block");
    assert.equal(paint(opaque, options), true);
    assert.deepEqual(
      opaque,
      render(paint, options),
      "old solid art is cleared"
    );
  }
});

test("gold has a quiet yellow body and a narrow reflective bevel", () => {
  const gold = material("gold_block");
  const colors = new Map();
  for (const color of visibleColors(gold)) {
    const key = color.join(",");
    colors.set(key, (colors.get(key) ?? 0) + 1);
    const [r, g, b] = color;
    assert.ok(r >= g + 12 && g >= b + 40, "gold pigment, not orange copper");
  }
  assert.ok(Math.max(...colors.values()) >= 100, "broad calm metal body");
  assert.ok(
    brightness(pixel(gold, 3, 1)) > brightness(pixel(gold, 8, 8)) + 30,
    "lit upper bevel"
  );
  assert.ok(
    brightness(pixel(gold, 1, 7)) > brightness(pixel(gold, 15, 7)) + 40,
    "lit left edge and shaded right edge"
  );
});

test("moss follows small connected seams while restrained gray stone stays dominant", () => {
  const cobble = material("mossy_cobblestone");
  const moss = Uint8Array.from({ length: COUNT }, (_, i) => {
    const [r, g, b] = cobble.subarray(i * 4, i * 4 + 3);
    return Number(g >= r + 15 && g >= b + 20);
  });
  const mossCount = moss.filter(Boolean).length;
  assert.ok(mossCount >= 25 && mossCount <= 64, "moss does not hide the stone");
  const patches = connectedSizes(moss);
  assert.ok(patches.length >= 3 && patches.length <= 6);
  assert.ok(
    patches.every((size) => size >= 3 && size <= 24),
    "trails, not confetti"
  );
  for (let channel = 0; channel < 3; channel++) {
    const values = visibleColors(cobble).map((color) => color[channel]);
    assert.ok(Math.max(...values) - Math.min(...values) <= 95);
  }
});

test("deep maroon brick courses have fine staggered mortar and small lit lips", () => {
  const bricks = material("nether_bricks");
  const mortar = pixel(bricks, 0, 0);
  for (const y of [0, 4, 8, 12])
    for (let x = 0; x < SIZE; x++)
      assert.deepEqual(
        pixel(bricks, x, y),
        mortar,
        "continuous horizontal seam"
      );
  assert.deepEqual(pixel(bricks, 0, 2), mortar);
  assert.deepEqual(pixel(bricks, 4, 6), mortar);
  assert.notDeepEqual(pixel(bricks, 4, 2), mortar, "alternate row joint");
  assert.ok(
    brightness(pixel(bricks, 2, 1)) > brightness(pixel(bricks, 2, 3)) + 25
  );
  assert.ok(meanBrightness(bricks) < 80, "dark, fired masonry");
  for (const [r, g, b] of visibleColors(bricks))
    assert.ok(r >= g + 8 && r >= b && b >= g + 4, "maroon undertones");
});

test("spawner bars and frame form one connected cage around six transparent windows", () => {
  const cage = material("spawner");
  const alpha = mask(cage);
  assert.equal(connectedSizes(alpha).length, 1);
  const windows = connectedSizes(
    Uint8Array.from(alpha, (value) => Number(!value))
  );
  assert.equal(windows.length, 6);
  assert.ok(windows.every((size) => size >= 10 && size <= 15));
  for (let edge = 0; edge < SIZE; edge++) {
    assert.equal(pixel(cage, edge, 0)[3], 255);
    assert.equal(pixel(cage, edge, 15)[3], 255);
    assert.equal(pixel(cage, 0, edge)[3], 255);
    assert.equal(pixel(cage, 15, edge)[3], 255);
  }
  for (const x of [3, 8, 12])
    for (const y of [4, 11]) assert.deepEqual(pixel(cage, x, y), [0, 0, 0, 0]);
  for (const x of [5, 10]) assert.equal(pixel(cage, x, 4)[3], 255);
  assert.equal(pixel(cage, 8, 7)[3], 255);
  assert.ok(meanBrightness(cage) < 100, "dark metal, not painted light");
});

test("wart crop is a connected red cluster with clear margins and a rooted footing", () => {
  const crop = material("nether_wart_crop");
  const alpha = mask(crop);
  const filled = alpha.filter(Boolean).length;
  assert.ok(filled >= 70 && filled <= 140);
  assert.deepEqual(connectedSizes(alpha), [filled]);
  for (let edge = 0; edge < SIZE; edge++) {
    assert.equal(pixel(crop, edge, 0)[3], 0);
    assert.equal(pixel(crop, 0, edge)[3], 0);
    assert.equal(pixel(crop, 15, edge)[3], 0);
  }
  assert.equal(pixel(crop, 7, 15)[3], 255);
  assert.equal(pixel(crop, 8, 15)[3], 255);
  for (const [r, g, b] of visibleColors(crop))
    assert.ok(r > g + 20 && r > b + 20, "red lobes and stalks");
});

test("composter rim shadows imply an open top without punching holes in cube faces", () => {
  const top = material("composter", "top");
  const side = material("composter");
  const bottom = material("composter", "bottom");
  assert.ok(brightness(pixel(top, 6, 1)) > brightness(pixel(top, 4, 4)) + 35);
  assert.ok(brightness(pixel(top, 6, 1)) > brightness(pixel(top, 8, 8)) + 25);
  assert.ok(brightness(pixel(side, 6, 6)) > brightness(pixel(side, 4, 6)) + 20);
  assert.ok(
    brightness(pixel(bottom, 2, 7)) > brightness(pixel(bottom, 6, 7)) + 15
  );
  assert.equal(pixel(top, 8, 8)[3], 255, "cavity is an opaque depth illusion");
});

test("lectern book pages, gutter and desk edge stay off its plain wooden underside", () => {
  const top = material("lectern", "top");
  const side = material("lectern");
  const bottom = material("lectern", "bottom");
  assert.ok(brightness(pixel(top, 4, 4)) > brightness(pixel(top, 0, 6)) + 30);
  assert.ok(brightness(pixel(top, 4, 6)) > brightness(pixel(top, 7, 6)) + 40);
  assert.notDeepEqual(pixel(top, 4, 4), pixel(top, 9, 4), "two page planes");
  assert.ok(
    brightness(pixel(side, 4, 1)) > brightness(pixel(bottom, 4, 1)) + 30
  );
  assert.notDeepEqual(
    pixel(bottom, 7, 7),
    pixel(bottom, 4, 7),
    "pedestal joint"
  );
});

test("cartography shows parchment, land, a river and brass dividers above its storage drawers", () => {
  const top = material("cartography_table", "top");
  const side = material("cartography_table");
  const bottom = material("cartography_table", "bottom");
  assert.ok(brightness(pixel(top, 3, 3)) > brightness(pixel(top, 0, 3)) + 40);
  const land = pixel(top, 3, 6);
  const river = pixel(top, 8, 6);
  assert.ok(land[1] > land[0] && land[1] > land[2]);
  assert.ok(river[2] > river[0] && river[1] > river[0]);
  assert.ok(brightness(pixel(top, 13, 5)) > brightness(pixel(top, 15, 5)) + 50);
  assert.notDeepEqual(
    pixel(side, 4, 4),
    pixel(bottom, 4, 4),
    "stored map rolls"
  );
  assert.notDeepEqual(pixel(side, 7, 11), pixel(bottom, 7, 11), "drawer pull");
});

test("smithing bench has a dark metal worktop, a hammer and a reinforced wooden body", () => {
  const top = material("smithing_table", "top");
  const side = material("smithing_table");
  const bottom = material("smithing_table", "bottom");
  assert.ok(
    meanBrightness(top) <
      meanBrightness(material("cartography_table", "top")) - 30
  );
  assert.ok(brightness(pixel(top, 9, 5)) > brightness(pixel(top, 3, 12)) + 35);
  const cap = pixel(side, 8, 1);
  const panel = pixel(side, 8, 12);
  assert.ok(cap[2] >= cap[0], "cool metal cap");
  assert.ok(panel[0] > panel[1] + 10, "warm timber beneath");
  assert.notDeepEqual(
    pixel(bottom, 1, 1),
    pixel(bottom, 6, 7),
    "corner hardware"
  );
});

test("wart and brick items have distinct connected cutout silhouettes and material cues", () => {
  const images = new Set();
  const silhouettes = new Set();
  for (const kind of STRUCTURE_ITEM_KEYS) {
    const pixels = item(kind);
    const alpha = mask(pixels);
    const filled = alpha.filter(Boolean).length;
    assert.ok(filled >= 40 && filled <= 150, kind);
    assert.deepEqual(connectedSizes(alpha), [filled], kind);
    for (let edge = 0; edge < SIZE; edge++) {
      assert.equal(pixel(pixels, edge, 0)[3], 0);
      assert.equal(pixel(pixels, edge, 15)[3], 0);
      assert.equal(pixel(pixels, 0, edge)[3], 0);
      assert.equal(pixel(pixels, 15, edge)[3], 0);
    }
    images.add(digest(pixels));
    silhouettes.add(digest(alpha));
  }
  assert.equal(images.size, STRUCTURE_ITEM_KEYS.length);
  assert.equal(silhouettes.size, STRUCTURE_ITEM_KEYS.length);
  const wart = item("nether_wart");
  const brick = item("nether_brick");
  const wartBounds = bounds(mask(wart));
  const brickBounds = bounds(mask(brick));
  assert.ok(wartBounds.height > brickBounds.height);
  assert.ok(brickBounds.width >= brickBounds.height + 4, "wide fired brick");
  assert.ok(meanBrightness(wart) > meanBrightness(brick) + 10);
  assert.ok(
    brightness(pixel(brick, 5, 5)) > brightness(pixel(brick, 5, 8)) + 20
  );
  assert.notDeepEqual(
    wart,
    material("nether_wart_crop"),
    "harvest is its own sprite"
  );
});

test("unsupported descriptors return false untouched, even with an invalid target", () => {
  const common = [
    undefined,
    null,
    {},
    [],
    "nether_brick",
    { kind: 1 },
    { kind: null },
    { kind: "__proto__" },
    { kind: "constructor" },
    { kind: "toString" },
  ];
  for (const [paint, optionsList] of [
    [
      paintStructureMaterial,
      [
        ...common,
        { kind: "GOLD_BLOCK" },
        { kind: "nether_wart" },
        { kind: "nether_brick" },
        { kind: "nether_brick_stairs" },
        { kind: "nether_brick_slab" },
        { kind: "nether_brick_fence" },
        { kind: "gold_block", face: null },
        { kind: "gold_block", face: "front" },
        { kind: "gold_block", face: "north" },
        { kind: "gold_block", face: "TOP" },
        { kind: "gold_block", face: 0 },
        { kind: "gold_block", variant: undefined },
        { kind: "gold_block", id: 1 },
        { kind: "nether_wart_crop", growth: 3 },
        { kind: "spawner", [Symbol("unexpected")]: true },
        Object.defineProperty({ kind: "lectern" }, "hidden", { value: true }),
      ],
    ],
    [
      paintStructureItem,
      [
        ...common,
        { kind: "NETHER_WART" },
        { kind: "nether_wart_crop" },
        { kind: "nether_bricks" },
        { kind: "nether_brick", face: "side" },
        { kind: "nether_brick", face: undefined },
        { kind: "nether_wart", variant: "default" },
        { kind: "nether_wart", id: 1 },
        { kind: "nether_wart", [Symbol("unexpected")]: true },
        Object.defineProperty({ kind: "nether_brick" }, "hidden", {
          value: true,
        }),
      ],
    ],
  ]) {
    for (const options of optionsList) {
      const pixels = new Uint8ClampedArray(BYTES).fill(53);
      assert.equal(paint(pixels, options), false);
      assert.ok(pixels.every((value) => value === 53));
      assert.equal(paint(null, options), false, "descriptor is checked first");
    }
  }
});

test("every recognized descriptor rejects invalid buffers before mutation", () => {
  for (const [paint, options] of PAINT_CASES) {
    for (const ArrayType of [Uint8Array, Uint8ClampedArray]) {
      for (const length of [0, BYTES - 1, BYTES + 1]) {
        const guarded = new ArrayType(length + 10).fill(31);
        const target = guarded.subarray(5, length + 5);
        assert.throws(() => paint(target, options), RangeError);
        assert.ok(guarded.every((value) => value === 31));
      }
    }
    for (const pixels of [
      new Float32Array(BYTES).fill(31),
      new Uint16Array(BYTES).fill(31),
      new Int8Array(BYTES).fill(31),
      new Array(BYTES).fill(31),
    ]) {
      assert.throws(() => paint(pixels, options), TypeError);
      assert.ok(pixels.every((value) => value === 31));
    }
    const backing = new Uint8Array(BYTES).fill(31);
    assert.throws(
      () => paint(new DataView(backing.buffer), options),
      TypeError
    );
    assert.ok(backing.every((value) => value === 31));
    for (const pixels of [null, undefined, {}, new ArrayBuffer(BYTES)])
      assert.throws(() => paint(pixels, options), TypeError);
  }
});

test("structure painters depend only on shared pure pixel primitives and palettes", () => {
  const entry = new URL("../src/structure-art.js", import.meta.url);
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
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
    assert.doesNotMatch(
      source,
      /\b(?:document|window|OffscreenCanvas|ImageData|THREE|fetch)\b/
    );
    assert.doesNotMatch(source, /\b(?:Math\.random|Date\.now)\s*\(/);
    const imports = [
      ...source.matchAll(
        /^\s*(?:import|export)\s+[^;]*?\bfrom\s*["']([^"']+)["']/gm
      ),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ];
    for (const match of imports) {
      const dependency = new URL(match[1], url);
      assert.ok(allowed.has(dependency.href), `${url.pathname}: ${match[1]}`);
      queue.push(dependency);
    }
  }
});
