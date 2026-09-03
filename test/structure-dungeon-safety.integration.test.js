import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { structurePoint } from "../src/structure-layouts.js";
import {
  authoredColumn,
  cellKey,
  structureFixture,
} from "./structure-fixtures.js";
import {
  assertNativeStanding,
  assertNativeWalk,
  assertSafetyClipping,
  assertSafetyRoutes,
  centeredStructurePoint,
  nativeSafetyWorld,
  resampleSafetyFixture,
} from "./structure-safety-fixtures.js";

function dungeonFixture(rotation, variant = "mossy_zombie_cellar") {
  return structureFixture("dungeon", {
    column: authoredColumn("dungeon", {
      surface: BLOCK.STONE,
      soil: BLOCK.STONE,
    }),
    matches: (d) => d.rotation === rotation && d.variant === variant,
  });
}

for (const rotation of [0, 1, 2, 3]) {
  test(`dungeon r${rotation} rejects unsafe exact shaft and landing columns before emission`, () => {
    const flat = dungeonFixture(rotation);
    for (const [x, z] of [
      [0, 7],
      [1, 8],
      [2, 7],
      [3, 7],
      [6, 7],
    ])
      for (const invalid of [
        () => null,
        // Native regressions: top 76 caused the room ceiling to escape the
        // descriptor; top 280 caused a partial 6000-write shaft.
        (c) => ({ ...c, top: 76, landTop: 76 }),
        (c) => ({ ...c, top: 280, landTop: 280 }),
        (c) => ({ ...c, top: NaN }),
        (c) => ({ ...c, top: 84.5, landTop: 84.5 }),
        (c) => ({ ...c, landTop: c.top - 1 }),
        (c) => ({ ...c, waterLevel: c.top + 1 }),
        (c) => ({ ...c, id: "beach" }),
        (c) => ({ ...c, surfaceOpen: true }),
        (c) => ({ ...c, openings: [[c.top - 2, c.top]] }),
      ]) {
        const fixture = resampleSafetyFixture(flat, (c, lx, lz) =>
          lx === x && lz === z ? invalid(c) : c
        );
        assert.equal(fixture.descriptor, null, `unsafe column ${x},${z}`);
      }
  });

  test(`dungeon r${rotation} retains bounded high-altitude flat sites`, () => {
    const fixture = resampleSafetyFixture(dungeonFixture(rotation), (c) => ({
      ...c,
      top: 280,
      landTop: 280,
    }));
    assert.ok(fixture.descriptor);
    const native = nativeSafetyWorld(fixture);
    const entry = fixture.descriptor.entries[0];
    assertNativeStanding(native.world, {
      x: entry.x + 0.5,
      y: entry.y,
      z: entry.z + 0.5,
    });
    assert.equal(native.localCell(-4, 5, -4).id, BLOCK.COBBLESTONE);
  });

  for (const variant of ["mossy_zombie_cellar", "cracked_skeleton_cellar"]) {
    test(`${variant} r${rotation} keeps flat and one-block shaft controls accessible`, () => {
      const flat = dungeonFixture(rotation, variant);
      for (const shaftRise of [0, 1]) {
        const fixture = resampleSafetyFixture(flat, (c, x, z) =>
          x === 0 && z === 7
            ? { ...c, top: c.top + shaftRise, landTop: c.top + shaftRise }
            : c
        );
        const d = fixture.descriptor;
        assert.ok(d);
        assert.deepEqual(d.markers, flat.descriptor.markers);
        const native = nativeSafetyWorld(fixture);
        const outsideY = flat.column.top + 1 - d.origin.y;
        const entryY = d.entries[0].y - d.origin.y;
        assertNativeWalk(
          native.world,
          centeredStructurePoint(d, 6, outsideY, 7),
          [5, 4, 3, 2].map((x) =>
            centeredStructurePoint(d, x, x >= 4 ? outsideY : entryY, 7)
          )
        );
        for (let y = 1; y <= d.plan.shaftTop; y++) {
          const ladder = native.localShape(1, y, 8);
          assert.ok(ladder.attachment.valid);
          assert.ok(ladder.climbable);
        }
        assertSafetyRoutes(fixture);
      }
    });

    test(`${variant} r${rotation} clears its real buried entry and grades a bounded route to the east terrace`, () => {
      const flat = dungeonFixture(rotation, variant);
      const fixture = resampleSafetyFixture(flat, (c, x) => ({
        ...c,
        top: c.top + (x >= 2 ? 2 : 0),
        landTop: c.top + (x >= 2 ? 2 : 0),
      }));
      const d = fixture.descriptor;
      assert.ok(d, "a valid two-block terrace is repaired, not discarded");
      assert.deepEqual(d.markers, flat.descriptor.markers);
      const native = nativeSafetyWorld(fixture);
      for (const entry of d.entries) {
        assert.equal(
          native.world.getCell(entry.x, entry.y, entry.z).id,
          BLOCK.AIR
        );
        assert.equal(
          native.world.getCell(entry.x, entry.y + 1, entry.z).id,
          BLOCK.AIR
        );
        assertNativeStanding(native.world, {
          x: entry.x + 0.5,
          y: entry.y,
          z: entry.z + 0.5,
        });
      }
      for (const [x, z] of [
        [0, 7],
        [1, 8],
        [2, 7],
        [3, 7],
        [6, 7],
      ]) {
        const p = structurePoint(d, x, 0, z);
        assert.ok(fixture.queried.has(cellKey(p.x, 0, p.z)));
      }
      const entryY = d.entries[0].y - d.origin.y;
      assertNativeWalk(
        native.world,
        centeredStructurePoint(d, 2, entryY, 7),
        [3, 4, 5, 6].map((x) =>
          centeredStructurePoint(d, x, entryY + Math.min(x - 2, 2), 7)
        )
      );
      assertSafetyRoutes(fixture);
      assertSafetyClipping(fixture, native);
    });
  }
}
