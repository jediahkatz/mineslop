import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { Fuses } from "../src/fuses.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { Wildlife } from "../src/wildlife.js";
import { entityContext, mobSnapshot } from "./entity-context-fixtures.js";

function savedWorld() {
  const context = entityContext();
  const mobStates = Object.fromEntries(
    ["overworld", "nether", "end"].map((dimension) => [
      dimension,
      mobSnapshot(context, dimension),
    ])
  );
  return {
    world: {
      version: 3,
      seed: context.seed,
      generatorVersion: 4,
      dimension: "overworld",
      edits: [],
    },
    player: { x: 0.5, y: 2_000_000, z: 0.5, yaw: 0, pitch: 0 },
    mobs: structuredClone(mobStates.overworld),
    mobStates,
    fuses: {
      version: 1,
      entries: [
        { dimension: "overworld", x: 0, y: -64, z: 0, remaining: 0.5 },
        { dimension: "nether", x: 0, y: 0, z: 0, remaining: 2 },
        { dimension: "end", x: 0, y: 255, z: 0, remaining: 1 },
      ],
    },
    experienceOrbs: {
      version: 1,
      orbs: [
        { dimension: "overworld", x: 0.5, y: -32.5, z: 0.5, amount: 7 },
        { dimension: "nether", x: 0.5, y: 200, z: 0.5, amount: 9 },
        { dimension: "end", x: 0.5, y: 1000, z: 0.5, amount: 3 },
      ],
    },
  };
}

test("default preflight normalizes all entity dimensions without allocating models or render resources", (t) => {
  const saved = savedWorld();
  const before = structuredClone(saved);
  const forbidden = () =>
    assert.fail("Pure preflight allocated/loaded rendering resources");
  t.mock.method(THREE.BufferGeometry.prototype, "setAttribute", forbidden);
  t.mock.method(THREE.Object3D.prototype, "add", forbidden);
  t.mock.method(Wildlife.prototype, "load", forbidden);
  t.mock.method(Fuses.prototype, "load", forbidden);
  const normalized = normalizeWorldComponents(saved);
  assert.deepEqual(normalized.mobs, saved.mobs);
  assert.deepEqual(normalized.mobStates, saved.mobStates);
  assert.deepEqual(normalized.fuses, saved.fuses);
  assert.deepEqual(
    normalized.experienceOrbs.orbs.map(({ amount }) => amount),
    [7, 9, 3]
  );
  for (const orb of normalized.experienceOrbs.orbs) {
    assert.equal(orb.age, 0);
    assert.equal(orb.pickupDelay, 0);
    assert.deepEqual(orb.velocity, { x: 0, y: 0, z: 0 });
  }
  normalized.mobStates.nether.entities[0].position.y = 0;
  normalized.mobs.entities[0].health = 1;
  normalized.experienceOrbs.orbs[0].velocity.x = 2;
  assert.deepEqual(saved, before);
});

test("preflight rejects every malformed primary or inactive mob snapshot instead of skipping it", () => {
  const badSaves = [];
  for (const dimension of ["overworld", "nether", "end"]) {
    for (const corrupt of [
      (data) => {
        data.seed = "different-seed";
      },
      (data) => {
        data.dimension = dimension === "end" ? "nether" : "end";
      },
      (data) => {
        data.entities[0].yaw = Infinity;
      },
      (data) => {
        data.entities[0].position.y = dimension === "overworld" ? -65 : -1;
      },
      (data) => {
        data.entities[0].position.y = dimension === "overworld" ? 320 : 256;
      },
      (data) => {
        data.entities.push(structuredClone(data.entities[0]));
      },
      (data) => {
        data.entities[0].kind = "unknown";
      },
    ]) {
      const saved = savedWorld();
      corrupt(saved.mobStates[dimension]);
      badSaves.push(saved);
    }
  }
  for (const mobs of [
    null,
    { version: 99 },
    { ...savedWorld().mobs, seed: "wrong" },
  ])
    badSaves.push({ ...savedWorld(), mobs });
  for (const mobStates of [
    null,
    [],
    { moon: savedWorld().mobs },
    { nether: undefined },
  ])
    badSaves.push({ ...savedWorld(), mobStates });
  for (const saved of badSaves)
    assert.throws(() => normalizeWorldComponents(saved), /mob/);
  assert.throws(
    () =>
      normalizeWorldComponents({
        ...savedWorld(),
        mobs: { ...savedWorld().mobs, dimension: "nether" },
      }),
    /mob/,
    "a valid active mobStates copy cannot hide an invalid primary snapshot"
  );
});

test("preflight keeps loose high-flight records distinct from contextual mob and block bounds", () => {
  const saved = savedWorld();
  assert.ok(normalizeWorldComponents(saved));
  saved.experienceOrbs.orbs[1].y = -1;
  assert.throws(
    () => normalizeWorldComponents(saved),
    /experience orbs.*coordinates/
  );
  saved.experienceOrbs.orbs[1].y = 1_000_000;
  assert.ok(normalizeWorldComponents(saved));
  saved.world.generatorVersion = 3;
  assert.throws(() => normalizeWorldComponents(saved), /mob|coordinates/);
  const legacy = {
    ...saved,
    mobs: undefined,
    mobStates: undefined,
    fuses: {
      version: 1,
      entries: [{ dimension: "overworld", x: 0, y: 96, z: 0, remaining: 1 }],
    },
    experienceOrbs: undefined,
  };
  assert.throws(
    () => normalizeWorldComponents(legacy),
    /explosives.*coordinates/
  );
  legacy.fuses.entries[0].y = 0;
  assert.throws(
    () => normalizeWorldComponents(legacy),
    /explosives.*coordinates/
  );
});
