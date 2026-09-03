import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { VoxelGame } from "../src/game.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { ITEM } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { Settlement } from "../src/settlement.js";
import { potionStack } from "./brewing-fixture.js";
import { integratedProgressionFixture } from "./game-progression-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

test("real Game preparation stages progression beside its still-detached pearl owner", {
  timeout: 30000,
}, async (t) => {
  const shell = {
    quality: "low",
    gameplay: { mode: "survival" },
    ui: { setLoading() {} },
  };
  const staged = await VoxelGame.prototype.prepareWorld.call(
    shell, "progression-host-stage", null, { generatorVersion: 3 }
  );
  const owners = [
    staged.vehicleServices, staged.mobIntegration,
    staged.progressionIntegration, staged.explorationServices,
    staged.projectileServices, staged.fluidServices,
    staged.buildingServices, staged.fuses, staged.overflow, staged.settlement,
    staged.gameplay, staged.world,
  ].filter(Boolean);
  t.after(() => {
    for (const owner of owners) assert.notEqual(owner.dispose?.(), false);
    assert.equal(staged.mobIntegration.wildlife.disposed, true);
    assert.equal(staged.world.coordinator.usage(staged.mobIntegration.wildlife), undefined);
    assert.equal(staged.world.coordinator.usage(staged.mobIntegration.experienceOrbs), undefined);
  });
  assert.equal(staged.progressionIntegration.world, staged.world);
  assert.equal(staged.progressionIntegration.gameplay, staged.gameplay);
  assert.equal(staged.progressionIntegration.projectileServices, staged.projectileServices);
  assert.equal(staged.mobIntegration.ecologyServices.trading, staged.progressionIntegration.services.trading);
  assert.equal(staged.vehicleServices._stagedWildlife, staged.mobIntegration.wildlife);
  assert.equal(staged.projectileServices.projectiles.staged, true);
  assert.equal(staged.progressionIntegration.active, false);
  assert.equal(staged.progressionIntegration.serialize().progression.version, 1);
});

test("Game preflight retains progression escrow and rejects the original malformed sidecar", (t) => {
  const f = integratedProgressionFixture(t);
  f.place("anvil");
  const snapshot = f.snapshot();
  snapshot.player = {
    ...snapshot.player, yaw: f.player.yaw, pitch: f.player.pitch, flying: false,
  };
  assert.deepEqual(
    normalizeWorldComponents(snapshot).progression,
    snapshot.progression
  );
  for (const progression of [null, undefined, { version: 99 }])
    assert.throws(
      () => normalizeWorldComponents({ ...snapshot, progression }),
      /progression/
    );
  const hostile = { ...snapshot };
  Object.defineProperty(hostile, "progression", {
    enumerable: true,
    get() { assert.fail("Game preflight must not invoke the original sidecar getter"); },
  });
  assert.throws(() => normalizeWorldComponents(hostile), /progression/);
});

test("real right-click station routing opens progression and closeScreens preserves escrow", async (t) => {
  const f = integratedProgressionFixture(t);
  f.place("enchanting");
  f.game.target = { ...f.at, ...f.world.getCell(f.at.x, f.at.y, f.at.z) };
  f.game.openStation = (hit) => VoxelGame.prototype.openStation.call(f.game, hit);
  f.game.ui.closeInventory = () => true;
  f.game.ui.closeAtlas = () => {};
  const use = new GameUseActions(f.game);
  assert.equal(use.perform(false), true);
  assert.equal(f.services.session.kind, "enchanting");
  assert.equal(f.game.overlayOpen, true);
  const owned = f.integration.serialize();
  assert.equal(await VoxelGame.prototype.closeScreens.call(f.game), true);
  assert.equal(f.services.isOpen, false);
  assert.equal(f.game.overlayOpen, false);
  assert.deepEqual(f.integration.serialize(), owned);
});

