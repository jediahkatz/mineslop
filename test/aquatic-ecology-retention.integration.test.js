import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { MELEE_COOLDOWN_SECONDS } from "../src/combat-feedback.js";
import { ecologyDeathReward, ECOLOGY_LIMITS } from "../src/expansion-ecology.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import {
  combatBeach, combatFixture, combatOcean, combatState, equip, uniqueAttackOwners,
} from "./combat-effects-fixture.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

const stacks = (entries) => entries.map(({ id, count }) => ({ id, count }));
const retained = (f) => stacks(f.overflow.serialize().entries);
const loose = (f) => stacks(f.game.pickups.serialize().items);
const xp = (f) => f.game.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0);
const ownership = (f) => ({
  archive: f.snapshot(), combat: combatState(f), rng: f.wildlife.randomState,
});

function reward(f, playerKill = true,
  baby = f.mob.kind === "turtle" && !f.ecology.ecology.state(f.mob.id).scuteClaimed) {
  const quote = ecologyDeathReward(f.mob.kind, playerKill, {
    seed: f.world.seed, generatorVersion: f.world.generatorVersion,
    dimension: f.world.dimension, id: f.mob.id, baby,
  });
  return { ...quote, drops: quote.drops.map(({ name, count }) => ({ id: ITEM[name], count })) };
}

function aim(f) {
  const baby = f.mob.kind === "turtle" && !f.ecology.ecology.state(f.mob.id).scuteClaimed;
  f.aim(f.mob, f.mob.spec.height / (baby ? 4 : 2));
  f.game.updateTarget();
  // Compare the boolean, not a cyclic live entity, on an authored-pose failure.
  assert.equal(f.game.meleeTarget?.entity === f.mob, true, "the real ray must select this resident");
}

function primary(f) {
  aim(f);
  f.game.primary(0.05, true);
}

function lastWearFixture(f) {
  assert.equal(f.mob.health, f.mob.spec.health);
  const remaining = f.mob.health - 1;
  const damage = f.ecology.hurt(f.mob, remaining, null, { retaliate: false });
  assert.equal(damage.damage, remaining, "public nonlethal setup damage, not an injected corpse");
  assert.equal(damage.killed, false);
  assert.equal(f.mob.health, 1);
  equip(f, { durability: 1 });
  assert.deepEqual(retained(f), []);
  assert.deepEqual(loose(f), []);
  assert.equal(xp(f), 0);
}

function assertFinalHandPayment(f, before, hits) {
  const paid = structuredClone(before.archive.gameplay);
  assert.deepEqual(paid.inventory, [{ id: ITEM.IRON_SWORD, count: 1 }]);
  assert.equal(paid.slots[paid.selected].durability, hits);
  paid.slots[paid.selected] = null;
  paid.exhaustion += hits * 0.1;
  // The archive carries compatibility projections as well as canonical slots.
  paid.inventory = [];
  paid.durability = {};
  paid.hotbar[paid.selected] = 0;
  paid.survivalHotbar[paid.survivalSelected] = 0;
  assert.deepEqual(f.gameplay.serialize(), paid, "only the final tool and attack exhaustion are spent");
  // Ongoing self-use wear preserves hand identity; breaking the stack changes it once.
  assert.equal(f.gameplay.getHandRevision(), before.combat.mainRevision + 1);
}

function fillSlot(f, id) {
  const size = f.overflow.size;
  const plan = f.overflow.prepareEnqueue([{ id, count: 1 }], point(f.mob.position), f.world.dimension);
  assert.ok(plan, "authored filler must occupy a real retained record");
  assert.equal(f.coordinator.commit([plan]).ok, true);
  assert.equal(f.overflow.size, size + 1, "distinct fillers must not merge");
}

function releaseSlot(f, id) {
  const before = ownership(f), size = f.overflow.size;
  const key = [...f.overflow.entries].find(([, entry]) => entry.id === id)?.[0];
  assert.equal(typeof key, "string");
  const plan = f.overflow.prepareFlushRecord(key, f.world, f.game.pickups);
  assert.ok(plan, "capacity is released through the real pickup receiver");
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.overflow, f.game.pickups]));
  assert.deepEqual(ownership(f), before, "preparing a flush cannot publish either owner");
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.overflow.size, size - 1);
  assert.deepEqual(loose(f).filter((drop) => drop.id === id), [{ id, count: 1 }]);
  assert.deepEqual(f.gameplay.serialize(), before.archive.gameplay);
  assert.deepEqual(f.ecology.ecology.serialize(), before.combat.ecology);
  assert.equal(f.wildlife.randomState, before.rng);
}

