import { getBiomeById } from "./biomes.js";
import { clamp, fractal, mix, noise, smooth, squareSpiral } from "./noise.js";
import { oceanId } from "./terrain-profiles.js";
import { forestDensity } from "./terrain-trees.js";

// Generator v3 only. Broad uplift, erosion and connected ridges vary within a
// biome; a forest no longer means the same small rolling hill repeated forever.
// Keep this column-scoped: both the worker and the distant mesh sample it.
export function shapeOverworld(x, z, field, salt, waterLevel) {
  const wx = x + (noise(x / 510, z / 510, salt ^ 17891) - 0.5) * 190;
  const wz = z + (noise(x / 510, z / 510, salt ^ 24103) - 0.5) * 190;
  const uplift = fractal(wx / 470, wz / 470, salt ^ 17989);
  const erosion = noise(wx / 230, wz / 230, salt ^ 11351);
  const ridge = 1 - Math.abs(noise(wx / 135, wz / 135, salt ^ 9013) * 2 - 1);
  const detail = noise(wx / 39, wz / 39, salt ^ 2851);
  const land = 1 - smooth(field.ocean);
  const relief = field.relief * mix(1.9, 0.6, erosion);
  let height =
    field.height +
    (uplift - 0.42) * 24 * land +
    mix((ridge ** 2 - 0.45) * 1.25, (detail - 0.5) * 0.6, erosion * 0.7) *
      relief +
    (noise(x / 11, z / 11, salt ^ 739) - 0.5) * 1.4;
  let id = field.nearest.id;
  const temperature = field.nearest.temperature;
  const category = getBiomeById(id).category;

  if (id === "desert") {
    const wind =
      wx * 0.085 + wz * 0.032 + noise(wx / 150, wz / 150, salt ^ 193) * 9;
    height += (1 - Math.abs(Math.sin(wind))) ** 2 * 5;
  }
  if (category === "badlands" || id === "savanna_plateau") {
    // Terraces survive between the river cuts; eroded mesas also gain hoodoos.
    height = mix(height, Math.round(height / 6) * 6, 0.84);
    if (id === "eroded_badlands")
      height += noise(wx / 23, wz / 23, salt ^ 1913) ** 4 * 23;
  }

  const riverDistance = Math.abs(noise(wx / 285, wz / 285, salt ^ 3571) - 0.5);
  const floodplain = 1 - smooth(clamp((riverDistance - 0.018) / 0.095));
  const channel = 1 - smooth(clamp((riverDistance - 0.009) / 0.026));
  const lake = smooth(
    clamp((noise(wx / 125, wz / 125, salt ^ 6311) - 0.79) / 0.12)
  );
  if (field.ocean < 0.45 && category !== "swamp") {
    height = mix(height, waterLevel + 5 + detail * 2, floodplain * 0.72);
    height = mix(height, waterLevel - 5 + detail * 2, Math.max(channel, lake));
  } else if (category === "swamp") {
    height = mix(height, waterLevel - 2 + detail * 3.5, 0.92);
  }

  // Smooth headroom leaves pointed peaks, not a giant flat ceiling at y=80.
  if (height > 70) height = 70 + 16 * (1 - Math.exp((70 - height) / 16));
  const top = Math.floor(height);
  if (category !== "swamp" && top < waterLevel - 1) {
    id =
      field.ocean > 0.5
        ? oceanId(temperature, top < 11)
        : temperature < 0.23
          ? "frozen_river"
          : "river";
  } else if (
    category !== "swamp" &&
    top <= waterLevel + 2 &&
    (field.ocean > 0.1 || channel > 0.15)
  ) {
    id =
      temperature < 0.23
        ? "snowy_beach"
        : field.relief > 10
          ? "stony_shore"
          : "beach";
  }
  return { height, id, temperature };
}

// Select a place in the actual seeded landscape instead of sculpting the same
// starter valley into every seed. This never generates or modifies any voxels.
export function findNaturalSpawn(
  column,
  waterLevel,
  salt,
  accept = () => true
) {
  let best = null;
  let bestScore = -Infinity;
  let fallback = null;
  let candidates = 0;
  for (const [dx, dz] of squareSpiral(64)) {
    const x = 21 + dx * 32;
    const z = 30 + dz * 32;
    const col = column(x, z);
    if (col.top <= waterLevel + 2 || col.top > 66) continue;
    const category = getBiomeById(col.id).category;
    if (["ocean", "river", "shore", "swamp"].includes(category)) continue;
    const local = [
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
    ].map(([ox, oz]) => column(x + ox, z + oz).top);
    const slope = Math.max(
      ...local.map((height) => Math.abs(height - col.top))
    );
    if (slope > 1) continue;
    const point = { x: x + 0.5, y: col.top + 1.01, z: z + 0.5 };
    // Avoid tall non-tree features at the landing cell.
    if (
      !col.profile.bamboo &&
      !["ice_spikes", "mushroom_fields"].includes(col.id) &&
      !fallback &&
      accept(point, col)
    )
      fallback = point;
    if (
      !["forest", "grassland", "taiga", "savanna"].includes(category) &&
      !(col.profile.tree && ["snowy", "mountain"].includes(category))
    )
      continue;
    const woodland = Math.max(
      ...[
        [-16, 0],
        [16, 0],
        [0, -16],
        [0, 16],
      ].map(([ox, oz]) => {
        const nearby = column(x + ox, z + oz);
        return nearby.profile.tree && Math.abs(nearby.top - col.top) <= 8
          ? forestDensity(nearby.x, nearby.z, nearby, salt)
          : 0;
      })
    );
    // A biome's tree label alone is not enough now that forests have clearings.
    // Prefer reachable woodland so a natural Survival start still offers tools.
    if (woodland < 0.35) continue;
    candidates++;
    const surroundings = [
      [-80, 0],
      [80, 0],
      [0, -80],
      [0, 80],
    ].map(([ox, oz]) => column(x + ox, z + oz).top);
    const contrast = Math.max(...surroundings) - Math.min(...surroundings);
    const water = surroundings.some((height) => height <= waterLevel);
    const score =
      Math.min(40, contrast) * 0.15 +
      (water ? 5 : 0) +
      woodland * 5 -
      Math.hypot(dx, dz) * 0.38 -
      slope * 1.5;
    if (score > bestScore && accept(point, col)) {
      best = point;
      bestScore = score;
    }
    if (candidates >= 40 && Math.max(Math.abs(dx), Math.abs(dz)) >= 8) break;
  }
  if (best || fallback) return best ?? fallback;
  throw new Error("No safe dry spawn was found near this seed's origin");
}
