import assert from "node:assert/strict";
import test from "node:test";
import { MAX_EXPERIENCE } from "../src/experience.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionInvariantError } from "../src/transactions.js";
import { applyTradeToInventory } from "../src/trading-inventory.js";
import {
  generateTraderOffers,
  MAX_TRADER_XP,
  traderLevel,
  TRADING_PROFESSIONS,
} from "../src/trading-offers.js";
import { Trading } from "../src/trading.js";
import {
  inventoryStacks,
  progressionContext,
  stockTradeInputs,
  traderFixture,
  tradeOptions,
  veto,
} from "./progression-fixture.js";

const total = (inventory, id) => inventory.slots
  .filter((stack) => stack?.id === id)
  .reduce((sum, stack) => sum + stack.count, 0);
const prices = (npc) => npc.offers.map(({ uses: _uses, ...offer }) => offer);
const firstOffer = (f) => f.trading.offers(f.id)[0];
const snapshot = (f) => [
  f.trading.serialize(), f.inventory.serialize(), f.coordinator.budget.totalBytes,
];
const restockOptions = (f, time, day = 0, extra = {}) => ({
  clock: { day, time }, readAvailability: f.readAvailability,
  jobsiteUsable: f.jobsiteUsable, validate: () => true, ...extra,
});

test("all professions have seeded persistent useful offers without reopen/reload rerolls", () => {
  for (const profession of TRADING_PROFESSIONS) {
    const f = traderFixture(profession);
    const expected = generateTraderOffers(f.id, profession, f.context);
    assert.deepEqual(f.trading.get(f.id).offers, expected);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(f.trading.get(f.id).offers, expected);
    const saved = f.trading.serialize();
    assert.equal(f.trading.load(JSON.parse(JSON.stringify(saved))), true);
    assert.deepEqual(f.trading.get(f.id).offers, expected);
    f.availability.dimension = "nether";
    f.availability.revision++;
    assert.deepEqual(f.trading.get(f.id).offers, expected);
    assert.equal(f.trading.prepareRegister({
      id: f.id, profession, jobsite: f.jobsite,
    }, { ...restockOptions(f, 2000), validate: () => true }), null);
  }
  const variants = new Set(Array.from({ length: 32 }, (_, i) => JSON.stringify(
    generateTraderOffers(`fixture:village/npc/${i}`, "librarian", progressionContext())
  )));
  assert.ok(variants.size > 1, "NPC identity actually seeds initial offer choices");
});

test("payment, output, finite stock, first-trade lock and both XP owners commit once", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer, 5);
  const before = snapshot(f);
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, 2000, 0, { count: 5 }));
  assert.ok(plan);
  assert.equal(plan.participants.length, 2);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.trading.commit(plan).ok, true);
  assert.equal(total(f.inventory, ITEM.WHEAT), 0);
  assert.equal(total(f.inventory, ITEM.EMERALD), 5);
  assert.equal(f.trading.get(f.id).offers[0].uses, 5);
  assert.equal(f.trading.get(f.id).locked, true);
  assert.equal(f.trading.get(f.id).xp, offer.xp * 5);
  assert.equal(f.trading.get(f.id).level, 2);
  assert.equal(f.inventory.serialize().experience.total, offer.playerXp * 5);
  const committed = snapshot(f);
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), committed);
});

test("read prerequisite failures and stale inventory reject without stock, item or XP changes", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  let plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f));
  const before = snapshot(f);
  f.availability.revision++;
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), before);
  plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f));
  inventoryStacks(f, [{ id: ITEM.WHEAT, count: offer.inputs[0].count + 1 }]);
  const changedInventory = snapshot(f);
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), changedInventory);
  plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, 2000, 0, {
    participants: [veto(f.coordinator)],
  }));
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), changedInventory);
});

test("full output capacity and insufficient or decorated payment leave the working draft unchanged", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  inventoryStacks(f, [
    { id: ITEM.WHEAT, count: 64 },
    { id: ITEM.DIRT, count: 35 * 64 },
  ]);
  const before = snapshot(f);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  assert.deepEqual(snapshot(f), before);
  const draft = { slots: f.inventory.slots, experienceTotal: 0 };
  const copy = structuredClone(draft);
  assert.equal(applyTradeToInventory(draft, offer, 1, f.context), false);
  assert.deepEqual(draft, copy);
  inventoryStacks(f, [{
    id: ITEM.WHEAT, count: 64, data: { version: 1, name: "Keep these seeds' harvest" },
  }]);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  inventoryStacks(f, [{ id: ITEM.WHEAT, count: offer.inputs[0].count - 1 }]);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  assert.equal(f.trading.get(f.id).xp, 0);
});