function refusePrimary(f) {
  aim(f);
  const before = ownership(f), expected = reward(f);
  for (let attempt = 0; attempt < 3; attempt++) {
    primary(f);
    assert.deepEqual(ownership(f), before,
      "refusal preserves every archived owner, RNG, hand revisions, exhaustion and cooldown");
    assert.deepEqual(reward(f), expected, "retry cannot reroll a positive quote");
    assert.equal(f.mob.dead, false);
    assert.equal(f.mob.health, 1);
    assert.equal(f.gameplay.getHandStack().durability, 1);
  }
}

function assertRetired(f) {
  assert.equal(f.mob.health, 0);
  assert.equal(f.mob.dead, true);
  assert.equal(f.wildlife.byId.has(f.mob.id), false);
  assert.equal(f.wildlife.killed.has(f.mob.id), false, "Ecology, not the legacy kill set, owns retirement");
  assert.equal(f.ecology.ecology.state(f.mob.id).alive, false);
}

function assertNoReplay(f, plan) {
  const committed = ownership(f);
  assert.equal(f.game.mobActions.commit(plan).ok, false);
  assert.equal(f.game.hitMob(f.mob, 100).ok, false);
  assert.equal(f.ecology.hurt(f.mob, 100, null, { retaliate: false }).hit, false);
  assert.deepEqual(ownership(f), committed, "stale plans and dead references cannot pay twice");
}

function playerDeath(f, expected) {
  aim(f);
  const before = ownership(f);
  const plan = f.game.mobActions.prepareMelee(f.mob);
  uniqueAttackOwners(f, plan.participants);
  assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
    new Set([f.gameplay, f.wildlife, f.ecology.ecology, f.overflow, f.game.experienceOrbs]));
  assert.deepEqual(ownership(f), before, "positive death preparation is read-only");
  primary(f);
  assertRetired(f);
  assert.deepEqual(retained(f), expected.drops);
  assert.equal(xp(f), expected.experience);
  assertFinalHandPayment(f, before, 1);
  assert.equal(f.game.lastAction, f.game.elapsed);
  assert.equal(f.wildlife.randomState, before.rng);
  assert.deepEqual(f.game.pickups.serialize(), before.archive.pickups);
  assert.deepEqual(f.progression.services.effects.serialize(), before.combat.effects);
  assert.deepEqual(f.progression.services.stations.serialize(), before.combat.stations);
  assertNoReplay(f, plan);
}

async function coldRetirement(t, f, generatorFactory) {
  const frozen = ownership(f), saved = parseWorldFile(exportWorldFile(frozen.archive));
  // JSON represents a signed-zero aim angle as zero; no owner may otherwise be repaired.
  assert.deepEqual(saved, JSON.parse(JSON.stringify(frozen.archive)));
  const again = await gameMobFixture(t, {
    saved, generatorFactory, overflowMaxEntries: f.overflow.maxEntries,
  });
  const reloaded = again.snapshot();
  assert.deepEqual(Object.keys(reloaded).sort(), Object.keys(saved).sort());
  // Loaded-column scans are residency metadata; compare every fluid resource and clock.
  const fluidResources = (fluids) => ({
    ...fluids, dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  });
  for (const key of Object.keys(saved))
    assert.deepEqual(key === "fluids" ? fluidResources(reloaded[key]) : reloaded[key],
      key === "fluids" ? fluidResources(saved[key]) : saved[key], `cold owner: ${key}`);
  assert.equal(again.wildlife.byId.has(f.mob.id), false);
  assert.equal(again.ecology.ecology.state(f.mob.id).alive, false);
  assert.equal(again.wildlife.randomState, frozen.rng);
  for (const [previous, restored] of [
    [f.gameplay, again.gameplay], [f.overflow, again.overflow],
    [f.ecology.ecology, again.ecology.ecology], [f.game.experienceOrbs, again.game.experienceOrbs],
  ]) assert.equal(again.coordinator.usage(restored), f.coordinator.usage(previous));
  const beforeReplay = ownership(again);
  assert.equal(again.game.hitMob(f.mob, 100).ok, false);
  assert.equal(again.ecology.hurt(f.mob, 100, null, { retaliate: false }).hit, false);
  assert.deepEqual(ownership(again), beforeReplay);
  assert.deepEqual(ownership(f), frozen, "cold reconstruction cannot alter the frozen source");
  return again;
}

