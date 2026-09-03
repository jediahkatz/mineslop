import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  PROGRESSION_ITEM_KEYS,
  PROGRESSION_MATERIAL_FACES,
  PROGRESSION_MATERIAL_KEYS,
  paintProgressionItem,
  paintProgressionMaterial,
  paintQuartzDeposits,
} from "../src/expansion-progression-art.js";
import { painter, TEXTURE_SIZE } from "../src/pixel-art.js";

const SIZE = TEXTURE_SIZE;
const COUNT = SIZE * SIZE;
const BYTES = COUNT * 4;
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const pixel = (pixels, x, y) =>
  Array.from(pixels.subarray((y * SIZE + x) * 4, (y * SIZE + x + 1) * 4));
const mask = (pixels) =>
  Uint8Array.from({ length: COUNT }, (_, i) => pixels[i * 4 + 3]);
const brightness = (color) => (color[0] + color[1] + color[2]) / 3;

function render(paint, options) {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(paint(pixels, Object.freeze({ ...options })), true);
  return pixels;
}

function visibleColors(pixels) {
  const result = [];
  for (let i = 0; i < COUNT; i++)
    if (pixels[i * 4 + 3]) result.push([...pixels.subarray(i * 4, i * 4 + 3)]);
  return result;
}

function meanBrightness(pixels) {
  const values = visibleColors(pixels).map(brightness);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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

test("progression items replace one tile with deterministic, connected, bounded cutouts", () => {
  const silhouettes = new Set();
  const images = new Set();
  for (const kind of PROGRESSION_ITEM_KEYS) {
    const expected = render(paintProgressionItem, { kind });
    const guarded = new Uint8Array(BYTES + 16).fill(67);
    const target = guarded.subarray(8, BYTES + 8);
    assert.equal(paintProgressionItem(target, { kind }), true);
    assert.deepEqual([...target], [...expected], `${kind}: no old background`);
    assert.ok(guarded.subarray(0, 8).every((value) => value === 67));
    assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 67));
    const alpha = mask(target);
    assert.ok(alpha.every((value) => value === 0 || value === 255));
    const filled = alpha.filter(Boolean).length;
    assert.ok(
      filled >= 30 && filled <= 140,
      `${kind}: ${filled} visible pixels`
    );
    assert.equal(components(alpha).length, 1, `${kind}: attached facets`);
    for (let edge = 0; edge < SIZE; edge++) {
      assert.equal(pixel(target, edge, 0)[3], 0);
      assert.equal(pixel(target, edge, 15)[3], 0);
      assert.equal(pixel(target, 0, edge)[3], 0);
      assert.equal(pixel(target, 15, edge)[3], 0);
    }
    for (let i = 0; i < COUNT; i++)
      if (!alpha[i])
        assert.ok(
          target.subarray(i * 4, i * 4 + 4).every((value) => value === 0)
        );
    const colors = new Set(
      visibleColors(target).map((color) => color.join(","))
    );
    assert.ok(colors.size >= 4 && colors.size <= 6, `${kind}: compact palette`);
    silhouettes.add(digest(alpha));
    images.add(digest(target));
  }
  assert.equal(silhouettes.size, PROGRESSION_ITEM_KEYS.length);
  assert.equal(images.size, PROGRESSION_ITEM_KEYS.length);
});

test("crystals, small gold, torn scrap, and a dark ingot retain different shape and material cues", () => {
  const quartz = render(paintProgressionItem, { kind: "quartz" });
  const nugget = render(paintProgressionItem, { kind: "gold_nugget" });
  const scrap = render(paintProgressionItem, { kind: "netherite_scrap" });
  const ingot = render(paintProgressionItem, { kind: "netherite_ingot" });
  const crystalBounds = bounds(mask(quartz));
  const ingotBounds = bounds(mask(ingot));
  assert.ok(crystalBounds.height > crystalBounds.width, "upright prisms");
  assert.ok(ingotBounds.width >= ingotBounds.height + 4, "wide forged bar");
  assert.ok(
    mask(nugget).filter(Boolean).length <= 55,
    "a nugget, not an ingot"
  );
  assert.ok(
    mask(nugget).filter(Boolean).length < mask(scrap).filter(Boolean).length
  );
  assert.equal(pixel(scrap, 8, 7)[3], 0, "perforated scrap");
  assert.equal(pixel(scrap, 9, 7)[3], 0);
  assert.equal(pixel(ingot, 8, 7)[3], 255, "solid ingot body");
  assert.ok(meanBrightness(quartz) > meanBrightness(ingot) + 40);
  assert.ok(meanBrightness(nugget) > meanBrightness(ingot) + 20);
  for (const [r, g, b] of visibleColors(nugget))
    assert.ok(r > g + 15 && g > b + 20, "restrained warm gold");
  for (const color of visibleColors(quartz))
    assert.ok(Math.max(...color) - Math.min(...color) < 32, "pale quartz");
});

