import { localMarker } from "./structure-layouts.js";
import {
  netherColumn,
  structureSupports,
  supportMinimum,
  surveyStructure,
} from "./structure-placement.js";

function prepareFortress(site) {
  const survey = surveyStructure(site, {
    x0: -16,
    z0: -15,
    x1: 19,
    z1: 15,
    step: 5,
    maxRelief: 6,
    height: 11,
    predicate: netherColumn,
  });
  if (!survey) return null;
  const supports = structureSupports(
    site,
    [
      [-3, -14],
      [3, -14],
      [-3, 14],
      [3, 14],
      [-5, -5],
      [5, -5],
      [-5, 5],
      [5, 5],
      [-15, -4],
      [-15, 4],
      [-7, -4],
      [-7, 4],
      [11, -5, 3],
      [18, -5, 3],
      [11, 5, 3],
      [18, 5, 3],
    ],
    survey.floorY,
    11
  );
  if (!supports) return null;
  return {
    y: survey.floorY,
    waterLevel: null,
    variant:
      site.random("fortress-roof") < 0.5
        ? "crossing_vault"
        : "broken_battlement",
    localBounds: [-16, supportMinimum(supports), -15, 20, 12, 16],
    entries: [
      [0, 1, 14, 0],
      [0, 1, -14, 2],
    ],
    plan: { supports },
  };
}

function fortressMarkers() {
  return [
    localMarker("container", "garden_store", "wart_store", [-13, 1, -2], {
      block: "CHEST",
      table: "nether_fortress/garden",
    }),
    localMarker("container", "crossing_store", "crossing_store", [2, 1, 3], {
      block: "CHEST",
      table: "nether_fortress/crossing",
    }),
    localMarker("crop_plot", "wart_garden", "wart_garden", [-11, 1, -3], {
      crop: "NETHER_WART_CROP",
      soil: "SOUL_SAND",
      localBounds: [-14, 0, -3, -7, 2, 4],
    }),
    localMarker("encounter", "blaze_nest", "blaze_spawner", [15, 4, 0], {
      entity: "blaze",
      mechanism: "spawner",
      block: "SPAWNER",
      unique: true,
      localBounds: [12, 4, -4, 18, 9, 5],
    }),
    localMarker("encounter", "crossing_guard", "hall_guard", [0, 1, -10], {
      entity: "wither_skeleton",
      unique: true,
      localBounds: [-2, 1, -13, 3, 5, -5],
    }),
  ];
}

function hall(b, x0, z0, x1, z1, floor, roof, material = "NETHER_BRICKS") {
  b.clear(x0, floor + 1, z0, x1, roof - 1, z1);
  b.fill(x0, floor, z0, x1, floor, z1, material);
  b.walls(x0, floor + 1, z0, x1, roof - 1, z1, material);
  b.fill(x0, roof, z0, x1, roof, z1, material);
}

