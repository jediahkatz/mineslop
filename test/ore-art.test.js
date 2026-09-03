import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../src/blocks.js";
import {
  paintProgressionMaterial,
  paintQuartzDeposits,
} from "../src/expansion-progression-art.js";
import { paintOreDeposits } from "../src/ore-art.js";
import { TEXTURE_SIZE } from "../src/pixel-art.js";
import {
  blockEmissionPixels,
  blockTexturePixels,
  createAtlas,
  tileFor,
} from "../src/textures.js";

// Safety/scope guardrails, not fidelity approval. Current rendered art still
// needs direct comparison with the vanilla Java 26.2 references.
const COUNT = TEXTURE_SIZE * TEXTURE_SIZE;
const BYTES = COUNT * 4;
const FACES = ["side", "top", "bottom"];
const ORES = [
  ...[
    "COAL", "IRON", "COPPER", "GOLD",
    "REDSTONE", "DIAMOND", "LAPIS", "EMERALD",
  ].flatMap((mineral) => [
    {
      id: BLOCK[`${mineral}_ORE`],
      host: BLOCK.STONE,
      deposit: BLOCK[`${mineral}_ORE`],
    },
    {
      id: BLOCK[`DEEPSLATE_${mineral}_ORE`],
      host: BLOCK.DEEPSLATE,
      deposit: BLOCK[`${mineral}_ORE`],
    },
  ]),
  { id: BLOCK.NETHER_GOLD_ORE, host: BLOCK.NETHERRACK, deposit: BLOCK.GOLD_ORE },
  { id: BLOCK.NETHER_QUARTZ_ORE, host: BLOCK.NETHERRACK, deposit: "quartz" },
];
const ORE_IDS = [
  14, 62, 63, 64, 65, 66, 67, 68, 1060, 1061, 1062, 1063, 1064,
  1065, 1066, 1067, 1068, 1069, 1070,
];
const MINERAL_IDS = [
  BLOCK.COAL_ORE,
  BLOCK.IRON_ORE,
  BLOCK.GOLD_ORE,
  BLOCK.COPPER_ORE,
  BLOCK.DIAMOND_ORE,
  BLOCK.EMERALD_ORE,
  BLOCK.REDSTONE_ORE,
  BLOCK.LAPIS_ORE,
];
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const brightness = (color) => (color[0] + color[1] + color[2]) / 3;
const mean = (values) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const pixel = (pixels, at) => pixels.subarray(at * 4, at * 4 + 4);

function paintDeposit(pixels, deposit) {
  if (deposit === "quartz") paintQuartzDeposits(pixels);
  else paintOreDeposits(pixels, deposit);
}

function depositPixels(deposit) {
  const pixels = new Uint8ClampedArray(BYTES);
  paintDeposit(pixels, deposit);
  return pixels;
}

function mineralColors(deposit) {
  const pixels = depositPixels(deposit);
  return Array.from({ length: COUNT }, (_, at) => pixel(pixels, at)).filter(
    (color) => color[3] === 255
  );
}

function hostContrast(id, host, deposit, face) {
  const original = blockTexturePixels(host, face);
  const pixels = blockTexturePixels(id, face);
  const mask = depositPixels(deposit);
  const differences = [];
  for (let at = 0; at < COUNT; at++)
    if (pixel(mask, at)[3])
      differences.push(
        brightness(pixel(pixels, at)) - brightness(pixel(original, at))
      );
  return differences;
}

