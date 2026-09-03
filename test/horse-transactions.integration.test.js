import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { horseClear } from "../src/horse-collision.js";
import { MAX_LIVING_HORSES } from "../src/horse-definitions.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { horseFixture, horseVeto } from "./horse-fixture.js";

test("natural-existing Wildlife horse gains only a sidecar, not another identity/pose/health collection", (t) => {
  const f = horseFixture(t);
  assert.equal(f.world.getBiome(8, 8).id, "plains", "generator query matches the authored biome volumes");
  let horse;
  for (let attempt = 0; attempt < 80 && !horse; attempt++) {
    f.wildlife.populate();
    horse = f.wildlife.entities.find((mob) => mob.kind === "horse" && horseClear(f.world, mob.position, false));
    for (const mob of [...f.wildlife.entities]) if (mob !== horse) f.wildlife.remove(mob);
  }
  assert.ok(horse, "actual natural Wildlife population must expose a horse");
  assert.equal(horse.id.includes(":local:"), false);
  f.actor.position = { x: horse.position.x, y: horse.position.y, z: horse.position.z + 3 };
  assert.equal(f.wildlife.damage(horse, 4).hit, true);
  f.hold("WHEAT");
  const result = f.horses.feed(horse.id);
  assert.equal(result.ok, true);
  assert.equal(result.handCostCommitted, true);
  assert.equal(horse.health, 22);
  assert.equal(f.gameplay.getHandStack(), null);
  assert.equal(f.horses.state(horse.id).temper, 3);
  assert.equal(f.horses.state(horse.id).tamed, false);
  assert.equal(horse.tamed, false, "base tamed belongs to wolf companions only");
  assert.equal(f.wildlife.byId.get(horse.id), horse);
  assert.equal(f.wildlife.entities.filter((mob) => mob.id === horse.id).length, 1);
  const saved = f.horses.serialize().entries[0];
  for (const field of ["position", "yaw", "health", "model"]) assert.equal(Object.hasOwn(saved, field), false);
  assert.equal(f.wildlife.interact(horse, ITEM.WHEAT), false, "legacy feed cannot bypass the real debit");
  assert.equal(f.wildlife.damage(horse, 1).reason, "prepared-horse-hit-required");
});

test("feeding debits the actual offhand in Survival and Creative without spending the main hand", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  const main = f.hold("STONE", { count: 12 });
  f.hold("WHEAT", { count: 2, hand: "offhand", data: { version: 1, name: "Horse feed" } });
  assert.equal(f.horses.feed(horse.id, { hand: "offhand" }).ok, true);
  assert.deepEqual(f.gameplay.getHandStack(), main);
  assert.equal(f.gameplay.offhand.count, 1);
  assert.equal(f.gameplay.offhand.data.name, "Horse feed");
  assert.equal(f.gameplay.setMode("creative"), true);
  assert.equal(f.horses.feed(horse.id, { hand: "offhand" }).ok, true);
  assert.equal(f.gameplay.offhand, null);
  assert.deepEqual(f.gameplay.slots[0], main);
  assert.equal(f.horses.state(horse.id).temper, 6);
  assert.equal(f.horses.state(horse.id).tamed, false);
});

test("feed has one participant per owner and capacity/budget/veto refusal changes nothing", (t) => {
  const f = horseFixture(t), horse = f.spawn();
  f.hold("WHEAT", { count: 3 });
  const veto = horseVeto(t, f.coordinator);
  const plan = f.horses.prepareFeed(horse.id);
  assert.equal(plan.ok, true);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.horses, f.wildlife, f.gameplay]));
  const before = f.ownership();
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.ownership(), before);
  const blocker = {};
  assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  const full = f.ownership();
  assert.equal(f.horses.feed(horse.id).ok, false);
  assert.deepEqual(f.ownership(), full);
  assert.equal(f.coordinator.release(blocker), true);
  assert.equal(f.horses.commit(plan).ok, true, "a pre-publication veto does not spend the prepared action");
  assert.equal(f.horses.commit(plan).ok, false, "successful publication is single-use");

  for (let index = 1; index < MAX_LIVING_HORSES; index++) {
    const other = f.spawn(`horse:capacity:${index}`);
    f.hold("WHEAT");
    assert.equal(f.horses.feed(other.id).ok, true);
  }
  const ninth = f.spawn("horse:ninth");
  f.hold("WHEAT");
  const capacity = f.ownership();
  assert.equal(f.horses.feed(ninth.id).ok, false);
  assert.equal(f.horses.mount(ninth.id).ok, false);
  assert.deepEqual(f.ownership(), capacity);
});

