import assert from "node:assert/strict";
import test from "node:test";
import {
  describeStructure,
  STRUCTURE_LIMITS,
} from "../src/structure-catalog.js";
import {
  createStructureSite,
  dryLandColumn,
  surveyStructure,
} from "../src/structure-placement.js";
import {
  authoredColumn,
  authoredContext,
  structureFixture,
} from "./structure-fixtures.js";

// Authored column fields only, not evidence of natural terrain discovery.
const offGridSurvey = {
  x0: -3,
  z0: -3,
  x1: 3,
  z1: 3,
  step: 4,
  maxRelief: 2,
  height: 3,
};
const key = (x, z) => `${x},${z}`;

function surveyedSite(
  anchor = authoredColumn("dungeon"),
  surrounding = authoredColumn("dungeon")
) {
  const { context } = authoredContext(
    "dungeon",
    "authored-survey",
    surrounding
  );
  const reads = [];
  const site = createStructureSite(
    {
      ...context,
      sampleColumn(x, z) {
        reads.push(key(x, z));
        return x === site.origin.x && z === site.origin.z
          ? anchor
          : surrounding;
      },
    },
    -2,
    -3
  );
  return { site, reads };
}

function assertUniqueSamples(reads) {
  assert.equal(new Set(reads).size, reads.length, "no repeated column reads");
  assert.ok(reads.length <= STRUCTURE_LIMITS.describeSamples);
}

function describeRelief(fixture, relief, gx = fixture.gx, gz = fixture.gz) {
  const { context, column, descriptor: d } = fixture;
  const reads = [];
  const result = describeStructure(
    d.kind,
    {
      ...context,
      sampleColumn(x, z) {
        reads.push(key(x, z));
        const top =
          column.top + (x === d.origin.x && z === d.origin.z ? 0 : relief);
        return { ...column, top, landTop: top };
      },
    },
    gx,
    gz
  );
  assertUniqueSamples(reads);
  return { result, reads };
}

test("an off-grid survey anchor contributes once without densifying either axis", () => {
  const anchor = authoredColumn("dungeon", { top: 82, landTop: 82 });
  const { site, reads } = surveyedSite(anchor);
  const cached = site.sample(0, 0);
  const checked = [];
  const result = surveyStructure(site, {
    ...offGridSurvey,
    predicate(column) {
      checked.push(column);
      return dryLandColumn(column);
    },
  });
  assert.ok(result);
  assert.equal(result.minTop, 82);
  assert.equal(result.maxTop, 84);
  assert.equal(result.floorY, 85);
  const expected = new Set(["0,0"]);
  for (const z of [-3, 1, 3])
    for (const x of [-3, 1, 3]) expected.add(key(x, z));
  assert.deepEqual(
    new Set(result.columns.map(({ x, z }) => key(x, z))),
    expected
  );
  assert.equal(result.columns.length, expected.size);
  assert.equal(checked.length, expected.size);
  assert.equal(checked.filter((column) => column === cached).length, 1);
  assert.equal(reads.length, expected.size);
  assertUniqueSamples(reads);
});

test("survey edges include the anchor and aligned grids never count it twice", () => {
  for (const rectangle of [
    { x0: 0, z0: -3, x1: 5, z1: 3 },
    { x0: -5, z0: -3, x1: 0, z1: 3 },
    { x0: -3, z0: 0, x1: 3, z1: 5 },
    { x0: -3, z0: -5, x1: 3, z1: 0 },
    { x0: -4, z0: -4, x1: 4, z1: 4 },
    { x0: 0, z0: 0, x1: 4, z1: 4 },
    { x0: 0, z0: 0, x1: 0, z1: 0 },
  ]) {
    const { site, reads } = surveyedSite(
      authoredColumn("dungeon", { top: 82, landTop: 82 })
    );
    site.sample(0, 0);
    const result = surveyStructure(site, { ...offGridSurvey, ...rectangle });
    assert.ok(result);
    assert.equal(result.minTop, 82);
    assert.equal(
      result.columns.filter(({ x, z }) => x === 0 && z === 0).length,
      1
    );
    assert.equal(
      new Set(result.columns.map(({ x, z }) => key(x, z))).size,
      result.columns.length
    );
    assert.equal(reads.length, result.columns.length);
    assertUniqueSamples(reads);
  }
});

test("a survey excludes an outside anchor even when the site already cached it", () => {
  for (const rectangle of [
    { x0: 1, z0: -3, x1: 5, z1: 3 },
    { x0: -5, z0: -3, x1: -1, z1: 3 },
    { x0: -3, z0: 1, x1: 3, z1: 5 },
    { x0: -3, z0: -5, x1: 3, z1: -1 },
  ]) {
    for (const cached of [false, true]) {
      const { site, reads } = surveyedSite(
        authoredColumn("dungeon", { top: 20, landTop: 20 })
      );
      if (cached) site.sample(0, 0);
      const result = surveyStructure(site, { ...offGridSurvey, ...rectangle });
      assert.ok(result);
      assert.equal(result.minTop, 84);
      assert.equal(result.maxTop, 84);
      assert.equal(result.floorY, 85);
      assert.equal(
        result.columns.some(({ x, z }) => x === 0 && z === 0),
        false
      );
      assert.equal(
        reads.filter((p) => p === key(site.origin.x, site.origin.z)).length,
        Number(cached)
      );
      assert.equal(reads.length, result.columns.length + Number(cached));
      assertUniqueSamples(reads);
    }
  }
});

