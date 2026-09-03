import assert from "node:assert/strict";
import test from "node:test";
import { prepareAnvilTransaction } from "../src/anvil.js";
import { BLOCK } from "../src/blocks.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import {
  createEnchantingPlayer,
  getEnchantingOffers,
  prepareEnchantingTransaction,
} from "../src/enchanting.js";
import { experienceForLevel } from "../src/experience.js";
import { ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import {
  anvilOptions,
  anvilRecord,
  bindings,
  enchantingOptions,
  enchantingRecord,
  materialStack,
  receiveInventory,
  stationFixture,
  tool,
} from "./enchantment-fixture.js";

function veto(coordinator) {
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  return Object.freeze({
    owner,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () => false,
    publish: () => assert.fail("A vetoed participant must not publish"),
  });
}

test("enchanting prepares read-only and commits input, lapis, XP and player seed together", () => {
  const f = stationFixture("enchanting", {
    record: enchantingRecord(
      tool(ITEM.IRON_PICKAXE, 17, { name: "Saved pick", repairCost: 3 }),
      materialStack(ITEM.LAPIS, 4)
    ),
    experienceTotal: experienceForLevel(30),
  });
  const before = f.snapshot();
  const seed = f.source.state.playerState.seed;
  const plan = prepareEnchantingTransaction(enchantingOptions(f));
  assert.equal(plan.ok, true);
  assert.equal(plan.prepared, true);
  assert.equal(plan.participants.length, 2);
  assert.equal(
    plan.participants.filter((entry) => entry.owner === f.gameplay).length,
    1
  );
  assert.equal(f.snapshot(), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(27));
  assert.equal(f.source.state.record.lapis.count, 1);
  assert.equal(f.source.state.record.input.durability, 17);
  assert.equal(f.source.state.record.input.data.name, "Saved pick");
  assert.equal(f.source.state.record.input.data.repairCost, 3);
  assert.deepEqual(f.source.state.record.input, plan.result.output);
  assert.equal(f.source.state.playerState.seed, nextEnchantingSeed(seed));
  assert.equal(f.gameplay.getState().cursor, null);
  const paid = f.snapshot();
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.snapshot(), paid);
});

test("a second prepared click cannot spend the same escrow/seed twice", () => {
  const f = stationFixture("enchanting");
  const options = enchantingOptions(f);
  const first = prepareEnchantingTransaction(options);
  const second = prepareEnchantingTransaction(options);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(f.coordinator.commit(first.participants).ok, true);
  const after = f.snapshot();
  assert.equal(f.coordinator.commit(second.participants).ok, false);
  assert.equal(f.snapshot(), after);
});

test("an unavailable station participant refuses without an XP fallback or seed advance", () => {
  const f = stationFixture("enchanting");
  const before = f.snapshot();
  const failed = prepareEnchantingTransaction(
    enchantingOptions(f, {
      prepareStation: () => null,
    })
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "station_rejected");
  assert.equal(f.snapshot(), before);
  const empty = prepareEnchantingTransaction(
    enchantingOptions(f, {
      prepareStation: () => [],
    })
  );
  assert.equal(empty.ok, false);
  assert.equal(f.snapshot(), before);
});

test("insufficient XP or lapis during player preparation changes no ownership", () => {
  const poor = stationFixture("enchanting", {
    experienceTotal: experienceForLevel(30) - 1,
  });
  const poorBefore = poor.snapshot();
  assert.equal(
    prepareEnchantingTransaction(enchantingOptions(poor)).reason,
    "required_level"
  );
  assert.equal(poor.snapshot(), poorBefore);
  const noLapis = stationFixture("enchanting", {
    record: enchantingRecord(tool(), materialStack(ITEM.LAPIS, 2)),
  });
  const lapisBefore = noLapis.snapshot();
  assert.equal(
    prepareEnchantingTransaction(enchantingOptions(noLapis)).reason,
    "insufficient_lapis"
  );
  assert.equal(noLapis.snapshot(), lapisBefore);
});

