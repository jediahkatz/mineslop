import { BLOCK_STATE as S } from "./block-state.js";
import { localMarker } from "./structure-layouts.js";
import {
  beachColumn,
  hasSurfaceSupport,
  oceanColumn,
  structureSupports,
  supportMinimum,
  surveyStructure,
} from "./structure-placement.js";

const shipDamage = ["whole", "broken_bow", "broken_stern"];
const survivesShip = (damage, z) =>
  damage === "broken_bow" ? z >= -3 : damage === "broken_stern" ? z <= 3 : true;
const treasureMap = Object.freeze({
  kind: "buried_treasure",
  dimension: "overworld",
});

function shoreGangway(site, floorY) {
  const ramp = [];
  let previous = site.sample(-10, 0)?.top - floorY;
  if (!Number.isInteger(previous) || previous < -4 || previous > -1)
    return null;
  for (let x = -10; x <= -5; x++) {
    const column = site.sample(x, 0);
    if (
      !hasSurfaceSupport(column) ||
      (!beachColumn(column) && !oceanColumn(column))
    )
      return null;
    const ground = column.top - floorY;
    const y = x === -10 ? ground : Math.max(previous, ground, x + 6);
    if (y - previous > 1 || ground < -4 || ground > 1) return null;
    ramp.push({ x, y, z: 0, bottom: ground - 1, stair: y > previous });
    previous = y;
  }
  return previous === 1 ? ramp : null;
}

function prepareShipwreck(site) {
  const center = site.sample(0, 0);
  const beached = beachColumn(center);
  const survey = surveyStructure(site, {
    x0: beached ? -10 : -5,
    z0: -12,
    x1: 5,
    z1: 12,
    step: 4,
    height: 11,
    maxRelief: 3,
    predicate: beached
      ? (c) => (beachColumn(c) || oceanColumn(c)) && c.depth <= 8
      : (c) => oceanColumn(c) && c.depth >= 6 && c.depth <= 100,
  });
  if (!survey) return null;
  if (beached && !survey.columns.some(({ column }) => oceanColumn(column)))
    return null;
  const waterLevel = beached ? site.spec.seaLevel : center.waterLevel;
  if (
    survey.columns.some(({ column }) => column.frozen) &&
    survey.floorY + 10 > waterLevel - 2
  )
    return null;
  const damage =
    shipDamage[Math.floor(site.random("ship-damage") * shipDamage.length)];
  const supports = structureSupports(
    site,
    [-8, 0, 8].filter((z) => survivesShip(damage, z)).map((z) => [0, z]),
    survey.floorY
  );
  if (!supports) return null;
  const ramp = beached ? shoreGangway(site, survey.floorY) : [];
  if (!ramp) return null;
  return {
    y: survey.floorY,
    waterLevel,
    variant: `${beached ? "beached" : "sunken"}_${damage}`,
    localBounds: [
      beached ? -11 : -5,
      Math.min(supportMinimum(supports), ...ramp.map((p) => p.bottom)),
      -12,
      6,
      11,
      13,
    ],
    entries: beached
      ? [[-10, ramp[0].y + 1, 0, 1]]
      : [
          [-5, 2, 0, 1],
          [0, 5, 0, 0],
        ],
    plan: { damage, supports, beached, ramp },
  };
}

function shipMarkers(d) {
  const markers = [];
  if (d.plan.damage !== "broken_bow")
    markers.push(
      localMarker("container", "supply", "supply", [-2, 2, -6], {
        block: "CHEST",
        table: "shipwreck/supply",
      })
    );
  if (d.plan.damage !== "broken_stern") {
    markers.push(
      localMarker("container", "treasure", "treasure", [1, 5, 8], {
        block: "CHEST",
        table: "shipwreck/treasure",
      })
    );
    markers.push(
      localMarker("container", "chart", "map", [-1, 5, 8], {
        block: "CHEST",
        table: "shipwreck/map",
        mapTarget: treasureMap,
      })
    );
  }
  return markers;
}

