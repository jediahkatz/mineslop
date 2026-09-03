import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { blockBatch } from "../src/mesh-palette.js";
import {
  paintStructureItem,
  paintStructureMaterial,
} from "../src/structure-art.js";
import {
  blockTexturePixels,
  itemTexturePixels,
  tileFor,
} from "../src/textures.js";

const materials = [
  ["GOLD_BLOCK", "gold_block"],
  ["MOSSY_COBBLESTONE", "mossy_cobblestone"],
  ["NETHER_BRICKS", "nether_bricks"],
  ["NETHER_BRICK_STAIRS", "nether_bricks"],
  ["NETHER_BRICK_SLAB", "nether_bricks"],
  ["NETHER_BRICK_FENCE", "nether_bricks"],
  ["NETHER_WART_CROP", "nether_wart_crop"],
  ["SPAWNER", "spawner"],
  ["COMPOSTER", "composter"],
  ["LECTERN", "lectern"],
  ["CARTOGRAPHY_TABLE", "cartography_table"],
  ["SMITHING_TABLE", "smithing_table"],
];
const faces = ["side", "top", "bottom"];

test("registered structure materials use their actual painter and declared face allocation", () => {
  for (const [name, kind] of materials) {
    const id = BLOCK[name];
    const block = BLOCKS[id];
    assert.deepEqual(block.art, { kind });
    assert.ok(Object.isFrozen(block.art));
    for (const face of faces) {
      const expected = new Uint8ClampedArray(1024);
      assert.equal(paintStructureMaterial(expected, { kind, face }), true);
      assert.deepEqual(
        blockTexturePixels(id, face),
        expected,
        `${name}/${face}`
      );
    }
    assert.equal(
      new Set(faces.map((face) => tileFor(id, face))).size,
      block.distinctFaces ? 3 : 1
    );
  }
});

test("Nether brick shapes share their declared material while keeping native block identities", () => {
  const ids = [
    BLOCK.NETHER_BRICKS,
    BLOCK.NETHER_BRICK_STAIRS,
    BLOCK.NETHER_BRICK_SLAB,
    BLOCK.NETHER_BRICK_FENCE,
  ];
  assert.equal(new Set(ids).size, 4);
  assert.equal(new Set(ids.map((id) => tileFor(id))).size, 4);
  for (const id of ids)
    assert.deepEqual(
      blockTexturePixels(id),
      blockTexturePixels(BLOCK.NETHER_BRICKS)
    );
});

test("spawner and wart cutouts preserve their distinct physical shapes", () => {
  for (const id of [BLOCK.SPAWNER, BLOCK.NETHER_WART_CROP]) {
    assert.equal(blockBatch[id], "foliage");
    assert.ok(
      blockTexturePixels(id).some(
        (value, index) => index % 4 === 3 && value === 0
      )
    );
  }
  assert.equal(BLOCKS[BLOCK.SPAWNER].shape, "cube");
  assert.equal(BLOCKS[BLOCK.SPAWNER].solid, true);
  assert.equal(BLOCKS[BLOCK.NETHER_WART_CROP].shape, "cross");
  assert.equal(BLOCKS[BLOCK.NETHER_WART_CROP].solid, false);
});

test("Nether ingredients use distinct original sprites instead of one generic fallback", () => {
  for (const [id, kind] of [
    [ITEM.NETHER_WART, "nether_wart"],
    [ITEM.NETHER_BRICK, "nether_brick"],
  ]) {
    assert.deepEqual(getItem(id).art, { kind });
    const expected = new Uint8ClampedArray(1024);
    assert.equal(paintStructureItem(expected, { kind }), true);
    assert.deepEqual(itemTexturePixels(id), expected);
  }
  assert.notDeepEqual(
    itemTexturePixels(ITEM.NETHER_WART),
    itemTexturePixels(ITEM.NETHER_BRICK)
  );
});
