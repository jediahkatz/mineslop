import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { ENDERMAN_LIMITS } from "../src/enderman.js";
import { stepMob } from "../src/mob-ai.js";
import { MOB_SPECIES } from "../src/mob-species.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { Wildlife } from "../src/wildlife.js";
import { World } from "../src/world.js";
import { endermanImportHarness } from "./enderman-save-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { ecosystem, flatWorld } from "./mob-fixtures.js";

async function endermanArchive(t) {
  const f = await gameMobFixture(t);
  for (const [index, attackCooldown] of [0, 0.1, ENDERMAN_LIMITS.recovery, MOB_SPECIES.enderman.cooldown].entries()) {
    const mob = f.wildlife.spawn("enderman", { x: 3.5 + index * 3, y: 65, z: 3.5 }, {
      id: `enderman:restore:${index}`,
    });
    assert.ok(mob);
    Object.assign(mob, { attackCooldown, angry: 19 - index, health: 28 + index });
    mob.root.rotation.y = 0.2 * index;
  }
  return { f, saved: f.snapshot() };
}

function traceRestore(t) {
  const records = [];
  const load = Wildlife.prototype.load;
  t.mock.method(Wildlife.prototype, "load", function (saved, ...args) {
    const result = load.call(this, saved, ...args);
    if (result && saved) {
      const actual = this.serialize();
      const differences = saved.entities.flatMap((expected) => {
        const restored = actual.entities.find((entry) => entry.id === expected.id);
        return Object.keys(expected).filter((key) =>
          JSON.stringify(expected[key]) !== JSON.stringify(restored?.[key])
        ).map((field) => ({ id: expected.id, field, expected: expected[field], actual: restored?.[field] }));
      });
      records.push({ expected: structuredClone(saved), actual, differences });
      t.diagnostic(JSON.stringify({ detachedRestoreDifferences: differences }));
    }
    return result;
  });
  return records;
}

test("real detached Game restore preserves every serialized Enderman field before canonical adoption", async (t) => {
  const { saved } = await endermanArchive(t);
  const original = structuredClone(saved), records = traceRestore(t);
  const restored = await gameMobFixture(t, { saved });
  assert.equal(records.length, 1, "one detached base load, never a retry");
  assert.deepEqual(records[0].differences, []);
  assert.deepEqual(restored.wildlife.serialize(), saved.mobs);
  for (const mob of restored.wildlife.entities) {
    assert.equal(mob.restoreAttackCooldown, ENDERMAN_LIMITS.recovery);
    assert.equal(Object.hasOwn(saved.mobs.entities.find((entry) => entry.id === mob.id), "restoreAttackCooldown"), false);
  }
  assert.equal(restored.wildlife.ecologyServices, restored.ecology);
  assert.equal(restored.wildlife.horseServices, restored.horses);
  assert.deepEqual(saved, original);
  assert.deepEqual(normalizeWorldComponents(parseWorldFile(exportWorldFile(restored.snapshot()))).mobs, saved.mobs);
});

test("post-load melee safety is transient, respects longer saved cooldowns, and freezes while dormant", (t) => {
  for (const attackCooldown of [0, 0.1, ENDERMAN_LIMITS.recovery, MOB_SPECIES.enderman.cooldown]) {
    const world = flatWorld(), hits = [];
    const wildlife = ecosystem(world, { onDamage: (...args) => { hits.push(args); return { health: 20 }; } });
    t.after(() => wildlife.dispose());
    const original = wildlife.spawn("enderman", { x: 2, y: 9, z: 0.5 });
    Object.assign(original, { attackCooldown, angry: 19 });
    const saved = wildlife.serialize();
    assert.equal(wildlife.load(saved), true);
    const mob = wildlife.byId.get(original.id);
    assert.deepEqual(wildlife.serialize(), saved);
    const step = () => wildlife.update(0.05, wildlife.clock + 0.05, new THREE.Vector3(0.5, 9, 0.5), {
      mode: "survival", health: 20, timeOfDay: 0.5,
      playerEye: new THREE.Vector3(0.5, 10.62, 0.5), playerForward: new THREE.Vector3(-1, 0, 0),
    });
    mob.dormant = true;
    stepMob(mob, 0.05, wildlife.context);
    assert.equal(mob.restoreAttackCooldown, ENDERMAN_LIMITS.recovery);
    assert.equal(mob.attackCooldown, attackCooldown);
    mob.dormant = false;
    const delay = Math.max(attackCooldown, ENDERMAN_LIMITS.recovery);
    for (let i = 0; i < Math.ceil(delay / 0.05) - 1; i++) step();
    assert.equal(hits.length, 0, `cannot attack before ${delay} seconds`);
    step();
    step();
    assert.equal(hits.length, 1, "melee resumes after both independent cooldowns");
    assert.equal(world.unloadedReads, 0);
    assert.equal(Object.hasOwn(wildlife.serialize().entities[0], "restoreAttackCooldown"), false);
  }
});

