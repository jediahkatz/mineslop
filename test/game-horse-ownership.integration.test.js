import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { stackIdentity } from "../src/item-stack-data.js";
import { horseSeat } from "../src/horse-definitions.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

test("raw Boat and Horse mount plans cannot win sequentially or in the same transaction", async (t) => {
  for (const winner of ["horse", "boat"]) {
    const f = await gameMobFixture(t), mob = f.spawn(), boatId = f.placeBoat();
    const boat = f.vehicles.boats.prepareMount(boatId);
    const horse = f.horses.prepareMount(mob.id);
    assert.equal(boat.ok, true, boat.reason);
    assert.equal(horse.ok, true, horse.reason);
    const before = f.ownership();
    assert.equal(f.coordinator.commit([...boat.participants, ...horse.participants]).ok, false,
      "a read-only Horses peer on Boat mount prevents joint-plan write skew");
    assert.deepEqual(f.ownership(), before);
    const first = winner === "horse" ? horse : boat, second = winner === "horse" ? boat : horse;
    assert.equal(f.coordinator.commit(first.participants).ok, true);
    const committed = f.ownership();
    assert.equal(f.coordinator.commit(second.participants).ok, false);
    assert.deepEqual(f.ownership(), committed);
    assert.equal(Number(f.horses.mountFor() !== null) + Number(f.vehicles.boats.mountFor() !== null), 1);
    assert.equal(winner === "horse"
      ? f.vehicles.boats.prepareMount(boatId).ok
      : f.horses.prepareMount(mob.id).ok, false);
  }
});

test("raw saved-rider loads cannot bypass the detached host's cross-normalized admission", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn(), boatId = f.placeBoat();
  const saved = f.vehicles.boats.serialize();
  saved.boats.find((boat) => boat.id === boatId).passengers[0] = "player";
  const before = f.ownership();
  assert.equal(f.vehicles.boats.prepareLoad(saved), null);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.mount(mob.id).ok, true);
  const mounted = f.ownership();
  assert.equal(f.vehicles.boats.prepareLoad(saved), null);
  assert.deepEqual(f.ownership(), mounted);
  const staged = await gameMobFixture(t, { saved: mounted.archive, activate: false });
  assert.equal(staged.horses.mountFor().id, mob.id, "the checked host load admits its one archived rider");
  assert.equal(staged.vehicles.boats.prepareLoad(saved), null);
  assert.equal(staged.horses.prepareLoad(mounted.archive.horses), null);
  staged.activate();
  assert.equal(staged.player.vehicleType, "horse");
});

test("an unchanged existing boat rider can reload without introducing a second mount", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn(), boatId = f.placeBoat();
  assert.equal(f.vehicles.boats.mount(boatId).ok, true);
  assert.equal(f.game.applyVehiclePose(), true);
  const saved = f.vehicles.boats.serialize();
  assert.equal(f.vehicles.boats.load(saved), true);
  assert.deepEqual(f.vehicles.boats.serialize(), saved);
  assert.equal(f.vehicles.boats.mountFor().id, boatId);
  assert.equal(f.horses.prepareMount(mob.id).ok, false);
  assert.equal(f.horses.mountFor(), null);
});

test("Game feed uses real offhand food before empty-main mounting and a debit veto changes nothing", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  f.hold("WHEAT", { hand: "offhand", count: 2, data: { version: 1, name: "Trail feed" } });
  t.mock.method(f.wildlife, "interact", () => assert.fail("No legacy horse interact"));
  const prepare = f.gameplay.prepareHandCost;
  const veto = t.mock.method(f.gameplay, "prepareHandCost", function (...args) {
    const paid = Reflect.apply(prepare, this, args);
    assert.ok(paid);
    return { ...paid, validate: () => false };
  });
  const before = f.ownership();
  assert.equal(f.game.useActions.tap(), false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.state(mob.id), null, "a refusal cannot retain a new tracked ID");
  veto.mock.restore();
  f.game.elapsed += 0.21;
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.gameplay.getHandStack("offhand").count, 1);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.horses.state(mob.id).temper, 3);
  assert.equal(f.horses.state(mob.id).tamed, false);
  assert.equal(f.game.useActions.use.active, false, "entity feeding never starts eating");
});

