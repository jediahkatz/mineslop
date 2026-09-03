import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../src/blocks.js";
import {
  CONTENT_BLOCK_ART_DESCRIPTORS,
  paintContentBlockMaterial,
} from "../src/content-block-art.js";
import {
  CONTENT_ITEM_ART_DESCRIPTORS,
  CONTENT_POTION_ART_TYPES,
  paintContentItem,
  potionArtDescriptor,
} from "../src/content-item-art.js";
import { EXPANSION_WOOD_PALETTES } from "../src/expansion-art-common.js";
import { paintBuildingMaterial } from "../src/expansion-building-art.js";
import { paintExpansionItem } from "../src/expansion-item-art.js";
import { paintExpansionMaterial } from "../src/expansion-material-art.js";
import {
  GEAR_ITEM_ART_DESCRIPTORS,
  paintGearItem,
} from "../src/gear-item-art.js";
import { getItem, ITEM, ITEMS } from "../src/items.js";
import { BREWABLE_POTIONS } from "../src/potion-rules.js";
import { painter, rgb, TEXTURE_SIZE } from "../src/pixel-art.js";
import {
  blockTexturePixels,
  itemTexturePixels,
  tileFor,
} from "../src/textures.js";
import { WOOD_FAMILIES } from "../src/wood-content.js";

const BYTES = TEXTURE_SIZE * TEXTURE_SIZE * 4;
const digest = (pixels) => createHash("sha256").update(pixels).digest("hex");
const alpha = (pixels) =>
  Uint8Array.from(
    { length: TEXTURE_SIZE * TEXTURE_SIZE },
    (_, index) => pixels[index * 4 + 3]
  );
const colors = (pixels) => {
  const values = new Set();
  for (let index = 0; index < pixels.length; index += 4)
    if (pixels[index + 3])
      values.add([...pixels.subarray(index, index + 3)].join(","));
  return values;
};
const render = (paint, descriptor) => {
  const pixels = new Uint8ClampedArray(BYTES);
  assert.equal(paint(pixels, descriptor), true, JSON.stringify(descriptor));
  return pixels;
};
const paintBlock = (pixels, descriptor) =>
  paintBuildingMaterial(pixels, descriptor) ||
  paintExpansionMaterial(pixels, descriptor);

test("every newly registered item uses its explicit original painter through the actual texture dispatcher", () => {
  // Allocation bounds scope this wave; classification still comes from kind.
  const entries = ITEMS.filter(({ id }) => id >= 65546 && id <= 65632);
  assert.equal(entries.length, 87);
  const images = new Set();
  for (const item of entries) {
    assert.notEqual(item.kind, "block");
    assert.ok(item.art && Object.isFrozen(item.art), item.name);
    const expected = render(paintExpansionItem, item.art);
    assert.deepEqual(itemTexturePixels(item.id), expected, item.name);
    images.add(digest(expected));
    const mask = alpha(expected);
    assert.ok(mask.every((value) => value === 0 || value === 255));
    assert.ok(
      mask.filter(Boolean).length > 20 && mask.filter(Boolean).length < 240,
      item.name
    );
    assert.ok(
      colors(expected).size >= 3,
      `${item.name}: not a flat fallback swatch`
    );
  }
  assert.equal(
    images.size,
    entries.length,
    "Unrelated items cannot reuse the same fallback image"
  );
});

test("all new blocks dispatch explicit face/part descriptors without falling through to generic textures", () => {
  const entries = BLOCK_CATALOG.filter(({ id }) => id >= 1104 && id <= 1194);
  assert.equal(entries.length, 91);
  for (const block of entries) {
    assert.ok(block.art && Object.isFrozen(block.art), block.name);
    for (const part of block.textureParts ?? [undefined]) {
      for (const face of ["side", "top", "bottom"]) {
        const descriptor = {
          ...block.art,
          face,
          ...(part === undefined ? {} : { part }),
        };
        const expected = render(paintBlock, descriptor);
        assert.deepEqual(
          blockTexturePixels(block.id, face, part),
          expected,
          `${block.name}/${face}/${part}`
        );
        assert.ok(alpha(expected).some((value) => value === 255));
      }
    }
    assert.deepEqual(
      itemTexturePixels(block.id),
      blockTexturePixels(block.id),
      block.name
    );
  }
});

