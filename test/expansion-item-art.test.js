import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EXPANSION_WOOD_PALETTES } from "../src/expansion-art-common.js";
import {
  EXPANSION_ITEM_KEYS,
  EXPANSION_ITEM_VARIANTS,
  paintExpansionItem,
} from "../src/expansion-item-art.js";
import { rgb, TEXTURE_SIZE } from "../src/pixel-art.js";

const SIZE = TEXTURE_SIZE;
const COUNT = SIZE * SIZE;
const BYTES = COUNT * 4;
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const pixel = (pixels, x, y) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x + 1) * 4));
const mask = (pixels) =>
  Uint8Array.from({ length: COUNT }, (_, i) => pixels[i * 4 + 3]);
const rowWidth = (pixels, y) =>
  mask(pixels)
    .subarray(y * SIZE, (y + 1) * SIZE)
    .filter(Boolean).length;

function render(kind, variant) {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(
    paintExpansionItem(pixels, Object.freeze({ kind, variant })),
    true,
    `${kind}/${variant}`
  );
  return pixels;
}

function colorsOf(pixels) {
  const colors = new Set();
  for (let i = 0; i < COUNT; i++)
    if (pixels[i * 4 + 3])
      colors.add([...pixels.subarray(i * 4, i * 4 + 3)].join(","));
  return colors;
}

function connectedCount(ink) {
  const seen = new Set();
  let count = 0;
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start] || seen.has(start)) continue;
    count++;
    const queue = [start];
    seen.add(start);
    for (let at = 0; at < queue.length; at++) {
      const x = queue[at] % SIZE;
      const y = Math.floor(queue[at] / SIZE);
      // One-pixel fishing line and stair-step outlines use diagonal adjacency.
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
  }
  return count;
}

test("all semantic item keys replace pixels deterministically without escaping their tile", () => {
  const hashes = new Set();
  for (const key of EXPANSION_ITEM_KEYS) {
    const [kind, variant] = key.split("/");
    const expected = render(kind, variant);
    const guarded = new Uint8Array(BYTES + 16).fill(47);
    const target = guarded.subarray(8, BYTES + 8);
    assert.equal(paintExpansionItem(target, { kind, variant }), true);
    assert.deepEqual(
      [...target],
      [...expected],
      `${key}: no old background ink`
    );
    assert.ok(guarded.subarray(0, 8).every((value) => value === 47));
    assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 47));
    hashes.add(digest(target));
    const alpha = mask(target);
    assert.ok(
      alpha.every((value) => value === 0 || value === 255),
      key
    );
    const filled = alpha.filter(Boolean).length;
    assert.ok(
      filled >= 35 && filled <= 180,
      `${key}: ${filled} visible pixels`
    );
    assert.equal(
      connectedCount(alpha),
      1,
      `${key}: no detached placeholder specks`
    );
    for (let edge = 0; edge < SIZE; edge++) {
      assert.equal(pixel(target, edge, 0)[3], 0, key);
      assert.equal(pixel(target, edge, SIZE - 1)[3], 0, key);
      assert.equal(pixel(target, 0, edge)[3], 0, key);
      assert.equal(pixel(target, SIZE - 1, edge)[3], 0, key);
    }
    for (let i = 0; i < COUNT; i++)
      if (!alpha[i])
        assert.ok(
          target.subarray(i * 4, i * 4 + 4).every((value) => value === 0)
        );
    const colors = colorsOf(target);
    assert.ok(
      colors.size >= 4 && colors.size <= 14,
      `${key}: restrained facets`
    );
  }
  assert.equal(hashes.size, EXPANSION_ITEM_KEYS.length);
});

test("different item forms are identifiable by silhouette, not only their colors", () => {
  const descriptors = [
    ["boat", "oak"],
    ["raft", "bamboo"],
    ["fishing_rod"],
    ["fish", "cod"],
    ["fish", "salmon"],
    ["fish", "tropical"],
    ["fish", "pufferfish"],
    ["scute", "turtle"],
    ["scute", "armadillo"],
    ["heart_of_the_sea"],
    ["nautilus_shell"],
    ["potion", "water"],
    ["book"],
    ["paper"],
    ["ender_pearl"],
    ["brewing_stand"],
    ["enchanting_table"],
    ["anvil"],
  ];
  const shapes = descriptors.map(([kind, variant]) =>
    digest(mask(render(kind, variant)))
  );
  assert.equal(new Set(shapes).size, descriptors.length);
});

