import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { horseMotion, MAX_RETAINED_HORSE_IDS } from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { Wildlife } from "../src/wildlife.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { horseFixture, horseRecord, horseVeto } from "./horse-fixture.js";

test("empty hand mounts untamed bareback, with no steering/jump and commit-time cross-vehicle guard", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold(null);
  const plan = f.horses.prepareMount(horse.id);
  assert.equal(plan.ok, true);
  f.crossMountAllowed = false;
  const before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  f.crossMountAllowed = true;
  assert.equal(f.horses.commit(plan).ok, true);
  const initial = horse.position.clone(), yaw = horse.root.rotation.y;
  f.tick(20, { forward: 1, strafe: 1, yaw: 0, jump: true });
  assert.deepEqual(horse.position, initial);
  assert.equal(horse.root.rotation.y, yaw);
  assert.equal(f.horses.getHorse(horse.id).controlled, false);
  assert.equal(f.horses.riderPose().vehicleType, "horse");
  assert.equal(f.horses.riderPose().grounded, false);
  assert.equal(f.horses.riderPose().position.y, horse.position.y + 0.95);
});

test("a blocked completed buck persists once across save/reload and exits before the next attempt", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold(null);
  assert.equal(f.horses.mount(horse.id).ok, true);
  f.ring();
  f.tick(60);
  const pending = f.horses.state(horse.id);
  assert.equal(pending.failedAttempts, 1);
  assert.equal(pending.temper, 5);
  assert.equal(pending.tamingTicksLeft, 0);
  assert.equal(pending.rider, "player");
  f.tick(120);
  assert.deepEqual(f.horses.state(horse.id), pending);
  assert.equal(f.horses.dismount().reason, "no-safe-exit");
  const restored = horseFixture(t, { saved: f.snapshot() });
  restored.tick(80);
  assert.deepEqual(restored.horses.state(horse.id), pending);
  restored.ring(BLOCK.AIR);
  restored.tick();
  const next = restored.horses.state(horse.id);
  assert.equal(next.rider, null);
  assert.equal(next.tamingTicksLeft, 60);
  assert.equal(next.failedAttempts, 1);
  assert.equal(next.temper, 5);
  assert.equal(restored.horses.mount(horse.id).ok, true);
  assert.equal(restored.horses.state(horse.id).failedAttempts, 1);
});

test("motion ownership survives a late dismount and a late mount for the whole AI frame", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold(null);
  assert.equal(f.horses.mount(horse.id).ok, true);
  f.horses.beginFrame("frame:first");
  assert.equal(f.wildlife.context.ownsMotionThisFrame(horse), true);
  const before = horse.position.clone();
  assert.equal(f.horses.dismount().ok, true);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.wildlife.context.ownsMotionThisFrame(horse), true);
  assert.equal(f.wildlife.context.retainsMob(horse), true);
  f.wildlife.update(0.2, 0.2, f.actor.position, { mode: "survival", health: 20 });
  assert.deepEqual(horse.position, before, "no generic gravity/wander step after this frame's dismount");
  f.horses.beginFrame("frame:next");
  assert.equal(f.wildlife.context.ownsMotionThisFrame(horse), false);
  assert.equal(f.horses.mount(horse.id).ok, true);
  assert.equal(f.wildlife.context.ownsMotionThisFrame(horse), true, "late mount claims this frame immediately");
  assert.equal(f.horses.dismount().ok, true);
  assert.equal(f.wildlife.context.ownsMotionThisFrame(horse), true);
});

test("unloaded retained horses keep the SAME base object/location/health and never relocate like wolves", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  assert.equal(f.horses.track(horse.id).ok, true);
  assert.equal(f.horses.hurt(horse, 3).ok, true);
  const pose = horse.position.clone(), saved = f.wildlife.serialize(), generated = f.generated();
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  f.tick();
  assert.equal(f.wildlife.entities.includes(horse), false);
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.dormantHorses.get(horse.id), horse);
  assert.deepEqual(horse.position, pose);
  assert.equal(horse.health, 21);
  assert.deepEqual(f.wildlife.serialize(), saved);
  assert.equal(f.wildlife.relocate(horse, { x: 25, y: 1, z: 25 }), false);
  assert.equal(f.generated(), generated, "retention never requests missing chunks");
  const archive = f.snapshot();
  const restored = horseFixture(t, { saved: archive });
  assert.equal(restored.wildlife.byId.get(horse.id).health, 21);
  assert.deepEqual(restored.wildlife.byId.get(horse.id).position, pose);
  f.world._generateSync(0, 0);
  f.wildlife._wakeHorses();
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.entities.includes(horse), true);
  assert.deepEqual(horse.position, pose, "waking itself uses the saved location");
  assert.equal(horse.tamed, false);
});

