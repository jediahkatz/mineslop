import { BLOCK_STATE as S } from "./block-state.js";
import { localMarker, oakRoof } from "./structure-layouts.js";
import { villageColumn } from "./structure-placement.js";

const homes = [
  { key: "farmstead", x: -10, z: -8, front: 2 },
  { key: "library", x: 10, z: -8, front: 2 },
  { key: "smithy", x: 10, z: 8, front: 0 },
];
const residents = [
  {
    key: "grower",
    home: "farmstead",
    profession: "farmer",
    side: -1,
    job: "composter",
  },
  {
    key: "reader",
    home: "library",
    profession: "librarian",
    side: -1,
    job: "lectern",
  },
  {
    key: "surveyor",
    home: "library",
    profession: "cartographer",
    side: 1,
    job: "map_desk",
  },
  {
    key: "smith",
    home: "smithy",
    profession: "toolsmith",
    side: -1,
    job: "smithing_bench",
  },
];

function samplePad(site, x, z, rx, rz) {
  const points = [];
  for (const dz of [-rz, 0, rz])
    for (const dx of [-rx, 0, rx]) {
      const column = site.sample(x + dx, z + dz);
      if (!villageColumn(column)) return null;
      points.push({ x: x + dx, z: z + dz, top: column.top });
    }
  const floor = Math.max(...points.map((p) => p.top));
  if (floor - Math.min(...points.map((p) => p.top)) > 2) return null;
  return { floor, points };
}

function pathStepsFit(paths) {
  for (const path of paths.values())
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
    ]) {
      const next = paths.get(`${path.x + dx},${path.z + dz}`);
      if (next && Math.abs(next.y - path.y) > 1) return false;
    }
  return true;
}

function gradeApproaches(paths) {
  const pending = [...paths.values()].filter(
    (path) => path.stair !== undefined
  );
  for (let i = 0; i < pending.length; i++) {
    const path = pending[i];
    for (const [dx, dz, facing] of [
      [0, -1, 0],
      [1, 0, 1],
      [0, 1, 2],
      [-1, 0, 3],
    ]) {
      const next = paths.get(`${path.x + dx},${path.z + dz}`);
      if (!next || next.y >= path.y - 1) continue;
      // Initial edges differ by at most one, and each doorway raises its
      // approach by at most one. Propagation therefore raises any path once.
      next.y = path.y - 1;
      next.stair = (facing + 2) & 3;
      pending.push(next);
    }
  }
}

