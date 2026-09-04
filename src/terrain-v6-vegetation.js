import { BIOME_PROFILES, getBiomeById } from "./biomes.js";
import { hash } from "./noise.js";
import { createV4Vegetation, v4ForestDensity } from "./terrain-v4-vegetation.js";

function speciesFor(id) {
  const profile = BIOME_PROFILES[id];
  return {
    tree: profile.tree ?? (getBiomeById(id).category === "grassland" ? "oak" : null),
    density: profile.tree ? profile.density : getBiomeById(id).category === "grassland" ? 0.035 : 0,
  };
}

/**
 * A separate population policy, never a material/profile mutation. Interpolate
 * density over the bounded regional support, then sample species in proportion
 * to its population mass. Use a separate deterministic channel for species so
 * the tree-presence roll is not correlated with a particular species.
 *
 * Shore, river, ocean, mountain/rare overrides retain their explicit biome
 * policy. Their substrate/water/treeline eligibility remains authoritative.
 */
export function v6VegetationColumn(col, salt, dimension = "overworld") {
  if (!col || dimension !== "overworld" ||
    !col.woodland?.some((entry) => entry.id === col.id)) return col;
  const choices = col.woodland.map(({ id, weight }) => {
    const { tree, density } = speciesFor(id);
    return { tree, mass: weight * density };
  });
  const density = choices.reduce((total, entry) => total + entry.mass, 0);
  let remaining = hash(col.x, col.z, salt ^ 58543) * density;
  let tree = null;
  for (const entry of choices) {
    if (entry.mass <= 0) continue;
    tree = entry.tree;
    remaining -= entry.mass;
    if (remaining < 0) break;
  }
  return { ...col, profile: { ...col.profile, tree, density } };
}

export function v6ForestDensity(col, salt, dimension = "overworld") {
  return v4ForestDensity(v6VegetationColumn(col, salt, dimension), salt, dimension);
}

// Mesh parts, owner anchors, eligibility and ground cover are frozen v4
// behavior. Only the columns seen by tree population selection are adapted.
export function createV6Vegetation(context) {
  return createV4Vegetation({
    ...context,
    sampleColumn: (x, z) =>
      v6VegetationColumn(context.sampleColumn(x, z), context.salt, context.dimension),
  });
}