test("aggregate save capacity refusal is exact, and a freeing participant can fund a metadata trade", () => {
  const f = traderFixture("librarian");
  const offer = f.trading.offers(f.id).find((entry) => entry.output.id === ITEM.ENCHANTED_BOOK);
  assert.ok(offer);
  stockTradeInputs(f, offer);
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f));
  assert.ok(plan);
  const delta = plan.participants.reduce((sum, participant) =>
    sum + participant.afterBytes - participant.beforeBytes, 0);
  assert.ok(delta > 0, "this specific metadata trade consumes additional archive bytes");
  const blocker = {};
  const blockedBytes = MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes;
  f.coordinator.register(blocker, blockedBytes);
  const before = snapshot(f);
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), before);
  let freed = false;
  const combined = {
    ...plan,
    participants: [...plan.participants, {
      owner: blocker, beforeBytes: blockedBytes, afterBytes: blockedBytes - delta,
      validate: () => !freed,
      publish: () => { freed = true; },
    }],
  };
  assert.equal(f.trading.commit(combined).ok, true);
  assert.equal(freed, true);
  assert.equal(f.coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
  assert.equal(total(f.inventory, ITEM.ENCHANTED_BOOK), 1);
});

test("stock is finite and only two explicit usable-jobsite restocks occur per calendar day", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  const initialPrices = prices(f.trading.get(f.id));
  const exhaust = (time, day = 0) => {
    stockTradeInputs(f, offer, offer.maxUses);
    const plan = f.trading.prepareTrade(
      f.id, offer.id, tradeOptions(f, time, day, { count: offer.maxUses })
    );
    assert.equal(f.trading.commit(plan).ok, true);
    assert.equal(f.trading.offers(f.id).find((entry) => entry.id === offer.id).remaining, 0);
    assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, time, day)), null);
  };
  exhaust(2000);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 1999)), null);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 9000)), null);
  f.checks.jobsiteUsable = false;
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 3000)), null);
  f.checks.jobsiteUsable = true;
  // There is intentionally no bed field, bed query or bed prerequisite.
  assert.equal(f.trading.commit(f.trading.prepareRestock(f.id, restockOptions(f, 3000))).ok, true);
  assert.equal(f.trading.get(f.id).restocks, 1);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 3100)), null, "full stock is not a restock");
  exhaust(3500);
  assert.equal(f.trading.commit(f.trading.prepareRestock(f.id, restockOptions(f, 5000))).ok, true);
  exhaust(5500);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 6000)), null);
  assert.equal(f.trading.get(f.id).restocks, 2);
  assert.deepEqual(prices(f.trading.get(f.id)), initialPrices);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 0, 1)), null);
  assert.equal(f.trading.offers(f.id).find((entry) => entry.id === offer.id).remaining, 0);
  assert.equal(f.trading.commit(f.trading.prepareRestock(f.id, restockOptions(f, 2500, 3))).ok, true);
  assert.equal(f.trading.get(f.id).restocks, 1, "sleep/missed days do not bank extra restocks");
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 6000, 0)), null);
});

test("jobsite accessibility, NPC revision and dimension are rechecked before restock publication", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  let plan = f.trading.prepareRestock(f.id, restockOptions(f, 3000));
  const before = snapshot(f);
  f.checks.jobsiteUsable = false;
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), before);
  f.checks.jobsiteUsable = true;
  plan = f.trading.prepareRestock(f.id, restockOptions(f, 3000));
  f.availability.revision++;
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), before);
  f.availability.dimension = "nether";
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 3000)), null);
});

test("a captured calendar prerequisite rejects a restock prepared before sleep or a day change", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  let day = 0;
  const plan = f.trading.prepareRestock(f.id, restockOptions(f, 3000, day, {
    validate: () => day === 0,
  }));
  const before = snapshot(f);
  day = 1;
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), before);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, {
    inventory: f.inventory, clock: { day, time: 2000 }, readAvailability: f.readAvailability,
  }), null, "live calendar/interaction prerequisite is mandatory");
});