test("a later required participant veto leaves enchanting input, output, XP, lapis and RNG unchanged", () => {
  const f = stationFixture("enchanting");
  const required = veto(f.coordinator);
  const before = f.snapshot();
  const plan = prepareEnchantingTransaction(
    enchantingOptions(f, { participants: [required] })
  );
  assert.equal(plan.ok, true);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.snapshot(), before);
});

test("shelf, access and source revisions are revalidated before any payment", () => {
  for (const invalidate of [
    (f) => {
      f.shelvesRevision++;
    },
    (f) => {
      f.access = false;
    },
    (f) => {
      f.source.accept = false;
    },
  ]) {
    const f = stationFixture("enchanting");
    const before = f.snapshot();
    const plan = prepareEnchantingTransaction(enchantingOptions(f));
    assert.equal(plan.ok, true);
    invalidate(f);
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.equal(f.snapshot(), before);
  }
});

test("mutating the shelf snapshot does not validate an offer calculated with old power", () => {
  const f = stationFixture("enchanting");
  const options = enchantingOptions(f);
  const plan = prepareEnchantingTransaction(options);
  const before = f.snapshot();
  options.shelves.power = 0;
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.snapshot(), before);
});

test("XP and seed changes from another action invalidate an old prepared offer", () => {
  const f = stationFixture("enchanting");
  const staleXp = prepareEnchantingTransaction(enchantingOptions(f));
  assert.equal(f.gameplay.addExperience(1), true);
  const afterXp = f.snapshot();
  assert.equal(f.coordinator.commit(staleXp.participants).ok, false);
  assert.equal(f.snapshot(), afterXp);
  const staleSeed = prepareEnchantingTransaction(enchantingOptions(f));
  const before = f.source.state;
  const seedChange = f.prepareStation({
    before,
    after: {
      ...before,
      playerState: createEnchantingPlayer(
        nextEnchantingSeed(before.playerState.seed)
      ),
    },
  });
  assert.ok(seedChange);
  assert.equal(f.coordinator.commit([seedChange]).ok, true);
  const afterSeed = f.snapshot();
  assert.equal(f.coordinator.commit(staleSeed.participants).ok, false);
  assert.equal(f.snapshot(), afterSeed);
});

test("archive-capacity rejection is atomic and a still-valid plan can succeed after capacity is available", () => {
  const f = stationFixture("enchanting");
  const filler = {};
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const before = f.snapshot();
  const plan = prepareEnchantingTransaction(enchantingOptions(f));
  assert.equal(plan.ok, true);
  const refused = f.coordinator.commit(plan.participants);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "budget-rejected");
  assert.equal(f.snapshot(), before);
  assert.equal(f.coordinator.release(filler), true);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(
    f.source.state.playerState.seed,
    nextEnchantingSeed(plan.result.before.playerState.seed)
  );
});

test("missing read guards, async preparers and invalid required participants cannot be silently omitted", () => {
  const f = stationFixture("enchanting");
  const before = f.snapshot();
  for (const overrides of [
    { validateAccess: undefined },
    { shelves: { ok: true, power: 15 } },
    { prepareStation: async () => assert.fail("async preparer must not run") },
    { participants: [null] },
    { participants: null },
  ]) {
    assert.equal(
      prepareEnchantingTransaction(enchantingOptions(f, overrides)).ok,
      false
    );
    assert.equal(f.snapshot(), before);
  }
});

test("duplicate/foreign owners reject instead of creating a second Gameplay or station authority", () => {
  const f = stationFixture("enchanting");
  const before = f.snapshot();
  const duplicate = prepareEnchantingTransaction(
    enchantingOptions(f, {
      prepareStation: (change) => {
        const source = f.prepareStation(change);
        return [source, source];
      },
    })
  );
  assert.equal(duplicate.reason, "invalid_participant");
  const otherCoordinator = new TransactionCoordinator();
  const foreign = veto(otherCoordinator);
  const other = prepareEnchantingTransaction(
    enchantingOptions(f, {
      prepareStation: () => foreign,
    })
  );
  assert.equal(other.reason, "invalid_participant");
  assert.equal(f.snapshot(), before);
});

