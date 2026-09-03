import assert from "node:assert/strict";
import { Gameplay } from "../src/gameplay.js";
import {
  insertStack,
  splitStackPayload,
} from "../src/inventory-slots.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { Trading, TRADING_JOBSITES } from "../src/trading.js";
import { progressionContext } from "./exploration-ledger-fixture.js";

// Keep the existing trading-test imports compatible without requiring Trading
// when only exploration/loot's checkpoint suites are imported.
export {
  ExplorationDestination,
  progressionContext,
  structureMarker,
  veto,
} from "./exploration-ledger-fixture.js";

/** Authored NPC/jobsite observations; no visible villager or natural spawn claim. */
export function traderFixture(profession = "farmer", id = "fixture:village/npc/first") {
  const context = progressionContext();
  const coordinator = new TransactionCoordinator();
  const trading = new Trading({ context, coordinator });
  const inventory = new Gameplay({ context, coordinator });
  const availability = {
    adult: true, alive: true, nitwit: false, available: true,
    dimension: "overworld", revision: 0,
  };
  const checks = { jobsiteUsable: true };
  const readAvailability = () => ({ ...availability });
  const jobsiteUsable = () => checks.jobsiteUsable;
  const jobsite = TRADING_JOBSITES[profession] ? {
    id: "fixture:village/jobsite/first",
    kind: TRADING_JOBSITES[profession],
    dimension: "overworld",
    position: { x: 8, y: 64, z: 8 },
  } : null;
  const plan = trading.prepareRegister({ id, profession, jobsite }, {
    clock: { day: 0, time: 1000 },
    validate: () => true, readAvailability, jobsiteUsable,
  });
  assert.ok(plan, `Real registered resources are required for ${profession}`);
  assert.equal(trading.commit(plan).ok, true);
  return {
    context, coordinator, trading, inventory, id, jobsite,
    availability, checks, readAvailability, jobsiteUsable,
  };
}

export function inventoryStacks(fixture, payloads, { resetXp = false } = {}) {
  const plan = fixture.inventory.prepareInventory((owned) => {
    owned.slots.fill(null);
    if (resetXp) owned.experienceTotal = 0;
    for (const payload of payloads) {
      const stacks = splitStackPayload(payload, 36, fixture.context);
      assert.ok(stacks);
      for (const stack of stacks) assert.equal(insertStack(owned.slots, stack), null);
    }
    return true;
  });
  assert.ok(plan);
  assert.equal(fixture.coordinator.commit([plan]).ok, true);
}

export function stockTradeInputs(fixture, offer, count = 1) {
  inventoryStacks(fixture, offer.inputs.map((input) => ({
    ...structuredClone(input), count: input.count * count,
  })));
}

export const tradeOptions = (fixture, time = 2000, day = 0, extra = {}) => ({
  inventory: fixture.inventory,
  clock: { day, time },
  readAvailability: fixture.readAvailability,
  validate: () => true,
  ...extra,
});
