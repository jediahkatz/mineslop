import assert from "node:assert/strict";
import test from "node:test";
import {
  describeStructure,
  STRUCTURE_LIMITS,
} from "../src/structure-catalog.js";
import { rotateStructureXZ } from "../src/structure-layouts.js";
import { createStructureSite } from "../src/structure-placement.js";
import {
  authoredColumn,
  authoredContext,
  structureFixture,
} from "./structure-fixtures.js";

function resample(fixture, change) {
  const { descriptor: d, context, column } = fixture;
  let samples = 0;
  const result = describeStructure(
    d.kind,
    {
      ...context,
      sampleColumn(x, z) {
        samples++;
        return change(column, x - d.origin.x, z - d.origin.z);
      },
    },
    d.gx,
    d.gz
  );
  assert.ok(samples <= STRUCTURE_LIMITS.describeSamples);
  return result;
}

test("authored ocean placements reject shallow, mixed-climate, steep and exposed support fields", () => {
  const monument = structureFixture("ocean_monument");
  assert.equal(
    resample(monument, (c) => ({ ...c, top: 53, landTop: 53, depth: 10 })),
    null
  );
  assert.equal(
    resample(monument, (c) => ({ ...c, frozen: true })),
    null
  );
  assert.equal(
    resample(monument, (c, dx, dz) =>
      dx || dz ? { ...c, top: 46, landTop: 46, depth: 17 } : c
    ),
    null
  );
  const deep = resample(monument, (c) => ({
    ...c,
    top: -24,
    landTop: -24,
    depth: 87,
  }));
  assert.ok(deep);
  assert.ok(
    deep.bounds.minY < 0,
    "negative terrain elevation is not an absent-floor sentinel"
  );
  assert.ok(
    deep.bounds.maxY <= deep.waterLevel - 1,
    "every monument voxel stays submerged"
  );

  const ruin = structureFixture("ocean_ruin");
  assert.equal(
    resample(ruin, (c, dx, dz) =>
      dx || dz ? { ...c, id: "cold_ocean", temperature: 0.3 } : c
    ),
    null
  );
  assert.equal(
    resample(ruin, (c) => ({ ...c, top: 58, landTop: 58, depth: 5 })),
    null
  );
  const cold = structureFixture("ocean_ruin", {
    column: authoredColumn("ocean_ruin", {
      id: "cold_ocean",
      temperature: 0.3,
    }),
  });
  assert.match(cold.descriptor.variant, /^cold_/);
  assert.equal(
    resample(cold, (c) => ({ ...c, openings: [[c.top - 1, c.top + 2]] })),
    null
  );
});

test("authored village and dungeon placements reject water, cliffs, unsupported openings and build-limit breaches", () => {
  for (const kind of ["village", "dungeon"]) {
    const fixture = structureFixture(kind);
    assert.equal(
      resample(fixture, (c) => ({ ...c, waterLevel: c.top + 2 })),
      null
    );
    assert.equal(
      resample(fixture, (c) => ({ ...c, surfaceOpen: true, top: c.top - 5 })),
      null
    );
    assert.equal(
      resample(fixture, (c, dx, dz) =>
        dx || dz ? { ...c, top: c.top + 12, landTop: c.top + 12 } : c
      ),
      null
    );
    assert.equal(
      resample(fixture, (c) => ({
        ...c,
        top: fixture.context.spec.maxY - 2,
        landTop: fixture.context.spec.maxY - 2,
      })),
      null
    );
  }
  const village = structureFixture("village", {
    matches: (d) => d.rotation === 0,
  });
  const terraced = resample(village, (c, dx) => {
    const step = Math.max(-1, Math.min(1, Math.floor(dx / 6)));
    return { ...c, top: c.top + step, landTop: c.landTop + step };
  });
  assert.ok(terraced);
  assert.ok(new Set(terraced.plan.buildings.map((home) => home.y)).size > 1);
  assert.ok(new Set(terraced.plan.paths.map((path) => path.y)).size > 1);
  assert.ok(
    terraced.plan.supports.every((pier) => pier.top - pier.bottom <= 4)
  );
});

test("authored Nether sites require dry supports and clearance beneath the natural roof", () => {
  for (const kind of ["nether_fortress", "bastion_remnant"]) {
    const fixture = structureFixture(kind);
    assert.equal(
      resample(fixture, (c) => ({ ...c, roof: c.top + 7 })),
      null
    );
    assert.equal(
      resample(fixture, (c) => ({ ...c, top: 30, landTop: 30 })),
      null
    );
    assert.equal(
      resample(fixture, (c, dx, dz) =>
        dx || dz ? { ...c, top: c.top + 15, landTop: c.top + 15 } : c
      ),
      null
    );
  }
  const bastion = structureFixture("bastion_remnant");
  assert.equal(
    resample(bastion, (c) => ({ ...c, id: "basalt_deltas" })),
    null
  );
});

test("authored buried treasure remains on dry shore and below its natural surface", () => {
  const fixture = structureFixture("buried_treasure");
  assert.equal(
    resample(fixture, (c) => ({ ...c, waterLevel: 67 })),
    null
  );
  assert.equal(
    resample(fixture, (c) => ({ ...c, id: "stony_shore" })),
    null
  );
  assert.ok(fixture.descriptor.markers[0].position.y < fixture.column.top);
  assert.equal(fixture.descriptor.entries[0].y, fixture.column.top + 1);
});

test("authored beached wrecks require a real sampled shoreline instead of an inland boat display", () => {
  const beach = authoredColumn("buried_treasure");
  const shallow = authoredColumn("shipwreck", {
    top: 62,
    landTop: 62,
    depth: 1,
  });
  let descriptor = null;
  for (let i = 0; i < 512 && !descriptor; i++) {
    const { context } = authoredContext(
      "shipwreck",
      `authored-beached-${i}`,
      beach
    );
    const site = createStructureSite(context, -3, -4);
    const coastal = {
      ...context,
      sampleColumn(x, z) {
        const [, localZ] = rotateStructureXZ(
          x - site.origin.x,
          z - site.origin.z,
          (4 - site.rotation) & 3
        );
        return localZ >= 5 ? shallow : beach;
      },
    };
    descriptor = describeStructure("shipwreck", coastal, -3, -4);
    if (descriptor) {
      assert.ok(descriptor.plan.beached);
      assert.equal(describeStructure("shipwreck", context, -3, -4), null);
    }
  }
  assert.ok(descriptor);
});
