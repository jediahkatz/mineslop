import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { paintBuildingMaterial } from "../src/expansion-building-art.js";
import {
  paintProgressionItem,
  paintProgressionMaterial,
  paintQuartzDeposits,
} from "../src/expansion-progression-art.js";
import { getItem, ITEM } from "../src/items.js";
import { paintStone } from "../src/material-art.js";
import { paintOreDeposits } from "../src/ore-art.js";
import {
  blockTexturePixels,
  itemTexturePixels,
  tileFor,
} from "../src/textures.js";

const tile = () => new Uint8ClampedArray(16 * 16 * 4);
const ores = [
  "COAL",
  "IRON",
  "COPPER",
  "GOLD",
  "REDSTONE",
  "DIAMOND",
  "LAPIS",
  "EMERALD",
];

test("deep ores retain their mineral deposits over the registered deepslate host", () => {
  for (const name of ores) {
    const id = BLOCK[`DEEPSLATE_${name}_ORE`];
    const legacy = BLOCK[`${name}_ORE`];
    assert.equal(BLOCKS[id].oreHost, "deepslate");
    assert.equal(BLOCKS[id].oreArt, legacy);
    assert.equal(
      new Set(["side", "top", "bottom"].map((face) => tileFor(id, face))).size,
      3,
      `${name}: directional host faces cannot share the side atlas slot`
    );
    for (const face of ["side", "top", "bottom"]) {
      const expected = tile();
      assert.equal(
        paintBuildingMaterial(expected, { kind: "deepslate", face }),
        true
      );
      paintOreDeposits(expected, legacy);
      assert.deepEqual(blockTexturePixels(id, face), expected);
      assert.notDeepEqual(expected, blockTexturePixels(legacy, face));
    }
  }
});

test("Nether gold and quartz use the red host instead of ordinary stone", () => {
  for (const face of ["side", "top", "bottom"]) {
    const host = blockTexturePixels(BLOCK.NETHERRACK, face);
    const quartz = new Uint8ClampedArray(host);
    paintQuartzDeposits(quartz);
    assert.deepEqual(blockTexturePixels(BLOCK.NETHER_QUARTZ_ORE, face), quartz);
    const gold = new Uint8ClampedArray(host);
    paintOreDeposits(gold, BLOCK.GOLD_ORE);
    assert.deepEqual(blockTexturePixels(BLOCK.NETHER_GOLD_ORE, face), gold);
    assert.notDeepEqual(gold, quartz);
  }
});

test("historical ore textures retain their exact original composition", () => {
  for (const name of ores) {
    const id = BLOCK[`${name}_ORE`];
    const expected = tile();
    paintStone(expected);
    paintOreDeposits(expected, id);
    for (const face of ["side", "top", "bottom"])
      assert.deepEqual(blockTexturePixels(id, face), expected);
  }
});

test("registered progression blocks and items dispatch their actual original painters", () => {
  for (const id of [BLOCK.ANCIENT_DEBRIS, BLOCK.QUARTZ_BLOCK])
    for (const face of ["side", "top", "bottom"]) {
      const expected = tile();
      assert.equal(
        paintProgressionMaterial(expected, { ...BLOCKS[id].art, face }),
        true
      );
      assert.deepEqual(blockTexturePixels(id, face), expected);
    }
  for (const id of [
    ITEM.QUARTZ,
    ITEM.GOLD_NUGGET,
    ITEM.NETHERITE_SCRAP,
    ITEM.NETHERITE_INGOT,
  ]) {
    const expected = tile();
    assert.equal(paintProgressionItem(expected, getItem(id).art), true);
    assert.deepEqual(itemTexturePixels(id), expected);
  }
});
