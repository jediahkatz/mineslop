import { BLOCK_STATE as S } from "./block-state.js";
import { localMarker } from "./structure-layouts.js";
import { dryLandColumn, surveyStructure } from "./structure-placement.js";

function prepareDungeon(site) {
  const maxRelief = 2;
  const survey = surveyStructure(site, {
    x0: -5,
    z0: -5,
    x1: 5,
    z1: 9,
    step: 4,
    height: 3,
    maxRelief,
    predicate: dryLandColumn,
  });
  if (!survey) return null;
  // The sparse survey misses the shaft and the actual east-facing landing.
  // Bound their exact columns before deriving a shaft height or emitting cells.
  const entranceTops = new Map();
  let minTop = survey.minTop;
  let maxTop = survey.maxTop;
  for (let z = 5; z <= 9; z++)
    for (let x = -2; x <= 6; x++) {
      if (x > 2 && (z === 5 || z === 9)) continue;
      const column = site.sample(x, z);
      if (!dryLandColumn(column)) return null;
      minTop = Math.min(minTop, column.top);
      maxTop = Math.max(maxTop, column.top);
      if (maxTop - minTop > maxRelief) return null;
      entranceTops.set(`${x},${z}`, column.top);
    }
  const y = survey.minTop - 10;
  const shaftTop = entranceTops.get("0,7") - y;
  const approach = [];
  for (let z = 6; z <= 8; z++) {
    const outside = entranceTops.get(`6,${z}`) - y;
    let previous = shaftTop;
    for (let x = 3; x <= 5; x++) {
      const top =
        outside >= shaftTop
          ? Math.min(outside, shaftTop + x - 2)
          : Math.max(outside, shaftTop - (x - 3));
      const stair = top > previous ? 1 : top > outside ? 3 : undefined;
      const natural = entranceTops.get(`${x},${z}`) - y;
      if (top !== natural || stair !== undefined)
        approach.push({
          x,
          z,
          y: top,
          bottom: Math.min(natural, top) - 1,
          ...(stair === undefined ? {} : { stair }),
        });
      previous = top;
    }
  }
  const high = Math.max(6, shaftTop + 3, ...approach.map((p) => p.y + 3));
  if (y - 1 < site.spec.minY + 3 || y + high >= site.spec.maxY) return null;
  return {
    y,
    waterLevel: null,
    variant:
      site.random("dungeon-occupant") < 0.5
        ? "mossy_zombie_cellar"
        : "cracked_skeleton_cellar",
    localBounds: [-5, -1, -5, 6, high, 10],
    entries: [[2, shaftTop + 1, 7, 3]],
    plan: { shaftTop, approach },
  };
}

function dungeonMarkers(d) {
  return [
    localMarker("container", "west_cache", "cellar_cache", [-3, 1, 2], {
      block: "CHEST",
      table: "dungeon/cache",
    }),
    localMarker("container", "east_cache", "cellar_cache", [3, 1, -2], {
      block: "CHEST",
      table: "dungeon/cache",
    }),
    localMarker("encounter", "cellar_spawner", "dungeon_spawner", [0, 1, 0], {
      block: "SPAWNER",
      mechanism: "spawner",
      unique: true,
      entity: d.variant === "mossy_zombie_cellar" ? "zombie" : "skeleton",
      localBounds: [-3, 1, -3, 4, 5, 4],
    }),
  ];
}

function emitDungeon(d, b) {
  const { shaftTop } = d.plan;
  b.fill(-4, -1, -4, 4, 0, 4, "COBBLESTONE");
  b.clear(-4, 1, -4, 4, 4, 4);
  b.walls(-4, 1, -4, 4, 4, 4, "MOSSY_COBBLESTONE");
  b.fill(-4, 5, -4, 4, 5, 4, "COBBLESTONE");
  for (const x of [-3, 0, 3]) b.fill(x, 0, -3, x, 0, 3, "MOSSY_COBBLESTONE");
  for (const z of [-3, 3]) b.fill(-3, 4, z, 3, 4, z, "OAK_LOG", S.AXIS_X);
  b.set(-3, 1, 2, "CHEST");
  b.set(3, 1, -2, "CHEST");
  b.set(0, 1, 0, "SPAWNER");
  b.fill(-2, 0, 4, 2, 0, 9, "COBBLESTONE");
  for (const x of [-2, 2]) b.fill(x, 1, 4, x, shaftTop, 9, "COBBLESTONE");
  b.fill(-2, 4, 4, 2, 4, 5, "COBBLESTONE");
  b.clear(-1, 1, 4, 1, 3, 7);
  b.fill(-2, shaftTop, 5, 2, shaftTop, 9, "MOSSY_COBBLESTONE");
  b.clear(-1, 1, 6, 1, shaftTop + 2, 8);
  b.fill(-1, 1, 9, 1, shaftTop + 1, 9, "COBBLESTONE");
  b.fill(1, 1, 8, 1, shaftTop, 8, "LADDER", 0);
  b.set(1, shaftTop + 1, 8, "OAK_TRAPDOOR", S.OPEN);
  // The declared entry stands on the east rim, outside the cleared shaft.
  b.clear(2, shaftTop + 1, 6, 2, shaftTop + 2, 8);
  for (const p of d.plan.approach) {
    b.fill(p.x, p.bottom, p.z, p.x, p.y - 1, p.z, "COBBLESTONE");
    b.set(
      p.x,
      p.y,
      p.z,
      p.stair === undefined ? "MOSSY_COBBLESTONE" : "OAK_STAIRS",
      p.stair ?? 0
    );
    b.clear(p.x, p.y + 1, p.z, p.x, p.y + 2, p.z);
  }
  if (d.variant === "cracked_skeleton_cellar") {
    b.clear(-4, 2, -1, -4, 3, 0);
    b.set(-3, 1, -1, "OAK_SLAB");
  }
}

export const UNDERGROUND_STRUCTURE_DEFINITION = {
  kind: "dungeon",
  dimension: "overworld",
  maxWrites: 6000,
  requiredContent: [
    "AIR",
    "COBBLESTONE",
    "MOSSY_COBBLESTONE",
    "OAK_LOG",
    "OAK_SLAB",
    "OAK_STAIRS",
    "CHEST",
    "SPAWNER",
    "LADDER",
    "OAK_TRAPDOOR",
  ],
  prepare: prepareDungeon,
  markers: dungeonMarkers,
  emit: emitDungeon,
};
