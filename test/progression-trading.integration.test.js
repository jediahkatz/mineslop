import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { generateTraderOffers, TRADING_PROFESSIONS } from "../src/trading-offers.js";
import { progressionStack } from "./progression-live-fixture.js";
import { progressionTradingFixture } from "./progression-trading-fixture.js";

const total = (f, id) => f.gameplay.slots.reduce(
  (sum, stack) => sum + (stack?.id === id ? stack.count : 0), 0
);
const prices = (f) => f.services.trading.get(f.npcId).offers.map(({ uses: _uses, ...offer }) => offer);
const offer = (f, id = "farmer/wheat") => f.services.view().offers.find((entry) => entry.id === id);
const trade = (f, value, count = 1) => f.action({ type: "trade", offerId: value.id, count });

test("all six live professions admit real jobsites and retain identity-seeded offers across reopening", (t) => {
  for (const profession of TRADING_PROFESSIONS) {
    const f = progressionTradingFixture(t, { profession });
    assert.equal(f.openTrader().opened, true);
    const expected = generateTraderOffers(f.npcId, profession, f.context);
    assert.deepEqual(f.services.trading.get(f.npcId).offers, expected);
    assert.equal(f.services.view().kind, "trading");
    for (let i = 0; i < 3; i++) {
      assert.equal(f.openTrader().opened, true);
      assert.deepEqual(f.services.trading.get(f.npcId).offers, expected);
    }
    assert.equal(f.services.trading.load(f.services.trading.serialize()), false,
      "activated ledgers cannot be individually reloaded under a live host");
  }
});

test("ecology id callbacks resolve actual mobs and idle runtime reads retain frozen stock ownership", (t) => {
  const f = progressionTradingFixture(t);
  const observation = f.observations.at(-1).observation;
  assert.equal(f.services.onVillagerIntent("missing-villager", observation), null);
  assert.equal(f.services.onVillagerIntent(f.npcId, observation).ok, true);
  const runtime = f.services.trading.readRuntime(f.npcId);
  assert.equal(runtime.profession, "farmer");
  assert.equal(runtime.needsRestock, false);
  assert.equal(Object.hasOwn(runtime, "offers"), false, "idle readers do not project offer payloads");
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.jobsite.position), true);
  assert.throws(() => { runtime.jobsite.position.x = 0; }, TypeError);
  const before = f.snapshot(), revision = f.services.trading.revision;
  for (let i = 0; i < 20; i++) assert.equal(f.work(), null);
  assert.equal(f.services.trading.revision, revision);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  assert.equal(runtime.needsRestock, false, "a captured runtime projection is immutable");
  assert.equal(f.services.trading.readRuntime(f.npcId).needsRestock, true);
  assert.equal(f.work().ok, true);
  assert.equal(f.services.trading.readRuntime(f.npcId).needsRestock, false);
});

test("one live trade atomically pays exact inventory, output, finite stock, player XP and earned villager level", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  assert.equal(value.inputs[0].id, ITEM.WHEAT);
  assert.equal(value.inputs[0].count, 20);
  assert.deepEqual(value.output, progressionStack(ITEM.EMERALD));
  f.stock(value, 5);
  const before = f.snapshot(), xp = f.gameplay.getState().experience.total;
  const plan = f.prepare({ type: "trade", offerId: value.id, count: 5 });
  assert.ok(plan.participants);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(plan.participants.length, 2);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(total(f, ITEM.WHEAT), 0);
  assert.equal(total(f, ITEM.EMERALD), 5);
  assert.equal(f.services.trading.get(f.npcId).xp, 10);
  assert.equal(f.services.trading.get(f.npcId).locked, true);
  assert.equal(f.services.view().level, 2);
  assert.equal(offer(f).remaining, value.maxUses - 5);
  assert.ok(offer(f, "farmer/pumpkin"), "level two is earned through payment");
  assert.equal(f.gameplay.getState().experience.total, xp + 15);
  const after = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), after);
});