function emitShipwreck(d, b) {
  const { damage, supports } = d.plan;
  b.foundations(supports, "OAK_LOG");
  for (let z = -11; z <= 11; z++) {
    if (!survivesShip(damage, z)) continue;
    const radius = Math.abs(z) >= 10 ? 2 : Math.abs(z) >= 7 ? 3 : 4;
    b.clear(-radius, 1, z, radius, 8, z);
    b.set(0, 0, z, "OAK_LOG", S.AXIS_Z);
    b.fill(-radius, 1, z, radius, 1, z, "PLANKS");
    for (const side of [-1, 1]) {
      b.fill(side * radius, 2, z, side * radius, 4, z, "PLANKS");
      b.set(side * radius, 1, z, "OAK_STAIRS", S.TOP | (side < 0 ? 1 : 3));
      if (Math.abs(z) < 10) b.set(side * radius, 5, z, "OAK_FENCE");
    }
    b.fill(-radius + 1, 4, z, radius - 1, 4, z, "PLANKS");
    if (Math.abs(z) === 11)
      b.fill(-radius, 2, z, radius, 3, z, "OAK_LOG", S.AXIS_X);
    // Ribs remain legible from inside the flooded two-block-high hold.
    if (z % 4 === 0)
      for (const side of [-1, 1])
        b.fill(side * (radius - 1), 2, z, side * (radius - 1), 3, z, "OAK_LOG");
  }
  // A torn port hatch and the deck companionway connect hold, water and deck.
  b.clear(-4, 2, -1, -3, 3, 1);
  b.clear(0, 4, 0, 1, 4, 2);
  b.fill(2, 2, 1, 2, 3, 1, "PLANKS");
  b.fill(1, 2, 1, 1, 4, 1, "LADDER", 3);
  b.set(0, 4, 1, "OAK_TRAPDOOR", S.OPEN | 1);
  b.fill(0, 5, -2, 0, damage === "broken_stern" ? 7 : 10, -2, "OAK_LOG");
  b.fill(-2, 8, -2, 2, 8, -2, "OAK_LOG", S.AXIS_X);
  if (damage !== "broken_stern") {
    b.clear(-2, 5, 5, 2, 7, 9);
    b.walls(-2, 5, 5, 2, 7, 9, "PLANKS");
    b.clear(0, 5, 5, 0, 6, 5);
    for (const x of [-2, 2]) b.set(x, 6, 7, "GLASS");
    b.fill(-2, 8, 5, 2, 8, 9, "OAK_SLAB");
    b.set(-1, 5, 8, "CHEST");
    b.set(1, 5, 8, "CHEST");
  }
  if (damage !== "broken_bow") b.set(-2, 2, -6, "CHEST");
  if (damage !== "whole") {
    const z = damage === "broken_bow" ? -3 : 3;
    b.fill(-2, 2, z, 2, 2, z, "OAK_LOG", S.AXIS_X);
    b.clear(-1, 3, z, 1, 5, z);
  }
  for (const p of d.plan.ramp) {
    b.fill(p.x, p.bottom, p.z, p.x, p.y - 1, p.z, "OAK_LOG");
    b.set(p.x, p.y, p.z, p.stair ? "OAK_STAIRS" : "PLANKS", p.stair ? 1 : 0);
    b.clear(p.x, p.y + 1, p.z, p.x, p.y + 3, p.z);
  }
}

function prepareRuin(site) {
  const warm = site.sample(0, 0).temperature >= 0.67;
  const survey = surveyStructure(site, {
    x0: -10,
    z0: -7,
    x1: 11,
    z1: 8,
    height: 7,
    submerged: true,
    predicate: (c) => oceanColumn(c) && c.temperature >= 0.67 === warm,
  });
  if (!survey) return null;
  const supports = structureSupports(
    site,
    [
      [-4, -4],
      [4, -4],
      [-4, 4],
      [4, 4],
      [0, 7],
      [6, -3],
      [10, -3],
      [6, 3],
      [10, 3],
      [-9, -4],
      [-9, 4],
    ],
    survey.floorY
  );
  if (!supports) return null;
  const annex = site.random("ruin-annex") < 0.6;
  return {
    y: survey.floorY,
    waterLevel: site.sample(0, 0).waterLevel,
    variant: `${warm ? "warm" : "cold"}_${annex ? "courtyard" : "fallen_arch"}`,
    localBounds: [-10, supportMinimum(supports), -7, 12, 8, 9],
    entries: [[0, 1, 7, 0]],
    plan: { warm, annex, supports },
  };
}

function ruinMarkers(d) {
  return [
    localMarker(
      "container",
      "shrine",
      d.plan.warm ? "shrine" : "crypt",
      [2, 1, -2],
      {
        block: "CHEST",
        table: d.plan.warm ? "ocean_ruin/warm_shrine" : "ocean_ruin/cold_crypt",
        mapTarget: treasureMap,
      }
    ),
    ...(d.plan.annex
      ? [
          localMarker("container", "annex", "annex", [8, 1, -1], {
            block: "CHEST",
            table: "ocean_ruin/annex",
          }),
        ]
      : []),
  ];
}