test("wood families use their explicit palettes and matching construction faces, not numeric-ID color fallbacks", () => {
  const plankImages = new Set();
  for (const family of WOOD_FAMILIES) {
    const expected = render(paintExpansionMaterial, {
      kind: "planks",
      variant: family.key,
      face: "side",
    });
    const palette = EXPANSION_WOOD_PALETTES[family.key].map((tone) =>
      rgb(tone).join(",")
    );
    assert.ok(
      [...colors(expected)].every((color) => palette.includes(color)),
      family.key
    );
    assert.ok(alpha(expected).every((value) => value === 255));
    plankImages.add(digest(expected));
    for (const part of ["planks", "slab", "stairs", "fence", "fence_gate"]) {
      const block = BLOCKS[family[part]];
      assert.equal(block.art.variant, family.key);
      assert.equal(block.woodFamily, family.key);
      assert.deepEqual(
        blockTexturePixels(block.id),
        expected,
        `${family.key}.${part}`
      );
    }
    const door = BLOCKS[family.door];
    const lower = blockTexturePixels(door.id, "side", "lower");
    const upper = blockTexturePixels(door.id, "side", "upper");
    assert.notDeepEqual(
      upper,
      lower,
      `${family.key}: two authored door halves`
    );
    assert.ok(
      alpha(upper).some((value) => value === 0),
      "Optical window cutout"
    );
    assert.equal(
      door.solid,
      true,
      "Optical holes do not delete the door collision"
    );
    assert.equal(door.cutout, true);
    assert.notEqual(
      tileFor(door.id, "side", "lower"),
      tileFor(door.id, "side", "upper")
    );
    assert.notDeepEqual(blockTexturePixels(family.trapdoor, "top"), expected);
  }
  assert.equal(plankImages.size, 12);
  assert.equal(WOOD_FAMILIES[0].planks, 7);
});

test("new gear/resource painters are deterministic, binary-alpha and strictly bounded to one tile", () => {
  for (const descriptor of [
    ...GEAR_ITEM_ART_DESCRIPTORS,
    ...CONTENT_ITEM_ART_DESCRIPTORS,
  ]) {
    assert.ok(Object.isFrozen(descriptor));
    const expected = render(paintExpansionItem, descriptor);
    const guarded = new Uint8Array(BYTES + 16).fill(137);
    const target = guarded.subarray(8, BYTES + 8);
    assert.equal(paintExpansionItem(target, descriptor), true);
    assert.deepEqual([...target], [...expected], JSON.stringify(descriptor));
    assert.ok(guarded.subarray(0, 8).every((value) => value === 137));
    assert.ok(guarded.subarray(BYTES + 8).every((value) => value === 137));
    assert.ok(alpha(expected).every((value) => value === 0 || value === 255));
    for (let at = 0; at < BYTES; at += 4)
      if (expected[at + 3] === 0)
        assert.ok(expected.subarray(at, at + 4).every((value) => value === 0));
  }
  for (const descriptor of CONTENT_BLOCK_ART_DESCRIPTORS) {
    const expected = render(paintContentBlockMaterial, descriptor);
    assert.deepEqual(render(paintExpansionMaterial, descriptor), expected);
    const untouched = new Uint8ClampedArray(BYTES).fill(29);
    assert.equal(paintBuildingMaterial(untouched, descriptor), false);
    assert.ok(untouched.every((value) => value === 29));
    for (const paint of [paintContentBlockMaterial, paintExpansionMaterial]) {
      const guarded = new Uint8Array(BYTES + 8).fill(83);
      const target = guarded.subarray(4, BYTES + 4);
      assert.equal(paint(target, descriptor), true);
      assert.deepEqual([...target], [...expected]);
      assert.ok(guarded.subarray(0, 4).every((value) => value === 83));
      assert.ok(guarded.subarray(BYTES + 4).every((value) => value === 83));
    }
  }
});

test("anvils retain supported metal fallback, station stats and exact authored wear overlays", () => {
  const stages = [
    [BLOCK.ANVIL, "anvil", BLOCK.CHIPPED_ANVIL],
    [BLOCK.CHIPPED_ANVIL, "chipped_anvil", BLOCK.DAMAGED_ANVIL],
    [BLOCK.DAMAGED_ANVIL, "damaged_anvil", null],
  ];
  for (const [stage, [id, kind, next]] of stages.entries()) {
    const block = BLOCKS[id];
    assert.equal(block.texture, "metal");
    assert.equal(block.color, "#5c696d");
    assert.equal(block.hardness, 5);
    assert.equal(block.tool, "pickaxe");
    assert.equal(block.tier, 1);
    assert.equal(block.station, "anvil");
    assert.equal(block.directional, true);
    assert.equal(block.distinctFaces, true);
    assert.equal(block.anvilStage, stage);
    assert.equal(block.nextDamagedBlock, next);
    assert.deepEqual(block.art, { kind });
    for (const face of ["side", "top", "bottom"]) {
      const expected = render(paintExpansionMaterial, { kind: "anvil", face });
      // Preserve the checkpoint's crack strokes independently of dispatch.
      if (stage > 0) {
        const p = painter(expected);
        p.line(5, 2, 7, 6, "#30353c");
        p.line(7, 6, 5, 9, "#30353c");
        if (stage === 2) {
          p.line(7, 6, 11, 8, "#30353c", 2);
          p.line(11, 8, 9, 13, "#30353c");
          p.line(6, 4, 8, 4, "#9aa9a6");
        }
      }
      assert.deepEqual(blockTexturePixels(id, face), expected, `${kind}/${face}`);
    }
  }
});