test("profession changes lock after the first trade; jobsite loss does not reroll or refill", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  const previous = f.trading.get(f.id);
  assert.equal(f.trading.prepareAssign(f.id, {
    profession: "toolsmith",
    jobsite: { ...f.jobsite, kind: "SMITHING_TABLE" },
  }, restockOptions(f, 3000)), null);
  const released = f.trading.prepareAssign(f.id, {
    profession: "farmer", jobsite: null,
  }, restockOptions(f, 3000));
  assert.equal(f.trading.commit(released).ok, true);
  assert.deepEqual(f.trading.get(f.id).offers, previous.offers);
  assert.equal(f.trading.get(f.id).locked, true);
  assert.equal(f.trading.prepareRestock(f.id, restockOptions(f, 4000)), null);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.commit(f.trading.prepareTrade(
    f.id, offer.id, tradeOptions(f, 4000)
  )).ok, true, "remaining stock may trade without a jobsite");
});

test("babies, nitwits, unemployed, dead and unavailable NPCs cannot trade", () => {
  for (const field of ["adult", "alive", "available", "nitwit"]) {
    const f = traderFixture("farmer");
    const offer = firstOffer(f);
    stockTradeInputs(f, offer);
    f.availability[field] = field === "nitwit";
    const before = snapshot(f);
    assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
    assert.deepEqual(snapshot(f), before);
  }
  for (const profession of ["unemployed", "nitwit"]) {
    const f = traderFixture(profession);
    assert.deepEqual(f.trading.offers(f.id), []);
    assert.equal(f.trading.prepareTrade(f.id, "farmer/wheat", tradeOptions(f)), null);
    if (profession === "nitwit") {
      assert.equal(f.trading.prepareAssign(f.id, {
        profession: "farmer",
        jobsite: {
          id: "fixture:composter", kind: "COMPOSTER", dimension: "overworld",
          position: { x: 8, y: 64, z: 8 },
        },
      }, restockOptions(f, 2000)), null);
    }
  }
});

test("untraded profession assignment is deterministic and exclusive jobsites cannot be double-claimed", () => {
  const f = traderFixture("unemployed");
  const jobsite = {
    id: "fixture:composter", kind: "COMPOSTER", dimension: "overworld",
    position: { x: 8, y: 64, z: 8 },
  };
  assert.equal(f.trading.commit(f.trading.prepareAssign(f.id, {
    profession: "farmer", jobsite,
  }, restockOptions(f, 2000))).ok, true);
  const expected = f.trading.get(f.id).offers;
  assert.equal(f.trading.commit(f.trading.prepareAssign(f.id, {
    profession: "unemployed", jobsite: null,
  }, restockOptions(f, 2100))).ok, true);
  assert.equal(f.trading.commit(f.trading.prepareAssign(f.id, {
    profession: "farmer", jobsite,
  }, restockOptions(f, 2200))).ok, true);
  assert.deepEqual(f.trading.get(f.id).offers, expected);
  const otherId = "fixture:village/npc/second";
  assert.equal(f.trading.commit(f.trading.prepareRegister({
    id: otherId, profession: "unemployed",
  }, { clock: { day: 0, time: 2200 }, validate: () => true })).ok, true);
  assert.equal(f.trading.prepareAssign(otherId, {
    profession: "farmer", jobsite,
  }, restockOptions(f, 2300)), null);
});

test("death or a destroyed jobsite can release the claim without erasing persistent trade progress", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  const before = f.trading.get(f.id);
  f.availability.alive = false;
  f.availability.revision++;
  const refused = f.trading.prepareReleaseJobsite(f.id, {
    clock: { day: 0, time: 3000 },
    validate: () => true,
    participants: [veto(f.coordinator)],
  });
  assert.equal(f.trading.commit(refused).ok, false);
  assert.deepEqual(f.trading.get(f.id), before);
  const released = f.trading.prepareReleaseJobsite(f.id, {
    clock: { day: 0, time: 3000 }, validate: () => !f.availability.alive,
  });
  assert.equal(f.trading.commit(released).ok, true);
  assert.equal(f.trading.get(f.id).jobsite, null);
  assert.equal(f.trading.get(f.id).xp, before.xp);
  assert.deepEqual(f.trading.get(f.id).offers, before.offers);
  const nextId = "fixture:village/npc/replacement";
  f.availability.alive = true;
  assert.equal(f.trading.commit(f.trading.prepareRegister({
    id: nextId, profession: "farmer", jobsite: f.jobsite,
  }, { ...restockOptions(f, 3100), validate: () => true })).ok, true);
  assert.ok(f.trading.get(f.id), "the original NPC record is retained");
});

