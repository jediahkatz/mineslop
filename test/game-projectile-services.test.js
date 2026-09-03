import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { GameTravel } from "../src/game-travel.js";
import { getItem, ITEM } from "../src/items.js";
import { MAX_PEARL_ID } from "../src/pearl-save.js";
import { collidesWithWorld } from "../src/player.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import {
  finishPearlFlight,
  projectileHostFixture,
} from "./game-projectile-fixture.js";

function nextImpact(fixture) {
  const { service } = fixture;
  const id = service.projectiles.projectiles[0]?.id;
  assert.ok(id, "a real held-item throw must already exist");
  for (let tick = 0; tick < 20; tick++) {
    const plan = service.projectiles.prepareImpactTransaction(id);
    if (plan) return plan;
    service.frame(0.05);
  }
  assert.fail("the authored room must admit an actual next-tick swept impact");
}

test("staging owns a bounded empty pool without binding Game or allocating render resources", async (t) => {
  const f = await projectileHostFixture(t, { activate: false });
  const children = f.scene.children.length;
  assert.equal(f.service.projectiles.staged, true);
  assert.equal(f.service.game, null);
  assert.equal(f.game.projectileServices, undefined);
  assert.equal(f.service.renderer, null);
  assert.equal(f.service.throw(), false);
  assert.equal(f.service.frame(0.1), false);
  assert.equal(f.scene.children.length, children);
  assert.equal(f.service.serialize().playerProjectiles.projectiles.length, 0);
  assert.equal(f.service.activate(f.game).ok, true);
  assert.equal(f.game.projectiles, f.service.projectiles);
  assert.equal(
    f.service.activate(f.game).ok,
    true,
    "same-host activation is idempotent"
  );
  assert.equal(f.service.renderer, null);
  const before = f.service.serialize();
  const revision = f.service.projectiles.revision;
  for (let frame = 0; frame < 120; frame++) {
    assert.equal(f.service.frame(1 / 60), true);
    assert.equal(f.service.render(), true);
  }
  assert.equal(
    f.service.projectiles.revision,
    revision,
    "no dormant frame transactions"
  );
  assert.deepEqual(f.service.serialize(), before);
  assert.equal(f.scene.children.length, children);
});

test("real use dispatch spends one pearl, sweeps flight, teleports and reports exactly five lost HP", async (t) => {
  const f = await projectileHostFixture(t);
  const start = f.player.position.clone();
  const heading = [f.player.yaw, f.player.pitch];
  assert.equal(f.game.useActions.begin("mouse"), true);
  assert.equal(f.gameplay.getHandStack().count, 5);
  assert.equal(f.service.projectiles.size, 1);
  assert.equal(f.service.projectiles.cooldown, 1);
  assert.equal(f.service.renderer.pearls.count, 1);
  assert.deepEqual(f.service.projectiles.projectiles[0].position, {
    x: start.x,
    y: start.y + f.player.eyeHeight,
    z: start.z,
  });
  assert.equal(
    f.gameplay.health,
    20,
    "the throw itself does not teleport or hurt"
  );
  assert.ok(f.player.position.equals(start));
  finishPearlFlight(f);
  assert.ok(f.player.position.distanceTo(start) > 1);
  assert.equal(
    collidesWithWorld(f.world, f.player.position, f.player.height),
    false
  );
  assert.equal(f.gameplay.health, 15);
  assert.equal(f.observed.hurt.length, 1);
  assert.equal(f.observed.hurt[0].damage, 5);
  assert.deepEqual([f.player.yaw, f.player.pitch], heading);
  assert.deepEqual(f.player.velocity.toArray(), [0, 0, 0]);
  assert.equal(f.player.fallDistance, 0);
  assert.equal(f.player._jumpQueued, false);
  assert.equal(f.service.renderer.pearls.visible, false);
  assert.equal(
    f.player.eyePosition.y,
    f.player.position.y + f.player.eyeHeight
  );
  assert.ok(
    f.observed.saves > 0 && f.observed.hud > 0 && f.observed.targets > 0
  );
});

test("both hands share the same cooldown and Creative retains supplies and health", async (t) => {
  const f = await projectileHostFixture(t, { mode: "creative" });
  const main = f.gameplay.getHandStack();
  const off = f.gameplay.getHandStack("offhand");
  assert.equal(f.service.throw("offhand"), true);
  assert.deepEqual(f.gameplay.getHandStack("offhand"), off);
  assert.equal(f.service.throw("main"), false);
  assert.deepEqual(f.gameplay.getHandStack(), main);
  assert.equal(f.service.projectiles.size, 1);
  finishPearlFlight(f);
  assert.equal(f.gameplay.health, 20);
  assert.equal(f.observed.hurt.length, 0);
  assert.equal(f.observed.death, 0);
});

