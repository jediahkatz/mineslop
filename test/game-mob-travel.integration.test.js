import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameTravel } from "../src/game-travel.js";
import { createTravelPreviewWorld } from "../src/game-travel-stage.js";
import { Wildlife } from "../src/wildlife.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

const destination = Object.freeze({ x: 40.5, y: 65, z: 40.5, dimension: "nether" });

async function mounted(t) {
  const f = await gameMobFixture(t), mob = f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  f.hold("FISHING_ROD", { hand: "offhand" });
  assert.equal(f.vehicles.useHand("offhand").ok, true);
  return { ...f, sourceWildlife: f.wildlife, mob };
}

test("destination inspection keeps the source epoch, riders, casts and borrowers live until one departure", async (t) => {
  const f = await mounted(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const before = f.snapshot(), epoch = f.world.epoch, events = [];
  const beforeTravel = t.mock.method(f.progression, "beforeTravel");
  const cancel = t.mock.method(f.projectiles, "cancel");
  const detach = f.vehicles.detachForTravel;
  t.mock.method(f.vehicles, "detachForTravel", function (...args) {
    events.push("departure");
    return Reflect.apply(detach, this, args);
  });
  const capture = f.mobs.capture;
  t.mock.method(f.mobs, "capture", function (...args) {
    events.push(`capture:${f.world.dimension}`);
    if (f.world.dimension === "overworld") assert.equal(f.horses.mountFor(), null);
    return Reflect.apply(capture, this, args);
  });
  const change = f.world.setDimension;
  t.mock.method(f.world, "setDimension", function (...args) {
    events.push("dimension");
    assert.equal(f.horses.wildlife, null);
    assert.equal(f.ecology.wildlife, null);
    assert.equal(f.horses.mountFor(), null);
    return Reflect.apply(change, this, args);
  });
  const load = Wildlife.prototype.load;
  const loading = t.mock.method(Wildlife.prototype, "load", function (...args) {
    events.push(`load:${this.dimension}`);
    assert.equal(this.horseServices, null);
    assert.equal(this.ecologyServices, null);
    assert.ok(args[1].horses && args[1].ecology);
    return Reflect.apply(load, this, args);
  });
  let preview;
  f.game.travel = new GameTravel(f.game, {
    worldFactory(source, dimension) {
      preview = createTravelPreviewWorld(source, dimension);
      const ensure = preview.ensureArea;
      t.mock.method(preview, "ensureArea", async function (...args) {
        entered.resolve();
        await release.promise;
        return Reflect.apply(ensure, this, args);
      });
      return preview;
    },
  });
  const travelling = f.game.travel.teleport(destination);
  await entered.promise;
  assert.notEqual(preview, f.world);
  assert.notEqual(preview.coordinator, f.coordinator);
  assert.equal(f.world.dimension, "overworld");
  assert.equal(f.world.epoch, epoch);
  assert.equal(f.game.wildlife, f.sourceWildlife);
  assert.equal(f.horses.wildlife, f.sourceWildlife);
  assert.equal(f.ecology.wildlife, f.sourceWildlife);
  assert.equal(f.coordinator.usage(f.sourceWildlife), 0);
  assert.equal(f.horses.mountFor().id, f.mob.id);
  assert.equal(f.vehicles.fishing.hasCast(), true);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(beforeTravel.mock.callCount(), 0);
  assert.equal(cancel.mock.callCount(), 0);
  assert.equal(f.game.transitionGate.busy, true);
  const competing = await f.game.travel.teleport({ ...destination, dimension: "end" });
  assert.equal(competing.ok, false);
  assert.match(competing.message, /transition/);
  release.resolve();
  const result = await travelling;
  assert.equal(result.ok, true, result.message);
  assert.equal(loading.mock.callCount(), 1, "the destination base is restored exactly once");
  assert.ok(events.indexOf("departure") < events.indexOf("capture:overworld"));
  assert.ok(events.indexOf("capture:overworld") < events.indexOf("dimension"));
  assert.ok(events.indexOf("dimension") < events.indexOf("load:nether"));
  assert.equal(beforeTravel.mock.callCount(), 1);
  assert.equal(cancel.mock.callCount(), 1);
  assert.equal(preview._disposed, true);
  assert.equal(f.sourceWildlife.disposed, true);
  assert.equal(f.coordinator.usage(f.sourceWildlife), undefined);
  assert.equal(f.horses.wildlife, f.game.wildlife);
  assert.equal(f.ecology.wildlife, f.game.wildlife);
  assert.equal(f.coordinator.usage(f.game.wildlife), 0);
  assert.equal(f.game.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.horses.state(f.mob.id).dimension, "overworld");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.fishing.hasCast(), false);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.vehicleType, null);
  assert.deepEqual(f.snapshot().mobStates.overworld, before.mobStates.overworld);
  assert.equal(f.snapshot().horses.entries[0].rider, null);

  // The original base identity/position is restored on return, never moved to
  // the destination or recreated as a second base alongside a sidecar pose.
  f.game.travel = new GameTravel(f.game);
  const returned = await f.game.travel.teleport({
    x: 8.5, y: 65, z: 11.5, dimension: "overworld",
  });
  assert.equal(returned.ok, true, returned.message);
  const horse = f.game.wildlife.byId.get(f.mob.id);
  assert.ok(horse);
  assert.deepEqual(point(horse.position), point(f.mob.position));
  assert.equal(f.game.wildlife.entities.filter((mob) => mob.id === horse.id).length, 1);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.takeExitPose(), null);
});