function emitFortress(d, b) {
  b.foundations(d.plan.supports, "NETHER_BRICKS");
  hall(b, -3, -14, 3, 14, 0, 5);
  hall(b, -5, -5, 5, 5, 0, 7);
  hall(b, -15, -4, -7, 4, 0, 5);
  for (const z of [-14, -5, 5, 14]) {
    b.clear(-1, 1, z, 1, 3, z);
    b.fill(-2, 4, z, 2, 4, z, "NETHER_BRICK_SLAB");
  }
  b.fill(-7, 0, -1, -5, 0, 1, "NETHER_BRICKS");
  b.clear(-7, 1, -1, -5, 3, 1);
  b.fill(-7, 4, -1, -5, 4, 1, "NETHER_BRICKS");
  b.fill(-14, 0, -3, -8, 0, 3, "SOUL_SAND");
  b.fill(-14, 0, 0, -8, 0, 1, "NETHER_BRICKS");
  for (const z of [-3, -2, 2, 3])
    b.fill(-14, 1, z, -8, 1, z, "NETHER_WART_CROP");
  b.set(-13, 0, -2, "NETHER_BRICKS");
  b.set(-13, 1, -2, "CHEST");
  b.set(2, 1, 3, "CHEST");
  b.set(-11, 4, -3, "GLOWSTONE");

  // A vaulted crossing leads to a rising, parapeted bridge and the blaze hall.
  b.fill(5, 0, -2, 11, 0, 2, "NETHER_BRICKS");
  b.clear(5, 1, -2, 11, 8, 2);
  for (let x = 5; x <= 10; x++) {
    const level = Math.max(0, x - 7);
    for (const z of [-2, 2]) {
      b.fill(x, 0, z, x, level, z, "NETHER_BRICKS");
      b.set(x, level + 1, z, "NETHER_BRICK_FENCE");
    }
    if (x >= 7) {
      b.fill(x, 0, -1, x, level - 1, 1, "NETHER_BRICKS");
      b.fill(x, level, -1, x, level, 1, "NETHER_BRICK_STAIRS", 1);
    }
  }
  hall(b, 11, -5, 18, 5, 3, 9);
  b.clear(11, 4, -1, 11, 6, 1);
  b.set(15, 4, 0, "SPAWNER");
  for (const x of [11, 18])
    for (const z of [-5, 5]) {
      b.fill(x, 4, z, x, 10, z, "BASALT");
      b.set(x, 11, z, "NETHER_BRICK_SLAB");
    }
  if (d.variant === "broken_battlement") {
    b.clear(14, 8, -5, 16, 9, -3);
    b.set(17, 7, -5, "NETHER_BRICK_SLAB");
  }
  for (const x of [-4, 4]) b.set(x, 6, 0, "GLOWSTONE");
}

function prepareBastion(site) {
  const survey = surveyStructure(site, {
    x0: -13,
    z0: -12,
    x1: 13,
    z1: 15,
    step: 5,
    maxRelief: 5,
    height: 14,
    predicate: (c) => netherColumn(c) && c.id !== "basalt_deltas",
  });
  if (!survey) return null;
  const supports = structureSupports(
    site,
    [
      [-12, -10],
      [-12, 8],
      [-7, -10],
      [-7, 8],
      [12, -10],
      [12, 8],
      [7, -10],
      [7, 8],
      [-6, -11, 4],
      [6, -11, 4],
      [-6, -5, 4],
      [6, -5, 4],
      [-3, 11],
      [3, 11],
      [0, 15],
      [0, 3],
    ],
    survey.floorY,
    11
  );
  if (!supports) return null;
  return {
    y: survey.floorY,
    waterLevel: null,
    variant:
      site.random("bastion-damage") < 0.5 ? "bridge_keep" : "fallen_west",
    localBounds: [-14, supportMinimum(supports), -13, 15, 15, 16],
    entries: [[0, 1, 15, 0]],
    plan: { supports },
  };
}

function bastionMarkers(d) {
  return [
    localMarker("container", "treasury", "treasure", [0, 5, -9], {
      block: "CHEST",
      table: "bastion/treasure",
      tableGuarantees: ["netherite_upgrade_template"],
    }),
    localMarker("container", "armory", "armory", [10, 1, 5], {
      block: "CHEST",
      table: "bastion/armory",
    }),
    ...(d.variant === "bridge_keep"
      ? [
          localMarker("container", "gallery", "bridge_cache", [-10, 6, 2], {
            block: "CHEST",
            table: "bastion/bridge",
          }),
        ]
      : []),
    localMarker("encounter", "treasury_guard", "treasury_guard", [2, 5, -8], {
      entity: "piglin_brute",
      unique: true,
      localBounds: [-5, 5, -10, 6, 10, -5],
    }),
    localMarker("encounter", "gate_guard", "gate_guard", [2, 1, 8], {
      entity: "piglin",
      unique: true,
      localBounds: [-3, 1, 7, 4, 5, 12],
    }),
  ];
}

