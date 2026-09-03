import { BLOCK as B } from "./blocks.js";
import { hash } from "./noise.js";

const HEIGHTS = {
  oak: [3, 12],
  birch: [5, 13],
  tall_birch: [10, 21],
  spruce: [6, 18],
  pine: [10, 24],
  giant_spruce: [14, 28],
  dark: [5, 14],
  pale: [6, 16],
  cherry: [4, 11],
  jungle: [8, 28],
  mangrove: [5, 14],
  swamp_oak: [4, 12],
  acacia: [4, 12],
  mushroom: [4, 10],
};
const DIRECTIONS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

function copyTree(tree) {
  return {
    ...tree,
    parts: tree.parts.map((part) => ({ ...part })),
    bounds: { ...tree.bounds },
    ...(tree.exclude ? { exclude: { ...tree.exclude } } : {}),
  };
}

// Half-open bounds describe actual native writes, not just crown centers.
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
    const crown = part.kind === "crown";
    const trunk = part.kind === "trunk";
    const radius = crown ? part.radius : 0;
    const width = trunk ? part.width : 1;
    bounds.minX = Math.min(bounds.minX, part.x - radius);
    bounds.minZ = Math.min(bounds.minZ, part.z - radius);
    bounds.maxX = Math.max(bounds.maxX, part.x + radius + width);
    bounds.maxZ = Math.max(bounds.maxZ, part.z + radius + width);
    bounds.minY = Math.min(
      bounds.minY,
      part.y + (trunk ? 1 : crown && !part.flat ? -1 : 0)
    );
    bounds.maxY = Math.max(
      bounds.maxY,
      part.y + (trunk ? part.height + 1 : crown ? 2 : 1)
    );
  }
  return bounds;
}

function offset(direction, length) {
  const [dx, dz] = DIRECTIONS[direction % DIRECTIONS.length];
  return dx && dz
    ? [dx * Math.ceil(length / 2), dz * Math.floor(length / 2)]
    : [dx * length, dz * length];
}

/**
 * Sculpt a fresh native descriptor; callers gate this to v3 Overworld only.
 * No placement, density, palette, or shared-profile state is changed.
 * Legacy descriptors, unknown species, and Nether fungi are copied unchanged.
 * Returns null when a root has no room for even one log and its canopy.
 */