test("full output, missing/renamed payment and save-budget rejection never spend stock or XP", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  for (const payment of [
    progressionStack(ITEM.WHEAT, 19),
    progressionStack(ITEM.WHEAT, 20, { name: "Keep my harvest" }),
  ]) {
    f.editInventory((owned) => { owned.slots.fill(null); owned.slots[0] = payment; return true; });
    const before = f.snapshot();
    assert.equal(trade(f, value).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
  f.editInventory((owned) => {
    owned.slots.fill(progressionStack(BLOCK.STONE, 64));
    owned.slots[0] = progressionStack(ITEM.WHEAT, 64);
    return true;
  });
  const full = f.snapshot();
  assert.equal(trade(f, value).ok, false);
  assert.deepEqual(f.snapshot(), full);

  const librarian = progressionTradingFixture(t, { profession: "librarian" });
  assert.equal(librarian.openTrader().opened, true);
  const book = offer(librarian, "librarian/first-book");
  librarian.stock(book);
  const plan = librarian.prepare({ type: "trade", offerId: book.id });
  assert.ok(plan.participants.reduce((sum, part) => sum + part.afterBytes - part.beforeBytes, 0) > 0);
  const ballast = {};
  assert.equal(librarian.coordinator.register(ballast,
    MAX_RESERVED_BYTES - librarian.coordinator.budget.totalBytes), true);
  t.after(() => librarian.coordinator.release(ballast));
  const before = librarian.snapshot();
  assert.equal(librarian.services.commit(plan).reason, "budget-rejected");
  assert.deepEqual(librarian.snapshot(), before);
});

test("ecology revisions, physical pose, jobsite cells, calendar and menu tokens are real trade prerequisites", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  for (const invalidate of [
    () => f.ecology.invalidateAvailability(),
    () => {
      const pose = f.player.position.clone();
      f.player.setPosition({ ...pose, x: pose.x + 0.5 });
      f.player.setPosition(pose);
    },
    () => {
      const cell = f.world.getCell(f.site.x, f.site.y, f.site.z);
      f.put(f.site.x, f.site.y, f.site.z, BLOCK.AIR);
      f.put(f.site.x, f.site.y, f.site.z, cell.id, cell.state, cell.fluid);
    },
    () => { f.assignment = { ...f.assignment, revision: f.assignment.revision + 1 }; },
    () => { assert.equal(f.building.worldClock.advance(0.05), true); },
    () => { f.services.close(); assert.equal(f.openTrader().opened, true); },
  ]) {
    f.stock(value);
    const plan = f.prepare({ type: "trade", offerId: value.id });
    assert.ok(plan.participants);
    invalidate();
    const before = f.snapshot();
    assert.equal(f.services.commit(plan).ok, false);
    assert.deepEqual(f.snapshot(), before);
  }
  f.player.setPosition({ x: 8.5, y: 65, z: 15 });
  const outOfReach = f.snapshot();
  assert.equal(trade(f, value).ok, false);
  assert.deepEqual(f.snapshot(), outOfReach);
  assert.equal(f.services.frame(0).ok, true);
  assert.equal(f.services.isOpen, false);
});

test("only real work observations replenish stock, at most twice per actual building-calendar day", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f), initialPrices = prices(f);
  const exhaust = () => {
    assert.equal(f.openTrader().opened, true);
    f.stock(value, value.maxUses);
    assert.equal(trade(f, value, value.maxUses).ok, true);
    assert.equal(offer(f).remaining, 0);
    assert.equal(trade(f, value).ok, false);
  };
  exhaust();
  assert.equal(f.work().ok, true);
  assert.equal(f.services.trading.get(f.npcId).restocks, 1);
  exhaust();
  assert.equal(f.work(), null, "same calendar work tick cannot restock twice");
  assert.equal(f.building.worldClock.advance(1), true);
  assert.equal(f.work().ok, true);
  assert.equal(f.services.trading.get(f.npcId).restocks, 2);
  exhaust();
  assert.equal(f.building.worldClock.advance(1), true);
  assert.equal(f.work(), null);
  assert.deepEqual(prices(f), initialPrices);
  assert.equal(f.building.worldClock.advance(1200 * 3), true);
  assert.equal(f.openTrader().opened, true);
  assert.equal(offer(f).remaining, 0, "skipped days and menu opening perform no work");
  assert.equal(f.services.view().restocks, 0, "only today's allowance resets");
  assert.equal(f.work().ok, true);
  assert.equal(f.services.trading.get(f.npcId).restocks, 1);
  assert.deepEqual(prices(f), initialPrices);
});

test("stale work notifications, inaccessible jobsites, nitwits and dormant NPCs cannot restock or trade", (t) => {
  const f = progressionTradingFixture(t);
  const work = f.observations.at(-1).observation;
  assert.equal(work.intent, "work");
  assert.equal(f.services.onVillagerIntent(f.mob, { ...work, assignmentRevision: 0 }), null);
  assert.equal(f.services.trading.get(f.npcId), null);
  assert.equal(f.services.onVillagerIntent({ ...f.mob }, work), null, "actual ecology instance is mandatory");
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  f.put(f.site.x, f.site.y, f.site.z, BLOCK.AIR);
  const ledger = f.services.trading.serialize();
  assert.equal(f.work(), null);
  assert.deepEqual(f.services.trading.serialize(), ledger);
  assert.equal(f.openTrader().opened, true, "locked traders may sell remaining stock without work");
  f.mob.dormant = true;
  const before = f.snapshot();
  assert.equal(trade(f, value).ok, false);
  assert.deepEqual(f.snapshot(), before);
  f.mob.dormant = false;
  f.assignment = { ...f.assignment, profession: "nitwit", revision: 2 };
  f.ecology.update(f.mob, 0.05, f.ecologyContext);
  assert.equal(f.openTrader().ok, false);
});