function emitBastion(d, b) {
  b.clear(-12, 1, -11, 12, 13, 11);
  // Excavate first: the treasury's raised piers occupy this cleared volume.
  b.foundations(d.plan.supports, "BASALT");
  b.fill(-6, -1, -3, 6, 0, 11, "BLACKSTONE");
  hall(
    b,
    -12,
    -10,
    -7,
    8,
    0,
    d.variant === "fallen_west" ? 7 : 11,
    "BLACKSTONE"
  );
  hall(b, 7, -10, 12, 8, 0, 11, "BLACKSTONE");
  hall(b, -6, -11, 6, -5, 4, 10, "BLACKSTONE");
  for (const side of [-1, 1]) {
    b.clear(side < 0 ? -7 : 6, 1, 2, side < 0 ? -6 : 7, 3, 4);
    b.fill(side * 4, 0, 3, side * 4, 0, 6, "LAVA");
    b.fill(side * 5, 1, 2, side * 5, 1, 7, "NETHER_BRICK_FENCE");
    b.fill(side * 4, 5, -9, side * 4, 6, -9, "GOLD_BLOCK");
  }
  // The broad central stair is the only rise to the treasury; it is not sealed
  // behind a decorative facade. Each tread has masonry directly beneath it.
  for (let step = 0; step <= 4; step++) {
    const z = -1 - step;
    b.fill(-1, 0, z, 1, step - 1, z, "NETHER_BRICKS");
    b.fill(-1, step, z, 1, step, z, "NETHER_BRICK_STAIRS", 0);
  }
  b.clear(-1, 5, -5, 1, 7, -5);
  b.set(0, 5, -9, "CHEST");
  b.set(10, 1, 5, "CHEST");
  b.set(0, 9, -10, "GLOWSTONE");
  if (d.variant === "bridge_keep") {
    b.fill(-11, 5, -2, -8, 5, 7, "BLACKSTONE");
    b.clear(-8, 5, 0, -8, 5, 0);
    b.fill(-8, 1, 0, -8, 5, 0, "LADDER", 3);
    b.set(-10, 6, 2, "CHEST");
    b.fill(-11, 6, -2, -9, 6, -2, "NETHER_BRICK_FENCE");
  } else {
    b.clear(-12, 5, 3, -10, 7, 7);
    b.fill(-11, 1, 6, -10, 2, 7, "BLACKSTONE");
    b.set(-9, 1, 7, "NETHER_BRICK_SLAB");
  }
  b.fill(-2, 0, 12, 2, 0, 15, "NETHER_BRICKS");
  b.clear(-2, 1, 12, 2, 4, 15);
  for (const x of [-3, 3]) b.fill(x, 0, 11, x, 5, 11, "BASALT");
  b.fill(-3, 6, 11, 3, 6, 11, "BLACKSTONE");
  b.fill(-2, 7, 11, 2, 7, 11, "NETHER_BRICK_SLAB");
  for (const x of [-12, -7, 7, 12])
    for (const z of [-10, 8]) {
      if (x < 0 && d.variant === "fallen_west") continue;
      b.fill(x, 11, z, x, 13, z, "BASALT");
      b.set(x, 14, z, "NETHER_BRICK_SLAB");
    }
}

export const NETHER_STRUCTURE_DEFINITIONS = [
  {
    kind: "nether_fortress",
    dimension: "nether",
    maxWrites: 22000,
    requiredContent: [
      "AIR",
      "NETHER_BRICKS",
      "NETHER_BRICK_STAIRS",
      "NETHER_BRICK_SLAB",
      "NETHER_BRICK_FENCE",
      "SOUL_SAND",
      "NETHER_WART_CROP",
      "BASALT",
      "GLOWSTONE",
      "CHEST",
      "SPAWNER",
    ],
    prepare: prepareFortress,
    markers: fortressMarkers,
    emit: emitFortress,
  },
  {
    kind: "bastion_remnant",
    dimension: "nether",
    maxWrites: 30000,
    requiredContent: [
      "AIR",
      "LAVA",
      "BLACKSTONE",
      "BASALT",
      "NETHER_BRICKS",
      "NETHER_BRICK_STAIRS",
      "NETHER_BRICK_SLAB",
      "NETHER_BRICK_FENCE",
      "GLOWSTONE",
      "GOLD_BLOCK",
      "CHEST",
      "LADDER",
    ],
    prepare: prepareBastion,
    markers: bastionMarkers,
    emit: emitBastion,
  },
];
