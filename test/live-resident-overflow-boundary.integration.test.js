import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { ecologyDeathReward } from "../src/expansion-ecology.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { horseStableDraw } from "../src/horse-taming.js";
import { normalizePotionData } from "../src/item-stack-data.js";
import { ITEM } from "../src/items.js";
import { combatBeach } from "./combat-effects-fixture.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

// Authored habitat, residents and finite stock. The first three cases exercise
// production Game entry points and owners; the fourth is an intentionally authored
// API-only negative control, not a reachable Game action.
// No GPU, success mocks or synthetic participant clones.
async function liveRoster(t, health = 1) {
  const f = await gameMobFixture(t, {
    seed: "live-overflow-boundary", generatorVersion: 4, generatorFactory: combatBeach,
  });
  const horses = [
    f.spawn("live-overflow:horse-a", { x: 6.5, y: 65, z: 9.5 }),
    f.spawn("live-overflow:horse-b", { x: 8.5, y: 65, z: 9.5 }),
  ];
  const turtles = [{ x: 10.5, y: 65, z: 9.5 }, { x: 11.5, y: 65, z: 8.5 }]
    .map((position) => {
      const plan = f.ecology.prepareAdmission("turtle", position);
      assert.ok(plan);
      assert.equal(f.ecology.commit(plan).ok, true);
      return f.wildlife.byId.get(plan.result.id);
    });
  for (const [owner, residents] of [[f.horses, horses], [f.ecology, turtles]])
    for (const mob of residents) {
      const amount = mob.health - health;
      assert.equal(owner.hurt(mob, amount, null, { retaliate: false }).damage, amount);
      assert.equal(mob.health, health);
    }
  assert.ok(f.game.active && f.game.simulating);
  assert.ok(f.game.inventoryActions instanceof GameInventoryActions);
  assert.equal(f.game.vehicleServices.horses, f.wildlife.horseServices);
  assert.equal(f.game.ecologyServices, f.wildlife.ecologyServices);
  return Object.assign(f, { horsesUnderTest: horses, turtles, residents: [...horses, ...turtles] });
}

// Observation only: every call returns the original exact participant/plan.
// Small counters and bounded records keep even full Game-frame traces finite.
function observeBoundary(t, f) {
  const native = new WeakSet();
  const trace = {
    nativeAdditions: 0, inventoryWrappers: 0, inventoryNativeSources: 0,
    groupSizes: [], aggregates: [], batches: [], deathCommits: [],
  };
  const append = (list, entry) => {
    assert.ok(list.length < 64, "bounded focused owner trace");
    list.push(entry);
  };
  const add = f.overflow.prepareAddBatch;
  t.mock.method(f.overflow, "prepareAddBatch", function (...args) {
    const part = Reflect.apply(add, this, args);
    if (part) { native.add(part); trace.nativeAdditions++; }
    return part;
  });
  const bind = f.game.inventoryActions._bindPreparedDrops;
  t.mock.method(f.game.inventoryActions, "_bindPreparedDrops", function (...args) {
    const part = Reflect.apply(bind, this, args);
    if (part) {
      trace.inventoryWrappers += Number(part !== args[0]);
      trace.inventoryNativeSources += Number(native.has(args[0]));
    }
    return part;
  });
  const groups = f.game.inventoryActions.prepareDropItemGroups;
  t.mock.method(f.game.inventoryActions, "prepareDropItemGroups", function (...args) {
    append(trace.groupSizes, args[0].length);
    return Reflect.apply(groups, this, args);
  });
  const aggregate = f.overflow.prepareParticipantBatch;
  t.mock.method(f.overflow, "prepareParticipantBatch", function (parts) {
    const members = parts.map((part) => ({
      native: native.has(part), frozen: Object.isFrozen(part), valid: part.validate() === true,
    }));
    const combined = Reflect.apply(aggregate, this, [parts]);
    append(trace.aggregates, { members, accepted: combined !== null });
    return combined;
  });
  const finalize = f.wildlife.finalizeResidentEditBatch;
  t.mock.method(f.wildlife, "finalizeResidentEditBatch", function (batch, options = {}) {
    const inputOverflow = (options.participants ?? []).filter((part) => part.owner === f.overflow).length;
    const count = options.contributions?.length ?? 0;
    const plan = Reflect.apply(finalize, this, [batch, options]);
    if (inputOverflow || count > 1)
      append(trace.batches, {
        contributions: count, inputOverflow, accepted: plan !== null,
        outputOverflow: plan?.participants.filter((part) => part.owner === f.overflow).length ?? 0,
      });
    return plan;
  });
  const commit = f.coordinator.commit;
  t.mock.method(f.coordinator, "commit", function (parts) {
    const relevant = parts.some((part) => part.owner === f.wildlife) &&
      parts.some((part) => part.owner === f.overflow);
    const result = Reflect.apply(commit, this, [parts]);
    if (relevant) append(trace.deathCommits, {
      ok: result.ok, reason: result.reason,
      owners: parts.map((part) => part.owner.constructor.name),
      overflow: parts.filter((part) => part.owner === f.overflow).length,
    });
    return result;
  });
  return trace;
}

function totalDrops(records) {
  const totals = {};
  for (const { id, count } of records) totals[id] = (totals[id] ?? 0) + count;
  return totals;
}

