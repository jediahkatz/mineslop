import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { ITEM, getItem } from "../src/items.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { approachGameMob, nativeGameMobs } from "./game-mob-native-fixture.js";
import {
  approachResource, assertExactWorldEdits, attachResourceContainer, insertResourceCount,
  mineResource, nativeCells, reloadResourceStage,
} from "./chainmail-resource-fixture.js";

test("chunk-order comparison still rejects every missing, duplicated or changed world edit", () => {
  const expected = {
    version: 3, seed: "edit-comparison", generatorVersion: 4, dimension: "overworld",
    edits: [["overworld", 1, 20, 3, 0, 0, 0], ["overworld", 17, 21, 4, 0, 0, 0]],
  };
  assertExactWorldEdits({ ...expected, edits: [...expected.edits].reverse() }, expected);
  for (const mutate of [
    world => world.edits.pop(),
    world => world.edits.push([...world.edits[0]]),
    ...[0, 1, 2, 3, 4, 5, 6].map(index => world => {
      world.edits[0][index] = index === 0 ? "nether" : world.edits[0][index] + 1;
    }),
    world => { world.generatorVersion = 5; },
    world => { world.seed = "changed"; },
  ]) {
    const changed = structuredClone(expected);
    mutate(changed);
    assert.throws(() => assertExactWorldEdits(changed, expected));
  }
});