test("pearl impact bypasses actual armor and a charged shield without spending their durability", async (t) => {
  const f = await projectileHostFixture(t);
  const equipment = {
    head: ITEM.IRON_HELMET,
    chest: ITEM.IRON_ARMOR,
    legs: ITEM.IRON_LEGGINGS,
    feet: ITEM.IRON_BOOTS,
  };
  assert.equal(
    f.gameplay.inventoryTransaction((owned) => {
      for (const [slot, id] of Object.entries(equipment))
        owned.equipment[slot] = {
          id,
          count: 1,
          durability: getItem(id).durability,
        };
      owned.offhand = {
        id: ITEM.SHIELD,
        count: 1,
        durability: getItem(ITEM.SHIELD).durability,
      };
      return true;
    }),
    true
  );
  assert.equal(f.service.throw(), true);
  const shield = f.gameplay.getHandStack("offhand");
  assert.equal(
    f.game.useActions.use.start(
      "shield",
      "offhand",
      shield,
      f.gameplay.getHandRevision("offhand")
    ),
    true
  );
  f.game.useActions.use.advance(0.3);
  assert.equal(f.game.useActions.use.blocking, true);
  const armorBefore = f.gameplay.serialize().equipment;
  finishPearlFlight(f);
  assert.equal(f.gameplay.health, 15);
  assert.deepEqual(f.gameplay.serialize().equipment, armorBefore);
  assert.deepEqual(f.gameplay.getHandStack("offhand"), shield);
});

test("third-person rendering never becomes the launch origin or changes the checked stance", async (t) => {
  const f = await projectileHostFixture(t);
  f.player.perspective = "back";
  f.player.sneaking = true;
  f.player._syncCamera(0);
  const eye = f.player.eyePosition.clone();
  assert.ok(f.player.camera.position.distanceTo(eye) > 0.1);
  const height = f.player.height;
  assert.equal(f.service.throw(), true);
  assert.deepEqual(f.service.projectiles.projectiles[0].position, {
    x: eye.x,
    y: eye.y,
    z: eye.z,
  });
  finishPearlFlight(f);
  assert.equal(f.player.sneaking, true);
  assert.equal(f.player.height, height);
  assert.equal(f.player.perspective, "back");
});

test("impact pose, health and projectile retirement are one vetoable, single-use transaction", async (t) => {
  const f = await projectileHostFixture(t);
  assert.equal(f.service.throw(), true);
  const plan = nextImpact(f);
  assert.equal(new Set(plan.participants.map(({ owner }) => owner)).size, 3);
  const pose = f.player.position.clone();
  const health = f.gameplay.health;
  const saved = f.service.serialize();
  const owner = {};
  f.coordinator.register(owner, 0);
  t.after(() => f.coordinator.release(owner));
  const veto = {
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => false,
    publish: () => assert.fail("veto published"),
  };
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.ok(f.player.position.equals(pose));
  assert.equal(f.gameplay.health, health);
  assert.deepEqual(f.service.serialize(), saved);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  const arrived = f.player.position.clone();
  assert.equal(f.gameplay.health, 15);
  assert.equal(f.service.projectiles.size, 0);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.ok(f.player.position.equals(arrived));
  assert.equal(f.gameplay.health, 15);
});

test("moving away and back, input resets, stance or camera ownership changes stale a prepared impact", async (t) => {
  for (const change of [
    ({ player }) => {
      const p = player.position.clone();
      player.setPosition(p);
      player.setPosition(p);
    },
    ({ player }) => {
      player._applyLook(1, 0);
      player._applyLook(-1, 0);
    },
    ({ player }) => {
      player.enabled = false;
      player.enabled = true;
    },
    ({ player }) => {
      player.sneaking = !player.sneaking;
    },
    ({ game }) => {
      game.graphics.camera = new THREE.PerspectiveCamera();
    },
  ]) {
    const f = await projectileHostFixture(t);
    assert.equal(f.service.throw(), true);
    const plan = nextImpact(f);
    const beforeHealth = f.gameplay.health;
    const count = f.service.projectiles.size;
    change(f);
    const beforePose = f.player.position.clone();
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.ok(f.player.position.equals(beforePose));
    assert.equal(f.gameplay.health, beforeHealth);
    assert.equal(f.service.projectiles.size, count);
  }
});

test("pause freezes real flight and an actual IndexedDB save/reload resumes without a second item charge", async (t) => {
  const f = await projectileHostFixture(t);
  assert.equal(f.service.throw(), true);
  f.service.frame(0.05);
  f.game.paused = true;
  const frozen = f.service.serialize();
  f.service.frame(10, { simulating: false });
  assert.deepEqual(f.service.serialize(), frozen);
  assert.equal((await f.game.save()).ok, true);
  const saved = await f.game.storage.load();
  const normalized = normalizeWorldComponents(saved);
  assert.deepEqual(normalized.playerProjectiles, frozen.playerProjectiles);
  const resumed = await projectileHostFixture(t, { saved });
  assert.equal(resumed.gameplay.getHandStack().count, 5);
  assert.equal(resumed.service.projectiles.size, 1);
  assert.equal(resumed.observed.hurt.length, 0, "load does not replay damage");
  finishPearlFlight(resumed);
  assert.equal(resumed.gameplay.health, 15);
  assert.equal(resumed.gameplay.getHandStack().count, 5);
  assert.equal((await resumed.game.save()).ok, true);
  const completed = await resumed.game.storage.load();
  const final = await projectileHostFixture(t, { saved: completed });
  assert.equal(final.service.projectiles.size, 0);
  assert.equal(final.gameplay.health, 15);
  assert.equal(final.observed.hurt.length, 0);
});