function prepareVillage(site) {
  const paths = new Map();
  const addPath = (x, z) => paths.set(`${x},${z}`, { x, z });
  for (let x = -17; x <= 17; x++) for (let z = -1; z <= 1; z++) addPath(x, z);
  for (const cx of [-10, 10])
    for (const sign of [-1, 1])
      for (let dz = 2; dz <= 4; dz++)
        for (let dx = -1; dx <= 1; dx++) addPath(cx + dx, sign * dz);
  for (let x = -2; x <= 2; x++) for (const z of [-2, 2]) addPath(x, z);
  for (let x = -1; x <= 1; x++) addPath(x, -3);

  const baseY = site.sample(0, 0).top;
  for (const path of paths.values()) {
    const column = site.sample(path.x, path.z);
    if (!villageColumn(column)) return null;
    path.y = column.top - baseY;
    path.bottom = path.y - 1;
  }
  if (!pathStepsFit(paths)) return null;
  const buildings = [];
  for (const home of homes) {
    const pad = samplePad(site, home.x, home.z, 3, 3);
    if (!pad) return null;
    const y = pad.floor - baseY;
    const approachZ = home.front === 2 ? -4 : 4;
    for (let dx = -1; dx <= 1; dx++) {
      const approach = paths.get(`${home.x + dx},${approachZ}`);
      if (!approach || Math.abs(approach.y - y) > 1) return null;
      if (approach.y < y) {
        approach.y = y;
        approach.stair = (home.front + 2) & 3;
      }
    }
    buildings.push({
      ...home,
      y,
      supports: pad.points.map((p) => ({
        x: p.x,
        z: p.z,
        bottom: p.top - baseY - 1,
        top: y,
      })),
    });
  }
  gradeApproaches(paths);
  if (!pathStepsFit(paths)) return null;
  for (const home of buildings)
    for (let dx = -1; dx <= 1; dx++) {
      const approach = paths.get(`${home.x + dx},${home.front === 2 ? -4 : 4}`);
      if (Math.abs(approach.y - home.y) > 1) return null;
    }
  const farm = samplePad(site, -10, 9, 3, 4);
  const well = samplePad(site, 0, -5, 1, 1);
  if (!farm || !well) return null;
  const farmY = farm.floor - baseY;
  const wellY = well.floor - baseY;
  if (
    Math.abs(paths.get("-10,4").y - farmY) > 1 ||
    Math.abs(paths.get("0,-3").y - wellY) > 1
  )
    return null;
  const allTops = [
    ...[...paths.values()].map((p) => p.y),
    ...buildings.map((p) => p.y),
    farmY,
    wellY,
  ];
  if (Math.max(...allTops) - Math.min(...allTops) > 4) return null;
  const id = site.sample(0, 0).id;
  const style =
    id === "desert"
      ? "sandstone"
      : id.includes("taiga") || id.includes("snowy")
        ? "spruce"
        : id.startsWith("savanna")
          ? "acacia"
          : "oak";
  const supports = [
    ...buildings.flatMap((h) => h.supports),
    ...farm.points.map((p) => ({
      x: p.x,
      z: p.z,
      bottom: p.top - baseY - 1,
      top: farmY,
    })),
    ...well.points.map((p) => ({
      x: p.x,
      z: p.z,
      bottom: p.top - baseY - 1,
      top: wellY,
    })),
  ];
  const low = Math.min(
    ...supports.map((s) => s.bottom),
    ...[...paths.values()].map((p) => p.bottom),
    wellY - 1
  );
  const high = Math.max(...buildings.map((h) => h.y + 9), farmY + 3, wellY + 5);
  if (baseY + low < site.spec.minY || baseY + high > site.spec.maxY)
    return null;
  return {
    y: baseY,
    waterLevel: null,
    variant: `${style}_lane`,
    localBounds: [-18, low, -13, 19, high, 15],
    entries: [
      [-17, paths.get("-17,0").y + 1, 0, 1],
      [17, paths.get("17,0").y + 1, 0, 3],
    ],
    plan: {
      style,
      buildings,
      paths: [...paths.values()],
      supports,
      farmY,
      wellY,
    },
  };
}

function villageJobs(d) {
  const library = d.plan.buildings.find((h) => h.key === "library");
  const smithy = d.plan.buildings.find((h) => h.key === "smithy");
  return [
    {
      key: "composter",
      profession: "farmer",
      block: "COMPOSTER",
      at: [-12, d.plan.farmY + 1, 6],
    },
    {
      key: "lectern",
      profession: "librarian",
      block: "LECTERN",
      at: [9, library.y + 1, -10],
    },
    {
      key: "map_desk",
      profession: "cartographer",
      block: "CARTOGRAPHY_TABLE",
      at: [11, library.y + 1, -10],
      mapTarget: { kind: "ocean_monument", dimension: "overworld" },
    },
    {
      key: "smithing_bench",
      profession: "toolsmith",
      block: "SMITHING_TABLE",
      at: [11, smithy.y + 1, 10],
    },
  ];
}

