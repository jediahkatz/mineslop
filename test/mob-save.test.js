import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeMobSnapshot } from "../src/mob-save.js";
import { MAX_KILLED_MOBS, MAX_MOBS, MOB_SPECIES } from "../src/mob-species.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { isWorldPose } from "../src/world-spec.js";
import {
  entityContext,
  mobRecord,
  mobSnapshot,
} from "./entity-context-fixtures.js";

test("mob snapshots use each dimension's complete species collider, not player flight bounds", () => {
  for (const version of [1, 2, 3, 4]) {
    const context = entityContext(version);
    for (const dimension of ["overworld", "nether", "end"]) {
      const entry = mobRecord(context, dimension);
      const spec = MOB_SPECIES[entry.kind];
      const bounds = context.specForDimension(dimension);
      for (const y of [bounds.minY, bounds.maxY - spec.height]) {
        const saved = mobSnapshot(context, dimension, [
          {
            ...entry,
            position: { x: 0.5, y, z: 0.5 },
          },
        ]);
        assert.ok(
          normalizeMobSnapshot(saved, context, dimension),
          `${version}/${dimension}/${y}`
        );
      }
      for (const position of [
        { x: 0.5, y: bounds.minY - 0.01, z: 0.5 },
        { x: 0.5, y: bounds.maxY - spec.height + 0.01, z: 0.5 },
        { x: WORLD_MIN + spec.radius - 0.01, y: bounds.minY + 1, z: 0.5 },
        { x: WORLD_MAX - spec.radius + 0.01, y: bounds.minY + 1, z: 0.5 },
        { x: 0.5, y: 1_000_000, z: 0.5 },
      ]) {
        assert.equal(
          normalizeMobSnapshot(
            mobSnapshot(context, dimension, [{ ...entry, position }]),
            context
          ),
          null
        );
      }
      assert.equal(
        isWorldPose({ x: 0.5, y: 1_000_000, z: 0.5 }, context, dimension),
        true
      );
    }
  }
});

test("every supported species retains its own health, dimension and pose constraints", () => {
  const context = entityContext();
  for (const [kind, spec] of Object.entries(MOB_SPECIES)) {
    for (const dimension of ["overworld", "nether", "end"]) {
      const entry = mobRecord(context, dimension, {
        kind,
        health: spec.health,
        attackCooldown: spec.cooldown,
      });
      const allowed = Array.isArray(spec.dimension)
        ? spec.dimension
        : [spec.dimension];
      assert.equal(
        normalizeMobSnapshot(
          mobSnapshot(context, dimension, [entry]),
          context
        ) !== null,
        allowed.includes(dimension),
        `${kind}/${dimension}`
      );
    }
  }
});

test("malformed state, unsupported fields and wrong-world identities reject the complete snapshot", () => {
  const context = entityContext();
  const saved = mobSnapshot(context);
  const entry = saved.entities[0];
  for (const patch of [
    { id: "" },
    { id: "x".repeat(101) },
    { id: 1 },
    { kind: "toString" },
    { kind: "missing" },
    { kind: "ghast" },
    { kind: ["sheep"] },
    { health: 0 },
    { health: -1 },
    { health: Infinity },
    { health: entry.health + 1 },
    { yaw: NaN },
    { yaw: "0" },
    { tamed: 1 },
    { tamed: true },
    { angry: -0.1 },
    { angry: 21 },
    { angry: Infinity },
    { attackCooldown: -1 },
    { attackCooldown: MOB_SPECIES.sheep.cooldown + 0.01 },
    { fuse: 1.66 },
    { fuse: NaN },
    { pacified: -1 },
    { pacified: 61 },
    { absorbedBlock: BLOCK.STONE },
    { position: { x: NaN, y: -5, z: 0 } },
    { position: { x: 0, y: -5, z: 0, dimension: "nether" } },
    { state: { position: { x: 0, y: Infinity, z: 0 } } },
  ]) {
    assert.equal(
      normalizeMobSnapshot(
        {
          ...saved,
          entities: [
            { ...entry, id: "valid-first" },
            { ...entry, ...patch },
          ],
        },
        context
      ),
      null,
      JSON.stringify(patch)
    );
  }
  for (const data of [
    null,
    [],
    {},
    { ...saved, version: 2 },
    { ...saved, seed: "another-world" },
    { ...saved, dimension: "moon" },
    { ...saved, dimension: "nether" },
    { ...saved, randomState: -1 },
    { ...saved, randomState: 0x1_0000_0000 },
    { ...saved, randomState: 1.5 },
    { ...saved, randomState: Infinity },
    { ...saved, nextId: -1 },
    { ...saved, nextId: Number.MAX_SAFE_INTEGER },
    { ...saved, nextId: 0.5 },
    { ...saved, entities: [null] },
    { ...saved, entities: new Array(1) },
    { ...saved, killed: new Array(1) },
    { ...saved, killed: [entry.id] },
    { ...saved, killed: ["dead", "dead"] },
    { ...saved, entities: [entry, entry] },
    { ...saved, projectiles: [] },
  ]) {
    assert.equal(normalizeMobSnapshot(data, context, "overworld"), null);
  }
  assert.equal(
    normalizeMobSnapshot(saved, {
      ...context,
      generatorVersion: 99,
      specForDimension: undefined,
    }),
    null
  );
  assert.equal(normalizeMobSnapshot(saved, context, "end"), null);
});

