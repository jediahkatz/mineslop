import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { paintBuildingMaterial } from "../src/expansion-building-art.js";
import { paintExpansionItem } from "../src/expansion-item-art.js";
import { paintExpansionMaterial } from "../src/expansion-material-art.js";
import { getItem, ITEM } from "../src/items.js";
import { usesHeldSprite } from "../src/held-item.js";
import { blockBatch } from "../src/mesh-palette.js";
import {
  blockTexturePixels,
  itemTexturePixels,
  tileFor,
} from "../src/textures.js";

test("registered marine blocks dispatch their explicit painter before generic material or plant fallbacks", () => {
  for (const id of [BLOCK.MAGMA_BLOCK, BLOCK.KELP, BLOCK.SEA_LANTERN]) {
    const block = BLOCKS[id];
    assert.ok(Object.isFrozen(block.art));
    for (const face of ["side", "top", "bottom"]) {
      const expected = new Uint8ClampedArray(16 * 16 * 4);
      assert.equal(
        paintExpansionMaterial(expected, { ...block.art, face }),
        true
      );
      assert.deepEqual(blockTexturePixels(id, face), expected);
    }
    assert.deepEqual(itemTexturePixels(id), blockTexturePixels(id));
  }
});

test("kelp's connected stem crosses both tile boundaries instead of using surface-grass art", () => {
  assert.equal(BLOCKS[BLOCK.KELP].shape, "cross");
  const pixels = blockTexturePixels(BLOCK.KELP);
  for (const y of [0, 15]) {
    assert.equal(pixels[(y * 16 + 7) * 4 + 3], 255);
    assert.equal(pixels[(y * 16 + 8) * 4 + 3], 255);
  }
  assert.ok(pixels.some((value, index) => index % 4 === 3 && value === 0));
  assert.notDeepEqual(pixels, blockTexturePixels(BLOCK.TALL_GRASS));
});

test("new ordinary items use the registered original sprites independently of numeric ID ranges", () => {
  for (const id of [ITEM.PAPER, ITEM.BOOK]) {
    const item = getItem(id);
    assert.ok(Object.isFrozen(item.art));
    const expected = new Uint8ClampedArray(16 * 16 * 4);
    assert.equal(paintExpansionItem(expected, item.art), true);
    assert.deepEqual(itemTexturePixels(id), expected);
  }
  assert.notDeepEqual(
    itemTexturePixels(ITEM.PAPER),
    itemTexturePixels(ITEM.BOOK)
  );
  assert.equal(
    getItem(ITEM.SHIELD).art,
    undefined,
    "legacy equipment keeps its painter"
  );
});

test("declared face-dependent building materials receive distinct atlas slots", () => {
  assert.equal(BLOCKS[BLOCK.BOOKSHELF].distinctFaces, true);
  const tiles = ["side", "top", "bottom"].map((face) =>
    tileFor(BLOCK.BOOKSHELF, face)
  );
  assert.equal(new Set(tiles).size, 3);
  assert.notEqual(tileFor(BLOCK.BOOKSHELF), tileFor(BLOCK.PLANKS));
});

test("building registries dispatch actual face and multipart artwork", () => {
  for (const id of [
    BLOCK.COPPER_BLOCK,
    BLOCK.BOOKSHELF,
    BLOCK.OAK_DOOR,
    BLOCK.OAK_TRAPDOOR,
    BLOCK.LADDER,
    BLOCK.WHITE_BED,
    BLOCK.DEEPSLATE,
    BLOCK.COBBLED_DEEPSLATE,
  ]) {
    const block = BLOCKS[id];
    for (const part of block.textureParts ?? [undefined]) {
      for (const face of ["side", "top", "bottom"]) {
        const expected = new Uint8ClampedArray(16 * 16 * 4);
        const descriptor = {
          ...block.art,
          face,
          ...(part === undefined ? {} : { part }),
        };
        assert.equal(paintBuildingMaterial(expected, descriptor), true);
        assert.deepEqual(blockTexturePixels(id, face, part), expected);
      }
    }
  }
});

test("doors and beds retain distinct upper/head tiles instead of reusing lower/foot artwork", () => {
  assert.notEqual(
    tileFor(BLOCK.OAK_DOOR, "side", "upper"),
    tileFor(BLOCK.OAK_DOOR, "side", "lower")
  );
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.OAK_DOOR, "side", "upper"),
    blockTexturePixels(BLOCK.OAK_DOOR, "side", "lower")
  );
  assert.notEqual(
    tileFor(BLOCK.WHITE_BED, "top", "head"),
    tileFor(BLOCK.WHITE_BED, "top", "foot")
  );
  assert.notDeepEqual(
    blockTexturePixels(BLOCK.WHITE_BED, "top", "head"),
    blockTexturePixels(BLOCK.WHITE_BED, "top", "foot")
  );
  assert.throws(() => tileFor(BLOCK.WHITE_BED, "top", "unknown"), RangeError);
  assert.throws(
    () => blockTexturePixels(BLOCK.OAK_DOOR, "side", "unknown"),
    RangeError
  );
});

test("optical building cutouts use the existing alpha-tested batch and flat held sprites where appropriate", () => {
  for (const id of [BLOCK.OAK_DOOR, BLOCK.OAK_TRAPDOOR, BLOCK.LADDER])
    assert.equal(blockBatch[id], "foliage");
  assert.equal(usesHeldSprite(BLOCK.OAK_DOOR), true);
  assert.equal(usesHeldSprite(BLOCK.LADDER), true);
  const upper = blockTexturePixels(BLOCK.OAK_DOOR, "side", "upper");
  assert.ok(upper.some((value, index) => index % 4 === 3 && value === 0));
  assert.equal(
    BLOCKS[BLOCK.OAK_DOOR].solid,
    true,
    "windows do not remove collision"
  );
});