test("registered enchantment metadata transfers once and decorated book inputs are not silently spent", () => {
  const f = traderFixture("librarian");
  const offer = f.trading.offers(f.id).find((entry) => entry.output.id === ITEM.ENCHANTED_BOOK);
  const inputs = offer.inputs.map((input) => ({
    ...structuredClone(input),
    ...(input.id === ITEM.BOOK ? { data: { version: 1, name: "Keep this journal" } } : {}),
  }));
  inventoryStacks(f, inputs);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  stockTradeInputs(f, offer);
  const expected = structuredClone(offer.output);
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f));
  offer.output.data.enchantments = { unbreaking: 3 };
  assert.equal(f.trading.commit(plan).ok, true);
  assert.deepEqual(f.inventory.slots.find((stack) => stack?.id === ITEM.ENCHANTED_BOOK), expected);
  assert.equal(f.inventory.serialize().experience.total, 3);
  const after = snapshot(f);
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual(snapshot(f), after);
});

test("actual potion outputs keep canonical data and higher-level offers require earned level", () => {
  const f = traderFixture("cleric");
  const offer = f.trading.get(f.id).offers.find((entry) => entry.output.id === ITEM.POTION);
  stockTradeInputs(f, offer);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  const saved = f.trading.serialize();
  saved.npcs[0].xp = 250;
  saved.npcs[0].locked = true;
  assert.equal(f.trading.load(saved), true, "authored level fixture, not earned gameplay proof");
  const expected = structuredClone(offer.output);
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  assert.deepEqual(f.inventory.slots.find((stack) => stack?.id === ITEM.POTION), expected);
});

test("level partitioning and both experience bounds reject overflow rather than duplicating rewards", () => {
  const boundaries = [[0, 1], [9, 1], [10, 2], [69, 2], [70, 3], [149, 3], [150, 4], [249, 4], [250, 5]];
  for (const [xp, level] of boundaries) assert.equal(traderLevel(xp), level);
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  const player = f.inventory.prepareInventory((owned) => {
    owned.experienceTotal = MAX_EXPERIENCE;
    return true;
  });
  f.coordinator.commit([player]);
  const before = snapshot(f);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
  assert.deepEqual(snapshot(f), before);
  const saved = f.trading.serialize();
  saved.npcs[0].xp = MAX_TRADER_XP;
  saved.npcs[0].locked = true;
  assert.equal(f.trading.load(saved), true);
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)), null);
});

test("all state publishes before observers, and observer errors do not undo a successful trade", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  const error = new Error("authored observer error");
  let observed = false;
  f.trading.onChange = () => {
    observed = f.trading.get(f.id).xp === offer.xp &&
      total(f.inventory, ITEM.EMERALD) === 1 &&
      f.coordinator.usage(f.trading) === f.trading.reservedBytes;
    throw error;
  };
  const result = f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f)));
  assert.equal(result.ok, true);
  assert.equal(observed, true);
  assert.deepEqual(result.observerErrors, [error]);
});

test("only the changed bounded NPC record is admitted; whole-ledger serialization is not an action path", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  const serialize = f.trading.serialize.bind(f.trading);
  f.trading.serialize = () => assert.fail("trade must not serialize the whole ledger");
  assert.equal(f.trading.commit(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f))).ok, true);
  assert.equal(f.trading.reservedBytes, encodedBytes(serialize().npcs) - 2);
  const restored = new Trading({ context: f.context });
  assert.equal(restored.load(serialize()), true);
  assert.deepEqual(restored.serialize(), serialize());
});

test("async preparation/availability and fatal publication violations cannot become ordinary partial trades", () => {
  const f = traderFixture("farmer");
  const offer = firstOffer(f);
  stockTradeInputs(f, offer);
  let invoked = false;
  assert.equal(f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, 2000, 0, {
    readAvailability: async () => { invoked = true; return f.availability; },
  })), null);
  assert.equal(invoked, false);
  const peer = veto(f.coordinator, () => true);
  peer.publish = () => { throw new Error("authored invalid publisher"); };
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f, 2000, 0, {
    participants: [peer],
  }));
  assert.throws(() => f.trading.commit(plan), TransactionInvariantError);
});
