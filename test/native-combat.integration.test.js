import assert from "node:assert/strict";
import test from "node:test";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile } from "../src/storage.js";
import { closeBench, insert, stationAction } from "./brewing-acquisition-fixture.js";
import { verifyCombatExports } from "./combat-browser-verify.mjs";
import {
  aimCombatAnvil, aimNativeTurtle, assertCombatBounds, assertUnpaidCombat,
  checkedCombatArchive, freezeNativeCombat, nativeCombatFixture,
  nativeTurtleState, NATIVE_COMBAT_LIMITS, reloadNativeCombat,
} from "./native-combat-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const record = ({ f, anvil }) => f.progression.services.stations.get(anvil).record;
const rewards = (f) => ({
  pickups: f.game.pickups.serialize(), overflow: f.overflow.serialize(),
  experienceOrbs: f.game.experienceOrbs.serialize(),
});
const expectedSword = (durability) =>
  progressionStack(ITEM.IRON_SWORD, 1, { enchantments: { sharpness: 3 }, repairCost: 1 }, durability);

function assertPaidOwners(proof) {
  const { f } = proof;
  const owned = f.gameplay.serialize();
  assert.deepEqual(owned.slots, [expectedSword(249), ...Array(35).fill(null)]);
  assert.equal(owned.experience.total, 0);
  assert.equal(owned.experience.level, 0);
  assert.equal(owned.cursor, null);
  assert.equal(owned.offhand, null);
  assert.ok(Object.values(owned.equipment).every((stack) => stack === null));
  assert.ok(owned.craftingGrid.every((stack) => stack === null));
  assert.deepEqual(owned.crafting, []);
  assert.deepEqual(f.progression.services.effects.serialize().effects, []);
  assert.deepEqual(record(proof), { version: 1, left: null, right: null });
  const target = nativeTurtleState(proof);
  assert.equal(target.id, proof.evidence.scheduler.id);
  assert.equal(target.life, proof.evidence.scheduler.life);
  assert.equal(target.health, 22);
  assert.equal(target.dead, false);
  assert.equal(target.sidecar.alive, true);
  assert.deepEqual(target.sidecar.homeBeach, proof.evidence.scheduler.homeBeach);
  assert.equal(f.wildlife.killed.has(target.id), false);
  assert.equal(f.wildlife.autoSpawn, true);
}

