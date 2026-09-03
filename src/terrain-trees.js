import { BLOCK as B } from "./blocks.js";
import { LEGACY_MAX, LEGACY_MIN } from "./legacy-terrain.js";
import { clamp, hash, mix, noise, smooth } from "./noise.js";
import { TREE_SPECIES } from "./terrain-profiles.js";
import { varyTreeShape } from "./tree-shapes-v3.js";

export const TREE_SPACING = 8;
export const TREE_REACH = 8;
const LEGACY_AREA = {
  minX: LEGACY_MIN,
  maxX: LEGACY_MAX,
  minZ: LEGACY_MIN,
  maxZ: LEGACY_MAX,
};

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
    const crown = part.kind === "crown" || part.kind === "legacy-crown";
    const radius = crown ? part.radius : 0;
    const width = part.kind === "trunk" ? part.width : 1;
    bounds.minX = Math.min(bounds.minX, part.x - radius);
    bounds.maxX = Math.max(bounds.maxX, part.x + radius + width);
    bounds.minZ = Math.min(bounds.minZ, part.z - radius);
    bounds.maxZ = Math.max(bounds.maxZ, part.z + radius + width);
    bounds.minY = Math.min(
      bounds.minY,
      part.y +
        (part.kind === "trunk"
          ? 1
          : crown
            ? part.flat
              ? 0
              : part.kind === "legacy-crown"
                ? -2
                : -1
            : 0)
    );
    bounds.maxY = Math.max(
      bounds.maxY,
      part.y + (part.kind === "trunk" ? part.height + 1 : crown ? 2 : 1)
    );
  }
  return bounds;
}

// Parts retain the original voxel write order, including crowns before cherry
// branches and the water-replacing mangrove roots. LOD reads these same parts.
export function describeTree(x, z, col, chance, salt, waterLevel) {
  let type = col.profile.tree;
  if (type === "mixed") type = chance < 0.25 ? "birch" : "oak";
  const ground = Math.max(
    col.top,
    type === "mangrove" || type === "swamp_oak" ? waterLevel : col.top
  );
  const extra = Math.floor(hash(x, z, salt ^ 7219) * 4);
  const parts = [];
  const trunk = (x, y, z, height, block, wide = false) =>
    parts.push({ kind: "trunk", x, y, z, height, block, width: wide ? 2 : 1 });
  const crown = (x, y, z, radius, block, flat = false) =>
    parts.push({ kind: "crown", x, y, z, radius, block, flat });
  const put = (x, y, z, block, replaceWater = false) =>
    parts.push({ kind: "block", x, y, z, block, replaceWater });
  let height, wood, leaves, radius;
  if (["spruce", "pine", "giant_spruce"].includes(type)) {
    const giant = type === "giant_spruce",
      pine = type === "pine";
    height = (giant ? 17 : pine ? 15 : 9) + extra;
    wood = B.SPRUCE_LOG;
    leaves = B.SPRUCE_LEAVES;
    radius = giant ? 4 : pine ? 2 : 3;
    trunk(x, ground, z, height, wood, giant);
    const start = ground + (pine ? height - 7 : giant ? 5 : 3);
    for (let y = start; y <= ground + height; y++) {
      if ((ground + height - y) % 3 === 2) continue;
      crown(
        x,
        y,
        z,
        Math.min(radius, Math.floor((ground + height - y) / 3) + 1),
        leaves,
        true
      );
    }
  } else if (type === "acacia") {
    height = 5 + extra;
    wood = B.ACACIA_LOG;
    leaves = B.ACACIA_LEAVES;
    radius = 4;
    const direction = chance < 0.5 ? -1 : 1;
    trunk(x, ground, z, height - 2, wood);
    for (let step = 0; step < 4; step++)
      put(
        x + step * direction,
        ground + height - 2 + Math.floor(step / 2),
        z,
        wood
      );
    crown(x + direction * 3, ground + height, z, 4, leaves, true);
    crown(x - direction * 2, ground + height - 2, z + 1, 2, leaves, true);
  } else if (type === "mushroom") {
    height = 5 + extra;
    wood = B.MUSHROOM_STEM;
    leaves = chance < 0.5 ? B.RED_MUSHROOM : B.BROWN_MUSHROOM;
    radius = chance < 0.5 ? 3 : 4;
    trunk(x, ground, z, height, wood);
    crown(x, ground + height, z, radius, leaves, chance >= 0.5);
  } else {
    const species = TREE_SPECIES[type];
    if (!species) return null;
    [wood, leaves, , radius] = species;
    height = species[2] + extra;
    trunk(
      x,
      ground,
      z,
      height,
      wood,
      ["jungle", "pale", "dark"].includes(type)
    );
    if (type === "mangrove") {
      for (const [dx, dz] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ])
        for (let step = 1; step <= 3; step++)
          put(
            x + dx * (3 - step),
            ground + step,
            z + dz * (3 - step),
            wood,
            true
          );
    }
    if (type === "cherry") {
      crown(x - 2, ground + height - 1, z, 3, leaves);
      crown(x + 2, ground + height, z + 1, 3, leaves);
      put(x - 1, ground + height - 2, z, wood);
      put(x + 1, ground + height - 1, z, wood);
    }
    crown(
      x,
      ground + height,
      z,
      radius,
      leaves,
      ["dark", "crimson", "warped"].includes(type)
    );
    if (type === "jungle")
      crown(x + 2, ground + Math.floor(height * 0.65), z - 1, 2, leaves);
    if (type === "pale")
      for (let dy = 0; dy < 3; dy++)
        put(x - 3, ground + height - 2 - dy, z, B.MOSS);
  }
  return {
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
  };
}

