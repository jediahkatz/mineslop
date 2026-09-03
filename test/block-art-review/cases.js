import { BLOCK, BLOCK_CATALOG, BLOCKS } from "../../src/blocks.js";
import {
  BLOCK_STATE as S,
  defaultFluidFor,
  FLUID,
  normalizeCell,
} from "../../src/block-state.js";
import {
  HORIZONTAL_DIRECTIONS,
  resolveShape,
} from "../../src/block-shapes.js";
import { WOOD_FAMILIES } from "../../src/wood-content.js";

export const REVIEW_VERSION = 1;
export const PAGE_SIZE = 6;
export const MAX_CASES_PER_BLOCK = 16;
export const MAX_CELLS_PER_CASE = 32;
export const LIGHTS = Object.freeze(["day", "shadow", "night"]);
export const FACES = Object.freeze(["side", "top", "bottom"]);
export const SYMBOLS = new Map(Object.entries(BLOCK).map(([key, id]) => [id, key]));
const facingNames = ["north", "east", "south", "west"];
const knownShapes = new Set([
  "cube", "cross", "slab", "stairs", "door", "trapdoor",
  "fence", "fence_gate", "ladder", "bed",
]);
const specials = new Set([
  BLOCK.AIR, BLOCK.WATER, BLOCK.LAVA, BLOCK.NETHER_PORTAL, BLOCK.END_PORTAL,
]);
const stations = new Set([
  BLOCK.CRAFTING_TABLE, BLOCK.FURNACE, BLOCK.CHEST, BLOCK.TNT,
  BLOCK.BOOKSHELF, BLOCK.WHITE_BED, BLOCK.LADDER, BLOCK.SPAWNER,
]);

export function groupFor(block) {
  if (specials.has(block.id)) return "special-cells";
  const wood = WOOD_FAMILIES.find(
    (family) => family.key === block.woodFamily || family.source === block.id,
  );
  if (wood) return `wood-${wood.key}`;
  if (block.texture === "ore" || block.id === BLOCK.ANCIENT_DEBRIS) return "ores";
  if (stations.has(block.id) || block.station || block.jobSite || block.container)
    return "stations";
  if (
    block.coralFamily || block.aquatic || block.waterDevice ||
    /prismarine|sponge|kelp|coral|lily|turtle/i.test(block.name)
  ) return "marine";
  if (block.texture === "glass" || block.emissive) return "glass-and-light";
  if (block.shape === "cross" || block.texture === "leaves") return "foliage";
  return "earth-and-masonry";
}

export function specialAccounting(id) {
  if (id === BLOCK.AIR)
    return "Intentionally invisible: zero world geometry and transparent icon; the empty hand may retain the player's arm.";
  if (id === BLOCK.WATER || id === BLOCK.LAVA)
    return "Special fluid cell: inspect source/flow geometry and its actual inventory/held diagnostic presentation; this is not a claim that the cell is obtainable.";
  if (id === BLOCK.NETHER_PORTAL || id === BLOCK.END_PORTAL)
    return "Special portal cell: inspect the current emissive geometry, not an invented thin portal or natural portal placement.";
  return null;
}

const entry = (id, state = 0, offset = [0, 0, 0], fluid, role = "subject") => ({
  ...normalizeCell({ id, state, fluid: fluid ?? defaultFluidFor(id) }),
  offset,
  role,
});
const water = (id, state = 0) => entry(id, state, [0, 0, 0], FLUID.WATER_SOURCE);