function villageMarkers(d) {
  const markers = [];
  for (const h of d.plan.buildings) {
    markers.push(
      localMarker("home", h.key, h.key, [h.x, h.y + 1, h.z], {
        localBounds: [h.x - 2, h.y + 1, h.z - 2, h.x + 3, h.y + 4, h.z + 3],
        localEntry: [h.x, h.y + 1, h.z + (h.front === 2 ? 3 : -3), h.front],
      })
    );
    const chest =
      h.key === "smithy"
        ? [h.x - 2, h.y + 1, h.z - 2]
        : [h.x + 2, h.y + 1, h.z + 2];
    markers.push(
      localMarker("container", h.key, `${h.key}_stock`, chest, {
        block: "CHEST",
        table: `village/${h.key}`,
      })
    );
  }
  for (const resident of residents) {
    const h = d.plan.buildings.find((home) => home.key === resident.home);
    const facing = (h.front + 2) & 3;
    const bedX = h.x + resident.side * 2;
    markers.push(
      localMarker("bed", resident.key, "home_bed", [bedX, h.y + 1, h.z], {
        block: "WHITE_BED",
        facing,
        homeId: `${d.id}/home/${h.key}`,
        memberId: `${d.id}/member/${resident.key}`,
      })
    );
    markers.push(
      localMarker(
        "member",
        resident.key,
        "villager",
        [h.x + resident.side, h.y + 1, h.z + (h.front === 2 ? 1 : -1)],
        {
          entity: "villager",
          profession: resident.profession,
          homeId: `${d.id}/home/${h.key}`,
          bedId: `${d.id}/bed/${resident.key}`,
          jobSiteId: `${d.id}/job_site/${resident.job}`,
          stockTable: `village/trades/${resident.profession}`,
          unique: true,
        }
      )
    );
  }
  for (const { key, profession, block, at, mapTarget } of villageJobs(d))
    markers.push(
      localMarker("job_site", key, profession, at, {
        block,
        profession,
        memberId: `${d.id}/member/${residents.find((r) => r.job === key).key}`,
        ...(mapTarget ? { mapTarget } : {}),
      })
    );
  markers.push(
    localMarker(
      "crop_plot",
      "wheat",
      "irrigated_farm",
      [-11, d.plan.farmY + 1, 9],
      {
        crop: "WHEAT_CROP",
        soil: "FARMLAND",
        localBounds: [-12, d.plan.farmY, 7, -7, d.plan.farmY + 2, 13],
      }
    )
  );
  return markers;
}

function emitHome(d, h, b) {
  const wall = d.plan.style === "sandstone" ? "SANDSTONE" : "PLANKS";
  const log =
    d.plan.style === "spruce"
      ? "SPRUCE_LOG"
      : d.plan.style === "acacia" || d.plan.style === "sandstone"
        ? "ACACIA_LOG"
        : "OAK_LOG";
  const { x, y, z } = h;
  b.clear(x - 3, y + 1, z - 3, x + 3, y + 8, z + 3);
  b.fill(x - 3, y, z - 3, x + 3, y, z + 3, "COBBLESTONE");
  b.fill(x - 2, y, z - 2, x + 2, y, z + 2, "PLANKS");
  b.walls(x - 3, y + 1, z - 3, x + 3, y + 3, z + 3, wall);
  for (const dx of [-3, 3])
    for (const dz of [-3, 3])
      b.fill(x + dx, y + 1, z + dz, x + dx, y + 3, z + dz, log);
  for (const dx of [-3, 3]) b.set(x + dx, y + 2, z, "GLASS");
  b.door(x, y + 1, z + (h.front === 2 ? 3 : -3), h.front);
  if (d.plan.style === "sandstone") {
    b.fill(x - 3, y + 4, z - 3, x + 3, y + 4, z + 3, "TERRACOTTA");
    b.walls(x - 3, y + 5, z - 3, x + 3, y + 5, z + 3, "SANDSTONE");
    const back = h.front === 2 ? -1 : 1;
    b.fill(x, y + 1, z + back * 2, x, y + 3, z + back * 2, "LADDER", h.front);
    b.set(x, y + 4, z + back * 2, "OAK_TRAPDOOR", S.OPEN | h.front);
  } else oakRoof(b, x - 4, y + 4, z - 4, x + 4, z + 4, wall);
  for (const resident of residents.filter((r) => r.home === h.key))
    b.bed(x + resident.side * 2, y + 1, z, (h.front + 2) & 3);
  if (h.key === "library") {
    b.fill(x - 2, y + 1, z + 2, x - 1, y + 2, z + 2, "BOOKSHELF");
    b.set(x + 1, y + 1, z + 2, "OAK_STAIRS", 0);
  } else {
    b.set(x - 1, y + 1, z + (h.front === 2 ? -2 : 2), "CRAFTING_TABLE");
    if (h.key === "smithy") b.set(x + 2, y + 1, z + 1, "FURNACE");
  }
  const chest =
    h.key === "smithy" ? [x - 2, y + 1, z - 2] : [x + 2, y + 1, z + 2];
  b.set(...chest, "CHEST");
  b.set(x, y + 1, z + (h.front === 2 ? -1 : 1), "TORCH");
}