// Authored habitat, finite tools and nonlethal setup damage isolate Game input
// and retained ownership. These are not native acquisition or played-time claims.
test("positive dolphin cod survives full overflow refusal, primary retry and cold escrow", async (t) => {
  const f = await combatFixture(t, "dolphin", {
    seed: "aquatic-positive-dolphin:1", overflowMaxEntries: 1,
  });
  assert.equal(f.mob.id, "overworld:ecology:0");
  assert.equal(f.world.generatorVersion, 4);
  const expected = reward(f);
  assert.deepEqual(expected, { drops: [{ id: ITEM.RAW_COD, count: 1 }], experience: 1 },
    "this fixed identity MUST exercise positive cod retention, not an empty quote");
  lastWearFixture(f);
  fillSlot(f, BLOCK.COBBLESTONE);
  assert.equal(f.overflow.size, f.overflow.maxEntries);
  refusePrimary(f);
  releaseSlot(f, BLOCK.COBBLESTONE);
  assert.equal(f.overflow.size, 0);
  playerDeath(f, expected);
  await coldRetirement(t, f, combatOcean);
});

for (const playerKill of [true, false])
  test(`drowned ${playerKill ? "player" : "environment"} death respects full and one-free-slot material capacity`, async (t) => {
    const f = await combatFixture(t, "drowned", { overflowMaxEntries: 2 });
    const playerQuote = reward(f), environmentQuote = reward(f, false);
    assert.deepEqual(playerQuote, {
      drops: [{ id: ITEM.ROTTEN_FLESH, count: 1 }, { id: ITEM.COPPER_INGOT, count: 1 }],
      experience: 5,
    }, "two distinct positive records are required to detect partial payment");
    assert.deepEqual(environmentQuote, {
      drops: [{ id: ITEM.ROTTEN_FLESH, count: 1 }], experience: 0,
    });
    lastWearFixture(f);
    fillSlot(f, BLOCK.COBBLESTONE);
    fillSlot(f, BLOCK.DIRT);
    assert.equal(f.overflow.size, f.overflow.maxEntries);
    refusePrimary(f);
    const full = ownership(f);
    for (let attempt = 0; attempt < 3; attempt++) {
      assert.equal(f.ecology.hurt(f.mob, 100, null, { retaliate: false }).hit, false);
      assert.deepEqual(ownership(f), full, "full material retention also vetoes environmental death");
    }

    releaseSlot(f, BLOCK.COBBLESTONE);
    assert.equal(f.overflow.maxEntries - f.overflow.size, 1);
    const oneSlot = ownership(f), at = point(f.mob.position);
    for (const drop of playerQuote.drops)
      assert.ok(f.overflow.prepareEnqueue([drop], at, f.world.dimension, { pickupDelay: 0.4 }),
        "either reward alone fits, so refusal must be all-or-nothing");
    assert.equal(f.overflow.prepareEnqueue(playerQuote.drops, at, f.world.dimension,
      { pickupDelay: 0.4 }), null);
    assert.deepEqual(ownership(f), oneSlot, "even partial quote preparation cannot publish flesh");
    refusePrimary(f);
    if (playerKill) {
      releaseSlot(f, BLOCK.DIRT);
      assert.equal(f.overflow.size, 0);
      playerDeath(f, playerQuote);
    } else {
      const before = ownership(f);
      const plan = f.ecology.prepareHit(f.mob.id, 100, null, { playerKill: false, retaliate: false });
      assert.ok(plan);
      assert.deepEqual(new Set(plan.participants.map((part) => part.owner)),
        new Set([f.wildlife, f.ecology.ecology, f.overflow]));
      assert.deepEqual(ownership(f), before);
      assert.equal(f.ecology.hurt(f.mob, 100, null, { retaliate: false }).killed, true);
      assertRetired(f);
      assert.deepEqual(retained(f), [{ id: BLOCK.DIRT, count: 1 }, ...environmentQuote.drops],
        "one free slot is enough for environmental flesh, never player-only copper");
      assert.equal(xp(f), 0);
      assert.deepEqual(f.gameplay.serialize(), before.archive.gameplay);
      assert.equal(f.gameplay.getHandRevision(), before.combat.mainRevision);
      assert.equal(f.game.lastAction, before.combat.lastAction);
      assert.equal(f.wildlife.randomState, before.rng);
      assert.deepEqual(f.game.pickups.serialize(), before.archive.pickups);
      assert.deepEqual(f.progression.services.effects.serialize(), before.combat.effects);
      assert.deepEqual(f.progression.services.stations.serialize(), before.combat.stations);
      assertNoReplay(f, plan);
    }
    await coldRetirement(t, f, combatOcean);
  });