/** Only valid production cells. Neighbor fixtures are declared, never generated. */
export function casesFor(id) {
  const block = BLOCKS[id];
  if (!block || !knownShapes.has(block.shape))
    throw new RangeError(`Block ${id} needs an explicit shape review profile`);
  const result = [];
  const add = (key, cells, note = "") => {
    if (cells.length > MAX_CELLS_PER_CASE) throw new RangeError("Fixture cell budget");
    result.push({ id, key, cells, note });
  };
  const one = (key, state = 0) => add(key, [entry(id, state)]);
  const directions = (make) => facingNames.forEach((name, facing) => make(name, facing));
  if (block.shape === "door") {
    const door = (key, facing, open = false, right = false) => {
      const state = facing | (open ? S.OPEN : 0) | (right ? S.HINGE_RIGHT : 0);
      add(key, [entry(id, state), entry(id, state | S.PART, [0, 1, 0])],
        "Linked lower and upper cells; the upper cell supplies the hinge.");
    };
    directions((name, facing) => door(`closed-${name}-left`, facing));
    door("closed-north-right", 0, false, true);
    door("open-north-left", 0, true);
    door("open-north-right", 0, true, true);
    door("open-east-right", 1, true, true);
  } else if (block.shape === "bed") {
    directions((name, facing) => add(`paired-${name}`, [
      entry(id, facing),
      entry(id, facing | S.PART, [...HORIZONTAL_DIRECTIONS[facing]]),
    ], "Linked foot and head cells, not two isolated half-beds."));
  } else if (block.shape === "slab") {
    one("bottom");
    one("top", S.TOP);
    one("double", S.DOUBLE);
  } else if (block.shape === "stairs") {
    directions((name, facing) => one(`straight-${name}`, facing));
    one("top-straight-north", S.TOP);
    const corner = (key, inner, right, top = false) => {
      const half = top ? S.TOP : 0;
      add(key, [
        entry(id, half),
        entry(id, half | (right ? 1 : 3), [0, 0, inner ? 1 : -1], undefined, "context"),
      ], "The neighboring stair is present so the production corner resolver runs.");
    };
    for (const inner of [false, true])
      for (const right of [false, true])
        corner(`${inner ? "inner" : "outer"}-${right ? "right" : "left"}`, inner, right);
    corner("top-inner-right", true, true, true);
    corner("top-outer-left", false, false, true);
  } else if (block.shape === "trapdoor") {
    one("closed-bottom");
    one("closed-top", S.TOP);
    directions((name, facing) => one(`open-bottom-${name}`, facing | S.OPEN));
    one("open-top-north", S.OPEN | S.TOP);
  } else if (block.shape === "fence_gate") {
    directions((name, facing) => one(`closed-${name}`, facing));
    directions((name, facing) => one(`open-${name}`, facing | S.OPEN));
  } else if (block.shape === "fence") {
    one("isolated");
    const neighbors = (key, sides) => add(key, [
      entry(id),
      ...sides.map((side) => entry(
        id, 0, [...HORIZONTAL_DIRECTIONS[side]], undefined, "context",
      )),
    ]);
    neighbors("straight", [0, 2]);
    neighbors("corner", [0, 1]);
    neighbors("cross", [0, 1, 2, 3]);
    add("wall-connection", [
      entry(id), entry(BLOCK.STONE, 0, [1, 0, 0], undefined, "context"),
    ]);
    add("gate-connection", [
      entry(id), entry(BLOCK.OAK_FENCE_GATE, 0, [1, 0, 0], undefined, "context"),
    ]);
  } else if (block.shape === "ladder") {
    directions((name, facing) => {
      const support = HORIZONTAL_DIRECTIONS[(facing + 2) & 3];
      add(`supported-${name}`, [
        entry(id, facing),
        entry(BLOCK.STONE, 0, [...support], undefined, "context"),
      ], "A real full support face validates the attachment.");
    });
  } else if (id === BLOCK.WATER) {
    add("source", [water(id)]);
    for (let level = 1; level <= 7; level++)
      add(`flow-${level}`, [entry(id, 0, [0, 0, 0], FLUID.WATER_1 + level - 1)]);
    add("falling", [entry(id, 0, [0, 0, 0], FLUID.WATER_FALLING)]);
    add("stacked-source", [water(id), entry(id, 0, [0, 1, 0])]);
    add("bubble-up", [entry(id, 0, [0, 0, 0], FLUID.BUBBLE_UP)]);
    add("bubble-down", [entry(id, 0, [0, 0, 0], FLUID.BUBBLE_DOWN)]);
  } else if (id === BLOCK.LAVA) {
    one("source");
    add("stacked-source", [entry(id), entry(id, 0, [0, 1, 0])]);
  } else {
    if (block.directional === "axis") {
      one("axis-y");
      one("axis-x", S.AXIS_X);
      one("axis-z", S.AXIS_Z);
    } else if (block.directional) {
      directions((name, facing) => one(`facing-${name}`, facing));
    } else one(id === BLOCK.AIR ? "intentional-empty" : "default");
    if (block.shape === "cube" && id !== BLOCK.AIR) {
      add("repeat-2x2x2", Array.from({ length: 8 }, (_, index) =>
        entry(id, 0, [index & 1, (index >> 1) & 1, (index >> 2) & 1])),
      "Eight actual blocks expose horizontal and vertical tiling seams.");
    }
  }
  if (block.aquatic) {
    add("submerged", [
      entry(id),
      entry(BLOCK.WATER, 0, [0, 1, 0], undefined, "context"),
      ...HORIZONTAL_DIRECTIONS.map((offset) =>
        entry(BLOCK.WATER, 0, [...offset], undefined, "context")),
    ], "Real host fluid and surrounding water cells; no fake blue overlay.");
  } else if (block.waterloggable) {
    const cells = result[0].cells.map((cell, index) =>
      index === 0 ? { ...water(id, cell.state), offset: cell.offset } : cell);
    add("waterlogged", cells, "The original host ID remains; a separate fluid volume is meshed.");
  }
  if (result.length > MAX_CASES_PER_BLOCK) throw new RangeError(`Case budget for ${id}`);
  return result;
}