test("boats share the corresponding plank ramp while a bamboo raft has lashed slats", () => {
  const boatShapes = new Set();
  for (const family of EXPANSION_ITEM_VARIANTS.boat) {
    const boat = render("boat", family);
    const palette = EXPANSION_WOOD_PALETTES[family].map((hex) =>
      rgb(hex).join(",")
    );
    assert.ok([...colorsOf(boat)].every((color) => palette.includes(color)));
    boatShapes.add(digest(mask(boat)));
    assert.deepEqual(
      pixel(boat, 7, 8).slice(0, 3),
      rgb(EXPANSION_WOOD_PALETTES[family][1]),
      "shaded cockpit between the gunwales"
    );
    assert.deepEqual(
      pixel(boat, 7, 7).slice(0, 3),
      rgb(EXPANSION_WOOD_PALETTES[family][3])
    );
  }
  assert.equal(boatShapes.size, 1, "family skins reuse an authored boat form");
  const raft = render("raft", "bamboo");
  assert.ok(!boatShapes.has(digest(mask(raft))));
  for (const y of [5, 8, 11]) {
    assert.deepEqual(
      pixel(raft, 3, y).slice(0, 3),
      rgb(EXPANSION_WOOD_PALETTES.bamboo[2])
    );
    assert.equal(pixel(raft, 5, y)[3], 255, "rope stays attached to each slat");
  }
});

test("fishing rod retains its thin line, visible bobber, reel, and open hook", () => {
  const pixels = render("fishing_rod");
  assert.equal(pixel(pixels, 14, 6)[3], 255, "one-pixel fishing line");
  assert.equal(pixel(pixels, 13, 6)[3], 0, "air beside the line");
  assert.notDeepEqual(
    pixel(pixels, 13, 7),
    pixel(pixels, 13, 8),
    "two-tone bobber"
  );
  assert.equal(pixel(pixels, 5, 10)[3], 255, "reel on the handle");
  assert.equal(pixel(pixels, 11, 10)[3], 255, "hook tip");
  assert.equal(pixel(pixels, 12, 10)[3], 0, "hook interior is open");
});

test("fish retain connected fins and eyes, with a broader spined puffer silhouette", () => {
  for (const variant of EXPANSION_ITEM_VARIANTS.fish) {
    const fish = render("fish", variant);
    assert.deepEqual(
      pixel(fish, 12, variant === "tropical" ? 8 : 7).slice(0, 3),
      rgb("#283b3e")
    );
    assert.equal(connectedCount(mask(fish)), 1);
  }
  const puffer = render("fish", "pufferfish");
  assert.equal(pixel(puffer, 7, 1)[3], 255, "attached upper spine");
  assert.equal(pixel(puffer, 14, 5)[3], 255, "attached side spine");
  assert.ok(rowWidth(puffer, 5) > rowWidth(puffer, 2));
  assert.notDeepEqual(
    mask(render("scute", "turtle")),
    mask(render("scute", "armadillo"))
  );
});

test("potion colors change the liquid while keeping the stopper, glass, and silhouette", () => {
  const empty = render("potion", "empty");
  const liquids = new Set();
  assert.equal(rowWidth(empty, 4), 4, "narrow bottle neck");
  assert.equal(rowWidth(empty, 8), 8, "round bottle shoulders");
  for (const variant of EXPANSION_ITEM_VARIANTS.potion) {
    const bottle = render("potion", variant);
    assert.deepEqual(mask(bottle), mask(empty));
    assert.deepEqual(
      bottle.subarray(0, 6 * SIZE * 4),
      empty.subarray(0, 6 * SIZE * 4)
    );
    assert.deepEqual(pixel(bottle, 5, 7), pixel(empty, 5, 7), "glass glint");
    liquids.add(pixel(bottle, 8, 10).join(","));
  }
  assert.equal(liquids.size, EXPANSION_ITEM_VARIANTS.potion.length);
});

