import assert from "node:assert/strict";
import test from "node:test";
import { getStructureMarkers } from "../src/structure-catalog.js";
import {
  authoredColumn,
  beachedStructureFixture,
  cellKey,
  namedStructureCells,
  reachableStructureCells,
  structureFixture,
} from "./structure-fixtures.js";

function assertInteriorRoutes(fixture) {
  const { descriptor: d } = fixture;
  const { cells } = namedStructureCells(d);
  const reachable = reachableStructureCells(fixture, cells);
  assert.ok(reachable.size > 0, `${d.variant} has a usable exterior entrance`);
  for (const entry of d.entries)
    assert.ok(
      reachable.has(cellKey(entry.x, entry.y, entry.z)),
      `${d.variant} connects every entry to the same exterior start`
    );
  const adjacent = ({ x, y, z }) =>
    [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dz]) => reachable.has(cellKey(x + dx, y, z + dz)));
  for (const marker of getStructureMarkers(d)) {
    const { x, y, z } = marker.position;
    if (
      ["container", "job_site", "bed"].includes(marker.type) ||
      marker.mechanism === "spawner"
    )
      assert.ok(
        adjacent(marker.position),
        `${d.variant} has a two-cell route to ${marker.role}`
      );
    else
      assert.ok(
        reachable.has(cellKey(x, y, z)),
        `${d.variant} connects its entrance to ${marker.role}`
      );
  }
}

for (const damage of ["whole", "broken_bow", "broken_stern"]) {
  test(`authored sunken ${damage} ship has a connected hold, companionway and surviving cabin`, () => {
    assertInteriorRoutes(
      structureFixture("shipwreck", {
        matches: (d) => d.plan.damage === damage,
      })
    );
  });
  test(`authored beached ${damage} ship has a supported shore gangway and climbable dry companionway`, () => {
    assertInteriorRoutes(beachedStructureFixture(damage));
  });
}

for (const [label, column] of [
  ["warm", authoredColumn("ocean_ruin")],
  [
    "cold",
    authoredColumn("ocean_ruin", { id: "cold_ocean", temperature: 0.3 }),
  ],
]) {
  test(`authored ${label} ruin connects its colonnaded entry to the shrine and annex`, () => {
    assertInteriorRoutes(
      structureFixture("ocean_ruin", { column, matches: (d) => d.plan.annex })
    );
  });
}

for (const variant of ["tidal_court", "split_crown"]) {
  test(`authored ${variant} monument connects all three elder chambers through flooded arches and the swim shaft`, () => {
    assertInteriorRoutes(
      structureFixture("ocean_monument", {
        matches: (d) => d.variant === variant,
      })
    );
  });
}

for (const id of ["plains", "desert", "taiga", "savanna"]) {
  test(`authored ${id} village has reachable homes, complete beds, jobs, stock chests and an irrigated farm`, () => {
    assertInteriorRoutes(
      structureFixture("village", { column: authoredColumn("village", { id }) })
    );
  });
}

test("authored fortress garden and blaze hall connect through supported crossing and bridge stairs", () => {
  assertInteriorRoutes(structureFixture("nether_fortress"));
});

for (const variant of ["bridge_keep", "fallen_west"]) {
  test(`authored ${variant} bastion exposes usable gate, armory, treasury stairs and surviving gallery`, () => {
    assertInteriorRoutes(
      structureFixture("bastion_remnant", {
        matches: (d) => d.variant === variant,
      })
    );
  });
}

for (const variant of ["mossy_zombie_cellar", "cracked_skeleton_cellar"]) {
  test(`authored ${variant} dungeon has a supported ladder shaft and connected caches`, () => {
    assertInteriorRoutes(
      structureFixture("dungeon", { matches: (d) => d.variant === variant })
    );
  });
}
