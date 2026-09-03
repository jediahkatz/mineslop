import { GENERATOR_VERSION } from "./terrain.js";
import { createWorldContext } from "./world-spec.js";

/** Detached all-dimension bounds, including for legacy physics-only callers. */
export function entityContextFor(world, context = world) {
  if (typeof context?.specForDimension === "function") return context;
  return createWorldContext({
    seed: context?.seed ?? world?.seed,
    generatorVersion:
      context?.generatorVersion ?? world?.generatorVersion ?? GENERATOR_VERSION,
  });
}

export function matchesEntityContext(world, context) {
  return (
    !!world &&
    !world._disposed &&
    (context?.seed === undefined ||
      world.seed === undefined ||
      String(context.seed) === String(world.seed)) &&
    (context?.generatorVersion === undefined ||
      world.generatorVersion === undefined ||
      context.generatorVersion === world.generatorVersion)
  );
}

/** Pin world/context identity while a prepared ownership transfer is detached. */
export function captureEntityContext(world, context) {
  const seed = world?.seed;
  const generatorVersion = world?.generatorVersion;
  const dimension = world?.dimension;
  const epoch = world?.epoch ?? world?._epoch;
  const coordinator = world?.coordinator;
  const contextSeed = context?.seed;
  const contextVersion = context?.generatorVersion;
  const specForDimension = context?.specForDimension;
  return () =>
    context?.seed === contextSeed &&
    context?.generatorVersion === contextVersion &&
    context?.specForDimension === specForDimension &&
    (!world ||
      (matchesEntityContext(world, context) &&
        world.seed === seed &&
        world.generatorVersion === generatorVersion &&
        world.dimension === dimension &&
        world.coordinator === coordinator &&
        (world.epoch ?? world._epoch) === epoch));
}
