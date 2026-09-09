import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { nextEnchantingSeed, spendExperienceLevels } from "../src/enchantment-domain.js";
import {
  EXPERIENCE_ORB_LIFETIME, MAX_EXPERIENCE_ORBS, MAX_ORB_EXPERIENCE,
} from "../src/experience-orbs.js";
import { experienceForLevel } from "../src/experience.js";
import { ITEM } from "../src/items.js";
import { exportWorldFile, parseWorldFile } from "../src/storage.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

const initialRandom = 0x12345678;
const at = Object.freeze({ x: 8, y: 65, z: 8 });
const data = Object.freeze({ version: 1, name: "Prospector", enchantments: { fortune: 3 } });
const position = ({ x, y, z }) => ({ x, y, z });
const advanceRandom = (state, count) => {
  for (let i = 0; i < count; i++) state = nextEnchantingSeed(state);
  return state;
};

// Finite authored inputs, actual Game/World/Player/resource/archive owners.
// This is not a native resource-acquisition or GPU fixture.
async function fixture(t, {
  saved, block = BLOCK.DIAMOND_ORE, effectsSeed = initialRandom,
  heldTool = "DIAMOND_PICKAXE", overflowMaxEntries,
} = {}) {
  const f = await gameMobFixture(t, {
    saved, seed: "fortune-mining", generatorVersion: 4, activate: false,
    overflowMaxEntries,
  });
  if (!saved) {
    const stations = f.progression.services.stations;
    assert.equal(stations.load({ ...stations.serialize(), randomState: effectsSeed }), true,
      "only the detached test stage receives its fixed initial RNG");
  }
  f.activate();
  if (!saved) {
    f.hold(heldTool, { data });
    f.put(at.x, at.y, at.z, block);
  }
  f.aim({ x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5 });
  f.game.updateTarget();
  if (!saved) {
    assert.equal(f.game.target?.id, block);
    assert.deepEqual(position(f.game.target), at, "the target comes from the actual physical eye ray");
  }
  f.randomState = () => f.progression.services.stations.randomState;
  return f;
}

test("Fortune loot, wear, XP and saved RNG publish once in the real Game mining transaction", async (t) => {
  const f = await fixture(t);
  const before = f.ownership();
  const tableSeed = f.progression.services.stations.playerState;
  const held = f.gameplay.getHandStack();
  f.gameplay.random = () => assert.fail("Fortune mining cannot advance an unowned live RNG");
  const plan = f.game.harvestActions.prepareBreak(f.game.target);
  assert.ok(plan);
  assert.deepEqual(plan.result.drops, [{ id: ITEM.DIAMOND, count: 2 }]);
  assert.equal(plan.result.experience, 7);
  assert.deepEqual(f.ownership(), before, "preparation changes no source, hand, saved RNG or sink");
  assert.deepEqual(f.game.harvestActions.prepareBreak(f.game.target).result, plan.result,
    "repeated preparation cannot reroll the same uncommitted source");
  assert.equal(new Set(plan.participants.map(({ owner }) => owner)).size, plan.participants.length);
  assert.ok(plan.participants.some(({ owner }) => owner === f.progression.services.stations));
  for (const participant of plan.participants) {
    const veto = plan.participants.map((part) => part === participant
      ? { ...part, validate: () => false } : part);
    assert.equal(f.coordinator.commit(veto).ok, false);
    assert.deepEqual(f.ownership(), before, "every peer veto retains all original owners and rolls");
  }
  let notifications = 0;
  f.gameplay.onChange = () => {
    notifications++;
    assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR);
    assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
    assert.equal(f.randomState(), advanceRandom(initialRandom, 2));
  };
  const result = f.game.harvestActions.commit(plan);
  assert.equal(result.ok, true);
  assert.equal(result.dropsCommitted, true);
  assert.equal(result.experienceCommitted, true);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(notifications, 1);
  assert.deepEqual(f.gameplay.getHandStack().data, held.data);
  assert.deepEqual(f.progression.services.stations.playerState, tableSeed,
    "mining cannot reroll enchanting-table offers");
  const committed = f.ownership();
  assert.equal(f.game.harvestActions.commit(plan).ok, false);
  assert.deepEqual(f.ownership(), committed);
});

