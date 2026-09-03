import { getBiomeById } from "./biomes.js";
import { BLOCK_STATE as S } from "./block-state.js";
import { BLOCK as B } from "./blocks.js";
import { clamp, hash, noise, smooth } from "./noise.js";
import {
  remember,
  V4_LIMITS,
  V4_TREE_REACH,
  V4_TREE_SPACING,
  v4InBounds,
} from "./terrain-v4-config.js";
import { forEachV4Owner } from "./terrain-v4-writer.js";

const SPECIES = {
  oak: ["OAK_LOG", "LEAVES", 4, 13, 3],
  birch: ["BIRCH_LOG", "BIRCH_LEAVES", 6, 14, 2],
  tall_birch: ["BIRCH_LOG", "BIRCH_LEAVES", 12, 22, 3],
  spruce: ["SPRUCE_LOG", "SPRUCE_LEAVES", 7, 19, 3],
  pine: ["SPRUCE_LOG", "SPRUCE_LEAVES", 13, 25, 2],
  giant_spruce: ["SPRUCE_LOG", "SPRUCE_LEAVES", 17, 30, 4],
  dark: ["DARK_OAK_LOG", "DARK_OAK_LEAVES", 6, 15, 4],
  pale: ["PALE_LOG", "PALE_LEAVES", 7, 17, 4],
  cherry: ["CHERRY_LOG", "CHERRY_LEAVES", 5, 12, 3],
  jungle: ["JUNGLE_LOG", "JUNGLE_LEAVES", 10, 30, 4],
  mangrove: ["MANGROVE_LOG", "MANGROVE_LEAVES", 6, 14, 3],
  swamp_oak: ["OAK_LOG", "LEAVES", 5, 12, 3],
  acacia: ["ACACIA_LOG", "ACACIA_LEAVES", 5, 13, 4],
  crimson: ["CRIMSON_STEM", "CRIMSON_LEAVES", 6, 13, 3],
  warped: ["WARPED_STEM", "WARPED_LEAVES", 7, 15, 3],
  mushroom: ["MUSHROOM_STEM", "RED_MUSHROOM", 4, 10, 4],
};
const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
const EMPTY = Object.freeze([]);
const ramp = (n, a, b) => smooth(clamp((n - a) / (b - a)));

export function v4ForestDensity(col, salt, dimension = "overworld") {
  const cover =
    noise(col.x / 109, col.z / 109, salt ^ 9631) * 0.72 +
    noise(col.x / 47, col.z / 47, salt ^ 5419) * 0.28;
  const patch = 0.14 + ramp(cover, 0.27, 0.68) * 1.15;
  const treeline =
    173 +
    col.temperature * 56 +
    (noise(col.x / 137, col.z / 137, salt ^ 8221) - 0.5) * 25;
  const altitude =
    dimension === "overworld" ? 1 - ramp(col.top, treeline - 18, treeline) : 1;
  const density = col.profile.tree
    ? col.profile.density
    : getBiomeById(col.id).category === "grassland"
      ? 0.035
      : 0;
  return clamp(density * patch) * altitude;
}

function boundsOf(parts) {
  const bounds = {
    minX: Infinity,
    minY: Infinity,
    minZ: Infinity,
    maxX: -Infinity,
    maxY: -Infinity,
    maxZ: -Infinity,
  };
  for (const part of parts) {
    const radius = part.kind === "crown" ? part.radius : 0;
    const width = part.kind === "trunk" ? part.width : 1;
    bounds.minX = Math.min(bounds.minX, part.x - radius);
    bounds.minZ = Math.min(bounds.minZ, part.z - radius);
    bounds.maxX = Math.max(bounds.maxX, part.x + radius + width);
    bounds.maxZ = Math.max(bounds.maxZ, part.z + radius + width);
    bounds.minY = Math.min(
      bounds.minY,
      part.y +
        (part.kind === "trunk"
          ? 1
          : part.kind === "crown" && !part.flat
            ? -1
            : 0)
    );
    bounds.maxY = Math.max(
      bounds.maxY,
      part.y +
        (part.kind === "trunk"
          ? part.height + 1
          : part.kind === "crown"
            ? 2
            : 1)
    );
  }
  return Object.freeze(bounds);
}