test("retained bases do not enlarge the active/GPU population, and load refuses while any horse host is bound", (t) => {
  const f = horseFixture(t, { bind: false });
  const horses = { ...emptyHorseSnapshot(f.context),
    entries: Array.from({ length: 8 }, (_, index) => horseRecord(`retained:${index}`)) };
  const entries = [
    ...Array.from({ length: MAX_MOBS }, (_, index) => mobRecord(f.context, "overworld", {
      id: `legacy:${index}`, position: { x: 8.5, y: 1, z: 8.5 },
    })),
    ...horses.entries.map((entry) => mobRecord(f.context, "overworld", {
      id: entry.id, kind: "horse", health: 24, position: { x: 8.5, y: 1, z: 8.5 },
    })),
  ];
  assert.equal(f.horses.load(horses), true);
  const mobs = mobSnapshot(f.context, "overworld", entries);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.wildlife.entities.length, MAX_MOBS);
  assert.equal(f.wildlife.dormantHorses.size, 8);
  assert.equal(f.wildlife.byId.size, MAX_MOBS + 8);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses }), false);
  assert.equal(f.horses.suspend(), true);
  assert.equal(f.coordinator.usage(f.wildlife), 0, "borrower suspension never releases Wildlife");
  assert.equal(f.wildlife.load(mobs, { context: f.context }), false, "cannot forget the paired sidecar");
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses }), true);
});

test("lifecycle release has one owner, is atomic, and leaves the horse at source across a real World switch", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold(null);
  const mounted = f.horses.mount(horse.id);
  assert.equal(mounted.ok, true, mounted.reason);
  assert.equal(f.horses.preparePassengerRelease().ok, false);
  const plan = f.horses.preparePassengerRelease("player", { travelling: true });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.participants.map((part) => part.owner), [f.horses]);
  const before = f.ownership(), veto = horseVeto(t, f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.commit(plan).ok, true);
  const source = f.wildlife.serialize(), pose = horse.position.clone();
  assert.equal(f.horses.suspend(), true);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.wildlife.dispose(), true);
  assert.equal(f.coordinator.usage(f.wildlife), undefined);
  f.world.setDimension("nether").generate(1);
  const destination = new Wildlife(f.scene, f.world, { context: f.context, autoSpawn: false });
  assert.equal(f.horses.bindWildlife(destination), true);
  assert.equal(destination.byId.size, 0);
  assert.equal(f.horses.state(horse.id).dimension, "overworld");
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.horses.poseForArchive(), null, "never restore a stale seated departure pose");
  assert.equal(f.horses.suspend(), true);
  assert.equal(destination.dispose(), true);
  f.world.setDimension("overworld").generate(1);
  const returned = new Wildlife(f.scene, f.world, { context: f.context, autoSpawn: false });
  assert.equal(returned.load(source, { context: f.context, horses: f.horses.serialize() }), true);
  assert.equal(f.horses.bindWildlife(returned), true);
  assert.deepEqual(returned.byId.get(horse.id).position, pose);
  assert.equal(f.horses.suspend(), true);
  assert.equal(returned.dispose(), true);
});

test("same-frame travel clears an unconsumed dismount exit even after the rider link is gone", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold(null);
  const mounted = f.horses.mount(horse.id);
  assert.equal(mounted.ok, true, mounted.reason);
  f.horses.beginFrame("exit-before-pearl");
  assert.equal(f.horses.dismount().ok, true);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.horses.needsDeparture(), true);
  const plan = f.horses.preparePassengerRelease("player", { travelling: true });
  assert.deepEqual(plan.participants.map((part) => part.owner), [f.horses]);
  assert.equal(f.horses.commit(plan).ok, true);
  assert.equal(f.horses.poseForArchive(), null);
  assert.equal(f.horses.needsDeparture(), false);
  assert.equal(f.horses.ownsMotionThisFrame(horse), true, "clearing the exit does not give AI another step");
});