for (const { name, block, id, count, draws, effectsSeed = initialRandom, heldTool } of [
  { name: "Nether gold including a zero XP roll", block: BLOCK.NETHER_GOLD_ORE,
    id: ITEM.GOLD_NUGGET, count: 16, draws: 3 },
  { name: "raw iron without an XP roll", block: BLOCK.IRON_ORE,
    id: ITEM.RAW_IRON, count: 2, draws: 1 },
  { name: "gravel", block: BLOCK.GRAVEL, heldTool: "DIAMOND_SHOVEL",
    id: ITEM.FLINT, count: 1, draws: 1 },
  { name: "glowstone", block: BLOCK.GLOWSTONE,
    id: ITEM.GLOWSTONE_DUST, count: 4, draws: 2 },
  { name: "sea lantern", block: BLOCK.SEA_LANTERN,
    id: ITEM.PRISMARINE_CRYSTALS, count: 5, draws: 2 },
  { name: "melon", block: BLOCK.MELON, heldTool: "DIAMOND_AXE",
    id: ITEM.MELON_SLICE, count: 8, draws: 2 },
  { name: "coal with a zero XP roll", block: BLOCK.COAL_ORE,
    id: ITEM.COAL, count: 1, draws: 2, effectsSeed: 8 },
]) {
  test(`live ${name} consumes its exact saved loot/XP draw budget`, async (t) => {
    const f = await fixture(t, { block, effectsSeed, heldTool });
    const before = f.ownership();
    const tableSeed = f.progression.services.stations.playerState;
    const held = f.gameplay.getHandStack();
    f.gameplay.random = () => assert.fail("the complete draw budget belongs to the saved RNG");
    const plan = f.game.harvestActions.prepareBreak(f.game.target);
    assert.ok(plan, "unused or over-consumed reserved draws must not silently refuse mining");
    assert.deepEqual(plan.result.drops, [{ id, count }]);
    assert.equal(plan.result.experience, 0);
    assert.deepEqual(f.ownership(), before);
    assert.equal(f.game.harvestActions.commit(plan).ok, true);
    assert.equal(f.randomState(), advanceRandom(effectsSeed, draws));
    assert.deepEqual(f.progression.services.stations.playerState, tableSeed);
    assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
    assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR);
    assert.equal(f.game.experienceOrbs.size, 0, "zero XP is not an orb or a reason to omit its roll");
    assert.equal(f.game.pickups.serialize().items.filter((item) => item.id === id)
      .reduce((sum, item) => sum + item.count, 0), count);
  });
}

for (const sink of ["overflow", "experience"]) {
  for (const durability of [30, 1]) {
    test(`full ${sink} retains Fortune rolls and a ${durability}-durability tool until capacity returns`, async (t) => {
      // Configure the real overflow constructor's finite capacity; do not mock
      // admission. The XP case fills its unchanged production pool limit.
      const f = await fixture(t, { overflowMaxEntries: sink === "overflow" ? 1 : undefined });
      assert.equal(f.gameplay.inventoryTransaction((owned) => {
        owned.slots[0].durability = durability;
        return true;
      }), true);
      const expected = f.game.harvestActions.prepareBreak(f.game.target).result;
      const orbs = f.game.experienceOrbs;
      if (sink === "overflow") {
        assert.equal(f.overflow.enqueue([{ id: BLOCK.DIRT, count: 1 }],
          { x: 7.5, y: 65.5, z: 11.5 }, f.world.dimension), true);
        assert.equal(f.overflow.size, 1);
      } else {
        assert.equal(orbs.spawn(MAX_EXPERIENCE_ORBS * MAX_ORB_EXPERIENCE,
          { x: 7.5, y: 65.5, z: 11.5 }), true);
        assert.equal(orbs.size, MAX_EXPERIENCE_ORBS);
      }
      const full = f.ownership();
      for (let attempt = 0; attempt < 3; attempt++) {
        assert.equal(f.game.harvestActions.prepareBreak(f.game.target), null);
        assert.deepEqual(f.ownership(), full,
          "refused real destinations cannot remove the ore, wear the tool or consume saved rolls");
      }
      if (sink === "overflow") {
        assert.equal(f.overflow.flush(f.world, f.game.pickups), 1);
        assert.equal(f.overflow.size, 0);
        assert.equal(f.game.pickups.serialize().items[0].id, BLOCK.DIRT);
      } else {
        // Let the real active orb lifetime release capacity, without collecting
        // XP (collection is a distinct saved-RNG action through Mending).
        orbs.update(EXPERIENCE_ORB_LIFETIME + 1, EXPERIENCE_ORB_LIFETIME + 1,
          f.player.position, f.gameplay);
        assert.equal(orbs.size, 0);
        assert.equal(f.gameplay.getState().experience.total, 0);
      }
      assert.equal(f.randomState(), initialRandom);
      const retry = f.game.harvestActions.prepareBreak(f.game.target);
      assert.ok(retry);
      assert.deepEqual(retry.result, expected, "freed capacity retries the same unpaid Fortune result");
      assert.equal(f.game.harvestActions.commit(retry).ok, true);
      assert.equal(f.randomState(), advanceRandom(initialRandom, 2));
      assert.equal(f.gameplay.getHandStack()?.durability ?? 0, durability - 1);
      assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR);
      assert.equal(orbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0), 7);
      assert.equal(f.game.pickups.serialize().items.filter(({ id }) => id === ITEM.DIAMOND)
        .reduce((sum, item) => sum + item.count, 0), 2);
      const committed = f.ownership();
      assert.equal(f.game.harvestActions.commit(retry).ok, false);
      assert.deepEqual(f.ownership(), committed);
    });
  }
}