test("Game awards real collectible XP and credits levels only after the orb is collected", (t) => {
  const f = integratedProgressionFixture(t);
  assert.equal(VoxelGame.prototype.awardExperience.call(f.game, 7, f.player.position), true);
  assert.ok(f.orbs.size > 0);
  assert.equal(f.gameplay.getState().experience.total, 0);
  for (let i = 0; i < 30 && f.orbs.size; i++)
    f.orbs.update(0.1, f.game.elapsed += 0.1, f.player.position, f.gameplay);
  assert.equal(f.orbs.size, 0);
  assert.equal(f.gameplay.getState().experience.total, 7);
  assert.equal(f.gameplay.getState().experience.level, 1);
  assert.equal(f.calls.feedback.at(-1).levelUp, true);
});

test("real held drink dispatch uses potion ownership rather than the ordinary food path", (t) => {
  const f = integratedProgressionFixture(t);
  f.editInventory((owned) => {
    owned.slots[0] = potionStack(f.services.catalog, "healing");
    return true;
  });
  assert.equal(f.gameplay.select(0), true);
  f.gameplay.damage(10, "test fixture");
  const beforeHealth = f.gameplay.health;
  f.game.eat = () => assert.fail("A potion must not go through food consumption");
  f.game.updateTarget = () => {
    f.game.target = f.game.mobTarget = f.game.vehicleTarget = null;
  };
  const use = new GameUseActions(f.game);
  assert.equal(use.begin("mouse"), true);
  assert.equal(use.use.kind, "drink");
  for (let i = 0; i < 17; i++) {
    f.game.elapsed += 0.1;
    use.update(0.1);
  }
  assert.equal(use.use.active, false);
  assert.equal(f.gameplay.getHandStack("main").id, ITEM.GLASS_BOTTLE);
  assert.ok(f.gameplay.health > beforeHealth);
  assert.equal(f.gameplay.count(BLOCK.STONE), 0);
});

function stockedStation(t) {
  const f = integratedProgressionFixture(t);
  const settlement = new Settlement({ context: f.context, coordinator: f.coordinator });
  assert.equal(settlement.bindWorld(f.world), true);
  t.after(() => settlement.dispose());
  f.game.settlement = settlement;
  f.place("enchanting");
  f.editInventory((owned) => {
    owned.slots[0] = progressionStack(ITEM.IRON_PICKAXE);
    owned.slots[1] = progressionStack(ITEM.DIAMOND_SWORD, 1, { name: "Stored sword" });
    owned.slots[2] = progressionStack(ITEM.LAPIS, 8);
    return true;
  });
  assert.equal(f.open().ok, true);
  f.transfer(1, 0);
  f.transfer(2, 1);
  assert.equal(f.integration.close().ok, true);
  f.gameplay.select(0);
  return {
    ...f,
    harvest: new GameHarvestActions(f.game),
    hit: { ...f.at, ...f.world.getCell(f.at.x, f.at.y, f.at.z) },
  };
}

test("real Game harvesting retains a station's owned contents once", (t) => {
  const f = stockedStation(t);
  assert.equal(f.harvest.break(f.hit).ok, true);
  assert.equal(f.world.get(f.at.x, f.at.y, f.at.z), BLOCK.AIR);
  assert.equal(f.services.stations.get(f.at), null);
  const drops = f.overflow.serialize();
  assert.equal(drops.entries.filter((entry) => entry.id === ITEM.DIAMOND_SWORD)
    .reduce((total, entry) => total + entry.count, 0), 1);
  assert.equal(drops.entries.find((entry) => entry.id === ITEM.DIAMOND_SWORD).data.name, "Stored sword");
  assert.equal(drops.entries.filter((entry) => entry.id === ITEM.LAPIS)
    .reduce((total, entry) => total + entry.count, 0), 8);
  assert.equal(f.harvest.break(f.hit).ok, false);
  assert.deepEqual(f.overflow.serialize(), drops);
});

test("station-retention veto leaves the real block, escrow and mining hand untouched", (t) => {
  const f = stockedStation(t);
  const before = f.snapshot();
  t.mock.method(f.game, "prepareDropItems", () => null);
  assert.equal(f.harvest.break(f.hit).ok, false);
  assert.deepEqual(f.snapshot(), before);
});