test("a preview failure leaves source creatures and mounted resources unchanged", async (t) => {
  const f = await mounted(t), before = f.snapshot(), epoch = f.world.epoch;
  const departure = t.mock.method(f.vehicles, "detachForTravel");
  const progression = t.mock.method(f.progression, "beforeTravel");
  let preview;
  f.game.travel = new GameTravel(f.game, {
    worldFactory(source, dimension) {
      preview = createTravelPreviewWorld(source, dimension);
      t.mock.method(preview, "ensureArea", async () => { throw new Error("preview unavailable"); });
      return preview;
    },
  });
  const result = await f.game.travel.teleport(destination);
  assert.equal(result.ok, false);
  assert.match(result.message, /preview unavailable/);
  assert.equal(departure.mock.callCount(), 0);
  assert.equal(progression.mock.callCount(), 0);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.epoch, epoch);
  assert.equal(f.game.wildlife, f.sourceWildlife);
  assert.equal(f.horses.wildlife, f.sourceWildlife);
  assert.equal(f.ecology.wildlife, f.sourceWildlife);
  assert.equal(f.player.seated, true);
  assert.equal(f.game.building, false);
  assert.equal(preview._disposed, true);
});

test("a real departure participant veto keeps both the horse rider and offhand cast at source", async (t) => {
  const f = await mounted(t);
  f.hold("ENDER_PEARL", { count: 2 });
  assert.equal(f.projectiles.throw("main"), true);
  assert.equal(f.projectiles.projectiles.size, 1);
  const before = f.snapshot(), epoch = f.world.epoch;
  const progression = t.mock.method(f.progression, "beforeTravel");
  const cancel = t.mock.method(f.projectiles, "cancel");
  const prepare = f.vehicles.prepareDeparture;
  t.mock.method(f.vehicles, "prepareDeparture", function (...args) {
    const plan = Reflect.apply(prepare, this, args);
    assert.equal(plan.ok, true);
    // Keep the host plan identity and replace the actual captured Horse
    // validator for this one invocation; no alternate successful publisher.
    const horse = plan.participants.find((part) => part.owner === f.horses);
    assert.ok(horse);
    const commit = f.coordinator.commit;
    const veto = t.mock.method(f.coordinator, "commit", function (participants) {
      veto.mock.restore();
      assert.equal(participants, plan.participants);
      return Reflect.apply(commit, this, [participants.map((part) =>
        part === horse ? { ...part, validate: () => false } : part)]);
    });
    return plan;
  });
  const result = await f.game.travel.teleport(destination);
  assert.equal(result.ok, false);
  assert.match(result.message, /leave the vehicle/);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.world.epoch, epoch);
  assert.equal(f.game.wildlife, f.sourceWildlife);
  assert.equal(f.horses.mountFor().id, f.mob.id);
  assert.equal(f.vehicles.fishing.hasCast(), true);
  assert.equal(f.projectiles.projectiles.size, 1);
  assert.equal(progression.mock.callCount(), 0);
  assert.equal(cancel.mock.callCount(), 0);
});