test("progression material faces are deterministic opaque full-tile replacements", () => {
  const images = new Set();
  for (const kind of PROGRESSION_MATERIAL_KEYS) {
    for (const face of PROGRESSION_MATERIAL_FACES) {
      const expected = render(paintProgressionMaterial, { kind, face });
      const guarded = new Uint8ClampedArray(BYTES + 16).fill(43);
      const target = guarded.subarray(8, BYTES + 8);
      assert.equal(paintProgressionMaterial(target, { kind, face }), true);
      assert.deepEqual(target, expected);
      assert.ok(guarded.subarray(0, 8).every((value) => value === 43));
      assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 43));
      assert.ok(
        mask(target).every((value) => value === 255),
        `${kind}/${face}`
      );
      const colors = new Set(
        visibleColors(target).map((color) => color.join(","))
      );
      assert.ok(colors.size >= 4 && colors.size <= 6, `${kind}/${face}`);
      if (face === "side") images.add(digest(target));
    }
  }
  assert.equal(images.size, PROGRESSION_MATERIAL_KEYS.length);
});

test("ancient debris has continuous side strata and a distinct cut end; quartz stone stays pale and quiet", () => {
  const side = render(paintProgressionMaterial, { kind: "ancient_debris" });
  const top = render(paintProgressionMaterial, {
    kind: "ancient_debris",
    face: "top",
  });
  const bottom = render(paintProgressionMaterial, {
    kind: "ancient_debris",
    face: "bottom",
  });
  assert.notDeepEqual(side, top);
  assert.deepEqual(top, bottom);
  for (const y of [3, 8, 14])
    assert.deepEqual(
      pixel(side, 0, y),
      pixel(side, 15, y),
      "layer continues across tile edges"
    );
  const stone = render(paintProgressionMaterial, { kind: "quartz_block" });
  assert.ok(meanBrightness(stone) > meanBrightness(side) + 50);
  for (let channel = 0; channel < 3; channel++) {
    const values = Array.from(
      { length: COUNT },
      (_, i) => stone[i * 4 + channel]
    );
    assert.ok(
      Math.max(...values) - Math.min(...values) <= 44,
      "restrained stone detail"
    );
  }
  for (const face of ["top", "bottom"])
    assert.deepEqual(
      render(paintProgressionMaterial, { kind: "quartz_block", face }),
      stone
    );
});

test("quartz deposits form a few connected pale clusters while leaving most of the host visible", () => {
  const deposits = new Uint8ClampedArray(BYTES);
  assert.equal(paintQuartzDeposits(deposits), true);
  const ink = mask(deposits);
  assert.ok(ink.every((alpha) => alpha === 0 || alpha === 255));
  const filled = ink.filter(Boolean).length;
  assert.ok(filled >= 36 && filled <= 64, `${filled}/256 deposit pixels`);
  const groups = components(ink);
  assert.ok(groups.length >= 3 && groups.length <= 4);
  for (const group of groups) {
    assert.ok(
      group.length >= 6 && group.length <= 24,
      "clusters, not confetti"
    );
    const values = group.map((at) =>
      brightness(deposits.subarray(at * 4, at * 4 + 3))
    );
    assert.ok(
      Math.max(...values) - Math.min(...values) > 60,
      "shaded mineral facets"
    );
  }
  for (let edge = 0; edge < SIZE; edge++) {
    assert.equal(pixel(deposits, edge, 0)[3], 0);
    assert.equal(pixel(deposits, edge, 15)[3], 0);
    assert.equal(pixel(deposits, 0, edge)[3], 0);
    assert.equal(pixel(deposits, 15, edge)[3], 0);
  }
  const colors = new Set(
    visibleColors(deposits).map((color) => color.join(","))
  );
  assert.ok(colors.size >= 4 && colors.size <= 5);
});