function describe(col, type, salt, ceiling) {
  const { x, z } = col;
  const roll = (channel) =>
    hash(x, z, salt ^ Math.imul(channel + 1, 0x9e3779b1));
  if (type === "mixed") type = roll(0) < 0.28 ? "birch" : "oak";
  const species = SPECIES[type];
  if (!species) return null;
  const age = roll(1);
  const young = age < 0.25;
  const mature = age > 0.72;
  const wet = type === "mangrove" || type === "swamp_oak";
  const ground = wet ? Math.max(col.top, 63) : col.top;
  const height = Math.min(
    ceiling - ground - 3,
    species[2] + Math.floor(age * (species[3] - species[2] + 1))
  );
  if (height < 4) return null;
  const wood = B[species[0]];
  const leaves =
    type === "mushroom" && roll(2) > 0.5 ? B.BROWN_MUSHROOM : B[species[1]];
  const radius = clamp(species[4] + Number(mature) - Number(young), 1, 5);
  const structural = [];
  const crowns = [];
  const accents = [];
  const trunk = (dx, y, dz, length, width = 1) => {
    if (length > 0)
      structural.push({
        kind: "trunk",
        x: x + dx,
        y,
        z: z + dz,
        height: length,
        width,
        block: wood,
        state: 0,
        replaceWater: wet,
      });
  };
  const log = (dx, y, dz, state = 0) =>
    structural.push({
      kind: "block",
      x: x + dx,
      y,
      z: z + dz,
      block: wood,
      state,
      replaceWater: wet,
    });
  const crown = (dx, level, dz, r, flat = false) =>
    crowns.push({
      kind: "crown",
      x: x + dx,
      y: ground + level,
      z: z + dz,
      radius: Math.max(1, Math.min(r, 7 - Math.abs(dx), 7 - Math.abs(dz))),
      block: leaves,
      flat,
    });
  const wide =
    (type === "giant_spruce" && !young) ||
    (["dark", "pale", "jungle"].includes(type) && age > 0.42);
  const stemHeight = type === "acacia" ? height - 2 : height;
  trunk(0, ground, 0, stemHeight, wide ? 2 : 1);
  if (ground > col.top) trunk(0, col.top, 0, ground - col.top);

  const direction = Math.floor(roll(3) * 4);
  const limb = (dx, dz, tip, rise) => {
    const distance = Math.abs(dx) + Math.abs(dz);
    const start = ground + tip - rise;
    let px = 0;
    let pz = 0;
    let y = start;
    for (let step = 1; step <= distance; step++) {
      const axisX = px !== dx && (pz === dz || step % 2 === 1);
      if (axisX) px += Math.sign(dx);
      else pz += Math.sign(dz);
      log(px, y, pz, axisX ? S.AXIS_X : S.AXIS_Z);
      const nextY = start + Math.floor((step * rise) / distance);
      trunk(px, y, pz, nextY - y);
      y = nextY;
    }
  };

  if (["spruce", "pine", "giant_spruce"].includes(type)) {
    const bare =
      type === "pine"
        ? Math.floor(height * (0.5 + roll(4) * 0.2))
        : type === "giant_spruce"
          ? 4 + Math.floor(roll(4) * 5)
          : 2 + Math.floor(roll(4) * 3);
    let tier = 0;
    for (let level = bare; level < height; tier++) {
      const r = Math.max(
        1,
        Math.ceil((radius * (height - level)) / (height - bare))
      );
      const [dx, dz] = DIRECTIONS[direction];
      const lean = Number(r > 1 && roll(30 + tier) < 0.5);
      crown(dx * lean, level, dz * lean, r, true);
      level += 2 + Number(roll(50 + tier) < 0.27);
    }
    crown(0, height, 0, 1, true);
  } else if (type === "mushroom") {
    const brown = leaves === B.BROWN_MUSHROOM;
    if (!brown && mature) crown(0, height - 2, 0, radius, true);
    crown(0, height, 0, radius - Number(!brown && mature), brown);
  } else if (type === "crimson" || type === "warped") {
    crown(0, height - 1, 0, radius, true);
    crown(0, height + 0, 0, Math.max(1, radius - 1), true);
    if (mature) {
      const [dx, dz] = DIRECTIONS[direction];
      limb(dx * 2, dz * 2, height - 2, 1);
      crown(dx * 2, height - 2, dz * 2, 2, true);
    }
    if (roll(8) < 0.38)
      accents.push({
        kind: "block",
        x: x + 1,
        y: ground + height - 2,
        z,
        block: B.GLOWSTONE,
      });
  } else {
    if (type !== "acacia") crown(0, height, 0, radius, type === "dark");
    const slender = type === "birch" || type === "tall_birch";
    const branches = young ? 1 : mature && !slender ? 3 : 2;
    for (let i = 0; i < branches; i++) {
      const [dx, dz] = DIRECTIONS[(direction + [0, 2, 1][i]) % 4];
      const length = slender
        ? 1 + Math.floor(roll(10 + i) * 2)
        : 2 + Math.floor(roll(10 + i) * 3);
      const side = Number(roll(14 + i) > 0.6);
      const px = dx * length - dz * side;
      const pz = dz * length + dx * side;
      const drop =
        type === "jungle" && i === 0
          ? Math.floor(height * 0.28)
          : Math.floor(roll(18 + i) * 3);
      const tip = Math.max(3, height - drop);
      const rise =
        type === "acacia"
          ? Math.max(0, tip - stemHeight + 1)
          : 1 + Number(roll(22 + i) < 0.5);
      limb(px, pz, tip, rise);
      crown(
        px,
        tip,
        pz,
        type === "acacia"
          ? radius
          : slender
            ? 1 + Number(mature)
            : Math.max(2, radius - 1),
        type === "acacia" || type === "dark"
      );
    }
    if (type === "mangrove") {
      for (let i = 0; i < 3; i++) {
        const [dx, dz] = DIRECTIONS[(direction + i) % 4];
        const join = ground + 2 + Number(roll(60 + i) < 0.5);
        log(dx, join, dz, dx ? S.AXIS_X : S.AXIS_Z);
        log(dx * 2, join, dz * 2, dx ? S.AXIS_X : S.AXIS_Z);
        trunk(dx * 2, col.top, dz * 2, join - col.top);
      }
    }
    if (type === "pale" && !young) {
      const lobe = crowns.at(-1);
      for (let dy = 0; dy < 3; dy++)
        accents.push({
          kind: "block",
          x: lobe.x,
          y: lobe.y - 2 - dy,
          z: lobe.z + lobe.radius,
          block: B.MOSS,
        });
    }
  }
  const parts = Object.freeze(
    [...structural, ...crowns, ...accents].map(Object.freeze)
  );
  return Object.freeze({
    x,
    z,
    ground,
    height,
    wood,
    leaves,
    radius,
    type,
    parts,
    bounds: boundsOf(parts),
  });
}