export function writeTree(tree, put) {
  if (!tree) return;
  for (const part of tree.parts) {
    const { x, y, z, block } = part;
    if (part.kind === "trunk") {
      for (let dy = 1; dy <= part.height; dy++)
        for (let dz = 0; dz < part.width; dz++)
          for (let dx = 0; dx < part.width; dx++)
            put(x + dx, y + dy, z + dz, block, true);
    } else if (part.kind === "crown") {
      for (let dy = part.flat ? 0 : -1; dy <= 1; dy++) {
        const r = dy === 1 ? Math.max(1, part.radius - 1) : part.radius;
        for (let dz = -r; dz <= r; dz++)
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dz * dz > r * r + r) continue;
            put(x + dx, y + dy, z + dz, block);
          }
      }
    } else if (part.kind === "block") {
      put(x, y, z, block, part.replaceWater);
    }
  }
}

export function forestDensity(x, z, col, salt) {
  const cover =
    noise(x / 113, z / 113, salt ^ 9631) * 0.76 +
    noise(x / 67, z / 67, salt ^ 5419) * 0.24;
  const forest = smooth(clamp((cover - 0.32) / 0.35));
  const treeline =
    62 +
    col.temperature * 14 +
    (noise(x / 137, z / 137, salt ^ 8221) - 0.5) * 8;
  const altitude = 1 - smooth(clamp((col.top - treeline + 8) / 8));
  return clamp(col.profile.density * forest * 1.25) * altitude;
}

// Pure v1 height evaluation for optional far-tree sampling. Calling the frozen
// legacy.terrainHeight instead would synchronously build its entire voxel world.
// legacy-terrain.js remains the authoritative, unchanged v1 writer.
function legacyHeight(x, z, seed) {
  const broad = noise(x / 34, z / 34, seed);
  const detail = noise(x / 11, z / 11, seed ^ 815);
  let height = 18 + broad * 8 + detail * 3;
  const north = smooth(clamp((-z - 17) / 38));
  const ridge = Math.max(
    0,
    1 - Math.abs(noise(x / 25, z / 27, seed ^ 9871) * 2 - 1)
  );
  height += north * (10 + ridge * 23);
  height += Math.max(0, Math.abs(x) - 49) * 0.19;
  const riverCenter = Math.sin(z * 0.055) * 8 + Math.sin(z * 0.11) * 3;
  const riverWidth = 3.6 + Math.sin(z * 0.065) * 1.2;
  height = mix(
    11 + detail * 2,
    height,
    smooth(clamp((Math.abs(x - riverCenter) - riverWidth) / 7))
  );
  const lakeDistance = Math.hypot((x + 8) / 1.35, z - 3);
  height = mix(11 + detail * 2, height, smooth(clamp((lakeDistance - 9) / 8)));
  const overlook = smooth(clamp(1 - Math.hypot(x - 21, z - 30) / 9));
  height = mix(height, 26, overlook);
  return clamp(Math.floor(height), 6, 55);
}

function legacyTrees(gx, gz, salt) {
  const result = [];
  const start = LEGACY_MIN + 4;
  const minX = gx * TREE_SPACING,
    minZ = gz * TREE_SPACING;
  for (
    let iz = Math.max(0, Math.ceil((minZ - start - 2) / 6));
    iz <= Math.min(25, Math.floor((minZ + 7 - start) / 6));
    iz++
  ) {
    for (
      let ix = Math.max(0, Math.ceil((minX - start - 2) / 6));
      ix <= Math.min(25, Math.floor((minX + 7 - start) / 6));
      ix++
    ) {
      const ax = start + ix * 6,
        az = start + iz * 6;
      const chance = hash(ax, az, salt ^ 913);
      if (chance > 0.62) continue;
      const x = ax + Math.floor(hash(ax, az, salt ^ 84) * 3);
      const z = az + Math.floor(hash(ax, az, salt ^ 17) * 3);
      if (
        Math.floor(x / TREE_SPACING) !== gx ||
        Math.floor(z / TREE_SPACING) !== gz
      )
        continue;
      const ground = legacyHeight(x, z, salt);
      if (
        ground < 18 ||
        ground > 32 ||
        Math.hypot(x - 21, z - 30) < 11 ||
        (z > 4 && z < 31 && x > 12 && x < 29)
      )
        continue;
      const birch = chance < 0.19;
      const wood = birch ? B.BIRCH_LOG : B.OAK_LOG;
      const leaves = birch ? B.BIRCH_LEAVES : B.LEAVES;
      const height = (birch ? 6 : 4) + (chance < 0.3 ? 1 : 0);
      const parts = [
        { kind: "trunk", x, y: ground, z, height, block: wood, width: 1 },
        {
          kind: "legacy-crown",
          x,
          y: ground + height,
          z,
          radius: 2,
          block: leaves,
        },
      ];
      result.push({
        x,
        z,
        ground,
        height,
        wood,
        leaves,
        radius: 2,
        type: birch ? "birch" : "oak",
        legacy: true,
        parts,
        bounds: boundsOf(parts),
      });
    }
  }
  return result;
}

