import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S, FLUID } from "../src/block-state.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { resolveShape } from "../src/block-shapes.js";
import {
  getStructureMarkers,
  STRUCTURE_KINDS,
} from "../src/structure-catalog.js";
import {
  rotateStructureXZ,
  structureBounds,
  structurePoint,
} from "../src/structure-layouts.js";
import {
  authoredColumn,
  cellKey,
  localStructureCell,
  namedStructureCells,
  registeredCell,
  structureFixture,
} from "./structure-fixtures.js";

test("authored rotations preserve negative-coordinate cell bounds and the same voxel layout", () => {
  assert.deepEqual(rotateStructureXZ(3, -7, 1), [7, 3]);
  assert.deepEqual(rotateStructureXZ(3, -7, 2), [-3, 7]);
  assert.deepEqual(rotateStructureXZ(3, -7, 3), [-7, -3]);
  assert.throws(() => rotateStructureXZ(0, 0, 4), /rotation/);
  const { descriptor: d } = structureFixture("shipwreck", {
    matches: (candidate) =>
      candidate.rotation === 0 && candidate.plan.damage === "whole",
  });
  const baseline = namedStructureCells(d).cells;
  for (const rotation of [1, 2, 3]) {
    const rotated = { ...d, rotation };
    rotated.bounds = structureBounds(rotated, d.localBounds);
    const cells = namedStructureCells(rotated).cells;
    assert.equal(cells.size, baseline.size);
    for (const cell of baseline.values()) {
      const p = structurePoint(
        rotated,
        cell.x - d.origin.x,
        cell.y - d.origin.y,
        cell.z - d.origin.z
      );
      const other = cells.get(cellKey(p.x, p.y, p.z));
      assert.equal(other.block, cell.block);
      assert.equal(other.fluid, cell.fluid);
      const kind = BLOCKS[BLOCK[cell.block]].shape;
      if (["stairs", "trapdoor", "ladder"].includes(kind))
        assert.equal(
          other.state & S.FACING_MASK,
          ((cell.state & S.FACING_MASK) + rotation) & S.FACING_MASK
        );
      if (cell.block === "OAK_LOG" && rotation & 1 && cell.state)
        assert.equal(
          other.state,
          cell.state === S.AXIS_X ? S.AXIS_Z : S.AXIS_X
        );
    }
  }
});

for (const kind of STRUCTURE_KINDS) {
  test(`authored ${kind} containers match real supported cells and never carry rolled contents`, () => {
    const { descriptor: d } = structureFixture(kind);
    const { cells } = namedStructureCells(d);
    const markers = getStructureMarkers(d, { type: "container" });
    assert.equal(
      [...cells.values()].filter((c) => c.block === "CHEST").length,
      markers.length
    );
    for (const marker of markers) {
      const { x, y, z } = marker.position;
      assert.equal(cells.get(cellKey(x, y, z))?.block, "CHEST");
      const support = cells.get(cellKey(x, y - 1, z));
      assert.ok(
        support && BLOCKS[BLOCK[support.block]]?.solid,
        `${marker.id} has a real floor`
      );
      assert.equal(typeof marker.table, "string");
      assert.equal(Object.hasOwn(marker, "slots"), false);
      if (kind !== "buried_treasure") {
        const lid = cells.get(cellKey(x, y + 1, z));
        assert.ok(
          lid && ["AIR", "WATER"].includes(lid.block),
          `${marker.id} has lid clearance`
        );
      }
    }
  });
}

for (const kind of [
  "shipwreck",
  "village",
  "nether_fortress",
  "bastion_remnant",
  "dungeon",
]) {
  test(`authored ${kind} uses canonical shape states with linked doors/beds and supported ladders in every rotation`, () => {
    for (const rotation of [0, 1, 2, 3]) {
      const { descriptor: d } = structureFixture(kind, {
        matches: (candidate) => candidate.rotation === rotation,
      });
      const { cells } = namedStructureCells(d);
      const neighborhood = (p) => (dx, dy, dz) => {
        const other = cells.get(cellKey(p.x + dx, p.y + dy, p.z + dz));
        return other
          ? registeredCell(other)
          : { id: BLOCK.AIR, state: 0, fluid: FLUID.NONE };
      };
      for (const cell of cells.values()) {
        const native = registeredCell(cell);
        const shape = resolveShape(native, neighborhood(cell));
        if (shape.kind === "door" || shape.kind === "bed")
          assert.equal(
            shape.link.valid,
            true,
            `${kind} ${cellKey(cell.x, cell.y, cell.z)}`
          );
        if (shape.kind === "ladder")
          assert.equal(
            shape.attachment.valid,
            true,
            `${kind} ladder has a full supporting face`
          );
        if (["door", "bed"].includes(shape.kind))
          assert.equal(cell.fluid, FLUID.NONE);
      }
    }
  });
}