function emitRuin(d, b) {
  const stone = d.plan.warm ? "SANDSTONE" : "MOSSY_COBBLESTONE";
  const trim = d.plan.warm ? "TERRACOTTA" : "COBBLESTONE";
  b.foundations(d.plan.supports, stone);
  b.clear(-4, 1, -4, 4, 6, 4);
  b.fill(-4, 0, -4, 4, 0, 4, stone);
  b.walls(-4, 1, -4, 4, 3, 4, stone);
  for (const x of [-4, 4])
    for (const z of [-4, 4]) b.fill(x, 1, z, x, 5, z, trim);
  b.fill(-4, 5, -4, 4, 5, 0, trim);
  b.fill(-3, 6, -3, 3, 6, -2, stone);
  b.clear(-4, 4, -1, -2, 5, 0);
  b.clear(-1, 1, 4, 1, 3, 4);
  b.fill(-2, 0, 5, 2, 0, 7, stone);
  b.clear(-1, 1, 5, 1, 3, 7);
  for (const x of [-2, 2]) b.fill(x, 1, 6, x, 3, 6, trim);
  b.fill(-2, 4, 6, 2, 4, 6, stone);
  // The outlying colonnade is a broken attached courtyard, not a loot pedestal.
  b.fill(-9, 0, -4, -5, 0, 4, trim);
  for (const z of [-4, 0, 4]) {
    b.fill(-9, 1, z, -9, z === 0 ? 2 : 4, z, stone);
    b.set(-8, 1, z, trim);
  }
  b.fill(-9, 4, 4, -5, 4, 4, stone);
  b.fill(-5, 1, 4, -5, 3, 4, stone);
  b.fill(5, 0, -1, 10, 0, 1, trim);
  b.clear(4, 1, -1, 6, 3, 1);
  b.clear(6, 1, -3, 10, 4, 3);
  b.fill(6, 0, -3, 10, 0, 3, stone);
  b.walls(6, 1, -3, 10, d.plan.annex ? 3 : 1, 3, stone);
  b.clear(6, 1, -1, 6, 3, 1);
  if (d.plan.annex) {
    b.fill(6, 4, -3, 10, 4, 0, trim);
    b.set(8, 1, -1, "CHEST");
  } else {
    b.fill(9, 1, 1, 10, 2, 3, trim);
    b.set(7, 1, 2, "OAK_SLAB");
  }
  b.set(2, 1, -2, "CHEST");
}

function prepareMonument(site) {
  const survey = surveyStructure(site, {
    x0: -15,
    z0: -13,
    x1: 15,
    z1: 15,
    step: 5,
    height: 14,
    maxRelief: 4,
    submerged: true,
    predicate: (c) => oceanColumn(c) && c.depth >= 26 && !c.frozen,
  });
  if (!survey) return null;
  const supports = structureSupports(
    site,
    [
      [-14, -8],
      [-14, 8],
      [14, -8],
      [14, 8],
      [-5, -12],
      [5, -12],
      [-5, 12],
      [5, 12],
      [0, 15],
      [0, 0],
    ],
    survey.floorY
  );
  if (!supports) return null;
  return {
    y: survey.floorY,
    waterLevel: site.sample(0, 0).waterLevel,
    variant:
      site.random("monument-crown") < 0.5 ? "tidal_court" : "split_crown",
    localBounds: [-15, supportMinimum(supports), -13, 16, 15, 16],
    entries: [[0, 1, 15, 0]],
    plan: { supports },
  };
}

function monumentMarkers() {
  return [
    localMarker("encounter", "elder_west", "west_wing", [-10, 1, 0], {
      entity: "elder_guardian",
      unique: true,
      localBounds: [-13, 1, -7, -6, 6, 8],
    }),
    localMarker("encounter", "elder_east", "east_wing", [10, 1, 0], {
      entity: "elder_guardian",
      unique: true,
      localBounds: [7, 1, -7, 14, 6, 8],
    }),
    localMarker("encounter", "elder_crown", "crown", [0, 9, -9], {
      entity: "elder_guardian",
      unique: true,
      localBounds: [-4, 9, -10, 5, 12, -3],
    }),
  ];
}

function monumentRoom(b, x0, z0, x1, z1, floor, roof) {
  b.clear(x0, floor + 1, z0, x1, roof - 1, z1);
  b.fill(x0, floor, z0, x1, floor, z1, "PRISMARINE_BRICKS");
  b.walls(x0, floor + 1, z0, x1, roof - 1, z1, "PRISMARINE");
  b.fill(x0, roof, z0, x1, roof, z1, "PRISMARINE_BRICKS");
}