function componentSizes(pixels) {
  const seen = new Set();
  const sizes = [];
  for (let start = 0; start < COUNT; start++) {
    if (!pixel(pixels, start)[3] || seen.has(start)) continue;
    const queue = [start];
    seen.add(start);
    for (let index = 0; index < queue.length; index++) {
      const at = queue[index];
      const x = at % TEXTURE_SIZE;
      const y = Math.floor(at / TEXTURE_SIZE);
      for (const [nx, ny] of [
        [x - 1, y],
        [x + 1, y],
        [x, y - 1],
        [x, y + 1],
      ]) {
        if (nx < 0 || nx >= TEXTURE_SIZE || ny < 0 || ny >= TEXTURE_SIZE)
          continue;
        const next = ny * TEXTURE_SIZE + nx;
        if (pixel(pixels, next)[3] && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    sizes.push(queue.length);
  }
  return sizes;
}

test("all 19 ore catalog entries retain their host, mineral and face dispatch", () => {
  // Preserve the current caller contract, not a claim of vanilla face fidelity:
  // Nether gold still shares gold, and deepslate ores still use host face art.
  assert.equal(TEXTURE_SIZE, 16);
  assert.deepEqual(
    [...ORES.map(({ id }) => id), BLOCK.ANCIENT_DEBRIS].sort((a, b) => a - b),
    ORE_IDS
  );
  assert.deepEqual(
    BLOCK_CATALOG.filter(
      (block) => block.texture === "ore" || block.id === BLOCK.ANCIENT_DEBRIS
    ).map(({ id }) => id).sort((a, b) => a - b),
    ORE_IDS
  );
  for (const { id, host, deposit } of ORES) {
    for (const face of FACES) {
      const expected = blockTexturePixels(host, face);
      paintDeposit(expected, deposit);
      assert.deepEqual(blockTexturePixels(id, face), expected, `${id}/${face}`);
    }
  }
  for (const face of FACES) {
    const expected = new Uint8ClampedArray(BYTES);
    assert.equal(
      paintProgressionMaterial(expected, { kind: "ancient_debris", face }),
      true
    );
    assert.deepEqual(blockTexturePixels(BLOCK.ANCIENT_DEBRIS, face), expected);
  }
  for (const id of ORE_IDS) {
    assert.equal(Boolean(BLOCKS[id].emissive), false, `${id}: no default glow`);
    assert.ok(blockEmissionPixels(id).every((value) => value === 0));
    for (const face of FACES) {
      const pixels = blockTexturePixels(id, face);
      assert.equal(pixels.length, BYTES);
      assert.deepEqual(pixels, blockTexturePixels(id, face));
      for (let at = 0; at < COUNT; at++) assert.equal(pixel(pixels, at)[3], 255);
    }
  }
  const debrisTiles = FACES.map((face) => tileFor(BLOCK.ANCIENT_DEBRIS, face));
  assert.equal(new Set(debrisTiles).size, 3, "keep the directional face slots");
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.ANCIENT_DEBRIS, "side"),
    blockTexturePixels(BLOCK.ANCIENT_DEBRIS, "top")
  );
  assert.deepEqual(
    blockTexturePixels(BLOCK.ANCIENT_DEBRIS, "top"),
    blockTexturePixels(BLOCK.ANCIENT_DEBRIS, "bottom")
  );
});

test("deposit overlays are deterministic, opaque, bounded and preserve every host byte outside the mask", () => {
  for (const deposit of new Set(ORES.map((entry) => entry.deposit))) {
    const isolated = depositPixels(deposit);
    const original = Uint8Array.from(
      { length: BYTES },
      (_, i) => (i * 37 + 13) % 256
    );
    for (const BufferType of [Uint8Array, Uint8ClampedArray]) {
      const guarded = new BufferType(BYTES + 32).fill(67);
      const target = guarded.subarray(16, BYTES + 16);
      target.set(original);
      paintDeposit(target, deposit);
      let hostPixels = 0;
      for (let at = 0; at < COUNT; at++) {
        const ink = pixel(isolated, at)[3];
        assert.ok(ink === 0 || ink === 255);
        const expected = pixel(ink ? isolated : original, at);
        assert.deepEqual([...pixel(target, at)], [...expected]);
        if (!ink) hostPixels++;
      }
      assert.ok(
        hostPixels >= 180 && hostPixels <= 220,
        `${deposit}: bounded coverage`
      );
      const once = new BufferType(target);
      paintDeposit(target, deposit);
      assert.deepEqual(target, once, `${deposit}: idempotent overlay`);
      assert.ok(guarded.subarray(0, 16).every((value) => value === 67));
      assert.ok(guarded.subarray(BYTES + 16).every((value) => value === 67));
    }
    assert.deepEqual(depositPixels(deposit), isolated);
  }
  const unsupported = new Uint8ClampedArray(BYTES).fill(41);
  assert.throws(() => paintOreDeposits(unsupported, BLOCK.STONE), RangeError);
  assert.ok(unsupported.every((value) => value === 41));
});

test("mineral families keep distinct bounded masks that allow small grains", () => {
  // Java 26.2 has small chips and more than five pockets in several families.
  // Do not enforce the previous four-island design or an invented size ratio.
  const masks = new Set();
  for (const id of MINERAL_IDS) {
    const pixels = depositPixels(id);
    const sizes = componentSizes(pixels);
    assert.ok(sizes.length >= 2 && sizes.length <= 16, `${id}: bounded fragments`);
    assert.ok(sizes.every((size) => size <= 32), `${id}: bounded connected mass`);
    assert.ok(sizes.some((size) => size >= 4), `${id}: not only isolated pixels`);
    const alpha = Uint8Array.from(
      { length: COUNT },
      (_, at) => pixel(pixels, at)[3]
    );
    masks.add(digest(alpha));
  }
  assert.equal(masks.size, MINERAL_IDS.length, "not one recolored ore template");
});

test("coal remains a predominantly dark near-neutral mineral over unchanged hosts", () => {
  const colors = mineralColors(BLOCK.COAL_ORE);
  for (const [r, g, b] of colors)
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) <= 16, "near-neutral tones");
  assert.ok(
    colors.filter((color) => brightness(color) < 60).length >= colors.length * 0.7
  );
  // The reference has dark grains, not mandatory bright silver fractures.
  for (const { id, host } of ORES.filter(
    (entry) => entry.deposit === BLOCK.COAL_ORE
  )) {
    for (const face of FACES) {
      const differences = hostContrast(id, host, BLOCK.COAL_ORE, face);
      assert.ok(
        mean(differences) < -12,
        `${id}/${face}: dark mineral, not a lifted host`
      );
    }
  }
});