test("native scheduled turtle: unpaid physical anvil → paid Sharpness III hit → owned cold continuation", async (t) => {
  let proof, ready = false, paid = false;
  await t.test("first native beach, bounded public admission and physical anvil/victim rays", async () => {
    proof = await nativeCombatFixture(t);
    const { f, evidence, admission, poses } = proof;
    assertUnpaidCombat(proof);
    assert.match(proof.targetId, /^overworld:ecology:\d+$/);
    assert.equal(evidence.scheduler.frames, NATIVE_COMBAT_LIMITS.schedulerFrames);
    assert.ok(evidence.discovery.coarseSamples <= 9409);
    assert.ok(evidence.discovery.neighborSamples <= evidence.discovery.beachCandidates * 8);
    assert.equal(evidence.scheduler.probeTop, f.world.spec.seaLevel + 6);
    assert.equal(evidence.scheduler.probes, 12);
    assert.ok(admission.columns.length <= 49);
    for (const request of [admission.observer, admission.approach, ...Object.values(admission.fixtureAdmissions)])
      assert.ok(request.radius <= 2 && request.columns.every((key) => admission.columns.includes(key)));
    assert.equal(evidence.observations[0].generatedColumns, 25);
    assert.equal(evidence.observations[0].residentColumns, 25);
    assert.equal(evidence.observations.at(-1).generatedColumns, admission.columns.length);
    assert.equal(evidence.observations.at(-1).residentColumns, 25);
    assert.equal(evidence.observations.at(-1).removedColumns, admission.columns.length - 25);
    for (const pose of Object.values(poses)) {
      assert.equal(pose.flying, false);
      // The distant observer may now be normally evicted. It was checked while
      // resident before the real scheduler frame, never against unloaded air.
      if (pose !== poses.observer) assert.equal(isSafeRespawnPosition(f.world, pose), true);
    }
    assert.deepEqual(poses.initial, poses.anvil);
    assert.deepEqual(aimNativeTurtle(proof), poses.hit);
    assert.deepEqual(aimCombatAnvil(proof), poses.anvil);
    proof.unpaidArchive = f.snapshot();
    ready = true;
  });
  if (!ready) return; // Fail closed: no resource authoring retry or alternate site.

  await t.test("physical tap and station clicks pay one book/three levels; normal primary pays one wear for 30→22", async () => {
    const { f } = proof;
    const stations = f.progression.services.stations;
    const nativeBefore = nativeTurtleState(proof);
    const rewardsBefore = rewards(f);
    const randomBefore = stations.randomState;
    const generated = f.world.generator.counters.chunkGenerations;
    assert.equal(f.game.useActions.tap(), true, "normal use opens the physically targeted anvil");
    assert.equal(f.progression.isOpen, true);
    assert.equal(f.game.active, false, "the real progression overlay takes input");
    insert(f, 0, 0);
    insert(f, 1, 1);
    assert.deepEqual(record(proof), {
      version: 1,
      left: progressionStack(ITEM.IRON_SWORD),
      right: progressionStack(ITEM.ENCHANTED_BOOK, 1, { enchantments: { sharpness: 3 } }),
    });
    assert.ok(f.gameplay.slots.every((stack) => stack === null), "the physical station now owns both inputs");
    assert.equal(f.gameplay.cursor, null);
    assert.equal(f.gameplay.getState().experience.total, 27);
    const preview = f.progression.view().preview;
    assert.equal(preview.ok, true);
    assert.equal(preview.levelCost, 3);
    assert.deepEqual(preview.output, expectedSword(250));
    assert.equal(stations.randomState, randomBefore, "preview does not consume anvil RNG");
    proof.paidPreviewKey = preview.key;

    const paidResult = stationAction(f, { type: "takeResult", previewKey: preview.key });
    assert.equal(paidResult.levelCost, 3);
    assert.equal(paidResult.anvilBroken, false);
    assert.equal(f.gameplay.getState().experience.total, 0);
    assert.deepEqual(f.gameplay.cursor, expectedSword(250), "the result is owned once by the cursor");
    assert.ok(f.gameplay.slots.every((stack) => stack === null));
    assert.deepEqual(record(proof), { version: 1, left: null, right: null });
    const randomAfterAnvil = nextEnchantingSeed(randomBefore);
    assert.equal(stations.randomState, randomAfterAnvil, "one legitimate anvil wear draw, not a seeded override");
    const expectedAnvil = randomAfterAnvil / 0x100000000 < 0.12 ? BLOCK.CHIPPED_ANVIL : BLOCK.ANVIL;
    assert.equal(f.world.get(proof.anvil.x, proof.anvil.y, proof.anvil.z), expectedAnvil);
    assert.equal(f.world.edits.size, 1);
    const afterPayment = f.snapshot();
    assert.equal(f.progression.action({
      type: "takeResult", previewKey: preview.key, sessionToken: f.progression.services.session.token,
    }).ok, false);
    assert.deepEqual(f.snapshot(), afterPayment, "replaying a paid preview cannot duplicate payment/output");
    stationAction(f, { type: "click", area: "inventory", index: 0, button: 0 });
    await closeBench(f);
    assert.equal(f.progression.isOpen, false);
    assert.equal(f.game.active, true);
    assert.deepEqual(f.gameplay.getHandStack(), expectedSword(250));
    assert.equal(f.gameplay.cursor, null);
    assert.deepEqual(nativeTurtleState(proof), nativeBefore, "no mob/health authoring during short UI actions");
    assert.deepEqual(rewards(f), rewardsBefore);
    proof.paidArchive = f.snapshot();
    assert.equal(verifyCombatExports(proof.unpaidArchive, proof.paidArchive).length, 2);

    proof.poses.hit = aimNativeTurtle(proof);
    const beforeAttack = {
      target: nativeTurtleState(proof), hand: f.gameplay.getHandStack(),
      exhaustion: f.gameplay.exhaustion, progression: f.progression.serialize(),
      wildlifeRandom: f.wildlife.randomState, rewards: rewards(f), edits: f.world.serialize(),
    };
    f.game.primary(0.05, true);
    assertPaidOwners(proof);
    assert.ok(Math.abs(f.gameplay.exhaustion - beforeAttack.exhaustion - 0.1) < 1e-9);
    assert.deepEqual(f.progression.serialize(), beforeAttack.progression, "offense consumes no progression RNG or effects");
    assert.equal(f.wildlife.randomState, beforeAttack.wildlifeRandom, "offense consumes no Wildlife RNG");
    assert.deepEqual(rewards(f), beforeAttack.rewards, "a nonlethal hit yields no loot/orbs/XP");
    assert.deepEqual(f.world.serialize(), beforeAttack.edits, "the hit does not edit habitat or anvil");
    assert.equal(f.world.generator.counters.chunkGenerations, generated);
    const afterAttack = f.snapshot();
    f.game.primary(0.05, true);
    assert.deepEqual(f.snapshot(), afterAttack, "normal cooldown refuses an immediate duplicate hit/wear");
    assertCombatBounds(f.world, proof.admission, "paid attack");
    t.diagnostic(`native paid attack ${JSON.stringify({
      id: proof.targetId, life: nativeTurtleState(proof).life,
      health: [beforeAttack.target.health, nativeTurtleState(proof).health],
      durability: [beforeAttack.hand.durability, f.gameplay.getHandStack().durability],
      experience: [27, f.gameplay.getState().experience.total], paidLevels: paidResult.levelCost,
      bookConsumed: 1, repairCost: f.gameplay.getHandStack().data.repairCost,
      offenseRandomDraws: 0, anvilRandomDraws: 1, rewardsUnchanged: true,
    })}`);
    paid = true;
  });
  if (!paid) return;

  await t.test("export/parser/preflight and a fresh real Game/World retain every paid owner without replay", async () => {
    await freezeNativeCombat(proof);
    const source = checkedCombatArchive(proof);
    const restored = await reloadNativeCombat(t, proof);
    assertPaidOwners(restored);
    const { f } = restored;
    assert.equal(verifyCombatExports(proof.unpaidArchive, proof.paidArchive, {
      hit: source.saved, restored: [f.snapshot()],
    }).length, 4);
    const forgedXp = structuredClone(proof.paidArchive);
    forgedXp.gameplay.experience = { total: 27, level: 3, progress: 0 };
    assert.throws(() => verifyCombatExports(proof.unpaidArchive, forgedXp),
      "an enchanted output without the XP payment is not valid evidence");
    const forgedRandom = structuredClone(source.saved);
    forgedRandom.progression.stations.randomState =
      nextEnchantingSeed(forgedRandom.progression.stations.randomState);
    assert.throws(() => verifyCombatExports(proof.unpaidArchive, proof.paidArchive, {
      hit: forgedRandom,
    }), "an unreported offense RNG draw is rejected");
    const forgedCold = structuredClone(f.snapshot());
    forgedCold.weather.elapsed++;
    assert.throws(() => verifyCombatExports(proof.unpaidArchive, proof.paidArchive, {
      hit: source.saved, restored: [forgedCold],
    }), "cold verification cannot exempt an altered simulation clock");
    const resourceBefore = {
      gameplay: f.gameplay.serialize(), progression: f.progression.serialize(),
      rewards: rewards(f), world: f.world.serialize(),
      clock: f.building.worldClock.serialize(), weather: f.weather.serialize(),
    };
    assert.equal(f.game.paused, true);
    const paused = f.snapshot();
    f.frame(1);
    assert.deepEqual(f.snapshot(), paused, "a real paused Game frame preserves EVERY resource and archived clock");
    assert.equal(f.game.heldAction, null);
    assert.equal(f.game.useActions.use.active, false);
    // Continue through normal physical station input, with no elapsed-time
    // authoring or disabled AI. Sustained active native Game-frame performance
    // is deliberately outside this paid-owner/checkpoint proof.
    f.game.paused = false;
    aimCombatAnvil(restored);
    assert.equal(f.game.useActions.tap(), true);
    assert.equal(f.progression.isOpen, true);
    assert.equal(f.progression.view().preview.ok, false);
    const beforeReplay = f.snapshot();
    assert.equal(f.progression.action({
      type: "takeResult", previewKey: proof.paidPreviewKey,
      sessionToken: f.progression.services.session.token,
    }).ok, false);
    assert.deepEqual(f.snapshot(), beforeReplay, "cold empty escrow cannot replay the paid preview");
    await closeBench(f);
    assertPaidOwners(restored);
    assert.deepEqual(f.gameplay.serialize(), resourceBefore.gameplay);
    assert.deepEqual(f.progression.serialize(), resourceBefore.progression);
    assert.deepEqual(rewards(f), resourceBefore.rewards);
    assert.deepEqual(f.world.serialize(), resourceBefore.world);
    assert.deepEqual(f.building.worldClock.serialize(), resourceBefore.clock);
    assert.deepEqual(f.weather.serialize(), resourceBefore.weather);
    assert.equal(f.wildlife.serialize().entities.filter((mob) => mob.id === proof.targetId).length, 1);
    assert.equal(f.ecology.ecology.serialize().entries.filter((state) => state.id === proof.targetId).length, 1);
    assertCombatBounds(f.world, proof.admission, "cold physical input continuation");
    await freezeNativeCombat(restored);
    checkedCombatArchive(restored);
    assert.equal(exportWorldFile(proof.f.snapshot()), source.text, "source remains quiescent throughout cold continuation");
    t.diagnostic(`native cold continuation ${JSON.stringify({
      pausedFrames: 1, activeInputs: "physical anvil tap, refused paid-preview replay, normal close",
      target: nativeTurtleState(restored), paidSword: f.gameplay.getHandStack(),
      xp: f.gameplay.getState().experience.total, escrow: record(restored),
      generation: f.world.generator.counters.chunkGenerations, residency: f.world.chunks.size,
      sourceGeneration: proof.f.world.generator.counters.chunkGenerations,
      sourceResidency: proof.f.world.chunks.size, bytes: Buffer.byteLength(source.text),
    })}`);
  });
});
