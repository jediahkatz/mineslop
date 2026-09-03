import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { stepPearlFlight } from "../src/pearl-physics.js";
import { MAX_PEARL_IMPACT_PEERS, PEARL_TELEPORT_DAMAGE } from "../src/player-projectiles.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

/** Authored wall and finite paid items; no fabricated impact/landing proposal. */
async function mountedPearl(t, { cast = true } = {}) {
  const f = await gameMobFixture(t), mob = f.spawn();
  const changes = [];
  for (let x = 5; x <= 11; x++)
    for (let y = 65; y <= 72; y++)
      changes.push({ x, y, z: 2, before: f.world.getCell(x, y, 2),
        after: { id: BLOCK.STONE, state: 0, fluid: 0 } });
  assert.equal(f.world.applyCells(changes), true);
  assert.equal(f.game.useActions.tap(), true);
  if (cast) {
    f.hold("FISHING_ROD", { hand: "offhand" });
    f.player.yaw = -Math.PI / 2;
    f.player.pitch = 0.04;
    f.player._syncCamera(0);
    assert.equal(f.vehicles.useHand("offhand").ok, true);
  }
  f.hold("ENDER_PEARL", { count: 3 });
  f.player.yaw = f.player.pitch = 0;
  f.player._syncCamera(0);
  f.game.elapsed += 0.21;
  f.key("Space");
  assert.equal(f.game.useActions.tap(), true);
  const pearls = f.projectiles.projectiles;
  assert.equal(pearls.size, 1);
  assert.equal(f.gameplay.getHandStack().count, 2);
  assert.deepEqual(pearls.projectiles[0].position, point(f.player.eyePosition));
  for (let tick = 0; tick < 16; tick++) {
    const projectile = pearls.projectiles[0];
    assert.ok(projectile);
    const flight = stepPearlFlight(f.world, f.context, projectile);
    if (flight.kind === "impact") {
      assert.equal(flight.hit.cell.z, 2);
      const before = f.ownership();
      const plan = pearls.prepareImpactTransaction(projectile.id);
      assert.ok(plan, "the actual next swept tick must prepare a clear landing");
      assert.deepEqual(f.ownership(), before);
      return { ...f, mob, pearls, plan, before };
    }
    assert.equal(flight.kind, "flight");
    f.frame();
  }
  assert.fail("The paid pearl must reach the authored wall within sixteen Game frames");
}

function assertDeparturePeers(f, { cast = true } = {}) {
  assert.equal(MAX_PEARL_IMPACT_PEERS, 4);
  const core = [f.projectiles, f.gameplay, f.pearls];
  const extra = [f.horses, ...(cast ? [f.vehicles.fishing] : []), f.vehicles];
  assert.deepEqual(new Set(f.plan.participants.map((part) => part.owner)),
    new Set([...core, ...extra]));
  assert.equal(f.plan.participants.length - core.length, extra.length);
  assert.ok(extra.length <= MAX_PEARL_IMPACT_PEERS);
}

test("a horse pearl pays pose, health, retirement, rider and cast in one bounded real-owner commit", async (t) => {
  const f = await mountedPearl(t);
  assertDeparturePeers(f);
  assert.equal(f.horses.mountFor().id, f.mob.id);
  assert.equal(f.vehicles.fishing.hasCast(), true);
  for (const vetoed of f.plan.participants) {
    const refused = f.plan.participants.map((part) =>
      part === vetoed ? { ...part, validate: () => false } : part);
    assert.equal(f.coordinator.commit(refused).ok, false);
    assert.deepEqual(f.ownership(), f.before, "no partial rider/pose/health/retirement on any veto");
  }
  const base = point(f.mob.position), observed = [];
  const result = f.coordinator.commit(f.plan.participants.map((part) => ({
    ...part,
    notify() {
      observed.push({
        player: point(f.player.position), seated: f.player.seated, type: f.player.vehicleType,
        rider: f.horses.mountFor(), cast: f.vehicles.fishing.hasCast(),
        health: f.gameplay.health, pearls: f.pearls.size, ridden: f.mob.horseView.ridden,
        keys: f.player._keys.size,
      });
      part.notify?.();
    },
  })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(observed.length, f.plan.participants.length);
  for (const state of observed) assert.deepEqual(state, {
    player: f.plan.request.position, seated: false, type: null, rider: null, cast: false,
    health: 20 - PEARL_TELEPORT_DAMAGE, pearls: 0, ridden: false, keys: 0,
  });
  assert.deepEqual(point(f.mob.position), base);
  assert.equal(f.wildlife.byId.get(f.mob.id), f.mob);
  assert.equal(f.vehicles.poseForArchive(), null);
  assert.equal(f.vehicles.takeExitPose(), null);
  const after = f.ownership();
  assert.equal(f.coordinator.commit(f.plan.participants).ok, false);
  assert.deepEqual(f.ownership(), after);
  f.frame(2);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.position.x, f.plan.request.position.x);
  assert.equal(f.player.position.z, f.plan.request.position.z);
  assert.equal(f.gameplay.getHandStack().count, 2);
  assert.equal(f.gameplay.health, 15);
});

test("the actual Game projectile frame departs the horse once and a completed archive never remounts", async (t) => {
  const f = await mountedPearl(t);
  const life = f.pearls.life, base = point(f.mob.position);
  // Inspection does not publish. Game.frame prepares a fresh impact after the
  // current horse/Player motion, before the late Wildlife pass.
  f.frame();
  assert.equal(f.pearls.size, 0);
  assert.equal(f.pearls.life, life);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.fishing.hasCast(), false);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.vehicleType, null);
  assert.equal(f.player._keys.size, 0);
  assert.deepEqual(point(f.mob.position), base, "the departure claims this frame's late AI motion");
  const saved = f.snapshot();
  assert.equal(saved.horses.entries[0].rider, null);
  assert.equal(saved.playerProjectiles.projectiles.length, 0);
  const restored = await gameMobFixture(t, { saved });
  assert.equal(restored.horses.mountFor(), null);
  assert.equal(restored.player.seated, false);
  assert.equal(restored.vehicles.takeExitPose(), null);
  assert.equal(restored.wildlife.byId.size, 1);
  assert.equal(restored.gameplay.getHandStack().count, 2);
  assert.equal(restored.gameplay.health, 15);
  assert.equal(restored.game.applyVehiclePose(), false);
});

test("an unconsumed horse dismount cannot snap a pearl landing back to the old exit", async (t) => {
  const f = await mountedPearl(t, { cast: false });
  const dismount = f.vehicles.dismount();
  assert.equal(dismount.ok, true, dismount.reason);
  assert.equal(f.player.seated, true, "no Player pose has consumed this exit yet");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.horses.needsDeparture(), true);
  assert.deepEqual(f.vehicles.poseForArchive(), dismount.exit);
  assert.equal(f.coordinator.commit(f.plan.participants).ok, false);
  f.plan = f.pearls.prepareImpactTransaction(f.plan.projectileId);
  assert.ok(f.plan);
  assertDeparturePeers(f, { cast: false });
  assert.equal(f.coordinator.commit(f.plan.participants).ok, true);
  assert.deepEqual(point(f.player.position), f.plan.request.position);
  assert.equal(f.player.seated, false);
  assert.equal(f.horses.needsDeparture(), false);
  assert.equal(f.vehicles.takeExitPose(), null);
  assert.equal(f.game.applyVehiclePose(), false);
  assert.deepEqual(point(f.player.position), f.plan.request.position);
});
