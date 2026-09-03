import assert from "node:assert/strict";
import test from "node:test";
import { paintProgressionItem } from "../src/expansion-progression-art.js";
import { getItem, ITEM } from "../src/items.js";
import { itemTexturePixels } from "../src/textures.js";

const alpha = (pixels) =>
  Array.from({ length: 256 }, (_, index) => pixels[index * 4 + 3]);

test("prismarine ingredients dispatch their own original material sprites", () => {
  for (const [id, kind] of [
    [ITEM.PRISMARINE_SHARD, "prismarine_shard"],
    [ITEM.PRISMARINE_CRYSTALS, "prismarine_crystals"],
  ]) {
    const item = getItem(id);
    assert.deepEqual(item.art, { kind });
    assert.ok(Object.isFrozen(item.art));
    const expected = new Uint8ClampedArray(16 * 16 * 4);
    assert.equal(paintProgressionItem(expected, item.art), true);
    assert.deepEqual(itemTexturePixels(id), expected);
    assert.notDeepEqual(expected, itemTexturePixels(ITEM.ARROW));
    assert.notDeepEqual(expected, itemTexturePixels(ITEM.QUARTZ));
    const mask = alpha(expected);
    assert.ok(mask.includes(0) && mask.includes(255));
  }
});

test("a prismarine shard and a crystal cluster differ in silhouette as well as color", () => {
  const shard = itemTexturePixels(ITEM.PRISMARINE_SHARD);
  const crystals = itemTexturePixels(ITEM.PRISMARINE_CRYSTALS);
  assert.notDeepEqual(shard, crystals);
  assert.notDeepEqual(alpha(shard), alpha(crystals));
  for (const pixels of [shard, crystals]) {
    for (let edge = 0; edge < 16; edge++)
      for (const index of [edge, 240 + edge, edge * 16, edge * 16 + 15])
        assert.equal(
          pixels[index * 4 + 3],
          0,
          "the sprite stays inside its tile"
        );
  }
});
