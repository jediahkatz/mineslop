import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { canOccupy, footprintLoaded } from "../src/mob-navigation.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { Wildlife } from "../src/wildlife.js";
import { World } from "../src/world.js";
import { advance } from "./mob-fixtures.js";

// This generates and streams real chunks in three dimensions, not a flat-world unit fixture.
test("real terrain supports live populations beyond legacy bounds and after dimension recreation", {
  timeout: 15000,
}, async (t) => {
  const world = new World("cedar-valley", { useWorker: false });
  const scene = new THREE.Scene();
  let wildlife;
  const inspect = (label) => {
    assert.ok(wildlife.entities.length > 0, `${label} has an actual ecosystem`);
    assert.ok(wildlife.entities.length <= MAX_MOBS);
    for (const mob of wildlife.entities) {
      assert.ok(
        footprintLoaded(world, mob.position.x, mob.position.z, mob.spec.radius)
      );
      assert.ok(
        canOccupy(
          world,
          mob.position.x,
          mob.position.y,
          mob.position.z,
          mob.spec,
          !!mob.spec.aquatic
        ),
        `${mob.kind} occupies valid terrain`
      );
      assert.ok(mob.position.toArray().every(Number.isFinite));
    }
    t.diagnostic(
      `${label}: ${wildlife.entities.length} live mobs (${[...new Set(wildlife.entities.map((mob) => mob.kind))].join(", ")}), ${world.chunks.size} loaded chunks, one instanced mesh`
    );
  };
  try {
    const start = new THREE.Vector3().copy(world.getSpawn());
    await world.ensureArea(start, 2);
    wildlife = new Wildlife(scene, world);
    advance(wildlife, 8, start, { mode: "creative", timeOfDay: 0.5 });
    inspect("Overworld spawn");
    const original = new Set(wildlife.entities.map((mob) => mob.id));
    const far = new THREE.Vector3(start.x + 256, start.y, start.z - 192);
    await world.ensureArea(far, 2);
    far.y = world.heightAt(Math.floor(far.x), Math.floor(far.z)) + 1.01;
    advance(wildlife, 8, far, { mode: "creative", timeOfDay: 0.5 });
    inspect("Beyond x=256 / negative chunk coordinates");
    assert.ok(wildlife.entities.every((mob) => !original.has(mob.id)));
    assert.ok(wildlife.entities.every((mob) => mob.position.x > 80));
    for (const dimension of ["nether", "end"]) {
      wildlife.dispose();
      world.setDimension(dimension);
      const destination = new THREE.Vector3().copy(world.getSpawn());
      await world.ensureArea(destination, 2);
      wildlife = new Wildlife(scene, world);
      advance(wildlife, 8, destination, { mode: "creative", timeOfDay: 0.5 });
      inspect(dimension);
      assert.ok(
        wildlife.entities.every((mob) => {
          const allowed = mob.spec.dimension;
          return Array.isArray(allowed)
            ? allowed.includes(dimension)
            : allowed === dimension;
        })
      );
    }
  } finally {
    wildlife?.dispose();
    world.dispose();
  }
});