export function varyTreeShape(tree, salt, maxHeight = 96) {
  if (!tree) return tree;
  if (tree.legacy || !Object.hasOwn(HEIGHTS, tree.type)) return copyTree(tree);
  if (
    ![tree.x, tree.z, tree.ground, maxHeight].every(Number.isSafeInteger) ||
    tree.ground < 0
  )
    return null;

  const room = Math.min(96, maxHeight) - tree.ground - 2;
  if (room < 1) return null;
  // Independent channels make an individual tree independent of generation
  // order and of how many random choices another species happens to need.
  const roll = (channel) =>
    hash(tree.x, tree.z, salt ^ Math.imul(channel + 1, 0x9e3779b1));
  const age = roll(0);
  const young = age < 0.25,
    mature = age > 0.7;
  const [low, high] = HEIGHTS[tree.type];
  const height = Math.min(room, low + Math.floor(age * (high - low + 1)));
  const direction = Math.floor(roll(1) * 8);
  const mainRadius = Math.max(
    1,
    Math.min(
      5,
      tree.radius - (young ? 1 : 0) + (mature && roll(2) < 0.5 ? 1 : 0)
    )
  );
  const wood = [],
    crowns = [],
    accents = [];
  const trunk = (dx, level, dz, length, width = 1) =>
    wood.push({
      kind: "trunk",
      x: tree.x + dx,
      y: tree.ground + level,
      z: tree.z + dz,
      height: length,
      width,
      block: tree.wood,
    });
  const log = (dx, level, dz, replaceWater = false) =>
    wood.push({
      kind: "block",
      x: tree.x + dx,
      y: tree.ground + level,
      z: tree.z + dz,
      block: tree.wood,
      replaceWater,
    });
  const crown = (dx, level, dz, radius, flat = false) =>
    crowns.push({
      kind: "crown",
      x: tree.x + dx,
      y: tree.ground + level,
      z: tree.z + dz,
      // Count the exclusive outer voxel edge too: even an offset crown must
      // fit the existing eight-block root scan, without increasing tree reach.
      radius: Math.min(radius, 7 - Math.abs(dx), 7 - Math.abs(dz)),
      block: tree.leaves,
      flat: flat || level === 1,
    });
  const limb = (dx, dz, tip, rise, xFirst) => {
    const distance = Math.abs(dx) + Math.abs(dz);
    const start = tip - rise;
    let x = 0,
      z = 0,
      level = start;
    for (let step = 1; step <= distance; step++) {
      if (x !== dx && (z === dz || (step % 2 === 1) === xFirst))
        x += Math.sign(dx);
      else z += Math.sign(dz);
      // A horizontal step and then a vertical riser, never a diagonal gap.
      // A limb is at most four steps and two risers (six wood parts).
      log(x, level, z);
      const next = start + Math.floor((step * rise) / distance);
      if (next > level) trunk(x, level, z, next - level);
      level = next;
    }
  };
  const branchDirection = (index) =>
    direction +
    (index === 0
      ? 0
      : index === 1
        ? 3 + Math.floor(roll(10) * 2)
        : 5 + Math.floor(roll(11) * 2));

  const wide =
    height >= 4 &&
    ((tree.type === "giant_spruce" && !young) ||
      (["dark", "pale", "jungle"].includes(tree.type) && age > 0.35));
  const stemHeight =
    tree.type === "acacia" && height >= 4 ? height - 2 : height;
  trunk(0, 0, 0, stemHeight, wide ? 2 : 1);

  if (height < 4) {
    const flat =
      ["spruce", "pine", "giant_spruce", "acacia", "dark"].includes(
        tree.type
      ) ||
      (tree.type === "mushroom" && tree.leaves === B.BROWN_MUSHROOM);
    crown(0, height, 0, Math.min(2, mainRadius), flat);
  } else if (["spruce", "pine", "giant_spruce"].includes(tree.type)) {
    const bare =
      tree.type === "pine"
        ? Math.floor(height * (0.52 + roll(3) * 0.18))
        : tree.type === "giant_spruce"
          ? 4 + Math.floor(roll(3) * 5)
          : 2 + Math.floor(roll(3) * 4);
    const start = Math.min(height - 1, bare);
    const [dx, dz] = DIRECTIONS[direction];
    let tier = 0;
    for (let level = start; level < height; tier++) {
      const radius = Math.max(
        1,
        Math.ceil((mainRadius * (height - level)) / (height - start))
      );
      // Uneven skirts retain the central leader and species-specific taper.
      // Every shifted tier still intersects the solid central trunk.
      const lean = radius > 1 && roll(30 + tier) < 0.55 ? 1 : 0;
      crown(dx * lean, level, dz * lean, radius, true);
      level += 2 + (roll(50 + tier) < 0.25 ? 1 : 0);
    }
    crown(0, height, 0, 1, true);
  } else if (tree.type === "acacia") {
    for (let i = 0; i < (mature ? 3 : 2); i++) {
      const length =
        i === 0
          ? 3 + Math.floor(roll(20) * 2)
          : 2 + Math.floor(roll(20 + i) * 3);
      const [dx, dz] = offset(branchDirection(i), length);
      const tip = height - (i === 0 ? 0 : 1 + Math.floor(roll(24 + i) * 2));
      const rise = tip - (stemHeight - (i === 0 ? 0 : 1));
      limb(dx, dz, tip, rise, roll(28 + i) < 0.5);
      crown(
        dx,
        tip,
        dz,
        i === 0 ? Math.min(4, mainRadius) : 2 + (mature ? 1 : 0),
        true
      );
    }
  } else if (tree.type === "mushroom") {
    const radius = 2 + Math.floor(roll(3) * 4);
    const brown = tree.leaves === B.BROWN_MUSHROOM;
    const domed = !brown && radius >= 4 && height >= 6 && roll(4) < 0.65;
    if (domed) crown(0, height - 2, 0, radius, true);
    crown(0, height, 0, radius - (domed ? 1 : 0), brown);
  } else {
    const slender = tree.type === "birch" || tree.type === "tall_birch";
    const flat = tree.type === "dark";
    crown(0, height, 0, mainRadius, flat);

    if (tree.type === "mangrove") {
      // Connected stilt roots keep the native water-replacement semantics.
      // Three roots + two limbs + the main stem/crown need at most 25 parts.
      for (let i = 0; i < (young ? 2 : 3); i++) {
        const [dx, dz] = DIRECTIONS[((direction & 6) + i * 2) % 8];
        const join = 2 + Math.floor(roll(60 + i) * 2);
        log(dx, join, dz, true);
        log(dx * 2, join, dz * 2, true);
        trunk(dx * 2, 0, dz * 2, join);
      }
    } else if (tree.type === "jungle" && wide) {
      for (let i = 0; i < 2; i++) {
        const [dx, dz] = DIRECTIONS[((direction & 6) + i * 2) % 8];
        trunk(
          dx > 0 ? 2 : dx,
          0,
          dz > 0 ? 2 : dz,
          2 + Math.floor(roll(60 + i) * 3)
        );
      }
    }

    const branches = young
      ? 1
      : slender || tree.type === "mangrove"
        ? 2
        : mature
          ? 3
          : 2;
    for (let i = 0; i < branches; i++) {
      const length = slender
        ? 1 + Math.floor(roll(20 + i) * 2)
        : young
          ? 2
          : 2 + Math.floor(roll(20 + i) * 3);
      const [dx, dz] = offset(branchDirection(i), length);
      const drop =
        tree.type === "jungle" && !young && i === 0
          ? Math.floor(height * (0.24 + roll(24) * 0.12))
          : Math.floor(roll(24 + i) * (slender ? 4 : 3));
      const tip = Math.max(2, height - drop);
      const rise = Math.min(tip - 1, 1 + (roll(28 + i) < 0.5 ? 1 : 0));
      limb(dx, dz, tip, rise, roll(32 + i) < 0.5);
      const radius = slender
        ? 1 + (mature ? 1 : 0)
        : Math.max(
            1,
            Math.min(3, mainRadius - 1 + Math.floor(roll(36 + i) * 2))
          );
      crown(dx, tip, dz, radius, flat);
    }
    if (tree.type === "pale") {
      const lobe = crowns[Math.floor(roll(70) * crowns.length)];
      const length = Math.min(3, lobe.y - tree.ground - 2);
      for (let i = 0; i < length; i++)
        accents.push({
          kind: "block",
          x: lobe.x + lobe.radius,
          y: lobe.y - 2 - i,
          z: lobe.z,
          block: B.MOSS,
          replaceWater: false,
        });
    }
  }

  // Native put() preserves wood and lets logs replace leaves. Emitting all
  // structural wood first also keeps every lobe supported throughout writing.
  const parts = [...wood, ...crowns, ...accents];
  return {
    ...tree,
    height,
    radius: Math.max(...crowns.map((part) => part.radius)),
    parts,
    bounds: boundsOf(parts),
  };
}
