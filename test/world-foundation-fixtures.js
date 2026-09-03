import { World } from "../src/world.js";
import { getWorldSpec } from "../src/world-spec.js";

/** Empty data fixtures, deliberately not a natural v4 terrain implementation. */
export function emptyFixtureGenerator(seed, dimension, generatorVersion) {
  const spec = getWorldSpec(generatorVersion, dimension);
  return {
    getSpawn: () => ({ x: 0.5, y: spec.minY + 32.01, z: 0.5 }),
    generateChunk: (cx, cz) => ({
      cx,
      cz,
      minY: spec.minY,
      maxY: spec.maxY,
      blocks: new Uint16Array((spec.maxY - spec.minY) * 256),
      biomes: new Uint8Array(256),
    }),
  };
}

export function fixtureWorld(t, options = {}) {
  const world = new World("foundation-fixture", {
    generatorFactory: emptyFixtureGenerator,
    useWorker: false,
    ...options,
  });
  t.after(() => world.dispose());
  return world.generate(0);
}

export const changeCell = (world, x, y, z, after) => ({
  x,
  y,
  z,
  before: world.getCell(x, y, z),
  after,
});
