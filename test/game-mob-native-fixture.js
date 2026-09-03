import assert from "node:assert/strict";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { World } from "../src/world.js";
import { admitNativeStructure, nativeExplorationSite } from "./exploration-services-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

/**
 * First native match in the existing bounded three-seed/four-window search.
 * The actual Game resident index, not a test marker map, supplies every marker.
 * Finite inventory and the player's approach are authored test prerequisites.
 */
export async function nativeGameMobs(t, kind = "village", generatorVersion = 4) {
  const dimension = kind === "nether_fortress" ? "nether" : "overworld";
  let world, descriptor;
  for (const seed of ["cedar-valley", "tidal-archive", "basalt-crossing"]) {
    world = new World(seed, { dimension, generatorVersion, useWorker: false });
    try { descriptor = nativeExplorationSite(world, kind, "", false); }
    catch (error) { world.dispose(); throw error; }
    if (descriptor) break;
    world.dispose();
  }
  assert.ok(descriptor, `Required native ${kind} is absent from the fixed search budget`);
  try { await admitNativeStructure(world, descriptor); }
  catch (error) { world.dispose(); throw error; }
  const entry = descriptor.entries[0];
  const f = await gameMobFixture(t, {
    world, generatorFactory: null,
    spawnPosition: { x: entry.x + 0.5, y: entry.y, z: entry.z + 0.5 },
    autoSpawn: true, admissionRadius: 3,
  });
  const canonical = f.mobs.markers.getStructure(descriptor.id);
  assert.ok(canonical, "the real resident index must admit the transported canonical descriptor");
  const transported = [...world.chunks.values()]
    .flatMap((chunk) => chunk.structures ?? []).find((entry) => entry.id === descriptor.id);
  assert.deepEqual(canonical, transported);
  for (const key of Object.keys(descriptor))
    assert.deepEqual(canonical[key], descriptor[key], `canonical native ${key}`);
  assert.equal(Object.isFrozen(canonical), true);
  f.descriptor = canonical;
  t.diagnostic(JSON.stringify({
    nativeGameEcology: kind, seed: world.seed, generatorVersion, id: canonical.id,
    admittedChunks: world.chunks.size,
  }));
  return f;
}

/** Bounded loaded/clear standing and precise physical-ray acquisition, not a hit mock. */
export function approachGameMob(f, mob) {
  for (const radius of [2, 1.5, 2.5])
    for (let direction = 0; direction < 8; direction++)
      for (const y of [Math.floor(mob.position.y), Math.floor(mob.position.y) - 1]) {
        const angle = direction * Math.PI / 4;
        const at = {
          x: mob.position.x + Math.sin(angle) * radius, y,
          z: mob.position.z + Math.cos(angle) * radius,
        };
        if (!isSafeRespawnPosition(f.world, at)) continue;
        f.player.setPosition(at);
        f.aim(mob);
        if (f.game.mobActions.capture(mob)) return at;
      }
  assert.fail(`No clear physical interaction in 48 bounded approach candidates for ${mob.id}`);
}
