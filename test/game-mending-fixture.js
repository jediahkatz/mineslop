import assert from "node:assert/strict";
import { armorItemId } from "../src/gear-content.js";
import { getItem, ITEM } from "../src/items.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

// Authored worn equipment; real Game, source pool and progression resource owners.
export async function gameMendingFixture(t, options) {
  const f = await gameMobFixture(t, { generatorVersion: 4, ...options });
  f.orbs = f.mobs.experienceOrbs;
  f.stations = f.progression.services.stations;
  f.equip = ({ damage = 2, enchanted = true, multiple = true, total = 0 } = {}) => {
    const stack = (id) => progressionStack(id, 1, {
      name: "Mending ownership test",
      ...(enchanted ? { enchantments: { mending: 1 } } : {}),
    }, getItem(id).durability - damage);
    assert.equal(f.gameplay.inventoryTransaction((owned) => {
      owned.slots.fill(null);
      owned.slots[f.gameplay.selected] = stack(ITEM.DIAMOND_PICKAXE);
      owned.offhand = multiple ? stack(ITEM.SHIELD) : null;
      for (const slot of ["head", "chest", "legs", "feet"])
        owned.equipment[slot] = multiple ? stack(armorItemId("diamond", slot)) : null;
      // Neither cursor nor non-selected inventory is eligible.
      owned.slots[9] = stack(ITEM.DIAMOND_PICKAXE);
      owned.cursor = stack(ITEM.DIAMOND_PICKAXE);
      owned.experienceTotal = total;
      return true;
    }), true);
  };
  f.spawnXp = (amount) => {
    assert.equal(f.game.awardExperience(amount, {
      x: f.player.position.x, y: f.player.position.y + 0.8, z: f.player.position.z,
    }), true);
  };
  // Game.awardExperience intentionally gives physical rewards a 0.2s delay.
  f.collect = () => f.orbs.update(0.25, f.game.elapsed += 0.25, f.player.position, f.gameplay);
  f.paidState = () => ({
    gameplay: f.gameplay.serialize(), stations: f.stations.serialize(),
    orbAmounts: f.orbs.serialize().orbs.map((orb) => orb.amount),
    bytes: f.coordinator.budget.totalBytes,
  });
  return f;
}