test("mineral palettes retain coarse hue families without forbidding pale diffuse facets", () => {
  // Vanilla includes near-white gold/gem cores and mint-cyan diamond facets.
  // Emission is checked independently; bright RGB is not a glow flag.
  for (const [r, g, b] of mineralColors(BLOCK.IRON_ORE))
    assert.ok(r > g + 8 && g > b + 8, "warm iron");
  for (const [r, g, b] of mineralColors(BLOCK.GOLD_ORE))
    assert.ok(r >= g && g > b + 32, "yellow gold, including pale cores");
  for (const [r, g, b] of mineralColors(BLOCK.DIAMOND_ORE))
    assert.ok(g >= r + 25 && b >= r + 20 && Math.abs(g - b) <= 32, "cyan facets");
  for (const [r, g, b] of mineralColors(BLOCK.EMERALD_ORE))
    assert.ok(g >= r + 20 && g >= b + 16, "green facets");
  for (const [r, g, b] of mineralColors(BLOCK.REDSTONE_ORE))
    assert.ok(
      r >= g + 35 && r >= b + 35 && Math.abs(g - b) <= 12,
      "red with muted host-facing edges"
    );
  for (const [r, g, b] of mineralColors(BLOCK.LAPIS_ORE))
    assert.ok(b >= g + 25 && g >= r + 10, "blue lapis");
  const copper = mineralColors(BLOCK.COPPER_ORE);
  const orange = copper.filter(([r, g, b]) => r >= g + 45 && g >= b + 18).length;
  const oxidized = copper.filter(([r, g, b]) => g >= r + 20 && g >= b + 8).length;
  // The reference contains substantial green areas, not just sparse accents.
  // Keep both hue families; their precise balance needs visual comparison.
  assert.ok(orange >= 8, "copper-colored exposures");
  assert.ok(oxidized >= 8, "green exposures");
});

test("bright minerals keep local value separation from their dark geological hosts", () => {
  for (const { id, host, deposit } of ORES.filter(
    (entry) =>
      entry.host !== BLOCK.STONE &&
      [BLOCK.GOLD_ORE, BLOCK.DIAMOND_ORE, BLOCK.EMERALD_ORE].includes(
        entry.deposit
      )
  )) {
    for (const face of FACES) {
      assert.ok(
        mean(hostContrast(id, host, deposit, face)) > 30,
        `${id}/${face}: mineral/host separation`
      );
    }
  }
});

test("shared plain hosts and the unrelated quartz block stay byte-identical", () => {
  // Java 26.2 comparison reopened iron, lapis and quartz ore; their old pixels
  // are no longer scope guards. Plain hosts and quartz block remain untouched.
  const unchanged = [
    [
      BLOCK.STONE,
      "8600b998fabd8d9342caab329889a79fefb50f96d650102ace895dd0c15a04e2",
    ],
    [
      BLOCK.DEEPSLATE,
      "15c855711b153148c2aea21267a978342725f6dbab3bbfe2e17392b983cefead",
      "8363f938b7dbbc70eb257066c9a32d09cb33936d7739b4db5543caa1907b4cc4",
    ],
    [
      BLOCK.NETHERRACK,
      "172ce8e1afe913dc289ed5a0c749b33b0f48af91c4c5a1ae8c766e06e8e745c3",
    ],
    [
      BLOCK.QUARTZ_BLOCK,
      "7f89c3e63cae6c0c333dd02a189ad07083b60e49a3d912b66f83ac9c2b2ad60a",
    ],
  ];
  for (const [id, side, end = side] of unchanged)
    for (const face of FACES)
      assert.equal(
        digest(blockTexturePixels(id, face)),
        face === "side" ? side : end,
        `${id}/${face}`
      );
});

test("the ore refinement keeps the existing face allocations and 320 by 580 atlas budget", () => {
  const allTiles = new Set(
    BLOCK_CATALOG.flatMap((block) =>
      (block.textureParts ?? [undefined]).flatMap((part) =>
        FACES.map((face) => tileFor(block.id, face, part))
      )
    )
  );
  assert.equal(allTiles.size, 463);
  assert.equal(Math.max(...allTiles), 462);
  const oreTiles = new Set(
    ORE_IDS.flatMap((id) => FACES.map((face) => tileFor(id, face)))
  );
  assert.equal(oreTiles.size, 37, "no extra ore variants or atlas slots");
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          createImageData: (width, height) => ({
            data: new Uint8ClampedArray(width * height * 4),
          }),
          putImageData() {},
          drawImage() {},
        }),
      };
    },
  };
  let atlas;
  try {
    atlas = createAtlas();
    assert.deepEqual([atlas.canvas.width, atlas.canvas.height], [320, 580]);
    assert.deepEqual(
      [atlas.emissiveTexture.image.width, atlas.emissiveTexture.image.height],
      [320, 580]
    );
    assert.equal(atlas.texture.generateMipmaps, false);
  } finally {
    atlas?.texture.dispose();
    atlas?.emissiveTexture.dispose();
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