test("held identity, complete base pose, world edits and availability are rechecked at commit", (t) => {
  let available = true;
  const f = horseFixture(t, { hooks: { available: () => available } }), horse = f.spawn();
  f.hold("APPLE", { count: 2 });
  let plan = f.horses.prepareFeed(horse.id);
  f.hold("APPLE", { count: 2 });
  let before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  plan = f.horses.prepareFeed(horse.id);
  horse.root.rotation.y += 0.1;
  before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false, "yaw changes are base ownership changes");
  assert.deepEqual(f.ownership(), before);
  plan = f.horses.prepareFeed(horse.id);
  f.put([[9, 4, 9, BLOCK.STONE]]);
  before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  plan = f.horses.prepareFeed(horse.id);
  available = false;
  before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
});

test("saddle slot conserves named copies across cursor, backpack and riding with a full inventory", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn());
  const saddle = f.saddle(horse);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots = draft.slots.map(() => ({ id: BLOCK.STONE, count: 64 }));
    return true;
  }), true);
  t.mock.method(f.overflow, "prepareEnqueue", () => assert.fail("ordinary slot movement needs no overflow sink"));
  let result = f.horses.slotAction(horse.id, { type: "click", area: "container", index: 0, button: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(f.gameplay.cursor, saddle);
  assert.equal(f.horses.state(horse.id).saddle, null);
  assert.equal(f.horses.mountFor().id, horse.id, "saddle removal leaves a bareback rider");
  assert.equal(f.horses.getHorse(horse.id).controlled, false);
  assert.equal(f.horses.slotAction(horse.id, { type: "click", area: "container", index: 0, button: 2 }).ok, true);
  assert.equal(f.gameplay.cursor, null);
  assert.deepEqual(f.horses.state(horse.id).saddle, saddle);
  const before = f.ownership();
  assert.equal(f.horses.slotAction(horse.id, { type: "quickMove", area: "container", index: 0 }).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.gameplay.inventoryTransaction((draft) => { draft.slots[9] = null; return true; }), true);
  result = f.horses.slotAction(horse.id, { type: "quickMove", area: "container", index: 0 });
  assert.equal(result.ok, true);
  assert.deepEqual(f.gameplay.slots[9], saddle);
  assert.equal(f.horses.state(horse.id).saddle, null);
  assert.equal(f.horses.slotAction(horse.id, { type: "quickMove", area: "inventory", index: 9 }).ok, true);
  const plan = f.horses.prepareSlotAction(horse.id, {
    type: "swapHotbar", area: "container", index: 0, hotbarIndex: 1,
  });
  assert.equal(plan.ok, false, "non-saddles cannot be swapped into a horse");
  assert.deepEqual(f.horses.state(horse.id).saddle, saddle);
});

test("saddle insertion veto and stale cursor cannot duplicate or lose the held stack", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn()), stack = f.hold("SADDLE");
  const veto = horseVeto(t, f.coordinator);
  let plan = f.horses.prepareSlotAction(horse.id, {
    type: "quickMove", area: "inventory", index: f.gameplay.selected,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.participants.filter((part) => part.owner === f.gameplay).length, 1);
  let before = f.ownership();
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    draft.slots[f.gameplay.selected] = null;
    draft.cursor = stack;
    return true;
  }), true);
  before = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), before);
  plan = f.horses.prepareSlotAction(horse.id, { type: "click", area: "container", index: 0, button: 0 });
  assert.equal(f.horses.commit(plan).ok, true);
  assert.equal(f.gameplay.cursor, null);
  assert.deepEqual(f.horses.state(horse.id).saddle, stack);
});