function emitMonument(d, b) {
  b.foundations(d.plan.supports, "PRISMARINE");
  monumentRoom(b, -5, -12, 5, 12, 0, 8);
  monumentRoom(b, -14, -8, -6, 8, 0, 6);
  monumentRoom(b, 6, -8, 14, 8, 0, 6);
  monumentRoom(b, -5, -11, 5, -3, 8, 12);
  b.fill(-3, 13, -10, 3, 13, -4, "DARK_PRISMARINE");
  if (d.variant === "split_crown") b.clear(-1, 13, -10, 1, 13, -4);
  // Flooded connecting arches and a central swim shaft reach all three elders.
  for (const side of [-1, 1]) {
    b.clear(side < 0 ? -6 : 5, 1, -1, side < 0 ? -5 : 6, 4, 1);
    b.set(side * 4, 4, 0, "SEA_LANTERN");
  }
  b.clear(-1, 1, -7, 1, 9, -5);
  b.clear(-1, 1, 12, 1, 4, 12);
  b.fill(-2, 0, 13, 2, 0, 15, "PRISMARINE_BRICKS");
  b.clear(-1, 1, 13, 1, 4, 15);
  for (const x of [-3, 3]) {
    b.fill(x, 0, 13, x, 3, 13, "PRISMARINE");
    b.set(x, 4, 13, "SEA_LANTERN");
  }
  b.fill(-3, 5, 13, 3, 5, 13, "PRISMARINE_BRICKS");
  for (const x of [-4, 4])
    for (const z of [-9, -3, 3, 9]) {
      b.fill(x, 1, z, x, 7, z, "DARK_PRISMARINE");
      b.set(x, 4, z, "SEA_LANTERN");
    }
  // Exactly a 2x2x2 gold core, enclosed in a mineable dark-prismarine vault.
  b.fill(-2, 1, 1, 1, 4, 4, "DARK_PRISMARINE");
  b.fill(-1, 2, 2, 0, 3, 3, "GOLD_BLOCK");
  b.fill(-12, 4, -6, -10, 5, -6, "WET_SPONGE");
  b.fill(-13, 1, -5, -13, 2, -5, "WET_SPONGE");
  for (const x of [-10, 10]) b.set(x, 5, 0, "SEA_LANTERN");
  b.set(0, 11, -10, "SEA_LANTERN");
}

function prepareTreasure(site) {
  const survey = surveyStructure(site, {
    x0: -1,
    z0: -1,
    x1: 1,
    z1: 1,
    step: 1,
    height: 1,
    maxRelief: 1,
    predicate: (c) => beachColumn(c) && c.waterLevel === null,
  });
  const center = site.sample(0, 0);
  if (!survey || center.top - 4 <= site.spec.minY) return null;
  return {
    y: center.top - 3,
    waterLevel: null,
    variant: center.id === "snowy_beach" ? "snowy_shore" : "sandy_shore",
    localBounds: [-1, -1, -1, 2, 5, 2],
    entries: [[0, 4, 0, 0]],
    plan: {},
  };
}

function emitTreasure(d, b) {
  b.set(0, -1, 0, "SANDSTONE");
  b.set(0, 0, 0, "CHEST");
  // No clearing, signpost or above-ground display. The target remains buried.
  b.fill(0, 1, 0, 0, 3, 0, "SAND");
}

export const OCEAN_STRUCTURE_DEFINITIONS = [
  {
    kind: "shipwreck",
    dimension: "overworld",
    maxWrites: 12000,
    requiredContent: [
      "AIR",
      "WATER",
      "OAK_LOG",
      "PLANKS",
      "OAK_STAIRS",
      "OAK_SLAB",
      "OAK_FENCE",
      "OAK_TRAPDOOR",
      "LADDER",
      "GLASS",
      "CHEST",
    ],
    prepare: prepareShipwreck,
    markers: shipMarkers,
    emit: emitShipwreck,
  },
  {
    kind: "ocean_ruin",
    dimension: "overworld",
    maxWrites: 10000,
    requiredContent: [
      "AIR",
      "WATER",
      "SANDSTONE",
      "TERRACOTTA",
      "MOSSY_COBBLESTONE",
      "COBBLESTONE",
      "OAK_SLAB",
      "CHEST",
    ],
    prepare: prepareRuin,
    markers: ruinMarkers,
    emit: emitRuin,
  },
  {
    kind: "ocean_monument",
    dimension: "overworld",
    maxWrites: 24000,
    requiredContent: [
      "WATER",
      "AIR",
      "PRISMARINE",
      "PRISMARINE_BRICKS",
      "DARK_PRISMARINE",
      "SEA_LANTERN",
      "WET_SPONGE",
      "GOLD_BLOCK",
    ],
    prepare: prepareMonument,
    markers: monumentMarkers,
    emit: emitMonument,
  },
  {
    kind: "buried_treasure",
    dimension: "overworld",
    maxWrites: 8,
    requiredContent: ["CHEST", "SAND", "SANDSTONE"],
    prepare: prepareTreasure,
    markers: () => [
      localMarker("container", "heart", "buried_treasure", [0, 0, 0], {
        block: "CHEST",
        table: "buried_treasure/heart_of_sea",
        tableGuarantees: ["heart_of_sea"],
      }),
    ],
    emit: emitTreasure,
  },
];