test("ordinary held mining reaches Fortune through the actual Game primary path", async (t) => {
  const f = await fixture(t, { block: BLOCK.DEEPSLATE_DIAMOND_ORE });
  // Player.setPosition starts just above the floor. Let real physics establish
  // support; mining while airborne correctly has the ordinary fivefold penalty.
  f.frame(2);
  assert.equal(f.player.grounded, true);
  f.game.updateTarget();
  const held = f.gameplay.getHandStack();
  let updates = 0;
  while (f.world.get(at.x, at.y, at.z) !== BLOCK.AIR && updates++ < 32)
    f.game.primary(0.05);
  assert.ok(updates <= 32, "the normal mining duration completes within its finite input sequence");
  assert.equal(f.world.get(at.x, at.y, at.z), BLOCK.AIR);
  assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
  assert.equal(f.randomState(), advanceRandom(initialRandom, 2));
  const archived = f.snapshot();
  assert.ok(archived.pickups.items.some(({ id, count }) => id === ITEM.DIAMOND && count === 2));
  assert.equal(archived.experienceOrbs.orbs.reduce((total, orb) => total + orb.amount, 0), 7);
  assert.ok(f.calls.saves > 0);
});

for (const [label, invalidate] of [
  ["changed held stack", (f) => f.hold("IRON_PICKAXE", { data })],
  ["paused Game", (f) => { f.game.paused = true; }],
  ["replaced progression binding", (f) => { f.game.progressionIntegration = null; }],
  ["source changed", (f) => f.put(at.x, at.y, at.z, BLOCK.STONE)],
  ["effects RNG consumed elsewhere", (f) => {
    const random = f.progression.services.stations.prepareRandom(1, { validate: () => true });
    assert.equal(f.coordinator.commit([random.participant]).ok, true);
  }],
]) {
  test(`a ${label} refuses the prepared Fortune action without advancing any remaining owner`, async (t) => {
    const f = await fixture(t);
    const plan = f.game.harvestActions.prepareBreak(f.game.target);
    assert.ok(plan);
    invalidate(f);
    const originalBinding = f.game.progressionIntegration;
    // A removed host cannot serialize through the Game binding. Its actual
    // independent owners remain readable without rebinding or repairing it.
    const before = {
      world: f.world.serialize(), gameplay: f.gameplay.serialize(),
      stations: f.progression.services.stations.serialize(), overflow: f.overflow.serialize(),
      pickups: f.game.pickups.serialize(), orbs: f.game.experienceOrbs.serialize(),
      bytes: f.coordinator.budget.totalBytes,
    };
    assert.equal(f.game.harvestActions.commit(plan).ok, false);
    assert.deepEqual({
      world: f.world.serialize(), gameplay: f.gameplay.serialize(),
      stations: f.progression.services.stations.serialize(), overflow: f.overflow.serialize(),
      pickups: f.game.pickups.serialize(), orbs: f.game.experienceOrbs.serialize(),
      bytes: f.coordinator.budget.totalBytes,
    }, before);
    assert.equal(f.game.progressionIntegration, originalBinding);
  });
}

test("Fortune refuses an unavailable RNG owner instead of falling back to unenchanted mining", async (t) => {
  const f = await fixture(t);
  const before = f.ownership();
  t.mock.method(f.progression.services.stations, "prepareRandom", () => null);
  assert.equal(f.game.harvestActions.prepareBreak(f.game.target), null);
  assert.deepEqual(f.ownership(), before);
});