test("tracked death atomically retains all leather/saddle, XP and tool cost, then permanently seals identity", (t) => {
  const f = horseFixture(t), horse = f.tame(f.spawn()), saddle = f.saddle(horse);
  const sword = f.hold("IRON_SWORD");
  const wear = f.gameplay.prepareHandCost("main", { stack: sword,
    handRevision: f.gameplay.getHandRevision("main"), wear: 1, notify: false });
  const plan = f.horses.prepareHit(horse.id, 1000, { x: 0, y: 0, z: -1 }, {
    playerKill: true, validate: () => true, participants: [wear],
  });
  assert.equal(plan.ok, true);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
  assert.equal(plan.participants.filter((part) => part.owner === f.overflow).length, 1);
  const before = f.ownership(), veto = horseVeto(t, f.coordinator);
  assert.equal(f.coordinator.commit([...plan.participants, veto]).ok, false);
  assert.deepEqual(f.ownership(), before);
  const result = f.horses.commit(plan);
  assert.equal(result.ok, true);
  assert.equal(result.killed, true);
  assert.equal(result.handCostCommitted, true);
  assert.equal(result.dropsCommitted, true);
  assert.equal(result.experienceCommitted, true);
  assert.equal(f.gameplay.getHandStack().durability, sword.durability - 1);
  assert.equal(f.horses.mountFor(), null);
  assert.equal(f.wildlife.byId.has(horse.id), false);
  assert.deepEqual(f.horses.state(horse.id), { id: horse.id, dimension: "overworld", alive: false });
  assert.equal(f.totals().xp, result.experience);
  const retainedSaddle = f.totals().drops.find((drop) => drop.id === ITEM.SADDLE);
  assert.equal(retainedSaddle.count, 1);
  assert.deepEqual(retainedSaddle.data, saddle.data);
  assert.equal(f.totals().drops.filter((drop) => drop.id === ITEM.LEATHER)
    .reduce((sum, drop) => sum + drop.count, 0), result.drops.find((stack) => stack.id === ITEM.LEATHER).count);
  assert.equal(f.wildlife.killed.has(horse.id), false, "no evicting legacy tombstone copy");
  assert.equal(f.wildlife.spawn("horse", horse.position, { id: horse.id }), null);
  const after = f.ownership();
  assert.equal(f.horses.commit(plan).ok, false);
  assert.equal(f.horses.hurt(horse, 999).hit, false);
  assert.deepEqual(f.ownership(), after);
});

test("required drop or XP sink refusal leaves base, saddle, rider, health and tool intact", (t) => {
  for (const hook of ["prepareDrops", "prepareExperience"]) {
    const f = horseFixture(t, { hooks: { [hook]: () => null } }), horse = f.tame(f.spawn());
    f.saddle(horse);
    const sword = f.hold("IRON_SWORD");
    const wear = f.gameplay.prepareHandCost("main", { stack: sword,
      handRevision: f.gameplay.getHandRevision(), wear: 1, notify: false });
    const before = f.ownership();
    const plan = f.horses.prepareHit(horse.id, 999, null,
      { playerKill: true, validate: () => true, participants: [wear] });
    assert.equal(plan.ok, false, hook);
    assert.deepEqual(f.ownership(), before, hook);
    assert.equal(f.wildlife.byId.get(horse.id), horse);
  }
});

test("real overflow capacity cannot split a lethal leather-plus-saddle transaction", (t) => {
  const f = horseFixture(t, { overflowEntries: 1 }), horse = f.tame(f.spawn());
  f.saddle(horse);
  const before = f.ownership();
  const result = f.horses.hurt(horse, 999);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "drop-rejected");
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.mountFor().id, horse.id);
  assert.equal(f.overflow.serialize().entries.length, 0);
});

test("committed exit ownership exists before a throwing death observer or a save", (t) => {
  let observed = false, f;
  f = horseFixture(t, { hooks: { onEvent: (event) => {
    if (event.type !== "death") return;
    observed = f.horses.mountFor() === null && !f.wildlife.byId.has(event.id) &&
      f.horses.poseForArchive()?.position.x === event.exit.position.x;
    throw new Error("Intentional postcommit observer failure");
  } } });
  const horse = f.tame(f.spawn());
  const result = f.horses.hurt(horse, 999);
  assert.equal(result.ok, true);
  assert.equal(observed, true);
  assert.equal(result.observerErrors.length, 1);
  assert.ok(f.horses.takeExitPose());
  assert.equal(f.horses.takeExitPose(), null);
});
