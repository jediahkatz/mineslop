import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { normalizeMobSnapshot } from "../src/mob-save.js";
import { Wildlife } from "../src/wildlife.js";
import { entityWorld } from "./entity-context-fixtures.js";

const wildlifeFor = (t, world) => {
  const wildlife = new Wildlife(new THREE.Scene(), world, {
    context: world.context,
    autoSpawn: false,
  });
  t.after(() => wildlife.dispose());
  return wildlife;
};

test("signed and tall dimension mob snapshots load completely, including dormant mobs", (t) => {
  for (const [dimension, floor, kind] of [
    ["overworld", -32, "sheep"],
    ["nether", 150, "piglin"],
    ["end", 200, "enderman"],
  ]) {
    const world = entityWorld({ dimension, floor });
    const wildlife = wildlifeFor(t, world);
    const mob = wildlife.spawn(kind, { x: 3.5, y: floor + 1, z: 3.5 });
    assert.ok(mob, dimension);
    const saved = wildlife.serialize();
    assert.deepEqual(normalizeMobSnapshot(saved, world.context), saved);
    const restoredWorld = entityWorld({ dimension, floor });
    restoredWorld.loaded = () => false;
    const restored = wildlifeFor(t, restoredWorld);
    assert.equal(restored.load(saved), true);
    assert.deepEqual(restored.serialize(), saved);
    assert.equal(restored.entities.length, 1);
    assert.equal(restored.entities[0].dormant, true);
    assert.equal(restored.byId.get(mob.id), restored.entities[0]);
  }
});

test("all records are validated before models allocate or the live ecosystem changes", (t) => {
  const world = entityWorld({ floor: -12 });
  const wildlife = wildlifeFor(t, world);
  const original = wildlife.spawn("sheep", { x: 3, y: -11, z: 3 });
  const saved = wildlife.serialize();
  let allocations = 0;
  t.mock.method(wildlife, "_createEntity", () => {
    allocations++;
    throw new Error("model allocation failed");
  });
  const corrupt = {
    ...saved,
    entities: [
      ...saved.entities,
      { ...saved.entities[0], id: "invalid-late", yaw: NaN },
    ],
  };
  assert.equal(wildlife.load(corrupt), false);
  assert.equal(allocations, 0);
  assert.deepEqual(wildlife.serialize(), saved);
  assert.equal(original.dead, false);
  assert.throws(() => wildlife.load(saved), /model allocation failed/);
  assert.equal(allocations, 1);
  assert.deepEqual(wildlife.serialize(), saved);
  assert.equal(original.dead, false);
});

test("high-flight players retain spawn protection while mobs remain inside species build bounds", (t) => {
  const world = entityWorld({ floor: -12 });
  const wildlife = wildlifeFor(t, world);
  const player = { x: 2.5, y: 1_000_000, z: 2.5 };
  assert.equal(wildlife.protectSpawn(player), true);
  wildlife.update(0, 0, player, { mode: "survival", timeOfDay: 0 });
  assert.equal(wildlife.player.y, player.y);
  assert.equal(wildlife.spawn("sheep", player, { restoring: true }), null);
  assert.equal(wildlife.protectSpawn({ ...player, y: -129 }), false);
  assert.equal(
    wildlife.spawn("sheep", { ...player, y: -65 }, { restoring: true }),
    null
  );
});

test("projectile bounds use the active dimension below zero and above historical height", (t) => {
  for (const [dimension, floor, kind, y] of [
    ["overworld", -32, "skeleton", -31],
    ["nether", 150, "ghast", 200],
  ]) {
    const world = entityWorld({ dimension, floor });
    const wildlife = wildlifeFor(t, world);
    const shooter = wildlife.spawn(kind, { x: 0.5, y, z: 0.5 });
    assert.ok(shooter);
    wildlife.update(
      0,
      0,
      { x: 15.5, y, z: 0.5 },
      { mode: "survival", timeOfDay: 0 }
    );
    wildlife.shoot(shooter);
    assert.equal(wildlife.projectiles.length, 1);
    wildlife.updateProjectiles(0.01);
    assert.equal(wildlife.projectiles.length, 1, dimension);
    assert.ok(
      wildlife.projectiles[0].position.toArray().every(Number.isFinite)
    );
  }
});

test("natural population accepts signed modern surfaces including a real cell at minus one", (t) => {
  for (const floor of [-12, -1]) {
    const world = entityWorld({ floor });
    const wildlife = wildlifeFor(t, world);
    wildlife.update(
      0,
      0,
      { x: 0.5, y: floor + 1, z: 0.5 },
      {
        mode: "creative",
        timeOfDay: 0.5,
      }
    );
    wildlife.populate();
    assert.ok(wildlife.entities.length > 0);
    assert.ok(wildlife.entities.every((mob) => mob.position.y === floor + 1));
    assert.ok(normalizeMobSnapshot(wildlife.serialize(), world.context));
  }
});

test("restored local identity collisions never overwrite a retained mob or killed record", (t) => {
  const world = entityWorld({ floor: -12 });
  const wildlife = wildlifeFor(t, world);
  const first = wildlife.spawn(
    "sheep",
    { x: 2.5, y: -11, z: 2.5 },
    {
      id: "overworld:local:0",
    }
  );
  wildlife.rememberKilled("overworld:local:1");
  const saved = wildlife.serialize();
  assert.equal(
    saved.nextId,
    0,
    "authored IDs do not consume the local counter"
  );
  assert.equal(wildlife.load(saved), true);
  const next = wildlife.spawn("sheep", { x: 5.5, y: -11, z: 2.5 });
  assert.equal(next.id, "overworld:local:2");
  assert.ok(wildlife.byId.has(first.id));
  assert.equal(wildlife.killed.has("overworld:local:1"), true);
  assert.equal(wildlife.serialize().nextId, 3);
});