export function emitV4Tree(tree, put) {
  for (const part of tree.parts) {
    const { x, y, z, block } = part;
    const options = {
      state: part.state ?? 0,
      mode: part.replaceWater ? "wet" : "soft",
    };
    if (part.kind === "trunk") {
      for (let dy = 1; dy <= part.height; dy++)
        for (let dz = 0; dz < part.width; dz++)
          for (let dx = 0; dx < part.width; dx++)
            put(x + dx, y + dy, z + dz, block, options);
    } else if (part.kind === "crown") {
      for (let dy = part.flat ? 0 : -1; dy <= 1; dy++) {
        const radius = dy === 1 ? Math.max(1, part.radius - 1) : part.radius;
        for (let dz = -radius; dz <= radius; dz++)
          for (let dx = -radius; dx <= radius; dx++)
            if (dx * dx + dz * dz <= radius * radius + radius)
              put(x + dx, y + dy, z + dz, block, options);
      }
    } else put(x, y, z, block, options);
  }
}

export function createV4Vegetation({
  salt,
  dimension,
  spec,
  sampleColumn,
  counters,
}) {
  const cache = new Map();
  function getTrees(gx, gz) {
    if (
      !Number.isSafeInteger(gx) ||
      !Number.isSafeInteger(gz) ||
      dimension === "end"
    )
      return EMPTY;
    const key = `${gx},${gz}`;
    if (cache.has(key)) return cache.get(key);
    counters.treeCells++;
    const x =
      gx * V4_TREE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1129) * 6);
    const z =
      gz * V4_TREE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1879) * 6);
    const col = sampleColumn(x, z);
    let result = EMPTY;
    if (col && col.top !== null && col.treeSafe) {
      const wet = ["swamp", "mangrove_swamp"].includes(col.id);
      const dryEnough =
        dimension === "nether"
          ? col.top > 32
          : wet
            ? col.depth <= 3
            : col.top >= 64;
      const chance = hash(gx, gz, salt ^ 2713);
      const type =
        col.profile.tree ??
        (getBiomeById(col.id).category === "grassland" ? "oak" : null);
      if (type && dryEnough && chance < v4ForestDensity(col, salt, dimension)) {
        const supported = [
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
          [1, 1],
        ].every(([dx, dz]) => {
          const next = sampleColumn(x + dx, z + dz);
          return (
            next &&
            next.top !== null &&
            next.treeSafe &&
            Math.abs(next.top - col.top) <= 2 &&
            (wet || next.waterLevel === null)
          );
        });
        if (supported) {
          const tree = describe(
            col,
            type,
            salt,
            dimension === "nether" ? col.roof : spec.maxY
          );
          if (tree) result = Object.freeze([tree]);
        }
      }
      if (col.id === "dark_forest" && dryEnough && chance > 0.96) {
        const mushroom = describe(col, "mushroom", salt, spec.maxY);
        if (mushroom) result = Object.freeze([...result, mushroom]);
      }
    }
    return remember(cache, key, result, V4_LIMITS.trees);
  }

  function decorate(bounds, writer) {
    forEachV4Owner(bounds, V4_TREE_SPACING, V4_TREE_REACH, (gx, gz) => {
      for (const tree of getTrees(gx, gz)) emitV4Tree(tree, writer.put);
      const x = gx * 8 + 2 + Math.floor(hash(gx, gz, salt ^ 2347) * 4);
      const z = gz * 8 + 2 + Math.floor(hash(gx, gz, salt ^ 4789) * 4);
      const col = sampleColumn(x, z);
      if (!col || col.top === null || col.surfaceOpen) return;
      const chance = hash(gx, gz, salt ^ 6197);
      if (col.id === "ice_spikes" && chance < 0.23) {
        const height = 7 + Math.floor(hash(gx, gz, salt ^ 49547) * 18);
        for (let dy = 1; dy <= height; dy++) {
          const radius = Math.max(0, Math.floor(3 * (1 - dy / height)));
          for (let dz = -radius; dz <= radius; dz++)
            for (let dx = -radius; dx <= radius; dx++)
              if (dx * dx + dz * dz <= radius * radius + 1)
                writer.put(x + dx, col.top + dy, z + dz, B.PACKED_ICE);
        }
      } else if (col.id === "basalt_deltas" && col.top > 31 && chance < 0.32) {
        const height = Math.min(
          col.roof - col.top - 5,
          3 + Math.floor(chance * 41)
        );
        for (let dy = 1; dy <= height; dy++)
          writer.put(x, col.top + dy, z, B.BASALT);
      } else if (
        (col.id === "end_highlands" && chance < 0.48) ||
        (col.id === "end_midlands" && chance < 0.1)
      ) {
        const height = 3 + Math.floor(hash(gx, gz, salt ^ 7559) * 7);
        for (let dy = 1; dy <= height; dy++)
          writer.put(x, col.top + dy, z, B.CHORUS);
        for (const [dx, dz] of DIRECTIONS.slice(0, 2)) {
          const level = col.top + height - 2;
          writer.put(x + dx, level, z + dz, B.CHORUS);
          writer.put(x + dx * 2, level, z + dz * 2, B.CHORUS);
          writer.put(x + dx * 2, level + 1, z + dz * 2, B.CHORUS);
        }
      }
    });
  }

  function groundCover(col, put) {
    if (
      dimension !== "overworld" ||
      col.surfaceOpen ||
      !v4InBounds(col.x, col.z)
    )
      return;
    const { x, z, top, profile, id } = col;
    const chance = hash(x, z, salt ^ 3199);
    const category = getBiomeById(id).category;
    if (col.waterLevel !== null) {
      if (category === "swamp" && col.depth <= 3 && chance < 0.12)
        put(x, 64, z, B.LILY_PAD, { mode: "air" });
      return;
    }
    if (
      category === "desert" ||
      (category === "badlands" && id !== "wooded_badlands")
    ) {
      if (chance < 0.01) {
        const height = 2 + Math.floor(hash(x, z, salt ^ 7837) * 3);
        for (let dy = 1; dy <= height; dy++) put(x, top + dy, z, B.CACTUS);
      } else if (chance < 0.06) put(x, top + 1, z, B.DEAD_BUSH);
    } else if (profile.bamboo && chance < profile.bamboo) {
      const height = 6 + Math.floor(hash(x, z, salt ^ 7247) * 8);
      for (let dy = 1; dy <= height; dy++) put(x, top + dy, z, B.BAMBOO);
    } else if ([B.GRASS, B.MOSS, B.PODZOL].includes(col.surface)) {
      const patch = noise(x / 29, z / 29, salt ^ 22571);
      let plant;
      if (id === "cherry_grove" && chance < 0.28) plant = B.PINK_PETALS;
      else if (id === "sunflower_plains" && patch > 0.45 && chance < 0.22)
        plant = B.SUNFLOWER;
      else if (category === "jungle" && chance < 0.005) plant = B.MELON;
      else if (chance < profile.flowers * (0.35 + patch))
        plant = hash(x, z, salt ^ 6343) < 0.5 ? B.RED_FLOWER : B.YELLOW_FLOWER;
      else if (chance < 0.18 + patch * 0.12)
        plant =
          category === "taiga" || id === "old_growth_birch_forest"
            ? B.FERN
            : B.TALL_GRASS;
      if (plant !== undefined) put(x, top + 1, z, plant);
    }
    if (top >= 63 && top <= 65 && chance > 0.976) {
      const water = DIRECTIONS.some(
        ([dx, dz]) => sampleColumn(x + dx, z + dz)?.waterLevel === 63
      );
      if (water)
        for (let dy = 1; dy <= 2 + Number(chance > 0.991); dy++)
          put(x, top + dy, z, B.SUGAR_CANE);
    }
  }

  return {
    getTrees,
    decorate,
    groundCover,
    get cacheSize() {
      return cache.size;
    },
  };
}
