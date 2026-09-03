import assert from "node:assert/strict";
import test from "node:test";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  generateTraderOffers,
  normalizeTradeOffer,
} from "../src/trading-offers.js";
import {
  advanceTraderCalendar,
  MAX_TRADERS,
  normalizeTradeClock,
  normalizeTradingSnapshot,
} from "../src/trading-state.js";
import { stockTradeInputs, traderFixture, tradeOptions } from "./progression-fixture.js";

test("malformed identity, price, metadata, stock and XP snapshots fail without partial replacement", () => {
  const f = traderFixture("farmer");
  const saved = f.trading.serialize();
  const changed = (edit) => {
    const copy = structuredClone(saved);
    edit(copy.npcs[0]);
    return copy;
  };
  const invalid = [
    null,
    { ...saved, version: 99 },
    { ...saved, seed: "different-world" },
    { ...saved, generatorVersion: 3 },
    { ...saved, npcs: new Array(MAX_TRADERS + 1) },
    { ...saved, npcs: [saved.npcs[0], saved.npcs[0]] },
    changed((npc) => { npc.id = "bad npc identity"; }),
    changed((npc) => { npc.profession = "invented_profession"; }),
    changed((npc) => { npc.unknown = true; }),
    changed((npc) => { npc.xp = -1; }),
    changed((npc) => { npc.xp = 10; }),
    changed((npc) => { npc.locked = true; }),
    changed((npc) => { npc.offers[0].uses = 1; }),
    changed((npc) => { npc.offers[0].uses = npc.offers[0].maxUses + 1; }),
    changed((npc) => { npc.offers[0].inputs[0].count = 0; }),
    changed((npc) => { npc.offers[0].inputs[0].count++; }),
    changed((npc) => { npc.offers[0].output.id = ITEM.APPLE; }),
    changed((npc) => { npc.offers[0].output.data = { version: 99 }; }),
    changed((npc) => { npc.offers.push(npc.offers[0]); }),
    changed((npc) => { npc.offers.pop(); }),
    changed((npc) => { npc.jobsite.kind = "LECTERN"; }),
    changed((npc) => { npc.jobsite.position.y = -65; }),
    changed((npc) => { npc.jobsite.dimension = "nether"; npc.jobsite.position.y = -1; }),
    changed((npc) => { npc.restocks = 3; }),
    changed((npc) => { npc.lastRestockTime = 3000; }),
  ];
  for (const value of invalid) {
    assert.equal(normalizeTradingSnapshot(value, f.context), null);
    const bytes = f.trading.reservedBytes;
    assert.equal(f.trading.load(value), false);
    assert.deepEqual(f.trading.serialize(), saved);
    assert.equal(f.trading.reservedBytes, bytes);
  }
});

test("snapshot normalization is detached and rejects accessors rather than executing them", () => {
  const f = traderFixture("librarian");
  const saved = f.trading.serialize();
  const normalized = normalizeTradingSnapshot(saved, f.context);
  assert.ok(normalized);
  normalized.npcs[0].offers[1].output.data.enchantments = { efficiency: 5 };
  assert.deepEqual(f.trading.serialize(), saved);
  const accessor = structuredClone(saved);
  let invoked = false;
  Object.defineProperty(accessor.npcs[0], "xp", {
    enumerable: true,
    get() { invoked = true; return 0; },
  });
  assert.equal(normalizeTradingSnapshot(accessor, f.context), null);
  assert.equal(invoked, false);
  const sparse = structuredClone(saved);
  delete sparse.npcs[0].offers[0];
  assert.equal(normalizeTradingSnapshot(sparse, f.context), null);
});

test("changing valid-looking seeded offer metadata or identity does not reroll an imported NPC", () => {
  const f = traderFixture("librarian");
  const saved = f.trading.serialize();
  const changed = structuredClone(saved);
  changed.npcs[0].offers[1].output.data.enchantments = { efficiency: 5 };
  assert.equal(normalizeTradingSnapshot(changed, f.context), null);
  const idChanged = structuredClone(saved);
  const otherId = Array.from({ length: 32 }, (_, i) => `fixture:unrelated-${i}`)
    .find((id) => JSON.stringify(generateTraderOffers(id, "librarian", f.context)) !==
      JSON.stringify(saved.npcs[0].offers));
  assert.ok(otherId);
  idChanged.npcs[0].id = otherId;
  assert.equal(normalizeTradingSnapshot(idChanged, f.context), null);
  const reordered = structuredClone(saved);
  reordered.npcs[0].offers.reverse();
  assert.deepEqual(normalizeTradingSnapshot(reordered, f.context), saved);
});