test("Game use keeps a committed horse mount when target and HUD observers throw", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  const targetError = new Error("post-mount target observer"), hudError = new Error("mount HUD observer");
  const updateTarget = f.game.updateTarget;
  let picks = 0;
  t.mock.method(f.game, "updateTarget", function (...args) {
    if (++picks === 2) throw targetError;
    return Reflect.apply(updateTarget, this, args);
  });
  t.mock.method(f.game, "refreshHud", () => { throw hudError; });
  assert.equal(f.game.useActions.tap(), true, "postcommit observers cannot invite a second mount");
  assert.equal(picks, 2);
  assert.equal(f.horses.mountFor().id, mob.id);
  assert.equal(f.wildlife.byId.get(mob.id), mob);
  assert.equal(f.player.vehicleType, "horse");
  assert.deepEqual(point(f.player.position), horseSeat(point(mob.position)));
  assert.deepEqual(f.game.useActions.observerErrors, [targetError, hudError]);
  assert.equal(f.vehicles.boats.mountFor(), null);
});

test("Game melee preserves saddle/leather/XP/tool atomicity and never uses legacy horse damage", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  const saddle = await f.saddle(mob);
  assert.equal(f.vehicles.dismount().ok, true);
  assert.equal(f.game.applyVehiclePose(), true);
  assert.equal(f.horses.hurt(mob, 20).ok, true);
  f.aim(mob);
  const sword = f.hold("IRON_SWORD");
  t.mock.method(f.wildlife, "damage", () => assert.fail("No legacy owned damage"));
  for (const [owner, method] of [
    [f.overflow, "prepareEnqueue"], [f.game.experienceOrbs, "prepareSpawn"],
  ]) {
    const prepare = owner[method];
    const veto = t.mock.method(owner, method, function (...args) {
      const part = Reflect.apply(prepare, this, args);
      assert.ok(part);
      return { ...part, validate: () => false };
    });
    const before = f.ownership();
    const plan = f.game.mobActions.prepareMelee(mob);
    assert.ok(plan.participants);
    assert.equal(plan.result.killed, true);
    assert.equal(f.game.mobActions.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), before);
    veto.mock.restore();
  }
  const plan = f.game.mobActions.prepareMelee(mob);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.horses, f.wildlife, f.gameplay, f.overflow, f.game.experienceOrbs]));
  const result = f.game.mobActions.commit(plan);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(result.handCostCommitted && result.dropsCommitted && result.experienceCommitted, true);
  assert.equal(f.gameplay.getHandStack().durability, sword.durability - 1);
  assert.equal(f.wildlife.byId.has(mob.id), false);
  assert.equal(f.wildlife.killed.has(mob.id), false);
  assert.deepEqual(f.horses.state(mob.id), { id: mob.id, dimension: "overworld", alive: false });
  const drops = f.overflow.serialize().entries;
  assert.equal(drops.filter((drop) => drop.id === ITEM.SADDLE).length, 1);
  assert.deepEqual(drops.find((drop) => drop.id === ITEM.SADDLE).data, saddle.data);
  assert.equal(drops.find((drop) => drop.id === ITEM.LEATHER).count,
    result.drops.find((drop) => drop.id === ITEM.LEATHER).count);
  assert.equal(f.game.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0),
    result.experience);
  const after = f.ownership();
  assert.equal(f.game.mobActions.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), after);
});

test("an owned bow hit pays its arrow and wear only with the horse death receipts", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  assert.equal(f.horses.hurt(mob, 23).ok, true);
  const bow = f.hold("BOW");
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots[9] = { id: ITEM.ARROW, count: 2 };
    return true;
  }), true);
  const shot = {
    hand: "main", itemId: ITEM.BOW, strength: 1,
    stackIdentity: stackIdentity(bow, f.context), handRevision: f.gameplay.getHandRevision(),
  };
  const prepare = f.overflow.prepareEnqueue;
  const veto = t.mock.method(f.overflow, "prepareEnqueue", function (...args) {
    const part = Reflect.apply(prepare, this, args);
    assert.ok(part);
    return { ...part, validate: () => false };
  });
  const before = f.ownership();
  assert.equal(f.game.useActions.fireBow(shot), false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.gameplay.getHandRevision(), shot.handRevision);
  veto.mock.restore();
  assert.equal(f.game.useActions.fireBow(shot), true);
  assert.equal(f.gameplay.countPlain(ITEM.ARROW), 1);
  assert.equal(f.gameplay.getHandStack().durability, bow.durability - 1);
  assert.equal(f.gameplay.getHandRevision(), shot.handRevision + 1);
  assert.equal(f.horses.state(mob.id).alive, false);
});