test("1024 retained tombstones never evict and a reused owner cannot erase or resurrect one", (t) => {
  const f = horseFixture(t, { bind: false });
  const saved = { ...emptyHorseSnapshot(f.context),
    entries: Array.from({ length: MAX_RETAINED_HORSE_IDS }, (_, index) => ({
      id: `dead:${index}`, dimension: "overworld", alive: false,
    })) };
  assert.equal(f.horses.load(saved), true);
  assert.equal(f.horses.load({ ...saved, entries: saved.entries.slice(1) }), false);
  assert.equal(f.horses.load({ ...saved, entries: [
    horseRecord("dead:0"), ...saved.entries.slice(1),
  ] }), false);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  const horse = f.spawn("new:capacity");
  f.hold("WHEAT");
  const before = f.ownership();
  assert.equal(f.horses.feed(horse.id).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.wildlife.spawn("horse", horse.position, { id: "dead:0" }), null);
});

test("mounted airborne velocity/fall state survives load, but charge/latches do not", (t) => {
  const f = horseFixture(t, { bind: false });
  const saved = { ...emptyHorseSnapshot(f.context), entries: [horseRecord("airborne", {
    tamed: true, tamingTicksLeft: 0, rider: "player",
    motion: { ...horseMotion(), vx: 1, vy: -3, vz: -2, grounded: false, fallDistance: 4 },
  })] };
  const mobs = mobSnapshot(f.context, "overworld", [mobRecord(f.context, "overworld", {
    id: "airborne", kind: "horse", health: 24, position: { x: 8.5, y: 6, z: 8.5 },
  })]);
  assert.equal(f.horses.load(saved), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses: saved }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.deepEqual(f.horses.state("airborne").motion, saved.entries[0].motion);
  assert.deepEqual(f.horses.riderPose().velocity, { x: 1, y: -3, z: -2 });
  assert.equal(f.horses.getHorse("airborne").jumpCharge, 0);
  f.tick();
  assert.ok(f.wildlife.byId.get("airborne").position.y < 6);
});

test("an unloaded unseated airborne horse sleeps without losing its motion/fall handoff", (t) => {
  const f = horseFixture(t, { bind: false });
  const motion = { vx: 1, vy: -3, vz: 0, grounded: false, fallDistance: 4 };
  const saved = { ...emptyHorseSnapshot(f.context),
    entries: [horseRecord("sleeping:airborne", { motion })] };
  const mobs = mobSnapshot(f.context, "overworld", [mobRecord(f.context, "overworld", {
    id: "sleeping:airborne", kind: "horse", health: 24, position: { x: 8.5, y: 6, z: 8.5 },
  })]);
  assert.equal(f.horses.load(saved), true);
  assert.equal(f.wildlife.load(mobs, { context: f.context, horses: saved }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  const horse = f.wildlife.byId.get("sleeping:airborne"), position = horse.position.clone();
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  f.tick(2);
  assert.equal(f.wildlife.dormantHorses.get(horse.id), horse);
  assert.equal(f.wildlife.entities.includes(horse), false);
  assert.deepEqual(f.horses.state(horse.id).motion, motion);
  assert.deepEqual(horse.position, position);
  f.world._generateSync(0, 0);
  f.wildlife._wakeHorses();
  f.tick();
  assert.equal(f.wildlife.entities.includes(horse), true);
  assert.ok(horse.position.y < position.y);
});

test("Ecology and Horses borrow Wildlife registration independently; only Wildlife disposal releases it", (t) => {
  const f = horseFixture(t, { bind: false });
  const ecology = new GameEcologyServices({
    world: f.world, context: f.context, coordinator: f.coordinator, gameplay: f.gameplay,
    overflow: f.overflow, experienceOrbs: f.experience,
  });
  assert.equal(ecology.restoreWildlife(f.wildlife), true);
  assert.equal(ecology.activate(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  const horse = f.spawn();
  assert.equal(f.horses.track(horse.id).ok, true);
  assert.equal(f.horses.suspend(), true);
  assert.equal(ecology.active, true);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(ecology.suspend(), true);
  assert.equal(f.coordinator.usage(f.wildlife), 0,
    "parent Ecology suspension must borrow, never release the base owner");
  assert.equal(f.horses.active, true);
  assert.equal(ecology.dispose(), true);
  assert.equal(f.horses.suspend(), true);
  assert.equal(f.wildlife.dispose(), true);
  assert.equal(f.coordinator.usage(f.wildlife), undefined);
});