test("same-byte reload invalidates old trade plans without changing their payment or saved stock", () => {
  const f = traderFixture("farmer");
  const offer = f.trading.offers(f.id)[0];
  stockTradeInputs(f, offer);
  const plan = f.trading.prepareTrade(f.id, offer.id, tradeOptions(f));
  const before = [f.trading.serialize(), f.inventory.serialize()];
  assert.equal(f.trading.load(f.trading.serialize()), true);
  assert.equal(f.trading.commit(plan).ok, false);
  assert.deepEqual([f.trading.serialize(), f.inventory.serialize()], before);
});

test("capacity-rejected replacement keeps old records; an accepted over-budget import retains all NPCs", () => {
  const f = traderFixture("farmer");
  const saved = f.trading.serialize();
  const larger = structuredClone(saved);
  const second = structuredClone(saved.npcs[0]);
  second.id = "fixture:village/npc/second";
  second.offers = generateTraderOffers(second.id, second.profession, f.context);
  second.jobsite.id = "fixture:village/jobsite/second";
  second.jobsite.position.x++;
  larger.npcs.push(second);
  const blocker = {};
  f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes);
  assert.equal(f.trading.load(larger), false);
  assert.deepEqual(f.trading.serialize(), saved);
  assert.equal(f.trading.load(larger, { allowOverBudget: true }), true);
  assert.deepEqual(f.trading.serialize(), larger);
  assert.equal(f.trading.get(second.id).profession, "farmer");
  assert.ok(f.coordinator.budget.totalBytes > MAX_RESERVED_BYTES);
});

test("import rejects duplicate jobsite identities and coordinates across NPC records", () => {
  const f = traderFixture("farmer");
  const saved = f.trading.serialize();
  const second = structuredClone(saved.npcs[0]);
  second.id = "fixture:village/npc/second";
  second.offers = generateTraderOffers(second.id, second.profession, f.context);
  for (const site of [
    { ...structuredClone(second.jobsite), id: "fixture:another-site-id" },
    { ...structuredClone(second.jobsite), position: { x: 16, y: 64, z: 8 } },
  ]) {
    assert.equal(normalizeTradingSnapshot({
      ...saved, npcs: [saved.npcs[0], { ...second, jobsite: site }],
    }, f.context), null);
  }
});

test("calendar validation is explicit and sleep cannot manufacture stock or elapsed-time rewards", () => {
  for (const clock of [
    null, {}, { day: -1, time: 0 }, { day: 0.5, time: 0 },
    { day: 0, time: -1 }, { day: 0, time: 24000 },
    { day: 0, time: 1, elapsedSeconds: 100000 },
  ]) assert.throws(() => normalizeTradeClock(clock));
  const npc = {
    clock: { day: 4, time: 6000 }, restocks: 2, lastRestockTime: 5000,
    offers: [{ uses: 12 }],
  };
  const before = structuredClone(npc);
  assert.deepEqual(advanceTraderCalendar(npc, { day: 100, time: 0 }), {
    clock: { day: 100, time: 0 }, restocks: 0, lastRestockTime: null,
  });
  assert.deepEqual(npc, before, "calendar projection does not perform a restock");
  assert.throws(() => advanceTraderCalendar(npc, { day: 3, time: 23999 }));
  assert.throws(() => advanceTraderCalendar(npc, { day: 4, time: 5999 }));
});

test("potion and enchantment data must match actual registered item capabilities", () => {
  const f = traderFixture("cleric");
  const potion = f.trading.get(f.id).offers.find((offer) => offer.output.id === ITEM.POTION);
  assert.ok(potion);
  for (const output of [
    { ...potion.output, id: ITEM.BOOK },
    { ...potion.output, data: { version: 1, potion: { id: "water_breathing", form: "drinkable", strong: true } } },
    { ...potion.output, data: { version: 1, enchantments: { efficiency: 1 } } },
  ]) {
    assert.throws(() => normalizeTradeOffer({ ...potion, output }, f.context));
  }
});