test("failure after committed departure recovers the source unseated and never restores an old rider", async (t) => {
  const f = await mounted(t), before = f.snapshot(), ensure = f.world.ensureArea;
  const seat = point(f.player.position), loads = [];
  t.mock.method(f.world, "ensureArea", async function (...args) {
    loads.push(this.dimension);
    assert.equal(f.horses.mountFor(), null);
    assert.equal(f.horses.wildlife, null);
    assert.equal(f.ecology.wildlife, null);
    if (this.dimension === "nether") throw new Error("destination admission failed");
    return Reflect.apply(ensure, this, args);
  });
  const result = await f.game.travel.teleport(destination);
  assert.equal(result.ok, false);
  assert.equal(result.rollbackFailed, undefined);
  assert.match(result.message, /destination admission failed/);
  assert.deepEqual(loads, ["nether", "overworld"]);
  assert.equal(f.world.dimension, "overworld");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.fishing.hasCast(), false);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.vehicleType, null);
  assert.equal(f.player.flying, false);
  assert.equal(f.player._keys.size, 0);
  assert.deepEqual(point(f.player.position), seat);
  assert.equal(f.vehicles.poseForArchive(), null);
  assert.equal(f.vehicles.takeExitPose(), null);
  assert.equal(f.horses.wildlife, f.game.wildlife);
  assert.equal(f.ecology.wildlife, f.game.wildlife);
  assert.equal(f.game.wildlife.byId.get(f.mob.id).dead, false);
  assert.deepEqual(f.snapshot().mobStates.overworld, before.mobStates.overworld);
  assert.equal(f.snapshot().horses.entries[0].rider, null);
  assert.equal(f.game.building, false);
});

test("a save observer failure after arrival does not undo departure or duplicate its horse", async (t) => {
  const f = await mounted(t), error = new Error("save observer");
  t.mock.method(f.game, "save", async () => { throw error; });
  const result = await f.game.travel.teleport(destination);
  assert.equal(result.ok, true);
  assert.deepEqual(result.observerErrors, [error]);
  assert.equal(f.world.dimension, "nether");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.player.seated, false);
  assert.equal(f.game.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.snapshot().mobStates.overworld.entities.filter((mob) => mob.id === f.mob.id).length, 1);
});

test("a real bed survives source-first travel and cross-dimension death/respawn without a stale horse seat", async (t) => {
  const f = await gameMobFixture(t);
  f.hold("WHITE_BED", { count: 1 });
  const hit = { x: 5, y: 64, z: 10, ...f.world.getCell(5, 64, 10),
    normal: { x: 0, y: 1, z: 0 }, localPoint: { x: 0.5, y: 1, z: 0.5 } };
  assert.equal(f.game.buildingActions.place("main", BLOCK.WHITE_BED, hit), true);
  const bed = { x: 5, y: 65, z: 10, ...f.world.getCell(5, 65, 10) };
  assert.equal(f.game.buildingActions.tryUse(bed).ok, true);
  const expected = f.building.beds.findRespawn(f.world);
  assert.ok(expected);
  const mob = f.spawn();
  f.hold(null);
  assert.equal(f.game.useActions.tap(), true);
  const base = point(mob.position), life = f.projectiles.projectiles.life;
  assert.equal((await f.game.travel.teleport(destination)).ok, true);
  assert.equal(f.game.paused, true);
  assert.equal(f.gameplay.damage(1000, "source-first-test"), 0);
  assert.equal(f.gameplay.dead, false);
  await f.game.play();
  assert.equal(f.game.paused, false);
  f.gameplay.damage(1000, "source-first-test");
  assert.equal(f.gameplay.dead, true);
  assert.equal(f.projectiles.projectiles.life, life + 1);
  const result = await f.game.travel.respawn();
  assert.equal(result.ok, true, result.message);
  assert.equal(result.fromBed, true);
  assert.equal(f.world.dimension, "overworld");
  assert.deepEqual(point(f.player.position), point(expected));
  assert.equal(f.player.seated, false);
  assert.equal(f.player.flying, false);
  assert.equal(f.gameplay.dead, false);
  assert.equal(f.gameplay.health, 20);
  assert.equal(f.projectiles.projectiles.life, life + 2);
  assert.equal(f.horses.mountFor(), null);
  assert.deepEqual(point(f.game.wildlife.byId.get(mob.id).position), base);
  assert.equal(f.horses.wildlife, f.game.wildlife);
  assert.equal(f.ecology.wildlife, f.game.wildlife);
  assert.equal(f.vehicles.takeExitPose(), null);
});
