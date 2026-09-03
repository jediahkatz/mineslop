import {
  columnLoaded,
  geometryWorldSpec,
  readGeometryCell,
} from "./geometry-world.js";

/**
 * Bounded read-only compatibility view for Player/Atmosphere's historical
 * physics-only callers. Real World cells, signed specs and unloaded coverage
 * still come from the shared geometry adapters; no generator or cache is used.
 * Retain one view per consumer, replacing it when its World identity changes.
 */
export function createFluidQueryView(source = {}) {
  source ??= {};
  return Object.freeze({
    get dimension() {
      return source.dimension ?? "overworld";
    },
    get generatorVersion() {
      return source.generatorVersion ?? 3;
    },
    get spec() {
      return geometryWorldSpec(source);
    },
    isLoaded: (x, z) => columnLoaded(source, x, z),
    getCell: (x, y, z) => readGeometryCell(source, x, y, z),
  });
}