test("a committed owned bow release stays successful when shot and sound observers throw", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  assert.equal(f.horses.hurt(mob, 23).ok, true);
  const bow = f.hold("BOW");
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots[9] = { id: ITEM.ARROW, count: 2 };
    return true;
  }), true);
  const shot = {
    hand: "main", itemId: ITEM.BOW, strength: 1,
    stackIdentity: stackIdentity(bow, f.context), handRevision: f.gameplay.getHandRevision(),
  };
  const shotError = new Error("owned shot observer"), soundError = new Error("owned shot audio");
  const shoot = t.mock.method(f.game.effects, "shoot", () => { throw shotError; });
  const sound = t.mock.method(f.game.effects, "sound", () => { throw soundError; });
  assert.equal(f.game.useActions.fireBow(shot), true);
  assert.deepEqual(f.game.useActions.observerErrors, [shotError, soundError]);
  assert.equal(f.gameplay.countPlain(ITEM.ARROW), 1);
  assert.equal(f.gameplay.getHandStack().durability, bow.durability - 1);
  assert.equal(f.gameplay.getHandRevision(), shot.handRevision + 1);
  assert.equal(f.horses.state(mob.id).alive, false);
  assert.equal(f.wildlife.byId.has(mob.id), false);
  const paid = f.ownership();
  assert.equal(f.game.useActions.fireBow(shot), false, "a stale release cannot pay or reward twice");
  assert.deepEqual(f.ownership(), paid);
  assert.equal(shoot.mock.callCount(), 1);
  assert.equal(sound.mock.callCount(), 1);
});

for (const mode of ["survival", "creative"]) {
  test(`an owned ${mode} bow release rejects observer reentry without invalidating the next draw`, async (t) => {
    const f = await gameMobFixture(t), mob = f.spawn();
    assert.equal(f.horses.hurt(mob, 23).ok, true);
    f.hold("BOW");
    assert.equal(f.gameplay.inventoryTransaction((draft) => {
      draft.slots[9] = { id: ITEM.ARROW, count: 2 };
      return true;
    }), true);
    if (mode === "creative") {
      assert.equal(f.gameplay.setMode(mode), true);
      assert.equal(f.gameplay.assignSlot(0, ITEM.BOW), true);
    }
    const stack = f.gameplay.getHandStack(), use = f.game.useActions.use;
    assert.equal(use.start("bow", "main", stack, f.gameplay.getHandRevision()), true);
    for (let index = 0; index < 4; index++) use.advance(0.25);
    const shot = use.release();
    assert.ok(shot);
    Object.freeze(shot);
    assert.equal(shot.strength, 1);
    let notifications = 0, shots = 0;
    let changeReplay, shootReplay, nextDrawStarted, nextRevision;
    const onChange = f.gameplay.onChange, shoot = f.game.effects.shoot;
    t.mock.method(f.gameplay, "onChange", function (...args) {
      Reflect.apply(onChange, this, args);
      if (++notifications === 1) {
        changeReplay = f.game.useActions.fireBow(shot);
        nextDrawStarted = f.game.beginUse();
        nextRevision = use.handRevision;
      }
    });
    t.mock.method(f.game.effects, "shoot", function (...args) {
      if (++shots === 1)
        shootReplay = f.game.useActions.fireBow(Object.freeze({ ...shot }));
      return Reflect.apply(shoot, this, args);
    });
    assert.equal(f.game.useActions.fireBow(shot), true);
    assert.deepEqual(f.game.useActions.observerErrors, []);
    assert.equal(notifications, 1);
    assert.equal(shots, 1);
    assert.equal(changeReplay, false, "Gameplay observers see an already retired release");
    assert.equal(shootReplay, false, "presentation observers cannot replay a copied release");
    assert.equal(nextDrawStarted, true);
    assert.equal(nextRevision, shot.handRevision + 1);
    assert.equal(use.active, true);
    assert.equal(use.matches(f.gameplay.getHandStack(), f.gameplay.getHandRevision()), true);
    const debit = mode === "survival" ? 1 : 0;
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2 - debit);
    assert.deepEqual(f.gameplay.getHandStack(), { ...stack, durability: stack.durability - debit });
    assert.equal(f.horses.state(mob.id).alive, false);
    assert.equal(f.wildlife.byId.has(mob.id), false);
    const paid = f.ownership();
    assert.equal(f.game.useActions.fireBow(shot), false);
    assert.deepEqual(f.ownership(), paid);
    for (let index = 0; index < 4; index++) {
      f.game.elapsed += 0.25;
      f.game.useActions.update(0.25);
    }
    assert.equal(use.progress, 1);
    assert.equal(f.game.endUse(), true, "the draw begun during notification is not retired later");
    assert.equal(notifications, 2);
    assert.equal(shots, 2);
    assert.equal(f.gameplay.getHandRevision(), shot.handRevision + 2);
    assert.equal(f.gameplay.countPlain(ITEM.ARROW), 2 - 2 * debit);
    assert.deepEqual(f.gameplay.getHandStack(), { ...stack, durability: stack.durability - 2 * debit });
    assert.deepEqual(f.horses.serialize(), paid.archive.horses);
    assert.deepEqual(f.overflow.serialize(), paid.archive.overflow);
    assert.deepEqual(f.game.experienceOrbs.serialize(), paid.archive.experienceOrbs);
    assert.equal(use.active, false);
    assert.equal(f.game.endUse(), false);
  });
}