test("close/reload projections retain unpaid escrow and reproduce offers without a persisted result", () => {
  const f = stationFixture("enchanting", {
    record: enchantingRecord(tool(ITEM.IRON_PICKAXE, 19, { name: "Escrow" })),
    experienceTotal: experienceForLevel(30),
  });
  const before = f.snapshot();
  const paidOnlyAfterCommit = prepareEnchantingTransaction(
    enchantingOptions(f)
  );
  assert.equal(paidOnlyAfterCommit.ok, true);
  assert.equal(f.snapshot(), before);
  const saved = JSON.parse(JSON.stringify(f.source.state));
  assert.equal(Object.hasOwn(saved.record, "output"), false);
  assert.equal(saved.record.input.data.enchantments, undefined);
  const reloaded = stationFixture("enchanting", {
    ...saved,
    experienceTotal: f.gameplay.getState().experience.total,
  });
  const menu = (fixture) =>
    getEnchantingOffers({
      input: fixture.source.state.record.input,
      playerState: fixture.source.state.playerState,
      bookshelfPower: 15,
      bindings,
    });
  assert.deepEqual(menu(reloaded), menu(f));
  assert.deepEqual(reloaded.source.state, f.source.state);
});

test("anvil commits left consumption, exact right debit, output, XP and prior work together", () => {
  const f = stationFixture("anvil", {
    record: anvilRecord(
      tool(ITEM.IRON_PICKAXE, 17, {
        name: "Left identity",
        enchantments: { efficiency: 3 },
        repairCost: 1,
      }),
      materialStack(ITEM.IRON_INGOT, 8, { name: "Repair reserve" })
    ),
    experienceTotal: experienceForLevel(30),
  });
  const before = f.snapshot();
  const plan = prepareAnvilTransaction(anvilOptions(f));
  assert.equal(plan.ok, true);
  assert.equal(plan.result.levelCost, 5);
  assert.equal(f.snapshot(), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(25));
  assert.equal(f.source.state.record.left, null);
  assert.equal(f.source.state.record.right.count, 4);
  assert.equal(f.source.state.record.right.data.name, "Repair reserve");
  const output = f.gameplay.getState().cursor;
  assert.equal(output.id, ITEM.IRON_PICKAXE);
  assert.equal(output.durability, 250);
  assert.equal(output.data.name, "Left identity");
  assert.equal(output.data.repairCost, 3);
  assert.deepEqual(output.data.enchantments, { efficiency: 3 });
  const paid = f.snapshot();
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.snapshot(), paid);
});

test("full cursor and full backpack reject anvil output with no costs or input loss", () => {
  const cursor = stationFixture("anvil");
  cursor.editInventory((owned) => {
    owned.cursor = materialStack(ITEM.APPLE, 64);
    return true;
  });
  const cursorBefore = cursor.snapshot();
  assert.equal(
    prepareAnvilTransaction(anvilOptions(cursor)).reason,
    "output_capacity"
  );
  assert.equal(cursor.snapshot(), cursorBefore);
  const backpack = stationFixture("anvil");
  backpack.editInventory((owned) => {
    owned.slots = Array.from({ length: 36 }, () =>
      materialStack(BLOCK.DIRT, 64)
    );
    return true;
  });
  const packBefore = backpack.snapshot();
  assert.equal(
    prepareAnvilTransaction(
      anvilOptions(backpack, {
        receiveOutput: receiveInventory,
      })
    ).reason,
    "output_capacity"
  );
  assert.equal(backpack.snapshot(), packBefore);
});

test("anvil never falls back to eager drops or silently accepts missing output destinations", () => {
  const f = stationFixture("anvil");
  const before = f.snapshot();
  for (const receiveOutput of [undefined, async () => true, () => false]) {
    const result = prepareAnvilTransaction(
      anvilOptions(f, {
        receiveOutput,
        acceptDrop: () => assert.fail("no eager drop fallback"),
      })
    );
    assert.equal(result.ok, false);
    assert.equal(f.snapshot(), before);
  }
});