async function hatchFixture(t) {
  const parents = await combatFixture(t, "turtle");
  const mother = parents.mob;
  const admission = parents.ecology.prepareAdmission("turtle", {
    x: mother.position.x + 1.4, y: mother.position.y, z: mother.position.z,
  });
  assert.ok(admission);
  assert.equal(parents.ecology.commit(admission).ok, true);
  const father = parents.wildlife.byId.get(admission.result.id);
  parents.hold("SEAGRASS", { count: 2 });
  for (const mob of [mother, father]) {
    const feed = parents.ecology.prepareInteraction(mob.id);
    assert.ok(feed);
    assert.equal(parents.ecology.commit(feed).ok, true);
  }
  assert.equal(parents.gameplay.getHandStack(), null);
  const breed = parents.ecology.ecology.prepareBreeding(mother, father, parents.wildlife.context);
  assert.ok(breed);
  assert.equal(parents.ecology.commit(breed).ok, true);
  assert.equal(breed.result.motherId, mother.id);
  const lay = parents.ecology.prepareLayEgg(mother.id);
  assert.ok(lay);
  assert.equal(parents.ecology.commit(lay).ok, true);
  const egg = parents.ecology.ecology.egg(lay.result.eggId);
  assert.equal(parents.world.get(egg.position.x, egg.position.y, egg.position.z), BLOCK.TURTLE_EGG);
  assert.equal(egg.remaining, ECOLOGY_LIMITS.eggHatch);
  assert.equal(parents.ecology.ecology.identityReserved(egg.childId), true);
  // Retire parents through actual environmental transactions so no adult body
  // occludes the hatchling's physical ray. Their legitimate drops remain owned.
  for (const mob of [mother, father])
    assert.equal(parents.ecology.hurt(mob, 100, null, { retaliate: false }).killed, true);
  parents.overflow.flush(parents.world, parents.game.pickups);
  assert.equal(parents.overflow.size, 0);
  assert.equal(xp(parents), 0);
  assert.equal(loose(parents).some((drop) => drop.id === ITEM.SCUTE), false);

  // Explicit archive timer boundary, not 300 seconds of simulated play.
  const window = parents.snapshot();
  window.ecology.ecology.eggs.find((value) => value.id === egg.id).remaining = 0.05;
  const f = await gameMobFixture(t, {
    saved: parseWorldFile(exportWorldFile(window)), generatorFactory: combatBeach, overflowMaxEntries: 1,
  });
  f.ecology.stepWorld(0.05);
  f.mob = f.wildlife.byId.get(egg.childId);
  assert.ok(f.mob, "the public host tick must hatch the World-owned egg");
  assert.equal(f.ecology.ecology.egg(egg.id).status, "hatched");
  assert.equal(f.world.get(egg.position.x, egg.position.y, egg.position.z), BLOCK.AIR);
  assert.equal(f.ecology.ecology.state(f.mob.id).scuteClaimed, false);
  assert.equal(f.ecology.ecology.state(f.mob.id).growthRemaining, ECOLOGY_LIMITS.turtleGrowth);
  return f;
}