test("actual death and respawn hooks invalidate old flights and persist distinct owner lives", async (t) => {
  const f = await projectileHostFixture(t, { health: 4 });
  assert.equal(f.service.throw(), true);
  const plan = nextImpact(f);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.gameplay.dead, true);
  assert.equal(f.observed.death, 1);
  assert.equal(f.service.projectiles.size, 0);
  assert.equal(f.service.projectiles.life, 1);
  assert.equal(f.player.enabled, false);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  const before = f.game.wildlife;
  const result = await new GameTravel(f.game).respawn();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(before.disposed, true);
  assert.notEqual(f.game.wildlife, before);
  assert.equal(f.coordinator.usage(before), undefined);
  assert.equal(f.coordinator.usage(f.game.wildlife), 0);
  assert.equal(f.game.wildlife.spawnGrace, 8);
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.equal(f.service.projectiles.life, 2);
  assert.equal(f.service.projectiles.size, 0);
  assert.equal(f.game.paused, true);
  const saved = await f.game.storage.load();
  assert.ok(saved, "the actual respawn must reach the IndexedDB archive save");
  assert.equal(saved.playerProjectiles.life, 2);
  assert.equal(saved.playerProjectiles.projectiles.length, 0);
  assert.deepEqual(saved.mobs, saved.mobStates.overworld);
  assert.deepEqual(saved.mobsByDimension, saved.mobStates);
});

test("capacity and stale ownership refusals preserve the held stack and projectile RNG", async (t) => {
  const f = await projectileHostFixture(t);
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  t.after(() => f.coordinator.release(filler));
  const hand = f.gameplay.getHandStack();
  const before = f.service.serialize();
  assert.equal(f.service.throw(), false);
  assert.deepEqual(f.gameplay.getHandStack(), hand);
  assert.deepEqual(f.service.serialize(), before);
  assert.equal(f.service.projectiles.size, 0);
  const otherScene = new THREE.Scene();
  f.game.graphics.scene = otherScene;
  assert.equal(f.service.throw(), false);
  assert.deepEqual(f.gameplay.getHandStack(), hand);
  assert.throws(() => f.service.serialize(), /stale/);
});

test("an observer error cannot undo a paid throw or starve rendering, saving and HUD observers", async (t) => {
  const f = await projectileHostFixture(t);
  f.game.effects.sound = () => {
    throw new Error("audio unavailable");
  };
  const saves = f.observed.saves,
    hud = f.observed.hud;
  assert.equal(f.service.throw(), true);
  assert.equal(f.gameplay.getHandStack().count, 5);
  assert.equal(f.service.projectiles.size, 1);
  assert.equal(f.service.renderer.pearls.count, 1);
  assert.ok(f.observed.saves > saves);
  assert.ok(f.observed.hud > hud);
  assert.equal(f.service.observerErrors.length, 1);
  assert.ok(f.service.observerErrors[0] instanceof AggregateError);
});

test("stale staging rejects activation and disposal releases only its own reservations", async (t) => {
  const f = await projectileHostFixture(t, { activate: false });
  f.world.setDimension("nether");
  assert.equal(f.service.activate(f.game).ok, false);
  assert.equal(f.game.projectileServices, undefined);
  assert.throws(() => f.service.serialize(), /stale/);
  const pearlOwner = f.service.projectiles;
  assert.equal(f.service.dispose(), true);
  assert.equal(f.coordinator.usage(f.service), undefined);
  assert.equal(f.coordinator.usage(pearlOwner), undefined);
  assert.notEqual(f.coordinator.usage(f.gameplay), undefined);
});

test("legacy empty seeds activate and exhausted life IDs clear without wrapping or spending", async (t) => {
  const f = await projectileHostFixture(t, { seed: "" });
  assert.equal(f.service.throw(), true);
  finishPearlFlight(f);
  const saved = f.game.archive.snapshot();
  saved.playerProjectiles.life = MAX_PEARL_ID;
  const max = await projectileHostFixture(t, { saved });
  const hand = max.gameplay.getHandStack();
  assert.equal(max.service.cancel("death", { advanceLife: true }), true);
  assert.equal(max.service.projectiles.life, MAX_PEARL_ID);
  assert.equal(max.service.throw(), false);
  assert.deepEqual(max.gameplay.getHandStack(), hand);
});

test("malformed staged sidecars fail without stealing reservations from live owners", async (t) => {
  const f = await projectileHostFixture(t);
  const before = f.coordinator.budget.totalBytes;
  assert.throws(
    () =>
      new GameProjectileServices({
        world: f.world,
        gameplay: f.gameplay,
        context: f.context,
        saved: { playerProjectiles: null },
      }),
    /staged projectile/
  );
  assert.equal(f.coordinator.budget.totalBytes, before);
  assert.equal(f.service.active, true);
});
