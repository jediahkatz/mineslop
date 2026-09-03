import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { coversFace } from "../src/block-shapes.js";
import { structurePoint } from "../src/structure-layouts.js";
import { structureFixture } from "./structure-fixtures.js";
import {
  assertNativeStanding,
  assertSafetyClipping,
  assertSafetyRoutes,
  centeredStructurePoint,
  nativeSafetyWorld,
  resampleSafetyFixture,
} from "./structure-safety-fixtures.js";

for (const rotation of [0, 1, 2, 3]) {
  for (const [kind, variant] of [
    ["bastion_remnant", "bridge_keep"],
    ["bastion_remnant", "fallen_west"],
    ["nether_fortress", "crossing_vault"],
    ["nether_fortress", "broken_battlement"],
  ]) {
    test(`${variant} r${rotation} keeps every final pier cell solid through its declared floor`, () => {
      const fixture = resampleSafetyFixture(
        structureFixture(kind, {
          matches: (d) => d.rotation === rotation && d.variant === variant,
        })
      );
      const d = fixture.descriptor;
      assert.ok(d);
      const native = nativeSafetyWorld(fixture);
      assert.ok(d.plan.supports.some((p) => p.top > 0));
      for (const pier of d.plan.supports)
        for (let y = pier.bottom; y <= pier.top; y++) {
          const shape = native.localShape(pier.x, y, pier.z);
          assert.equal(shape.fullCollision, true);
          assert.ok(
            coversFace(shape, "up", "support"),
            `${kind} pier ${pier.x},${y},${pier.z} retains full support`
          );
        }
      for (const entry of d.entries)
        assertNativeStanding(native.world, {
          x: entry.x + 0.5,
          y: entry.y,
          z: entry.z + 0.5,
        });
      if (kind === "bastion_remnant") {
        for (const [x, z] of [
          [-6, -11],
          [6, -11],
          [-6, -5],
          [6, -5],
        ])
          for (const y of [1, 2, 3]) {
            const p = structurePoint(d, x, y, z);
            const history = native.writes.filter(
              (w) => w.x === p.x && w.y === p.y && w.z === p.z
            );
            assert.ok(history.some((w) => w.id === BLOCK.AIR));
            assert.equal(
              history.at(-1).id,
              BLOCK.BASALT,
              "excavation precedes the retained raised pier"
            );
          }
        assert.equal(native.localCell(0, 4, -8).id, BLOCK.BLACKSTONE);
        assertNativeStanding(native.world, centeredStructurePoint(d, 0, 5, -8));
        assertSafetyClipping(fixture, native);
      }
      assertSafetyRoutes(fixture);
    });
  }
}