test("bounded native mining, fueled smelting, paid trading and equipment survive exact world archive restore", async (t) => {
  let f = await nativeGameMobs(t);
  t.after(() => {
    if (!process.env.CHAINMAIL_RESOURCE_ARTIFACT_DIR) return;
    const path = join(process.env.CHAINMAIL_RESOURCE_ARTIFACT_DIR,
      `chainmail_resource_checkpoint_${process.pid}_${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(f.snapshot()));
    t.diagnostic(`Resource ownership checkpoint: ${path}`);
  });
  const home = { ...f.descriptor.entries[0] };
  const member = f.descriptor.markers.find(marker =>
    marker.type === "member" && marker.profession === "toolsmith");
  assert.ok(member);
  f.frame(80);
  const merchantId = f.ecology.ecology.entityIdForMarker(member.id);
  f.hold("DIAMOND_PICKAXE", { data: {
    version: 1, enchantments: { efficiency: 5, fortune: 3 },
  } });
  assert.equal(f.gameplay.mode, "survival");
  assert.equal(f.player.allowFlight, false);
  assert.deepEqual(f.gameplay.slots.filter(Boolean).map(stack => stack.id), [ITEM.DIAMOND_PICKAXE]);
  const oreIds = [
    BLOCK.COAL_ORE, BLOCK.DEEPSLATE_COAL_ORE,
    BLOCK.IRON_ORE, BLOCK.DEEPSLATE_IRON_ORE,
  ];
  const targets = nativeCells(f.world, oreIds);
  const furnace = nativeCells(f.world, [BLOCK.FURNACE])[0];
  assert.ok(furnace, "native smithy must provide the unmodified furnace");
  const secondWindow = { x: home.x + 112, z: home.z };
  await f.world.ensureArea(secondWindow, 3);
  targets.push(...nativeCells(f.world, oreIds, secondWindow));
  assert.ok(targets.length <= 131072, "two fixed 49-column native ore planning windows");
  let frames = 80, mined = 0, oreAdmissions = 0;
  const totals = { coal: 0, rawIron: 0 };
  t.diagnostic(JSON.stringify({ nativeOreCandidates: targets.length, furnace }));
  for (const [ids, output, required, label] of [
    [[BLOCK.COAL_ORE, BLOCK.DEEPSLATE_COAL_ORE], ITEM.COAL, 78, "coal"],
    [[BLOCK.IRON_ORE, BLOCK.DEEPSLATE_IRON_ORE], ITEM.RAW_IRON, 24, "rawIron"],
  ]) {
    let inspected = 0;
    for (const at of targets.filter(at => ids.includes(at.id))) {
      assert.ok(++inspected <= 131072, "bounded ore candidate search");
      if (f.gameplay.countPlain(output) >= required) break;
      if (frames >= 360) {
        f.player.setPosition({ x: home.x + 0.5, y: home.y, z: home.z + 0.5 });
        f = await reloadResourceStage(t, f);
        frames = 0;
      }
      if (!f.world.isLoaded(at.x, at.z)) {
        assert.ok(++oreAdmissions <= 128, "bounded re-admission of the two native route windows");
        await f.world.ensureArea({ x: at.x, z: at.z }, 1);
      }
      if (f.world.get(at.x, at.y, at.z) !== at.id) continue;
      if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
        f.world.get(at.x + dx, at.y, at.z + dz) === BLOCK.AIR)) continue;
      if (!approachResource(f, at, { collectible: true })) continue;
      const result = mineResource(t, f, at, output);
      frames += result.frames;
      assert.ok(++mined <= 150, "finite mining budget includes both resources");
      totals[label] += result.produced;
      t.diagnostic(JSON.stringify({ mined, at, produced: result.produced, totals, frames }));
    }
    assert.ok(f.gameplay.countPlain(output) >= required,
      `Native route exhausted: ${label}=${f.gameplay.countPlain(output)} required=${required}`);
  }
  t.diagnostic(JSON.stringify({ resourceStageComplete: totals, mined, frames, oreAdmissions }));
  assert.equal(f.gameplay.countPlain(ITEM.EMERALD), 0);
  assert.equal(f.gameplay.countPlain(ITEM.IRON_INGOT), 0);
  assert.equal(f.gameplay.getHandStack().durability, getItem(ITEM.DIAMOND_PICKAXE).durability - mined);

  await f.world.ensureArea(furnace, 3);
  assert.ok(approachResource(f, furnace));
  let ui = attachResourceContainer(f);
  assert.equal(f.game.useActions.tap(), true, "physical Game use opens the native smithy furnace");
  assert.equal(ui.kind, "furnace");
  insertResourceCount(f, ui, ITEM.RAW_IRON, 24, 0);
  insertResourceCount(f, ui, ITEM.COAL, 3, 1);
  assert.deepEqual(f.game.settlement.inspectContainer(f.world, furnace).slots,
    [{ id: ITEM.RAW_IRON, count: 24 }, { id: ITEM.COAL, count: 3 }, null]);
  assert.equal(ui.close(), true);

  let smeltingFrames = 0, smeltingReloads = 0;
  for (; smeltingFrames < 5000; ) {
    const state = f.game.settlement.inspectContainer(f.world, furnace);
    if (state.slots[2]?.count === 24) break;
    if (frames >= 360) {
      f = await reloadResourceStage(t, f);
      assert.ok(++smeltingReloads <= 15, "finite save/reload stages respect the 512-frame fixture bound");
      frames = 0;
    }
    const batch = Math.min(360 - frames, 5000 - smeltingFrames);
    f.frame(batch);
    frames += batch;
    smeltingFrames += batch;
  }
  const smelted = f.game.settlement.inspectContainer(f.world, furnace);
  assert.deepEqual(smelted.slots, [null, null, { id: ITEM.IRON_INGOT, count: 24 }]);
  assert.equal(smelted.experience, 24);
  assert.equal(f.game.settlement.serialize().furnaces.find(value =>
    value.x === furnace.x && value.y === furnace.y && value.z === furnace.z).burnTime,
  0, "all three mined coal fuel units actually burn");
  assert.equal(f.gameplay.countPlain(ITEM.COAL), totals.coal - 3);
  assert.equal(f.gameplay.countPlain(ITEM.RAW_IRON), totals.rawIron - 24);
  assert.equal(f.gameplay.countPlain(ITEM.IRON_INGOT), 0, "smelting output belongs to the furnace until extraction");
  assert.ok(approachResource(f, furnace));
  ui = attachResourceContainer(f);
  assert.equal(f.game.useActions.tap(), true);
  const extraction = ui._action({ type: "quickMove", area: "container", index: 2 });
  assert.equal(extraction.ok, true);
  assert.equal(extraction.experience, 24);
  assert.equal(f.gameplay.countPlain(ITEM.IRON_INGOT), 24);
  const extracted = f.gameplay.serialize();
  assert.equal(ui._action({ type: "quickMove", area: "container", index: 2 }).ok, false);
  assert.deepEqual(f.gameplay.serialize(), extracted);
  assert.equal(ui.close(), true);
  t.diagnostic(JSON.stringify({ smeltingFrames, smeltingReloads, rawIronConsumed: 24, coalBurned: 3, ingots: 24 }));

  f.frame(5);
  const mob = f.wildlife.byId.get(merchantId);
  assert.ok(mob);
  approachGameMob(f, mob);
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.progression.view().npcId, merchantId);
  assert.equal(f.progression.view().level, 1);
  const pay = (suffix, count = 1) => {
    const view = f.progression.view();
    const offer = view.offers.find(value => value.id === `toolsmith/${suffix}`);
    assert.ok(offer);
    const before = f.ownership();
    const inputs = offer.inputs.map(stack => ({ ...stack, owned: f.gameplay.countPlain(stack.id) }));
    const plan = f.progression.prepareAction({
      type: "trade", offerId: offer.id, count, sessionToken: view.sessionToken,
    });
    assert.ok(plan.participants);
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.progression.commit(plan).ok, true);
    for (const stack of inputs)
      assert.equal(f.gameplay.countPlain(stack.id), stack.owned - stack.count * count);
    assert.equal(f.progression.services.trading.get(merchantId).offers
      .find(value => value.id === offer.id).uses, offer.uses + count);
    const paid = f.ownership();
    assert.equal(f.progression.commit(plan).ok, false);
    assert.deepEqual(f.ownership(), paid);
    return offer.output;
  };
  pay("coal", 5);
  assert.equal(f.progression.view().level, 2);
  pay("iron", 6);
  assert.equal(f.progression.view().level, 3);
  assert.equal(f.gameplay.countPlain(ITEM.EMERALD), 11);
  const acquired = ["boots", "leggings", "helmet", "chestplate"].map(piece => pay(`chainmail-${piece}`));
  assert.equal(f.gameplay.countPlain(ITEM.EMERALD), 2);
  assert.equal(f.gameplay.countPlain(ITEM.COAL), totals.coal - 78);
  assert.equal(f.gameplay.countPlain(ITEM.IRON_INGOT), 0);
  assert.equal(f.progression.close("resource-chain-complete").ok, true);
  if (f.game.screenClose) await f.game.screenClose;
  await Promise.resolve();
  for (const stack of acquired) {
    const index = f.gameplay.slots.findIndex(value => value?.id === stack.id);
    assert.ok(index >= 0);
    f.gameplay.select(index);
    assert.equal(f.game.useActions.useHand("main", f.gameplay.getHandStack(), false), true);
    assert.deepEqual(f.gameplay.equipment[getItem(stack.id).equipmentSlot], stack);
    assert.equal(f.gameplay.getHandStack(), null);
  }
  const saved = f.snapshot();
  assert.equal(saved.world.edits.length, mined, "only physically harvested native cells are edited");
  const parsed = parseWorldFile(exportWorldFile(saved));
  assert.deepEqual(parsed.world, saved.world);
  const indexedDB = new IDBFactory(), storage = new WorldStorage({ indexedDB });
  await storage.save(parsed);
  await storage.close();
  const reopened = new WorldStorage({ indexedDB });
  const loaded = await reopened.load();
  await reopened.close();
  assertExactWorldEdits(loaded.world, saved.world);
  const restored = await gameMobFixture(t, { saved: loaded, generatorFactory: null, admissionRadius: 3 });
  assertExactWorldEdits(restored.world.serialize(), saved.world);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  assert.deepEqual(restored.game.settlement.serialize(), saved.settlement);
  assert.deepEqual(restored.progression.services.trading.serialize(), saved.progression.trading);
  t.diagnostic(JSON.stringify({
    completedResourcePath: "native ore -> physical Game harvest/drop/pickup -> native fueled furnace -> paid native toolsmith -> Game equip -> file/IDB/native Game reload",
    nativeHarvest: totals, mined, coalBurned: 3, rawIronSmelted: 24, emeraldsEarned: 11,
    armorPurchased: 4, remainingEmeralds: 2,
    authored: { tool: "one full-durability diamond pickaxe, Efficiency V and Fortune III", food: 0,
      approaches: "scripted collision-safe teleports to native mining/pickup/furnace/villager positions",
      rawTradeInputs: 0, fuel: 0, emeralds: 0, armor: 0, furnace: 0 },
    fromZeroSurvivalJourney: false, browserGuiVerified: false,
  }));
});
