import { mix } from "./noise.js";
import { v5Ramp } from "./terrain-v5-biomes.js";

// Versioned operators, not post-generation slope clamps. Regional weights use
// the same 96-block distance-difference support as v5's lift/relief field.
export const V6_COAST = Object.freeze({ ocean: 0.425, land: 0.455 });
export function v6CoastalHeight(continental, ocean, land) {
  return mix(ocean, land, v5Ramp(continental, V6_COAST.ocean, V6_COAST.land));
}

// A continuous terrace transfer retains flat benches and steep risers. The old
// round(h/7)*7 transfer had a jump at every half-period, even inside one biome.
export function v6TerraceHeight(height) {
  const band = Math.floor(height / 7);
  return 7 * (band + v5Ramp(height / 7 - band, 0.3, 0.7));
}
