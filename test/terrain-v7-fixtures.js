export const v7Context = (generator) => ({
  seed: generator.seed, generatorVersion: 7, dimension: generator.dimension,
  spec: generator.spec, sampleColumn: generator.sampleColumn,
});
export const v7Job = (generator, cx, cz) => ({
  type: "generate", schemaVersion: 2, id: 7, epoch: 3, seed: generator.seed,
  dimension: generator.dimension, generatorVersion: generator.generatorVersion,
  minY: generator.minY, maxY: generator.maxY, cx, cz,
});
