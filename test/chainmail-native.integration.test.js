import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { ITEM, getItem } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { approachGameMob, nativeGameMobs } from "./game-mob-native-fixture.js";

test("native village smith sells all four pieces with earned emeralds; actual Game equip and archive reload retain ownership", async (t) => {
  const f = await nativeGameMobs(t), trading = f.progression.services.trading;
  const originalWorld = f.world.serialize();
  f.frame(80);
  const member = f.descriptor.markers.find(marker =>
    marker.type === "member" && marker.profession === "toolsmith");
  assert.ok(member);
  const id = f.ecology.ecology.entityIdForMarker(member.id);
  const mob = f.wildlife.byId.get(id);
  assert.ok(mob);
  assert.equal(mob.npcIntent, "work");
  assert.equal(trading.get(id).jobsite.id, member.jobSiteId);
  assert.equal(trading.get(id).xp, 0);
  assert.equal(f.gameplay.mode, "survival");
  assert.equal(f.player.allowFlight, false);
  approachGameMob(f, mob);
  assert.equal(f.game.useActions.tap(), true, "physical entity use opens the real progression host");
  assert.equal(f.progression.view().npcId, id);

  // Only these finite raw resources and the player's approach are authored.
  // Emeralds, levels and armor are all earned through production transactions.
  assert.equal(f.gameplay.inventoryTransaction(draft => {
    draft.slots.fill(null);
    draft.slots[0] = { id: ITEM.COAL, count: 64 };
    draft.slots[1] = { id: ITEM.COAL, count: 11 };
    draft.slots[2] = { id: ITEM.IRON_INGOT, count: 24 };
    return true;
  }), true);
  const prepare = (suffix, count = 1) => f.progression.prepareAction({
    type: "trade", offerId: `toolsmith/${suffix}`, count,
    sessionToken: f.progression.view().sessionToken,
  });
  const pay = (suffix, count = 1) => {
    const offer = f.progression.view().offers.find(o => o.id === `toolsmith/${suffix}`);
    assert.ok(offer);
    const inputs = offer.inputs.map(stack => [stack.id, f.gameplay.countPlain(stack.id), stack.count]);
    const output = f.gameplay.countPlain(offer.output.id);
    const xp = f.gameplay.getState().experience.total;
    const plan = prepare(suffix, count), before = f.ownership();
    assert.ok(plan.participants);
    assert.deepEqual(new Set(plan.participants.map(p => p.owner)), new Set([trading, f.gameplay]));
    assert.deepEqual(f.ownership(), before, "preparation cannot spend or grant");
    assert.equal(f.progression.commit(plan).ok, true);
    for (const [itemId, owned, price] of inputs)
      assert.equal(f.gameplay.countPlain(itemId), owned - price * count);
    assert.equal(f.gameplay.countPlain(offer.output.id), output + count * offer.output.count);
    assert.equal(f.gameplay.getState().experience.total, xp + count * offer.playerXp);
    assert.equal(trading.get(id).offers.find(o => o.id === offer.id).uses, offer.uses + count);
    const paid = f.ownership();
    assert.equal(f.progression.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), paid);
    return offer.output;
  };
  assert.equal(f.progression.view().offers.some(o => o.id.includes("/chainmail-")), false);
  pay("coal", 5);
  assert.equal(f.gameplay.countPlain(ITEM.COAL), 0);
  assert.equal(f.progression.view().level, 2);
  assert.equal(f.progression.view().offers.some(o => o.id === "toolsmith/chainmail-helmet"), false);
  pay("iron", 6);
  assert.equal(f.gameplay.countPlain(ITEM.IRON_INGOT), 0);
  assert.equal(f.gameplay.countPlain(ITEM.EMERALD), 11);
  assert.equal(f.progression.view().level, 3);

  const close = async () => {
    assert.equal(f.progression.close("chainmail-test").ok, true);
    if (f.game.screenClose) await f.game.screenClose;
    await Promise.resolve();
  };
  const stale = prepare("chainmail-boots");
  assert.ok(stale.participants);
  await close();
  f.frame(5); // Let the real 0.2-second physical-use cooldown expire.
  approachGameMob(f, mob);
  assert.equal(f.game.useActions.tap(), true);
  const reopened = f.ownership();
  assert.equal(f.progression.commit(stale).ok, false);
  assert.deepEqual(f.ownership(), reopened, "a reopened session cannot pay an old token");
  const acquired = ["boots", "leggings", "helmet", "chestplate"].map(suffix => pay(`chainmail-${suffix}`));
  assert.equal(f.gameplay.countPlain(ITEM.EMERALD), 2);
  assert.equal(trading.get(id).xp, 100);
  const pending = prepare("chainmail-boots");
  assert.ok(pending.participants);
  await close();
  for (const stack of acquired) {
    const index = f.gameplay.slots.findIndex(owned => owned?.id === stack.id);
    assert.ok(index >= 0);
    f.gameplay.select(index);
    assert.equal(f.game.useActions.useHand("main", f.gameplay.getHandStack(), false), true);
    assert.equal(f.gameplay.getHandStack(), null);
    assert.deepEqual(f.gameplay.equipment[getItem(stack.id).equipmentSlot], stack);
  }
  assert.deepEqual(f.world.serialize(), originalWorld, "trading never modifies native terrain or generator identity");
  const saved = f.snapshot(), ledger = JSON.stringify(saved.progression.trading);
  const file = parseWorldFile(exportWorldFile(saved));
  assert.deepEqual(normalizeWorldComponents(file).gameplay, saved.gameplay);
  assert.equal(JSON.stringify(file.progression.trading), ledger);
  const indexedDB = new IDBFactory(), storage = new WorldStorage({ indexedDB });
  await storage.save(file);
  await storage.close();
  const storageAgain = new WorldStorage({ indexedDB });
  const loaded = await storageAgain.load();
  await storageAgain.close();
  const restored = await gameMobFixture(t, { saved: loaded, generatorFactory: null, admissionRadius: 3 });
  assert.equal(JSON.stringify(restored.progression.services.trading.serialize()), ledger);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  const beforeReplay = restored.ownership();
  assert.equal(restored.progression.commit(pending).ok, false);
  assert.deepEqual(restored.ownership(), beforeReplay, "a pre-reload plan cannot grant a second item");
  for (const stack of acquired)
    assert.deepEqual(restored.gameplay.equipment[getItem(stack.id).equipmentSlot], stack);
  const restoredMob = restored.wildlife.byId.get(id);
  assert.ok(restoredMob, "the same native villager restores with its paid stock");
  restored.frame();
  const afterWork = restored.progression.services.trading.get(id);
  assert.deepEqual(afterWork.offers.map(({ uses, ...offer }) => offer),
    trading.get(id).offers.map(({ uses, ...offer }) => offer));
  const afterWorkLedger = JSON.stringify(restored.progression.services.trading.serialize());
  approachGameMob(restored, restoredMob);
  assert.equal(restored.game.useActions.tap(), true);
  assert.equal(JSON.stringify(restored.progression.services.trading.serialize()), afterWorkLedger);
  for (const stack of acquired) {
    const offer = restored.progression.view().offers.find(o => o.output.id === stack.id);
    assert.equal(offer.remaining, offer.maxUses - afterWork.offers.find(o => o.id === offer.id).uses);
  }
  t.diagnostic(JSON.stringify({
    evidence: "Native v4 terrain/resident/work/physical use + actual Game ownership; CPU headless transports",
    authoredPrerequisites: { approach: true, coal: 75, ironIngots: 24, starterEmeralds: 0, starterArmor: 0 },
    earned: { emeralds: 11, chainmailPieces: 4, remainingEmeralds: 2, villagerXp: 100 },
    archive: "world file + isolated fake IndexedDB + detached native Game reload",
    fullSurvivalJourney: false,
  }));
});
