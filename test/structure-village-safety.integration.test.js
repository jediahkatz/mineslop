import assert from "node:assert/strict";
import test from "node:test";
import { coversFace } from "../src/block-shapes.js";
import { structureFixture } from "./structure-fixtures.js";
import {
  assertNativeStanding,
  assertNativeWalk,
  assertSafetyClipping,
  assertSafetyRoutes,
  centeredStructurePoint,
  nativeSafetyWorld,
  resampleSafetyFixture,
} from "./structure-safety-fixtures.js";

function terrace(steps, south = false) {
  return (c, x, z) => {
    const nearHome = south
      ? Math.abs(x - 10) <= 4
      : Math.abs(x - 10) <= 4 || Math.abs(x + 10) <= 4;
    const distance = south ? z : -z;
    const rise = !nearHome
      ? 0
      : distance >= 5
        ? steps
        : distance === 4
          ? Math.max(0, steps - 1)
          : 0;
    return { ...c, top: c.top + rise, landTop: c.top + rise };
  };
}

function assertFinalPaths(fixture, native, expectedMaxDelta) {
  const d = fixture.descriptor;
  const paths = new Map(d.plan.paths.map((p) => [`${p.x},${p.z}`, p]));
  let maxDelta = 0;
  for (const p of paths.values()) {
    assertNativeStanding(
      native.world,
      centeredStructurePoint(d, p.x, p.y + 1, p.z)
    );
    assert.ok(
      coversFace(native.localShape(p.x, p.y - 1, p.z), "up", "support"),
      "each final path and stair has a solid foundation"
    );
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const next = paths.get(`${p.x + dx},${p.z + dz}`);
      if (next) maxDelta = Math.max(maxDelta, Math.abs(next.y - p.y));
    }
  }
  assert.equal(maxDelta, expectedMaxDelta);
  return paths;
}

for (const rotation of [0, 1, 2, 3]) {
  for (const [label, steps, south] of [
    ["flat control", 0, false],
    ["normal approach control", 1, false],
    ["two-step north approach", 2, false],
    ["two-step south approach", 2, true],
  ]) {
    test(`village r${rotation} retains connected final geometry for ${label}`, () => {
      const flat = structureFixture("village", {
        matches: (d) => d.rotation === rotation && d.variant === "oak_lane",
      });
      const fixture = resampleSafetyFixture(flat, terrace(steps, south));
      const d = fixture.descriptor;
      assert.ok(d, "bounded terraced approaches remain eligible");
      const native = nativeSafetyWorld(fixture);
      const paths = assertFinalPaths(fixture, native, steps ? 1 : 0);
      for (const entry of d.entries)
        assertNativeStanding(native.world, {
          x: entry.x + 0.5,
          y: entry.y,
          z: entry.z + 0.5,
        });
      assertNativeWalk(native.world, centeredStructurePoint(d, -18, 1, 0), [
        centeredStructurePoint(d, -17, 1, 0),
      ]);
      for (const homeX of south ? [10] : [-10, 10])
        for (const dx of [-1, 0, 1]) {
          const x = homeX + dx;
          const sign = south ? 1 : -1;
          const start = paths.get(`${x},${sign * 2}`);
          const targets = [3, 4].map((distance) => {
            const p = paths.get(`${x},${sign * distance}`);
            return centeredStructurePoint(d, p.x, p.y + 1, p.z);
          });
          assertNativeWalk(
            native.world,
            centeredStructurePoint(d, start.x, start.y + 1, start.z),
            targets
          );
        }
      assertSafetyRoutes(fixture);
      if (steps === 2 && !south) assertSafetyClipping(fixture, native);
      if (!steps) {
        assert.deepEqual(d.plan, flat.descriptor.plan);
        assert.deepEqual(d.markers, flat.descriptor.markers);
      }
    });
  }

  test(`village r${rotation} still rejects an unbounded approach cliff`, () => {
    const flat = structureFixture("village", {
      matches: (d) => d.rotation === rotation,
    });
    assert.equal(resampleSafetyFixture(flat, terrace(4)).descriptor, null);
  });
}
