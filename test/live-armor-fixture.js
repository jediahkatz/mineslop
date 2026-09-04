import assert from "node:assert/strict";
import { VoxelGame } from "../src/game.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { armorItemId } from "../src/gear-content.js";
import { addStatusEffects } from "../src/status-effects.js";
import { integratedProgressionFixture } from "./game-progression-integration-fixture.js";
import { progressionStack } from "./progression-live-fixture.js";

// Real production World, Player, Gameplay, Game bindings, Wildlife and both
// progression/projectile hosts. Only presentation is an observation sink.
export function liveArmorFixture(t, options) {
  const f = integratedProgressionFixture(t, options);
  Object.setPrototypeOf(f.game, VoxelGame.prototype);
  f.game.useActions = new GameUseActions(f.game);
  f.game.bindGameplay(f.gameplay);
  f.game.bindPlayerDamage();
  f.game.createWildlife();
  f.game.wildlife.autoSpawn = false;
  f.game.ui.closeInventory = () => true;
  f.game.ui.closeAtlas = () => {};
  f.events = [];
  const onHurt = f.gameplay.onHurt;
  f.gameplay.onHurt = (event) => { f.events.push(event); onHurt(event); };
  f.armor = (material = "netherite", enchantments = { protection: 4, unbreaking: 3 }) =>
    f.editInventory((owned) => {
      for (const slot of ["head", "chest", "legs", "feet"])
        owned.equipment[slot] = progressionStack(armorItemId(material, slot), 1, {
          name: `${material} ${slot}`, repairCost: 3, enchantments,
        });
      return true;
    });
  f.status = (id, amplifier = 0) => {
    const next = addStatusEffects(f.services.effects.serialize(), [
      { id, amplifier, durationTicks: 200 },
    ]);
    assert.equal(f.coordinator.commit([f.services.effects.prepare(next)]).ok, true);
  };
  f.hit = (amount, cause, kind = "melee", source = {
    x: f.player.position.x, y: f.player.eyePosition.y, z: f.player.position.z - 2,
  }) => {
    Object.assign(f.game.wildlife.context, {
      mode: f.gameplay.mode, health: f.gameplay.health, spawnProtected: false,
    });
    return f.game.wildlife.damagePlayer(amount, cause, source, { kind, position: source });
  };
  return f;
}