test("anvil prepared-source or World wear veto prevents output, XP payment and prior-work escalation", () => {
  for (const sourceVeto of [false, true]) {
    const f = stationFixture("anvil", {
      record: anvilRecord(
        tool(ITEM.IRON_PICKAXE, 17, { repairCost: 3 }),
        materialStack(ITEM.IRON_INGOT, 2)
      ),
    });
    const required = veto(f.coordinator);
    const before = f.snapshot();
    const plan = prepareAnvilTransaction(
      anvilOptions(f, {
        participants: sourceVeto ? [] : [required],
      })
    );
    assert.equal(plan.ok, true);
    assert.equal(plan.result.output.data.repairCost, 7);
    if (sourceVeto) f.source.accept = false;
    assert.equal(f.coordinator.commit(plan.participants).ok, false);
    assert.equal(f.source.state.record.left.data.repairCost, 3);
    assert.equal(f.gameplay.getState().cursor, null);
    assert.equal(f.snapshot(), before);
  }
});

test("anvil insufficient XP and stale keys fail before source preparation or output ownership", () => {
  const f = stationFixture("anvil", { experienceTotal: 0 });
  const before = f.snapshot();
  assert.equal(
    prepareAnvilTransaction(anvilOptions(f)).reason,
    "insufficient_levels"
  );
  assert.equal(f.snapshot(), before);
  const stale = stationFixture("anvil");
  const staleBefore = stale.snapshot();
  assert.equal(
    prepareAnvilTransaction(
      anvilOptions(stale, {
        previewKey: "old preview",
      })
    ).reason,
    "stale_preview"
  );
  assert.equal(stale.snapshot(), staleBefore);
});

test("rename-only uses its confirmed UI text and caps actual Gameplay payment at 39 levels", () => {
  const f = stationFixture("anvil", {
    record: anvilRecord(
      tool(ITEM.IRON_PICKAXE, 17, {
        name: "Old name",
        repairCost: 63,
      }),
      null
    ),
    experienceTotal: experienceForLevel(40),
  });
  const before = f.snapshot();
  const plan = prepareAnvilTransaction(
    anvilOptions(f, { rename: "Confirmed name" })
  );
  assert.equal(plan.ok, true);
  assert.equal(plan.result.levelCost, 39);
  assert.equal(f.snapshot(), before);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.gameplay.getState().experience.total, experienceForLevel(1));
  assert.equal(f.gameplay.getState().cursor.data.name, "Confirmed name");
  assert.equal(f.gameplay.getState().cursor.data.repairCost, 63);
  assert.equal(f.gameplay.getState().cursor.durability, 17);
  assert.equal(f.source.state.record.left, null);
});

test("observer errors occur only after the complete anvil ownership and reservation commit", () => {
  const f = stationFixture("anvil");
  const plan = prepareAnvilTransaction(anvilOptions(f));
  assert.equal(plan.ok, true);
  let inventoryNotifications = 0;
  let stationNotifications = 0;
  const assertCommitted = () => {
    assert.equal(f.source.state.record.left, null);
    assert.equal(f.source.state.record.right, null);
    assert.deepEqual(f.gameplay.getState().cursor, plan.result.output);
    assert.equal(
      f.gameplay.getState().experience.total,
      plan.result.experienceAfter
    );
    assert.equal(f.coordinator.usage(f.source), f.source.bytes);
  };
  f.gameplay.onChange = () => {
    inventoryNotifications++;
    assertCommitted();
  };
  f.source.onChange = () => {
    stationNotifications++;
    assertCommitted();
    throw new Error("Observer failed after commit");
  };
  const committed = f.coordinator.commit(plan.participants);
  assert.equal(committed.ok, true);
  assert.equal(inventoryNotifications, 1);
  assert.equal(stationNotifications, 1);
  assert.equal(committed.observerErrors.length, 1);
  assert.match(
    committed.observerErrors[0].message,
    /Observer failed after commit/
  );
  assertCommitted();
});
