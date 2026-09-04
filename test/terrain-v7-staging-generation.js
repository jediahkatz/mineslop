import { check } from "./terrain-v7-browser-contract.js";

// Frozen cedar-valley staging contract: new worlds synchronously prepare the
// radius-one spawn footprint (9 chunks); saved poses skip World.getSpawn().
// This is an exact allowance, never a measured baseline that could hide fallback.
export function checkStagingGeneration(world, isSaved) {
  const spawnChunks = isSaved ? 0 : 9;
  const mainThreadChunks = world.generator.counters?.chunkGenerations ?? null;
  check(world.generatorVersion < 4 || mainThreadChunks !== null, "staging generation counters required");
  if (mainThreadChunks !== null)
    check(mainThreadChunks === spawnChunks, "no silent staging fallback beyond intentional spawn");
  check(world._nextRequestId === 49 - spawnChunks, "only remaining staging chunks are queued");
  check(world._requests.size === 0 && world._inFlight.size === 0, "all staging requests completed");
  return { spawnChunks, mainThreadChunks, queuedChunks: world._nextRequestId };
}