// Optional surfaceColumn must report the same uncarved root height, biome and
// climate as column. V3 uses it only for cheap placement rejection; column still
// performs authoritative cave/wet-bank work for surviving candidates.
// isTreeEligible(tree, fullRootColumn) is an optional, pure v3-only predicate.
export function createTreeGenerator({
  salt,
  dimension,
  version,
  column,
  surfaceColumn = column,
  isTreeEligible,
  getSpawn,
  waterLevel,
  validXZ,
}) {
  const naturalTrees = version >= 3 && dimension === "overworld";
  const rootEligible = (col) =>
    !naturalTrees || (!col.caveMouth && !col.surfaceOpen);
  function model(x, z, col, placementChance, type) {
    // LOD may use the cheap uncarved surface for placement. Resolve the full
    // root only after density, spawn and water checks pass; cave plans remain
    // authoritative and are never approximated by the surface sampler.
    const root = naturalTrees && surfaceColumn !== column ? column(x, z) : col;
    if (!rootEligible(root)) return null;
    // Sparse cover truncates placementChance. Reusing it for species or mushroom
    // caps would turn every sparse patch into birches and red mushrooms.
    const shapeChance = naturalTrees
      ? hash(x, z, salt ^ 4421)
      : placementChance;
    const tree = describeTree(
      x,
      z,
      type ? { ...root, profile: { tree: type } } : root,
      shapeChance,
      salt,
      waterLevel
    );
    if (!naturalTrees) return tree;
    const varied = varyTreeShape(tree, salt);
    // A pure boolean predicate receives the ENTIRE morphed tree, including
    // half-open bounds and every branch/crown part, plus its full root column.
    // Reject whole trees intersecting reserved cave volumes before either the
    // native writer or LOD sees them; never clip only the voxel representation.
    if (varied && isTreeEligible && !isTreeEligible(varied, root)) return null;
    return varied;
  }
  function nearSpawn(x, z) {
    if (dimension !== "overworld") return false;
    if (version < 3)
      return (
        Math.hypot(x - 21, z - 30) < 12 || (z > 2 && z < 32 && x > 10 && x < 30)
      );
    const spawn = getSpawn();
    return Math.hypot(x + 0.5 - spawn.x, z + 0.5 - spawn.z) < 10;
  }
  function primary(x, z, col, chance) {
    const wetTree = col.id === "swamp" || col.id === "mangrove_swamp";
    if (
      !rootEligible(col) ||
      !col.profile.tree ||
      !(dimension === "nether"
        ? col.top > 21
        : col.top > waterLevel + 1 || wetTree)
    )
      return null;
    const density = naturalTrees
      ? forestDensity(x, z, col, salt)
      : col.profile.density;
    if (chance >= density || nearSpawn(x, z)) return null;
    return model(x, z, col, chance);
  }
  function mushroom(x, z, col, chance) {
    if (!rootEligible(col) || col.id !== "dark_forest" || chance <= 0.9)
      return null;
    if (
      naturalTrees &&
      ((chance - 0.9) * 10 >= forestDensity(x, z, col, salt) || nearSpawn(x, z))
    )
      return null;
    return model(x, z, col, chance * 0.5, "mushroom");
  }
  // Root-owned cells use floor division, including negative coordinates. Arrays
  // preserve both overlapping dark-forest trees and the old v1 six-block grid.
  function getTrees(gx, gz) {
    if (!Number.isSafeInteger(gx) || !Number.isSafeInteger(gz)) return [];
    const x = gx * TREE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1129) * 6);
    const z = gz * TREE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1879) * 6);
    if (!validXZ(x, z)) return [];
    const col = (naturalTrees ? surfaceColumn : column)(x, z),
      chance = hash(gx, gz, salt ^ 2713);
    const trees = [
      primary(x, z, col, chance),
      mushroom(x, z, col, chance),
    ].filter(Boolean);
    if (version !== 1 || dimension !== "overworld") return trees;
    const visible = trees.filter(
      ({ bounds }) =>
        bounds.minX < LEGACY_MIN ||
        bounds.maxX > LEGACY_MAX ||
        bounds.minZ < LEGACY_MIN ||
        bounds.maxZ > LEGACY_MAX
    );
    for (const tree of visible) tree.exclude = LEGACY_AREA;
    return visible.concat(legacyTrees(gx, gz, salt));
  }
  return { primary, mushroom, getTrees };
}