test("physical jobsite release is prepared with World ownership and preserves all saved offers and history", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  const trader = f.services.trading.get(f.npcId);
  const mutation = f.world.prepareMutation([{
    ...f.site, before: f.world.getCell(f.site.x, f.site.y, f.site.z),
    after: normalizeCell({ id: BLOCK.AIR }),
  }]);
  assert.ok(mutation);
  const plan = f.services.prepareVillagerJobsiteRelease(f.npcId, {
    validate: () => mutation.validate(), participants: [mutation],
  });
  assert.ok(plan);
  assert.equal(f.services.trading.get(f.npcId).jobsite.id, trader.jobsite.id);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.world.get(f.site.x, f.site.y, f.site.z), BLOCK.AIR);
  assert.equal(f.services.trading.get(f.npcId).jobsite, null);
  assert.equal(f.services.trading.get(f.npcId).xp, trader.xp);
  assert.deepEqual(f.services.trading.get(f.npcId).offers, trader.offers);
  assert.equal(f.services.commit(plan).ok, false);
});

test("close, death, dimension travel and detached reload retain purchased book metadata, offers and stock", (t) => {
  const f = progressionTradingFixture(t, { profession: "librarian", seed: "" });
  assert.equal(f.openTrader().opened, true);
  const value = offer(f, "librarian/first-book");
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  assert.deepEqual(f.gameplay.slots.find((stack) => stack?.id === ITEM.ENCHANTED_BOOK), value.output);
  const ledger = f.services.trading.serialize();
  f.services.close();
  f.gameplay.damage(100, "fall");
  assert.deepEqual(f.services.trading.serialize(), ledger);
  assert.equal(f.gameplay.respawn(), true);
  f.services.onDimensionChange();
  f.world.setDimension("nether").generate(0);
  assert.equal(f.openTrader().ok, false);
  f.world.setDimension("overworld").generate(0);
  const restored = progressionTradingFixture(t, { profession: "librarian", saved: f.snapshot() });
  assert.deepEqual(restored.services.trading.serialize(), ledger);
  assert.equal(restored.openTrader().opened, true);
  assert.deepEqual(restored.services.trading.serialize(), ledger);
  assert.equal(offer(restored, value.id).remaining, value.maxUses - 1);
  assert.deepEqual(restored.gameplay.slots.find((stack) => stack?.id === ITEM.ENCHANTED_BOOK), value.output);
});

test("real work reclaims a replacement jobsite without rerolling offers or restocking on assignment", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  const previous = f.services.trading.get(f.npcId);
  const removal = f.world.prepareMutation([{
    ...f.site, before: f.world.getCell(f.site.x, f.site.y, f.site.z),
    after: normalizeCell({ id: BLOCK.AIR }),
  }]);
  assert.ok(removal);
  const release = f.services.prepareVillagerJobsiteRelease(f.npcId, {
    validate: () => removal.validate(), participants: [removal],
  });
  assert.equal(f.services.commit(release).ok, true);
  const site = { x: 10, y: 65, z: 9 };
  f.put(site.x, site.y, site.z, BLOCK.COMPOSTER);
  f.assignment = {
    ...f.assignment, revision: f.assignment.revision + 1,
    jobSite: { id: "fixture:village/job_site/replacement",
      position: { x: site.x + 0.5, y: site.y, z: site.z + 0.5 } },
  };
  assert.equal(f.work().ok, true);
  const assigned = f.services.trading.get(f.npcId);
  assert.equal(assigned.jobsite.id, f.assignment.jobSite.id);
  assert.deepEqual(assigned.jobsite.position, site);
  assert.deepEqual(assigned.offers, previous.offers, "reassignment retains every stock use and payload");
  assert.equal(assigned.xp, previous.xp);
  assert.equal(assigned.restocks, previous.restocks);
  assert.equal(assigned.locked, true);
  assert.equal(f.work().ok, true, "a subsequent actual work event, not assignment, may replenish stock");
  assert.equal(f.services.trading.get(f.npcId).restocks, 1);
});