/** Bounded authored cell adapter accepted by the production mesher. No World/generator. */
export function fixtureWorld(reviewCase) {
  const origin = [8, 4, 8];
  const cells = new Map();
  if (!Array.isArray(reviewCase.cells) || reviewCase.cells.length > MAX_CELLS_PER_CASE)
    throw new RangeError("Fixture cell budget");
  for (const value of reviewCase.cells) {
    if (value.offset?.length !== 3 || !value.offset.every(Number.isSafeInteger))
      throw new RangeError("Fixture offsets must be three integer coordinates");
    const position = value.offset.map((coordinate, axis) => coordinate + origin[axis]);
    const key = position.join(",");
    if (cells.has(key)) throw new Error(`Duplicate fixture cell ${key}`);
    if (position.some((coordinate) => coordinate < 0 || coordinate >= 16))
      throw new RangeError("Fixture leaves its single 16³ section");
    cells.set(key, normalizeCell(value));
  }
  const air = normalizeCell({ id: BLOCK.AIR });
  const world = {
    dimension: "overworld",
    spec: { minY: 0, maxY: 16 },
    getCell: (x, y, z) => y < 0 || y >= 16 ? null : (cells.get(`${x},${y},${z}`) ?? air),
    isLoaded: () => true,
    // Neutral, untinted art plate. Biome tint remains a separate gameplay check.
    getBiome: () => null,
  };
  world.get = (x, y, z) => world.getCell(x, y, z)?.id ?? BLOCK.AIR;
  return { world, origin, cells };
}

export function resolvedSubjects(reviewCase) {
  const { world, origin } = fixtureWorld(reviewCase);
  return reviewCase.cells.filter(({ role }) => role === "subject").map((value) => {
    const [x, y, z] = value.offset.map((coordinate, axis) => coordinate + origin[axis]);
    return resolveShape(world.getCell(x, y, z), (dx, dy, dz) =>
      world.getCell(x + dx, y + dy, z + dz));
  });
}

export const CATALOG_GROUPS = Object.freeze(
  [...new Set(BLOCK_CATALOG.map(groupFor))].sort(),
);

export function facePartsFor(id) {
  return (BLOCKS[id].textureParts ?? [null]).flatMap((part) =>
    FACES.map((face) => ({ face, part })));
}

/** Minimum evidence matrix, not an exhaustive Cartesian product of all valid states. */
export function requiredCapturesFor(id) {
  const [base, ...states] = casesFor(id);
  return [
    ...LIGHTS.map((light) => ({ case: base.key, light, labels: "labeled" })),
    { case: base.key, light: "day", labels: "blind" },
    ...states.map(({ key }) => ({ case: key, light: "day", labels: "labeled" })),
  ];
}
