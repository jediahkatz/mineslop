import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { paintEquipmentItem } from "../src/equipment-art.js";

test("shield and iron equipment have distinct, bounded original pixel silhouettes", () => {
  const silhouettes = new Set();
  for (const name of ["SHIELD", "IRON_HELMET", "IRON_LEGGINGS", "IRON_BOOTS"]) {
    const pixels = new Uint8ClampedArray(16 * 16 * 4);
    assert.equal(paintEquipmentItem(pixels, name), true);
    const repeat = new Uint8ClampedArray(pixels.length);
    paintEquipmentItem(repeat, name);
    assert.deepEqual(pixels, repeat);
    const mask = Uint8Array.from({ length: 256 }, (_, i) => pixels[i * 4 + 3]);
    assert.ok(mask.every((alpha) => alpha === 0 || alpha === 255));
    const filled = mask.filter(Boolean).length;
    assert.ok(
      filled >= 45 && filled <= 150,
      `${name}: ${filled} visible pixels`
    );
    silhouettes.add(createHash("sha256").update(mask).digest("hex"));
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3]) colors.add([...pixels.subarray(i, i + 3)].join(","));
    }
    assert.ok(colors.size >= 4);
  }
  assert.equal(silhouettes.size, 4);
});

test("equipment dispatch leaves existing item painters untouched", () => {
  const pixels = new Uint8ClampedArray(16 * 16 * 4).fill(27);
  assert.equal(paintEquipmentItem(pixels, "BOW"), false);
  assert.ok(pixels.every((channel) => channel === 27));
});