test("authored wreck damage deletes the corresponding rooms and chest roles, with distinct supply/treasure/map tables", () => {
  const layouts = new Map();
  for (const damage of ["whole", "broken_bow", "broken_stern"]) {
    const { descriptor: d } = structureFixture("shipwreck", {
      matches: (candidate) => candidate.plan.damage === damage,
    });
    const { cells } = namedStructureCells(d);
    const markers = getStructureMarkers(d, { type: "container" });
    const roles = markers.map((m) => m.role).sort();
    assert.deepEqual(
      roles,
      damage === "whole"
        ? ["map", "supply", "treasure"]
        : damage === "broken_bow"
          ? ["map", "treasure"]
          : ["supply"]
    );
    assert.equal(new Set(markers.map((m) => m.table)).size, markers.length);
    assert.equal(
      markers.filter((m) => m.mapTarget).length,
      damage === "broken_stern" ? 0 : 1
    );
    layouts.set(damage, cells.size);
    assert.equal(
      localStructureCell(cells, d, 0, 0, damage === "broken_bow" ? -8 : 0)
        ?.block,
      damage === "broken_bow" ? undefined : "OAK_LOG"
    );
  }
  assert.equal(new Set(layouts.values()).size, layouts.size);
});

test("authored monuments contain exactly eight gold blocks, sponges, three distinct elders and no chest", () => {
  for (const variant of ["tidal_court", "split_crown"]) {
    const { descriptor: d } = structureFixture("ocean_monument", {
      matches: (candidate) => candidate.variant === variant,
    });
    const { cells } = namedStructureCells(d);
    assert.equal(
      [...cells.values()].filter((c) => c.block === "GOLD_BLOCK").length,
      8
    );
    assert.ok([...cells.values()].some((c) => c.block === "WET_SPONGE"));
    assert.equal(
      [...cells.values()].some((c) => c.block === "CHEST"),
      false
    );
    assert.deepEqual(getStructureMarkers(d, { type: "container" }), []);
    const elders = getStructureMarkers(d, { type: "encounter" });
    assert.equal(elders.length, 3);
    assert.equal(new Set(elders.map((e) => e.id)).size, 3);
    assert.ok(elders.every((e) => e.entity === "elder_guardian" && e.unique));
    assert.ok([...cells.values()].every((c) => c.y < d.waterLevel));
    assert.ok([...cells.values()].every((c) => c.block !== "AIR"));
    for (const elder of elders) {
      const { x, y, z } = elder.position;
      assert.equal(cells.get(cellKey(x, y, z)).block, "WATER");
      assert.equal(cells.get(cellKey(x, y + 1, z)).block, "WATER");
    }
  }
});

test("authored village members refer to unique homes, complete beds and actual profession blocks", () => {
  for (const column of [
    authoredColumn("village"),
    authoredColumn("village", { id: "desert", temperature: 0.9 }),
  ]) {
    const { descriptor: d } = structureFixture("village", { column });
    const { cells } = namedStructureCells(d);
    const markers = getStructureMarkers(d);
    const ids = new Map(markers.map((m) => [m.id, m]));
    const members = markers.filter((m) => m.type === "member");
    assert.equal(new Set(members.map((m) => m.bedId)).size, members.length);
    for (const member of members) {
      const home = ids.get(member.homeId);
      const bed = ids.get(member.bedId);
      const job = ids.get(member.jobSiteId);
      assert.equal(home.type, "home");
      assert.equal(bed.memberId, member.id);
      assert.equal(job.profession, member.profession);
      assert.equal(job.memberId, member.id);
      assert.equal(
        cells.get(cellKey(job.position.x, job.position.y, job.position.z))
          .block,
        job.block
      );
      assert.equal(
        cells.get(cellKey(home.entry.x, home.entry.y, home.entry.z)).block,
        "OAK_DOOR"
      );
    }
    for (const crop of [...cells.values()].filter(
      (c) => c.block === "WHEAT_CROP"
    ))
      assert.equal(
        cells.get(cellKey(crop.x, crop.y - 1, crop.z)).block,
        "FARMLAND"
      );
    assert.ok([...cells.values()].some((c) => c.block === "WATER"));
    assert.ok([...cells.values()].some((c) => c.block === "OAK_FENCE_GATE"));
  }
});

test("authored Nether exploration sites have real wart plots and spawner/treasure declarations, not granted resources", () => {
  const fortress = structureFixture("nether_fortress").descriptor;
  const fortressCells = namedStructureCells(fortress).cells;
  const wart = [...fortressCells.values()].filter(
    (c) => c.block === "NETHER_WART_CROP"
  );
  assert.ok(wart.length > 0);
  for (const crop of wart)
    assert.equal(
      fortressCells.get(cellKey(crop.x, crop.y - 1, crop.z)).block,
      "SOUL_SAND"
    );
  const blaze = getStructureMarkers(fortress).find(
    (m) => m.role === "blaze_spawner"
  );
  assert.equal(blaze.mechanism, "spawner");
  assert.equal(
    fortressCells.get(
      cellKey(blaze.position.x, blaze.position.y, blaze.position.z)
    ).block,
    "SPAWNER"
  );
  for (const variant of ["bridge_keep", "fallen_west"]) {
    const { descriptor: d } = structureFixture("bastion_remnant", {
      matches: (candidate) => candidate.variant === variant,
    });
    const chests = getStructureMarkers(d, { type: "container" });
    assert.deepEqual(
      chests.find((m) => m.role === "treasure").tableGuarantees,
      ["netherite_upgrade_template"]
    );
    assert.equal(
      chests.some((m) => m.role === "bridge_cache"),
      variant === "bridge_keep"
    );
  }
  const { descriptor: buried } = structureFixture("buried_treasure");
  const heart = getStructureMarkers(buried, { type: "container" })[0];
  assert.equal(heart.table, "buried_treasure/heart_of_sea");
  assert.deepEqual(heart.tableGuarantees, ["heart_of_sea"]);
});