function expectedRewards(f, playerCredit) {
  const drops = [];
  let experience = 0;
  for (const mob of f.horsesUnderTest) {
    drops.push({ id: ITEM.LEATHER, count: 1 +
      Math.floor(horseStableDraw(f.context, mob.id, f.world.dimension, "leather") * 2) });
    if (playerCredit) experience += 1 +
      Math.floor(horseStableDraw(f.context, mob.id, f.world.dimension, "experience") * 3);
  }
  for (const mob of f.turtles) {
    const reward = ecologyDeathReward(mob.kind, playerCredit, {
      seed: f.world.seed, generatorVersion: f.world.generatorVersion,
      dimension: f.world.dimension, id: mob.id,
      baby: !f.ecology.ecology.state(mob.id).scuteClaimed,
    });
    drops.push(...reward.drops.map(({ name, count }) => ({ id: ITEM[name] ?? BLOCK[name], count })));
    experience += reward.experience;
  }
  return { drops: totalDrops(drops), experience };
}

function actualRewards(f, expected) {
  const drops = [...f.overflow.serialize().entries, ...f.game.pickups.serialize().items];
  return {
    // The real creeper also breaks sand; only resident-resource IDs belong here.
    drops: totalDrops(drops.filter(({ id }) => Object.hasOwn(expected.drops, id))),
    experience: f.game.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0),
  };
}

function throwFromGame(f, id) {
  f.hold("SPLASH_POTION", { data: {
    version: 1, potion: normalizePotionData({ id, form: "splash" }),
  } });
  f.player.yaw = 0;
  f.player.pitch = -Math.PI / 9;
  f.player._syncCamera(0);
  assert.equal(f.withGlobals(() => f.game.useActions.tap()), true);
  assert.equal(f.gameplay.getHandStack(), null, "the finite thrown bottle is paid once");
  assert.equal(f.progression.services.potions.size, 1);
}

function finishFlight(f) {
  let frames = 0;
  while (f.progression.services.potions.size && frames < 16) { f.frame(); frames++; }
  return frames;
}

test("Game paid splash kills mixed residents using one guarded inventory drop participant", async (t) => {
  const f = await liveRoster(t), expected = expectedRewards(f, true);
  const trace = observeBoundary(t, f);
  throwFromGame(f, "harming");
  finishFlight(f);
  const actual = actualRewards(f, expected);
  assert.equal(f.progression.services.potions.size, 0);
  assert.ok(f.residents.every((mob) => mob.dead));
  assert.deepEqual(trace.groupSizes, [4]);
  assert.deepEqual(trace.batches, [
    { contributions: 4, inputOverflow: 1, accepted: true, outputOverflow: 1 },
  ]);
  assert.equal(trace.inventoryWrappers, 1);
  assert.equal(trace.inventoryNativeSources, 1);
  assert.deepEqual(trace.aggregates, []);
  assert.equal(trace.deathCommits.length, 1);
  assert.ok(trace.deathCommits.every(({ ok, overflow }) => ok && overflow === 1));
  assert.deepEqual(actual, expected);
});

test("Game unmodified creeper fuse resolves mixed deaths in separate single-victim commits", async (t) => {
  const f = await liveRoster(t), expected = expectedRewards(f, false);
  const source = f.wildlife.spawn("creeper", { x: 8.5, y: 65, z: 10 }, {
    id: "live-overflow:creeper",
  });
  assert.ok(source);
  assert.equal(source.fuse, 0);
  const trace = observeBoundary(t, f);
  let frames = 0;
  while (!source.dead && frames < 48) { f.frame(); frames++; }
  const actual = actualRewards(f, expected);
  assert.equal(source.dead, true);
  assert.ok(source.fuse >= 1.65);
  assert.ok(f.residents.every((mob) => mob.dead));
  assert.deepEqual(trace.aggregates, []);
  assert.equal(trace.batches.length, 4);
  assert.ok(trace.batches.every(({ contributions, inputOverflow, accepted, outputOverflow }) =>
    contributions === 1 && inputOverflow === 1 && accepted && outputOverflow === 1));
  assert.equal(trace.deathCommits.length, 4);
  assert.ok(trace.deathCommits.every(({ ok, overflow }) => ok && overflow === 1));
  assert.deepEqual(actual, expected);
});

test("Game poison pulses reach the nonlethal floor without producing competing drop participants", async (t) => {
  const f = await liveRoster(t, 2), trace = observeBoundary(t, f);
  throwFromGame(f, "poison");
  finishFlight(f);
  f.frame(60);
  assert.equal(f.progression.services.potions.size, 0);
  assert.ok(f.residents.every((mob) => !mob.dead && mob.health === 1));
  assert.equal(trace.nativeAdditions, 0);
  assert.deepEqual(trace.aggregates, []);
  assert.deepEqual(trace.deathCommits, []);
  assert.ok(trace.batches.every(({ inputOverflow }) => inputOverflow === 0));
});

test("API-only control: manually combined real guarded horse drops reject without any publication", async (t) => {
  const f = await liveRoster(t), before = f.ownership();
  const trace = observeBoundary(t, f);
  // Deliberately authored composition, NOT a reachable Game action. This is
  // the acceptance boundary to revisit before activating a new shared caller.
  const batch = f.wildlife.beginResidentEditBatch();
  const contributions = [
    ...f.horsesUnderTest.map((mob) => f.horses.contributeHit(batch, mob.id, 1, null)),
    ...f.turtles.map((mob) => f.ecology.contributeHit(batch, mob.id, 1, null)),
  ];
  assert.ok(contributions.every((part) => part?.complete === false));
  const plan = f.wildlife.finalizeResidentEditBatch(batch, {
    contributions, participants: contributions.flatMap((part) => part.peers),
  });
  assert.equal(plan, null);
  assert.equal(trace.aggregates.length, 1);
  assert.deepEqual(trace.aggregates[0], {
    members: [
      { native: false, frozen: true, valid: true }, { native: false, frozen: true, valid: true },
      { native: true, frozen: true, valid: true }, { native: true, frozen: true, valid: true },
    ],
    accepted: false,
  });
  assert.deepEqual(f.ownership(), before);
  assert.deepEqual(trace.deathCommits, []);
});