test("enchanted books keep bound pages and add an inset rune rather than detached glitter", () => {
  const book = render("book");
  const enchanted = render("enchanted_book");
  assert.deepEqual(mask(enchanted), mask(book));
  assert.notDeepEqual(enchanted, book);
  assert.deepEqual(
    pixel(enchanted, 6, 11),
    pixel(book, 6, 11),
    "shared page edge"
  );
  assert.notDeepEqual(
    pixel(enchanted, 9, 7),
    pixel(book, 9, 7),
    "inset cover rune"
  );
  const paper = render("paper");
  assert.equal(pixel(paper, 12, 2)[3], 0, "folded upper corner");
  assert.equal(pixel(paper, 12, 4)[3], 255, "attached fold");
  assert.equal(pixel(paper, 11, 12)[3], 255, "paper body");
  assert.notDeepEqual(mask(paper), mask(book));
});

test("crafting accents show an anvil waist and attached brewing bottles and open book", () => {
  const anvil = render("anvil");
  assert.ok(rowWidth(anvil, 4) > rowWidth(anvil, 8) + 6, "wide striking face");
  assert.ok(rowWidth(anvil, 12) > rowWidth(anvil, 8) + 4, "stable anvil foot");
  const stand = render("brewing_stand");
  assert.equal(pixel(stand, 7, 2)[3], 255, "central brewing rod");
  assert.equal(pixel(stand, 3, 10)[3], 255, "left bottle");
  assert.equal(pixel(stand, 11, 10)[3], 255, "right bottle");
  assert.notDeepEqual(pixel(stand, 3, 10), pixel(stand, 11, 10));
  const table = render("enchanting_table");
  assert.equal(pixel(table, 7, 2)[3], 0, "open book gutter");
  assert.equal(pixel(table, 5, 3)[3], 255, "left page");
  assert.equal(pixel(table, 10, 3)[3], 255, "right page");
  assert.equal(pixel(table, 3, 14)[3], 255, "table foot");
});

test("unsupported item keys are inert and do not manufacture gear or unsupported boats", () => {
  for (const options of [
    undefined,
    null,
    {},
    "boat/oak",
    { kind: 256 },
    { kind: "constructor" },
    { kind: "__proto__" },
    { kind: "boat" },
    { kind: "boat", variant: "bamboo" },
    { kind: "boat", variant: "crimson" },
    { kind: "boat", variant: "warped" },
    { kind: "boat", variant: "poplar" },
    { kind: "raft", variant: "oak" },
    { kind: "fish", variant: "unknown" },
    { kind: "potion", variant: null },
    { kind: "book", variant: "diamond" },
    { kind: "sword", variant: "iron" },
  ]) {
    const pixels = new Uint8ClampedArray(BYTES).fill(83);
    assert.equal(paintExpansionItem(pixels, options), false);
    assert.ok(pixels.every((value) => value === 83));
  }
  assert.equal(paintExpansionItem(null, { kind: "unsupported" }), false);
  assert.deepEqual(
    render("raft"),
    render("raft", "bamboo"),
    "singleton shorthand"
  );
  assert.ok(Object.isFrozen(EXPANSION_ITEM_KEYS));
  assert.ok(Object.isFrozen(EXPANSION_ITEM_VARIANTS));
  assert.ok(Object.isFrozen(EXPANSION_ITEM_VARIANTS.boat));
});

test("invalid item targets fail before mutation and valid reused buffers clear old art", () => {
  for (const target of [
    new Uint8Array(BYTES - 1).fill(37),
    new Uint8ClampedArray(BYTES + 1).fill(37),
  ]) {
    assert.throws(
      () => paintExpansionItem(target, { kind: "paper" }),
      RangeError
    );
    assert.ok(target.every((value) => value === 37));
  }
  const wrongType = new Float32Array(BYTES).fill(37);
  assert.throws(
    () => paintExpansionItem(wrongType, { kind: "paper" }),
    TypeError
  );
  assert.ok(wrongType.every((value) => value === 37));
  const target = render("enchanting_table");
  assert.equal(paintExpansionItem(target, { kind: "fishing_rod" }), true);
  assert.deepEqual(target, render("fishing_rod"));
});
