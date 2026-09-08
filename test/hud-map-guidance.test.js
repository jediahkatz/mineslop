import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { selectedMapGuidance } from "../src/ui/hud.js";

const map = {
  id: ITEM.TREASURE_MAP,
  count: 1,
  data: {
    version: 1,
    mapTarget: {
      seed: "beached-map-640",
      generatorVersion: 7,
      dimension: "overworld",
      structureId:
        "structure:v1:%22beached-map-640%22:overworld:buried_treasure:-2:0",
      x: -282,
      y: 60,
      z: 62,
    },
  },
};

test("selected persisted treasure maps give honest relative and absolute HUD guidance", () => {
  const cardinal = selectedMapGuidance(map, { x: -262, z: -93 });
  assert.equal(cardinal, "Treasure map · 20 west · 155 south · target -282, 60, 62");
  assert.ok(cardinal.length < 100, "guidance output stays bounded");
  assert.equal(
    selectedMapGuidance(map, { x: -282, z: 62 }),
    "Treasure map · target reached · target -282, 60, 62"
  );
});

test("map guidance rejects non-map spoofing, legacy targets and malformed stack metadata", () => {
  for (const stack of [
    { ...map, id: ITEM.PAPER },
    { ...map, count: 0 },
    { ...map, count: 1.5 },
    { ...map, extra: true },
    { ...map, data: null },
    { ...map, data: { ...map.data, version: 2 } },
    {
      ...map,
      data: {
        version: 1,
        mapTarget: { ...map.data.mapTarget, structureId: "legacy-map-target" },
      },
    },
  ])
    assert.equal(selectedMapGuidance(stack, { x: -262, z: -93 }), "");
  assert.equal(selectedMapGuidance({}, { x: 0, z: 0 }), "");
  assert.equal(selectedMapGuidance(map, null), "");
});

test("map guidance rejects unsafe positions, subtraction overflow and invalid target coordinates", () => {
  for (const position of [
    { x: Number.MAX_VALUE, z: -Number.MAX_VALUE },
    { x: Infinity, z: 0 },
    { x: -30_000_001, z: 0 },
    { x: 30_000_000, z: 0 },
  ])
    assert.equal(selectedMapGuidance(map, position), "");
  for (const mapTarget of [
    { ...map.data.mapTarget, x: -282.5 },
    { ...map.data.mapTarget, y: 320 },
    { ...map.data.mapTarget, z: 30_000_000 },
  ])
    assert.equal(
      selectedMapGuidance(
        { ...map, data: { version: 1, mapTarget } },
        { x: -262, z: -93 }
      ),
      ""
    );
});