test("unrelated resource silhouettes and material faces remain distinct", () => {
  for (const [a, b] of [
    [ITEM.TREASURE_MAP, ITEM.BOOK],
    [ITEM.TREASURE_MAP, ITEM.NETHERITE_UPGRADE_TEMPLATE],
    [ITEM.BLAZE_ROD, ITEM.BLAZE_POWDER],
    [ITEM.GHAST_TEAR, ITEM.GLOWSTONE_DUST],
    [ITEM.CARROT, ITEM.MELON_SLICE],
    [ITEM.POTION, ITEM.SPLASH_POTION],
    [ITEM.COPPER_PICKAXE, ITEM.COPPER_HOE],
    [ITEM.COPPER_HELMET, ITEM.COPPER_CHESTPLATE],
  ])
    assert.notDeepEqual(
      alpha(itemTexturePixels(a)),
      alpha(itemTexturePixels(b)),
      `${getItem(a).name}/${getItem(b).name}`
    );
  for (const [a, b] of [
    [BLOCK.BAMBOO_BLOCK, BLOCK.BAMBOO_PLANKS],
    [BLOCK.BARREL, BLOCK.CHEST],
    [BLOCK.BLAST_FURNACE, BLOCK.FURNACE],
    [BLOCK.BREWING_STAND, BLOCK.ENCHANTING_TABLE],
    [BLOCK.ANVIL, BLOCK.CHIPPED_ANVIL],
    [BLOCK.CHIPPED_ANVIL, BLOCK.DAMAGED_ANVIL],
    [BLOCK.IRON_BLOCK, BLOCK.SMOOTH_STONE],
    [BLOCK.DRIED_KELP_BLOCK, BLOCK.KELP],
    [BLOCK.CARROT_CROP, BLOCK.WHEAT_CROP],
    [BLOCK.CONDUIT, BLOCK.TURTLE_EGG],
  ])
    assert.notDeepEqual(
      blockTexturePixels(a),
      blockTexturePixels(b),
      `${getItem(a).name}/${getItem(b).name}`
    );
  assert.notDeepEqual(
    itemTexturePixels(ITEM.RAW_COD),
    itemTexturePixels(ITEM.COOKED_COD)
  );
  assert.notDeepEqual(
    itemTexturePixels(ITEM.RAW_SALMON),
    itemTexturePixels(ITEM.COOKED_SALMON)
  );
});

test("every supported potion has explicit metadata-driven drink/splash art without catalog mutation", () => {
  assert.deepEqual(
    [...CONTENT_POTION_ART_TYPES].sort(),
    Object.keys(BREWABLE_POTIONS).sort()
  );
  const catalogBefore = JSON.stringify(getItem(ITEM.POTION));
  const images = new Set();
  for (const id of Object.keys(BREWABLE_POTIONS)) {
    const descriptors = ["drinkable", "splash"].map((form) =>
      potionArtDescriptor({ id, form })
    );
    for (const descriptor of descriptors) {
      assert.ok(descriptor);
      images.add(digest(render(paintExpansionItem, descriptor)));
    }
    assert.notDeepEqual(
      alpha(render(paintExpansionItem, descriptors[0])),
      alpha(render(paintExpansionItem, descriptors[1]))
    );
  }
  assert.equal(images.size, CONTENT_POTION_ART_TYPES.length * 2);
  assert.equal(JSON.stringify(getItem(ITEM.POTION)), catalogBefore);
  assert.equal(
    potionArtDescriptor({ id: "not_a_potion", form: "drinkable" }),
    null
  );
  assert.equal(potionArtDescriptor({ id: "water", form: "lingering" }), null);
});

test("unknown new descriptors and invalid targets cannot partly overwrite a tile", () => {
  for (const [paint, options] of [
    [
      paintContentItem,
      { kind: "brewed_potion", variant: "water", form: "lingering" },
    ],
    [paintContentItem, { kind: "treasure_map", variant: "diamond" }],
    [paintGearItem, { kind: "gear_tool", material: "copper", tool: "bow" }],
    [paintGearItem, { kind: "gear_armor", material: "turtle", slot: "chest" }],
    [
      paintGearItem,
      { kind: "gear_tool", material: "unregistered", tool: "pickaxe" },
    ],
    [paintContentBlockMaterial, { kind: "barrel", face: "front" }],
    [paintContentBlockMaterial, { kind: "iron_block", unrelated: true }],
    [paintExpansionMaterial, { kind: "barrel", face: "front" }],
    [paintExpansionMaterial, { kind: "iron_block", unrelated: true }],
  ]) {
    const pixels = new Uint8ClampedArray(BYTES).fill(31);
    assert.equal(paint(pixels, options), false);
    assert.ok(pixels.every((value) => value === 31));
  }
  for (const [paint, options] of [
    [paintContentItem, { kind: "treasure_map" }],
    [paintGearItem, { kind: "gear_tool", material: "copper", tool: "hoe" }],
    [paintContentBlockMaterial, { kind: "barrel" }],
    [paintExpansionMaterial, { kind: "barrel" }],
    [paintExpansionMaterial, { kind: "chipped_anvil" }],
  ]) {
    const short = new Uint8Array(BYTES - 1).fill(53);
    const wrongType = new Float32Array(BYTES).fill(53);
    assert.throws(() => paint(short, options), RangeError);
    assert.throws(() => paint(wrongType, options), TypeError);
    assert.ok(short.every((value) => value === 53));
    assert.ok(wrongType.every((value) => value === 53));
  }
});