test("unaffected blocks and explosions do not consume the effects RNG", async (t) => {
  const f = await fixture(t, { block: BLOCK.ANCIENT_DEBRIS });
  const held = f.gameplay.getHandStack();
  const plain = f.game.harvestActions.break(f.game.target);
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.drops, [{ id: BLOCK.ANCIENT_DEBRIS, count: 1 }]);
  assert.equal(f.randomState(), initialRandom);
  f.put(at.x, at.y, at.z, BLOCK.DIAMOND_ORE);
  f.game.updateTarget();
  const blast = f.game.harvestActions.break(f.game.target, { explosion: true });
  assert.equal(blast.ok, true);
  assert.deepEqual(blast.drops, [{ id: ITEM.DIAMOND, count: 1 }]);
  assert.equal(blast.experience, 0);
  assert.equal(f.randomState(), initialRandom);
  assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
});

test("full archive export/import retains multiplied loot, tool metadata, RNG and original terrain version", async (t) => {
  const f = await fixture(t);
  const before = f.snapshot();
  assert.equal(f.game.harvestActions.break(f.game.target).ok, true);
  const saved = f.snapshot();
  const imported = parseWorldFile(exportWorldFile(saved));
  const restored = await fixture(t, { saved: imported });
  assert.equal(restored.world.generatorVersion, before.world.generatorVersion);
  assert.equal(restored.world.seed, before.world.seed);
  assert.deepEqual(restored.world.serialize(), saved.world);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  assert.deepEqual(restored.game.pickups.serialize(), saved.pickups);
  assert.deepEqual(restored.game.experienceOrbs.serialize(), saved.experienceOrbs);
  assert.deepEqual(restored.progression.serialize(), f.progression.serialize());
  assert.equal(restored.randomState(), advanceRandom(initialRandom, 2));
  assert.equal(restored.world.get(at.x, at.y, at.z), BLOCK.AIR);
  assert.equal(restored.game.quality, saved.quality);
  assert.equal(restored.game.soundEnabled, saved.soundEnabled);
});

test("a finite paid anvil book becomes a working Fortune tool and survives a cold archive reconstruction", async (t) => {
  const f = await fixture(t, { block: BLOCK.ANVIL });
  const earned = experienceForLevel(30);
  assert.equal(f.gameplay.inventoryTransaction((owned) => {
    owned.slots.fill(null);
    owned.slots[0] = progressionStack(ITEM.DIAMOND_PICKAXE, 1, { name: "Paid prospector" });
    owned.slots[1] = progressionStack(ITEM.ENCHANTED_BOOK, 1, { enchantments: { fortune: 3 } });
    owned.experienceTotal = earned;
    return true;
  }), true);
  assert.equal(f.game.useActions.tap(), true, "normal physical block use opens the real anvil owner");
  const action = (request) => f.progression.action({
    ...request, sessionToken: f.progression.services.session?.token,
  });
  for (const index of [0, 1]) {
    assert.equal(action({ type: "click", area: "inventory", index, button: 0 }).ok, true);
    assert.equal(action({ type: "click", area: "container", index, button: 0 }).ok, true);
  }
  const preview = f.progression.view().preview;
  assert.equal(preview.output.data.enchantments.fortune, 3);
  assert.ok(preview.levelCost > 0);
  assert.equal(action({ type: "takeResult", previewKey: preview.key }).ok, true);
  assert.equal(f.gameplay.getState().experience.total, spendExperienceLevels(earned, preview.levelCost));
  assert.equal(f.progression.services.stations.get({ ...at, dimension: "overworld" }).record.right, null);
  assert.equal(action({ type: "click", area: "inventory", index: 0, button: 0 }).ok, true);
  f.progression.close("test-complete");
  assert.equal(f.gameplay.cursor, null);
  assert.equal(f.gameplay.getHandStack().data.enchantments.fortune, 3);
  const saved = parseWorldFile(exportWorldFile(f.snapshot()));
  const restored = await fixture(t, { saved });
  restored.put(at.x, at.y, at.z, BLOCK.DIAMOND_ORE);
  restored.game.updateTarget();
  const state = restored.randomState();
  const plan = restored.game.harvestActions.prepareBreak(restored.game.target);
  assert.ok(plan);
  const multiplier = Math.max(1, Math.floor(nextEnchantingSeed(state) / 0x100000000 * 5));
  assert.deepEqual(plan.result.drops, [{ id: ITEM.DIAMOND, count: multiplier }]);
  assert.equal(restored.game.harvestActions.commit(plan).ok, true);
  assert.equal(restored.gameplay.getHandStack().data.name, "Paid prospector");
});
