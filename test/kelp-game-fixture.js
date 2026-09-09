import assert from "node:assert/strict";
import * as THREE from "three";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { GameHarvestActions } from "../src/game-harvest-actions.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { bindWorldServiceEvents } from "../src/game-world-events.js";
import { Gameplay } from "../src/gameplay.js";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { Settlement } from "../src/settlement.js";
import { createWorldContext } from "../src/world-spec.js";
import { InputElement } from "./control-fixture.js";
export { aimAt } from "./game-fluid-block-actions-fixture.js";

/** Real ownership/physics/actions over the supplied World. Only rendering,
 * audio, HUD and disk writes are absent. Never fabricates an ownership receipt.
 * Native callers supply a production-admitted World, not a generator override.
 */
export function kelpGame(t, world, { saved = null, limits, maxEntries } = {}) {
  const context = createWorldContext(world), coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const gameplay = new Gameplay({ mode: "survival", ...ownership });
  const settlement = new Settlement(ownership);
  const overflow = new DropOverflow({ ...ownership, maxEntries });
  const fuses = new Fuses(ownership);
  assert.equal(settlement.load(saved?.settlement ?? {
    version: 3, chests: [], furnaces: [], crops: [],
  }, { context, world }), true);
  if (saved?.gameplay) assert.equal(gameplay.load(saved.gameplay, { context }), true);
  else assert.equal(gameplay.inventoryTransaction((owned) => {
    owned.slots.fill(null);
    owned.offhand = null;
    return true;
  }), true);
  if (saved?.overflow) assert.equal(overflow.load(saved.overflow, { context }), true);
  if (saved?.fuses) assert.equal(fuses.load(saved.fuses, { context }), true);
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  const camera = new THREE.PerspectiveCamera(75);
  const scene = new THREE.Scene();
  const player = new Player(camera, world, new InputElement(document), { inputMode: "remote" });
  if (saved?.player) {
    player.setPosition(saved.player);
    player.yaw = saved.player.yaw;
    player.pitch = saved.player.pitch;
  }
  const pickups = new Pickups(scene, world, ownership);
  const experienceOrbs = new ExperienceOrbs(scene, world, {
    ...ownership, prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  if (saved?.pickups) assert.equal(pickups.load(saved.pickups, { context }), true);
  if (saved?.experienceOrbs) assert.equal(experienceOrbs.load(saved.experienceOrbs, { context }), true);
  const events = [];
  const game = {
    world, worldContext: context, coordinator, gameplay, settlement, overflow,
    fuses, player, pickups, experienceOrbs,
    active: true, simulating: true, paused: false, building: false, failed: false,
    elapsed: 0, currentTime: 0.4, quality: "low", soundEnabled: false,
    lastOverflowToast: -Infinity, mobTarget: null,
    graphics: { scene, camera, rebuildDirty: (n) => events.push(["rebuild", n]) },
    effects: { swing: 0, offhand: { swing: 0 }, sound: (...args) => events.push(["sound", ...args]) },
    ui: {
      toast: (message) => events.push(["toast", message]),
      openInventory: (options) => events.push(["inventory", options]),
    },
    scheduleSave: () => events.push(["save"]),
    refreshHud: () => events.push(["hud"]),
    updateTarget() { events.push(["target"]); },
  };
  game.inventoryActions = new GameInventoryActions(game);
  game.prepareDropItems = (...args) => game.inventoryActions.prepareDropItems(...args);
  game.harvestActions = new GameHarvestActions(game);
  game.useActions = new GameUseActions(game);
  game.eat = (hand) => VoxelGame.prototype.eat.call(game, hand);
  const fluid = new GameFluidServices({ world, overflow, settlement, context, saved, limits });
  assert.equal(fluid.activate(game).ok, true);
  const unbind = bindWorldServiceEvents(game);
  const archive = new GameArchive(game, {
    save: async () => assert.fail("CPU acceptance does not touch the original browser or archive"),
  });
  t.after(() => {
    unbind();
    player.dispose();
    fluid.dispose();
    pickups.dispose();
    experienceOrbs.dispose();
    fuses.dispose();
    overflow.dispose();
    settlement.dispose();
    gameplay.dispose();
  });
  return {
    world, context, coordinator, game, gameplay, settlement, overflow, player,
    pickups, experienceOrbs, fluid, events, snapshot: () => archive.snapshot(),
    harvest(position) {
      const hit = { ...position, ...world.getCell(position.x, position.y, position.z) };
      const plan = game.harvestActions.prepareBreak(hit);
      assert.ok(plan, "a real harvest must prepare World, wear and retained loot");
      const result = game.harvestActions.commit(plan);
      assert.equal(result.ok, true);
      return { plan, result };
    },
    collect(position) {
      player.setPosition(position);
      for (let i = 0; i < 40; i++) {
        overflow.flush(world, pickups);
        pickups.update(0.05, i * 0.05, player.position, gameplay);
      }
    },
  };
}

export function serviceTo(service, clock) {
  const delta = clock - service.fluids.diagnostics().clock;
  assert.ok(Number.isSafeInteger(delta) && delta >= 0 && delta <= 16384);
  for (let left = delta; left > 0; left -= 3)
    assert.equal(service.frame(Math.min(left, 3) / 4, { simulating: true }).advanced, true);
  assert.equal(service.fluids.diagnostics().clock, clock);
}