test("jobsite-assignment plans pin the actual ecology assignment and cannot change a traded profession", (t) => {
  const f = progressionTradingFixture(t);
  assert.equal(f.openTrader().opened, true);
  const value = offer(f);
  f.stock(value);
  assert.equal(trade(f, value).ok, true);
  f.services.close();
  const site = { x: 10, y: 65, z: 9 };
  f.put(site.x, site.y, site.z, BLOCK.COMPOSTER);
  f.assignment = {
    ...f.assignment, revision: f.assignment.revision + 1,
    jobSite: { id: "fixture:village/job_site/proposed",
      position: { x: site.x + 0.5, y: site.y, z: site.z + 0.5 } },
  };
  const plan = f.services.prepareVillagerJobsiteAssignment(f.npcId);
  assert.ok(plan?.participants);
  f.ecology.invalidateAvailability();
  const before = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), before);
  f.put(site.x, site.y, site.z, BLOCK.LECTERN);
  f.assignment = { ...f.assignment, profession: "librarian", revision: f.assignment.revision + 1 };
  assert.equal(f.services.prepareVillagerJobsiteAssignment(f.npcId), null);
  assert.equal(f.services.trading.get(f.npcId).profession, "farmer");
  assert.deepEqual(f.services.trading.serialize(), before.progression.trading);
});

test("one explosion releases multiple jobsite claims with World, both physical escrows and all drops exactly once", (t) => {
  const authored = progressionTradingFixture(t, { profession: "cleric" });
  const other = progressionTradingFixture(t, { profession: "toolsmith" });
  assert.equal(authored.openTrader().opened, true);
  assert.equal(other.openTrader().opened, true);
  const first = { ...authored.site, dimension: "overworld" };
  const second = { x: 6, y: 65, z: 8, dimension: "overworld" };
  authored.put(second.x, second.y, second.z, BLOCK.SMITHING_TABLE);
  authored.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.BLAZE_POWDER, 2);
    owned.slots[1] = progressionStack(ITEM.NETHERITE_INGOT, 3);
    return true;
  });
  assert.equal(authored.open(first).opened, true);
  authored.transfer(0, 4);
  assert.equal(authored.open(second).opened, true);
  authored.transfer(1, 2);
  const saved = authored.snapshot();
  // Authored import: the second real admitted trader is currently unloaded.
  // Destruction must release its saved claim without fabricating availability.
  const secondary = other.services.trading.serialize().npcs[0];
  secondary.jobsite.position = { x: second.x, y: second.y, z: second.z };
  saved.progression.trading.npcs.push(secondary);
  const f = progressionTradingFixture(t, { profession: "cleric", saved });
  const changes = [first, second].map((at) => ({
    ...at, before: f.world.getCell(at.x, at.y, at.z), after: normalizeCell({ id: BLOCK.AIR }),
  }));
  const ids = [first, second].map(({ dimension, x, y, z }) =>
    f.services.trading.jobsiteOwnerAt(dimension, { x, y, z }));
  assert.deepEqual(ids, [authored.npcId, other.npcId]);
  const beforeLedger = f.services.trading.serialize();
  const prepare = () => {
    const removal = f.services.prepareStationRemoval(changes, {
      extraDrops: [progressionStack(BLOCK.BREWING_STAND), progressionStack(BLOCK.SMITHING_TABLE)],
    });
    assert.equal(removal.ok, true);
    return f.services.prepareVillagerJobsitesRelease(ids, {
      participants: removal.participants,
      validate: () => removal.participants.every((part) => part.validate()),
    });
  };
  const stale = prepare();
  f.put(second.x, second.y, second.z, BLOCK.AIR);
  f.put(second.x, second.y, second.z, BLOCK.SMITHING_TABLE);
  const unchanged = f.snapshot();
  assert.equal(f.services.commit(stale).ok, false);
  assert.deepEqual(f.snapshot(), unchanged);
  assert.equal(f.services.prepareVillagerJobsitesRelease([ids[0], ids[0]], {
    validate: () => f.services.active,
  }), null);
  const plan = prepare();
  assert.equal(plan.participants.length, 4);
  assert.equal(new Set(plan.participants.map((part) => part.owner)).size, 4);
  assert.equal(f.services.commit(plan).ok, true);
  assert.equal(f.services.stations.size, 0);
  for (const { dimension, x, y, z } of [first, second]) {
    assert.equal(f.world.get(x, y, z), BLOCK.AIR);
    assert.equal(f.services.trading.jobsiteOwnerAt(dimension, { x, y, z }), null);
  }
  for (const id of ids) {
    const before = beforeLedger.npcs.find((record) => record.id === id);
    const after = f.services.trading.get(id);
    assert.equal(after.jobsite, null);
    assert.deepEqual(after.offers, before.offers);
    assert.equal(after.xp, before.xp);
  }
  const retained = f.overflow.serialize().entries;
  assert.equal(retained.find((stack) => stack.id === ITEM.BLAZE_POWDER).count, 2);
  assert.equal(retained.find((stack) => stack.id === ITEM.NETHERITE_INGOT).count, 3);
  assert.equal(retained.length, 4);
  const paid = f.snapshot();
  assert.equal(f.services.commit(plan).ok, false);
  assert.deepEqual(f.snapshot(), paid);
});