function emitFarm(d, b) {
  const y = d.plan.farmY;
  b.clear(-13, y + 1, 5, -7, y + 3, 13);
  b.fill(-13, y, 5, -7, y, 13, "DIRT");
  b.fill(-12, y, 7, -8, y, 12, "FARMLAND");
  b.fill(-12, y, 6, -8, y, 6, "PLANKS");
  b.fill(-10, y, 8, -10, y, 12, "WATER");
  for (const x of [-12, -11, -9, -8])
    for (let z = 7; z <= 12; z++) b.set(x, y + 1, z, "WHEAT_CROP");
  b.walls(-13, y + 1, 5, -7, y + 1, 13, "OAK_FENCE");
  b.set(-10, y + 1, 5, "OAK_FENCE_GATE", 0);
}

function emitVillage(d, b) {
  b.foundations(
    d.plan.supports,
    d.plan.style === "sandstone" ? "SANDSTONE" : "COBBLESTONE"
  );
  for (const p of d.plan.paths) {
    b.fill(p.x, p.bottom, p.z, p.x, p.y - 1, p.z, "DIRT");
    b.set(
      p.x,
      p.y,
      p.z,
      p.stair === undefined ? "GRAVEL" : "OAK_STAIRS",
      p.stair ?? 0
    );
    b.clear(p.x, p.y + 1, p.z, p.x, p.y + 3, p.z);
  }
  for (const h of d.plan.buildings) emitHome(d, h, b);
  emitFarm(d, b);
  const wy = d.plan.wellY;
  b.clear(-1, wy + 1, -6, 1, wy + 4, -4);
  b.fill(-1, wy, -6, 1, wy, -4, "COBBLESTONE");
  b.set(0, wy - 1, -5, "COBBLESTONE");
  b.set(0, wy, -5, "WATER");
  for (const x of [-1, 1])
    for (const z of [-6, -4]) b.fill(x, wy + 1, z, x, wy + 2, z, "OAK_FENCE");
  b.fill(-1, wy + 3, -6, 1, wy + 3, -4, "OAK_SLAB");
  for (const { block, at } of villageJobs(d)) b.set(...at, block);
}

export const VILLAGE_STRUCTURE_DEFINITION = {
  kind: "village",
  dimension: "overworld",
  maxWrites: 20000,
  requiredContent: [
    "AIR",
    "WATER",
    "DIRT",
    "GRAVEL",
    "FARMLAND",
    "WHEAT_CROP",
    "PLANKS",
    "OAK_LOG",
    "SPRUCE_LOG",
    "ACACIA_LOG",
    "COBBLESTONE",
    "SANDSTONE",
    "TERRACOTTA",
    "GLASS",
    "OAK_SLAB",
    "OAK_STAIRS",
    "OAK_DOOR",
    "OAK_TRAPDOOR",
    "LADDER",
    "OAK_FENCE",
    "OAK_FENCE_GATE",
    "WHITE_BED",
    "CHEST",
    "CRAFTING_TABLE",
    "FURNACE",
    "BOOKSHELF",
    "TORCH",
    "COMPOSTER",
    "LECTERN",
    "CARTOGRAPHY_TABLE",
    "SMITHING_TABLE",
  ],
  prepare: prepareVillage,
  markers: villageMarkers,
  emit: emitVillage,
};