for (const [label, change, options, surroundings] of [
  ["absent terrain", null, {}, {}],
  ["open surface", { surfaceOpen: true }, { predicate: () => true }, {}],
  ["missing surface support", { landTop: 83 }, {}, {}],
  ["near-surface opening", { openings: [[83, 85]] }, {}, {}],
  ["dry-land predicate", { waterLevel: 100 }, { predicate: dryLandColumn }, {}],
  ["roof clearance", { roof: 90 }, {}, { roof: 120 }],
  [
    "missing submersion",
    { waterLevel: null },
    { submerged: true },
    { waterLevel: 100 },
  ],
  [
    "water clearance",
    { waterLevel: 89 },
    { submerged: true },
    { waterLevel: 100 },
  ],
]) {
  test(`an off-grid anchor still enforces ${label}`, () => {
    const column = authoredColumn("dungeon", surroundings);
    const limits = { ...offGridSurvey, ...options };
    assert.ok(surveyStructure(surveyedSite(column, column).site, limits));
    const anchor =
      change === null ? null : Object.freeze({ ...column, ...change });
    const { site, reads } = surveyedSite(anchor, column);
    site.sample(0, 0);
    assert.equal(surveyStructure(site, limits), null);
    assertUniqueSamples(reads);
    assert.equal(
      reads.filter((p) => p === key(site.origin.x, site.origin.z)).length,
      1
    );
  });
}

test("cached anchors fit the exact column budget on offset and aligned grids", () => {
  for (const rectangle of [
    // 255 odd-coordinate grid points plus the off-grid anchor.
    { x0: -13, z0: -15, x1: 15, z1: 17, step: 2 },
    // 256 grid points already containing the anchor.
    { x0: -8, z0: -8, x1: 7, z1: 7, step: 1 },
  ]) {
    const { site, reads } = surveyedSite();
    site.sample(0, 0);
    const options = { ...rectangle, maxRelief: 0 };
    const result = surveyStructure(site, options);
    assert.ok(result);
    assert.equal(result.columns.length, STRUCTURE_LIMITS.describeSamples);
    assert.equal(reads.length, STRUCTURE_LIMITS.describeSamples);
    assertUniqueSamples(reads);
    assert.deepEqual(surveyStructure(site, options), result);
    assert.equal(reads.length, STRUCTURE_LIMITS.describeSamples);
    assert.throws(() => site.sample(32, 32), /column budget/);
    assert.equal(reads.length, STRUCTURE_LIMITS.describeSamples);
  }
});

for (const [kind, maxRelief, observedCliff] of [
  ["dungeon", 2, 12],
  ["nether_fortress", 6, 15],
]) {
  for (const rotation of [0, 1, 2, 3]) {
    test(`authored ${kind} anchor relief respects both signs and limits at rotation ${rotation}`, () => {
      const fixture = structureFixture(kind, {
        matches: (d) => d.rotation === rotation,
      });
      const original = structuredClone(fixture.descriptor);
      for (const relief of [
        0,
        maxRelief,
        -maxRelief,
        maxRelief + 1,
        -maxRelief - 1,
        observedCliff,
      ]) {
        const { result, reads } = describeRelief(fixture, relief);
        assert.equal(
          reads.filter((p) => p === key(original.origin.x, original.origin.z))
            .length,
          1
        );
        if (Math.abs(relief) > maxRelief) {
          assert.equal(result, null, `reject relief ${relief}`);
          continue;
        }
        assert.ok(result, `accept relief ${relief}`);
        if (relief === 0) assert.deepEqual(result, original);
        const { bounds } = result;
        const { spacing } = STRUCTURE_LIMITS;
        assert.ok(bounds.minX >= fixture.gx * spacing);
        assert.ok(bounds.maxX <= (fixture.gx + 1) * spacing);
        assert.ok(bounds.minZ >= fixture.gz * spacing);
        assert.ok(bounds.maxZ <= (fixture.gz + 1) * spacing);
        assert.ok(bounds.minY >= fixture.context.spec.minY);
        assert.ok(bounds.maxY <= fixture.context.spec.maxY);
        describeRelief(fixture, relief, fixture.gx + 1, fixture.gz - 1);
        assert.deepEqual(describeRelief(fixture, relief), { result, reads });
      }
      assert.deepEqual(fixture.descriptor, original);
    });
  }
}