test("quartz overlay preserves every untouched host byte and never writes outside its view", () => {
  const deposits = new Uint8ClampedArray(BYTES);
  paintQuartzDeposits(deposits);
  const ink = mask(deposits);
  // Synthetic red/cool hosts, including non-opaque alpha: this checks the
  // overlay contract without importing or claiming integration with terrain.
  for (const palette of [
    ["#6b3e38", "#79463f", "#8c5546"],
    ["#343b40", "#424950", "#535c62"],
  ]) {
    const original = new Uint8ClampedArray(BYTES);
    painter(original).field(palette, 37, 4, 5);
    for (let i = 0; i < COUNT; i++) original[i * 4 + 3] = 15 + ((i * 29) % 240);
    const guarded = new Uint8Array(BYTES + 16).fill(89);
    const target = guarded.subarray(8, BYTES + 8);
    target.set(original);
    assert.equal(paintQuartzDeposits(target), true);
    for (let i = 0; i < COUNT; i++) {
      const expected = (ink[i] ? deposits : original).subarray(
        i * 4,
        i * 4 + 4
      );
      assert.deepEqual([...target.subarray(i * 4, i * 4 + 4)], [...expected]);
    }
    assert.ok(guarded.subarray(0, 8).every((value) => value === 89));
    assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 89));
    const repeat = new Uint8ClampedArray(original);
    paintQuartzDeposits(repeat);
    assert.deepEqual(
      [...target],
      [...repeat],
      "same host gives the same overlay"
    );
    paintQuartzDeposits(target);
    assert.deepEqual([...target], [...repeat], "overlay is idempotent");
  }
});

test("pale quartz contrasts against a red host without bleaching the surrounding rock", () => {
  const pixels = new Uint8ClampedArray(BYTES);
  painter(pixels).rect(0, 0, SIZE, SIZE, "#74413b");
  const host = new Uint8ClampedArray(pixels);
  paintQuartzDeposits(pixels);
  const changed = [];
  let untouched = 0;
  for (let i = 0; i < COUNT; i++) {
    const after = pixels.subarray(i * 4, i * 4 + 4);
    const before = host.subarray(i * 4, i * 4 + 4);
    if (after.every((value, channel) => value === before[channel])) untouched++;
    else changed.push(brightness(after) - brightness(before));
  }
  assert.ok(untouched >= COUNT * 0.75);
  assert.ok(
    Math.min(...changed) > 15,
    "even the cavity edge has mineral contrast"
  );
  assert.ok(
    changed.reduce((sum, value) => sum + value, 0) / changed.length > 70
  );
  assert.ok(mask(pixels).every((alpha) => alpha === 255));
});

test("supported keys are frozen, face defaults are explicit, and unknown descriptors are inert", () => {
  assert.ok(Object.isFrozen(PROGRESSION_ITEM_KEYS));
  assert.ok(Object.isFrozen(PROGRESSION_MATERIAL_KEYS));
  assert.ok(Object.isFrozen(PROGRESSION_MATERIAL_FACES));
  assert.deepEqual(
    render(paintProgressionMaterial, { kind: "ancient_debris" }),
    render(paintProgressionMaterial, { kind: "ancient_debris", face: "side" })
  );
  for (const [paint, cases] of [
    [
      paintProgressionItem,
      [
        undefined,
        null,
        {},
        "quartz",
        { kind: 1 },
        { kind: "constructor" },
        { kind: "QUARTZ" },
        { kind: "nether_quartz" },
        { kind: "quartz", variant: "default" },
        { kind: "quartz", face: "side" },
      ],
    ],
    [
      paintProgressionMaterial,
      [
        undefined,
        null,
        {},
        { kind: "__proto__" },
        { kind: "netherrack" },
        { kind: "ancient_debris", face: null },
        { kind: "ancient_debris", face: "front" },
        { kind: "quartz_block", variant: "chiseled" },
        { kind: "quartz_block", [Symbol("unexpected")]: true },
      ],
    ],
  ]) {
    for (const options of cases) {
      const pixels = new Uint8ClampedArray(BYTES).fill(59);
      assert.equal(paint(pixels, options), false);
      assert.ok(pixels.every((value) => value === 59));
    }
    assert.equal(paint(null, { kind: "unsupported" }), false);
  }
});

test("all progression entry points reject invalid buffers before any mutation", () => {
  const paints = [
    (pixels) => paintProgressionItem(pixels, { kind: "quartz" }),
    (pixels) => paintProgressionMaterial(pixels, { kind: "ancient_debris" }),
    paintQuartzDeposits,
  ];
  for (const paint of paints) {
    for (const pixels of [
      new Uint8Array(BYTES - 4).fill(29),
      new Uint8ClampedArray(BYTES + 4).fill(29),
    ]) {
      assert.throws(() => paint(pixels), RangeError);
      assert.ok(pixels.every((value) => value === 29));
    }
    for (const pixels of [
      new Float32Array(BYTES).fill(29),
      new Array(BYTES).fill(29),
    ]) {
      assert.throws(() => paint(pixels), TypeError);
      assert.ok(pixels.every((value) => value === 29));
    }
    assert.throws(() => paint(null), TypeError);
  }
});

test("progression art depends only on pure pixel primitives, not registries or renderers", () => {
  const entry = new URL("../src/expansion-progression-art.js", import.meta.url);
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