for (const growthRefused of [false, true])
  test(`live ${growthRefused ? "growth-refused" : "newly hatched"} baby Game death pays no resources or XP and stays retired cold`, async (t) => {
    let f = await hatchFixture(t);
    if (growthRefused) {
      // Preserve a real hatched identity; only shorten its saved age window.
      const window = f.snapshot(), id = f.mob.id;
      window.ecology.ecology.entries.find((state) => state.id === id).growthRemaining = 0.05;
      f = await gameMobFixture(t, {
        saved: parseWorldFile(exportWorldFile(window)), generatorFactory: combatBeach, overflowMaxEntries: 1,
      });
      f.mob = f.wildlife.byId.get(id);
      // A positive public host step wakes the cold resident but cannot cross
      // the authored 0.05-second growth window. Game's input clock stays separate.
      f.wildlife.update(0.01, 0.01, f.player.position, {
        mode: f.gameplay.mode, health: f.gameplay.health,
      });
      assert.equal(f.mob.dormant, false);
      assert.ok(f.ecology.ecology.state(id).growthRemaining > 0);
      f.ecology.stepMob(f.mob, 0.05);
      assert.equal(f.ecology.ecology.state(id).growthRemaining, 0);
      assert.equal(f.ecology.ecology.state(id).scuteClaimed, false);
      const before = ownership(f);
      const growth = f.ecology.ecology.prepareGrowth(f.mob, f.wildlife.context, {
        prepareDrops: (drops, at, dimension) => {
          assert.deepEqual(drops, [{ name: "SCUTE", count: 1 }]);
          return f.overflow.prepareEnqueue([{ id: ITEM.SCUTE, count: 1 }], at, dimension,
            { pickupDelay: 0.4 });
        },
      });
      assert.ok(growth, "valid habitat and zero age must allow growth before material capacity is filled");
      assert.deepEqual(ownership(f), before);
      fillSlot(f, BLOCK.COBBLESTONE);
      const full = ownership(f);
      assert.equal(f.ecology.commit(growth).ok, false, "the earlier growth receipt is now stale");
      f.ecology.stepWorld(0.05);
      assert.deepEqual(ownership(f), full, "a real full sink prevents growth and its scute atomically");
      assert.equal(f.ecology.ecology.state(id).growthRemaining, 0);
      assert.equal(f.ecology.ecology.state(id).scuteClaimed, false,
        "zero remaining time is not committed adulthood");
    }

    assert.equal(f.mob.health, 30, "the hatched resident keeps its full configured species health");
    assert.equal(f.mob.health, f.mob.spec.health);
    assert.ok(reward(f, true, false).experience > 0, "an adult misclassification would observably pay XP");
    assert.deepEqual(reward(f), { drops: [], experience: 0 });
    f.player.setPosition({ x: f.mob.position.x, y: f.mob.position.y, z: f.mob.position.z + 2.5 });
    equip(f, { durability: 5 });
    aim(f);
    const before = ownership(f);
    let deathPlan;
    for (let hit = 0; hit < 5; hit++) {
      // Isolate the normal input cooldown boundary, not a played growth clock.
      if (hit) f.game.elapsed = f.game.lastAction + MELEE_COOLDOWN_SECONDS + 0.001;
      aim(f);
      const prepared = ownership(f);
      const plan = f.game.mobActions.prepareMelee(f.mob);
      uniqueAttackOwners(f, plan.participants);
      assert.equal(plan.participants.some((part) =>
        part.owner === f.overflow || part.owner === f.game.experienceOrbs), false);
      assert.deepEqual(ownership(f), prepared);
      if (hit === 4) deathPlan = plan;
      primary(f);
      assert.equal(f.mob.health, 30 - (hit + 1) * 6);
      assert.equal(f.gameplay.getHandStack()?.durability ?? 0, 4 - hit);
      assert.equal(f.gameplay.getHandRevision(), before.combat.mainRevision + (hit === 4 ? 1 : 0));
      assert.equal(f.gameplay.exhaustion, prepared.archive.gameplay.exhaustion + 0.1);
      assert.equal(f.game.lastAction, f.game.elapsed);
      assert.equal(f.wildlife.randomState, before.rng);
      assert.deepEqual(f.overflow.serialize(), before.archive.overflow);
      assert.deepEqual(f.game.pickups.serialize(), before.archive.pickups);
      assert.deepEqual(f.game.experienceOrbs.serialize(), before.archive.experienceOrbs);
      if (!f.mob.dead) {
        const committed = ownership(f);
        primary(f);
        assert.deepEqual(ownership(f), committed, "cooldown blocks a second payment at the same input time");
      }
    }
    assertRetired(f);
    assertFinalHandPayment(f, before, 5);
    assert.deepEqual(f.progression.services.effects.serialize(), before.combat.effects);
    assert.deepEqual(f.progression.services.stations.serialize(), before.combat.stations);
    assertNoReplay(f, deathPlan);
    const again = await coldRetirement(t, f, combatBeach);
    const retired = ownership(again);
    again.ecology.stepWorld(0.05);
    assert.deepEqual(ownership(again), retired, "a hatched egg and dead baby cannot replay growth after reload");
  });