test("saved live mobs, killed identities and tamed companions have independent bounded capacities", () => {
  const context = entityContext();
  const saved = mobSnapshot(context);
  const entries = Array.from({ length: MAX_MOBS }, (_, i) =>
    mobRecord(context, "overworld", { id: `mob:${i}` })
  );
  const killed = Array.from({ length: MAX_KILLED_MOBS }, (_, i) => `dead:${i}`);
  assert.ok(
    normalizeMobSnapshot({ ...saved, entities: entries, killed }, context)
  );
  assert.equal(
    normalizeMobSnapshot(
      { ...saved, entities: [...entries, { ...entries[0], id: "overflow" }] },
      context
    ),
    null
  );
  assert.equal(
    normalizeMobSnapshot(
      { ...saved, killed: [...killed, "overflow"] },
      context
    ),
    null
  );
  const wolves = Array.from({ length: 4 }, (_, i) =>
    mobRecord(context, "overworld", {
      id: `pet:${i}`,
      kind: "wolf",
      tamed: true,
    })
  );
  assert.ok(normalizeMobSnapshot({ ...saved, entities: wolves }, context));
  assert.equal(
    normalizeMobSnapshot(
      { ...saved, entities: [...wolves, { ...wolves[0], id: "pet:4" }] },
      context
    ),
    null
  );
});

test("canonical mob snapshots are detached, idempotent and lossless for supported state", () => {
  const context = entityContext();
  const saved = mobSnapshot(context, "overworld", [
    mobRecord(context, "overworld", {
      id: "pet",
      kind: "wolf",
      tamed: true,
      health: 7.5,
      angry: 12,
      attackCooldown: 1,
      pacified: 22,
      yaw: 19,
    }),
    mobRecord(context, "overworld", {
      id: "cube",
      kind: "sulfur_cube",
      absorbedBlock: BLOCK.TNT,
      position: { x: -29_000_000.25, y: -30.5, z: 29_000_000.25 },
    }),
  ]);
  saved.killed = ["authored:old", "overworld:local:99"];
  const before = structuredClone(saved);
  const normalized = normalizeMobSnapshot(saved, context);
  assert.ok(normalized);
  assert.deepEqual(saved, before);
  assert.deepEqual(normalizeMobSnapshot(normalized, context), normalized);
  assert.equal(normalized.entities[1].absorbedBlock, BLOCK.TNT);
  assert.equal(normalized.entities[0].health, 7.5);
  assert.ok(Math.abs(normalized.entities[0].yaw) <= Math.PI);
  saved.entities[1].position.y = 300;
  saved.killed.push("new");
  assert.equal(normalized.entities[1].position.y, -30.5);
  assert.deepEqual(normalized.killed, before.killed);
  const oldCube = mobRecord(context, "overworld", { kind: "sulfur_cube" });
  assert.equal(
    normalizeMobSnapshot(mobSnapshot(context, "overworld", [oldCube]), context)
      .entities[0].absorbedBlock,
    null
  );
});