test("late Wildlife death publishes and consumes one airborne exit with no second player tick", async (t) => {
  const source = await gameMobFixture(t), originalMob = source.spawn();
  await source.saddle(originalMob);
  const saved = source.snapshot();
  for (const copy of [saved.mobs, saved.mobStates.overworld, saved.mobsByDimension.overworld,
    saved.ecology.mobsByDimension.overworld])
    copy.entities.find((mob) => mob.id === originalMob.id).position.y = 75;
  saved.horses.entries[0].motion = {
    vx: 1, vy: -2, vz: 0.5, grounded: false, fallDistance: 2,
  };
  Object.assign(saved.player, horseSeat({ x: 8.5, y: 75, z: 8.5 }));
  const f = await gameMobFixture(t, { saved }), mob = f.wildlife.byId.get(originalMob.id);
  const update = f.wildlife.update;
  let exit;
  t.mock.method(f.wildlife, "update", function (...args) {
    if (!exit) {
      const seat = f.vehicles.riderPose();
      const result = f.horses.hurt(mob, 999);
      assert.equal(result.ok, true, result.reason);
      exit = result.exit;
      assert.deepEqual(exit.position, seat.position);
      assert.deepEqual(exit.velocity, seat.velocity);
      assert.equal(exit.grounded, false);
      assert.equal(f.vehicles.poseForArchive().seated, false);
    }
    return Reflect.apply(update, this, args);
  });
  f.frame();
  assert.ok(exit);
  assert.deepEqual(point(f.player.position), exit.position);
  assert.deepEqual(point(f.player.velocity), exit.velocity);
  assert.equal(f.player.seated, false);
  assert.equal(f.player.vehicleType, null);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.takeExitPose(), null);
  assert.equal(f.game.experienceOrbs.serialize().orbs.length, 0, "environmental damage grants no player XP");
  const y = f.player.position.y;
  f.frame();
  assert.ok(f.player.position.y < y, "ordinary player falling resumes next frame only");
});

test("Game player death releases riding/cast/input but leaves the live horse in its source world", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const base = point(mob.position), life = f.projectiles.projectiles.life;
  f.hold("FISHING_ROD", { hand: "offhand" });
  assert.equal(f.vehicles.useHand("offhand").ok, true);
  f.key("Space");
  f.gameplay.damage(1000, "integration-death");
  assert.equal(f.gameplay.dead, true);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.vehicles.fishing.hasCast(), false);
  assert.equal(f.horses.state(mob.id).alive, true);
  assert.deepEqual(point(mob.position), base);
  assert.equal(f.wildlife.byId.get(mob.id), mob);
  assert.equal(f.player.seated, false);
  assert.equal(f.player._keys.size, 0);
  assert.equal(f.projectiles.projectiles.life, life + 1);
  assert.equal(f.vehicles.poseForArchive(), null);
});