for (const legacy of [false, true]) {
  test(`real Game import stages and adopts ${legacy ? "legacy mobs-only" : "canonical"} Endermen with exact roundtrip`, async (t) => {
    const { f, saved } = await endermanArchive(t);
    if (legacy) {
      for (const key of ["ecology", "horses", "mobStates", "mobsByDimension"]) delete saved[key];
    }
    const expected = normalizeWorldComponents(saved), text = exportWorldFile(saved);
    const { writes, stages } = endermanImportHarness(t, f);
    const records = traceRestore(t);
    const result = await f.game.importWorld({ size: Buffer.byteLength(text), text: async () => text });
    assert.equal(result.ok, true, result.message);
    assert.equal(stages.length, 1);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].differences, []);
    assert.equal(f.game.wildlife, stages[0].mobIntegration.wildlife);
    assert.equal(f.game.wildlife.ecologyServices, f.game.ecologyServices);
    assert.equal(writes.length, 2, "checkpoint the old world and persist the imported one");
    assert.deepEqual(writes[1].mobs, expected.mobs);
    assert.deepEqual(normalizeWorldComponents(parseWorldFile(exportWorldFile(writes[1]))).mobs, expected.mobs);
    assert.deepEqual(f.game.wildlife.serialize(), expected.mobs);
    assert.deepEqual(saved.mobs, expected.mobs, "import never rewrites the input base");
  });
}

test("real import rolls back candidate owners on a conflicting restored base without weakening adoption", async (t) => {
  const { f, saved } = await endermanArchive(t);
  const before = f.ownership(), liveWorld = f.world, liveWildlife = f.wildlife;
  const { writes, stages } = endermanImportHarness(t, f);
  const disposed = [];
  const dispose = World.prototype.dispose;
  t.mock.method(World.prototype, "dispose", function (...args) {
    const result = dispose.apply(this, args);
    if (this !== liveWorld) disposed.push(this);
    return result;
  });
  const load = Wildlife.prototype.load;
  t.mock.method(Wildlife.prototype, "load", function (...args) {
    const result = load.apply(this, args);
    if (result && this !== liveWildlife) this.entities[0].attackCooldown += 0.01;
    return result;
  });
  const text = exportWorldFile(saved);
  const result = await f.game.importWorld({ size: Buffer.byteLength(text), text: async () => text });
  assert.equal(result.ok, false);
  assert.match(result.message, /Ecology cannot adopt the already-restored Wildlife/);
  assert.equal(stages.length, 0, "a rejected detached candidate never reaches installation");
  assert.equal(disposed.length, 1);
  assert.equal(disposed[0]._disposed, true);
  assert.equal(disposed[0].coordinator.budget.totalBytes, 0);
  assert.equal(writes.length, 1, "only the unchanged live checkpoint may be persisted");
  assert.equal(f.game.world, liveWorld);
  assert.equal(f.game.wildlife, liveWildlife);
  assert.equal(f.game.building, false);
  assert.deepEqual(f.ownership(), before);
});

// Optional local acceptance input is read-only and not a dependency of the
// permanent generated-archive regression above.
if (process.env.MINESLOP_ENDERMAN_IMPORT_FIXTURE) {
  test("the UI-exported Survival archive adopts without changing the supplied file or mob projection", async (t) => {
    const path = process.env.MINESLOP_ENDERMAN_IMPORT_FIXTURE;
    const text = readFileSync(path, "utf8"), saved = parseWorldFile(text);
    const expected = normalizeWorldComponents(saved);
    assert.ok(expected.mobs.entities.some((mob) => mob.kind === "enderman" && mob.attackCooldown === 0));
    const f = await gameMobFixture(t);
    const { writes, stages } = endermanImportHarness(t, f);
    const records = traceRestore(t);
    const result = await f.game.importWorld({ size: Buffer.byteLength(text), text: async () => text });
    assert.equal(result.ok, true, result.message);
    assert.equal(stages.length, 1);
    assert.deepEqual(records.flatMap((entry) => entry.differences), []);
    assert.deepEqual(f.game.wildlife.serialize(), expected.mobs);
    assert.deepEqual(writes[1].mobs, expected.mobs);
    if (Object.hasOwn(saved, "weather")) assert.deepEqual(writes[1].weather, saved.weather);
    assert.equal(readFileSync(path, "utf8"), text);
  });
}
