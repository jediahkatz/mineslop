import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import * as THREE from "three";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameProjectileServices } from "../src/game-projectile-services.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { Pickups } from "../src/pickups.js";
import { Player } from "../src/player.js";
import { Settlement } from "../src/settlement.js";
import { WorldStorage } from "../src/storage.js";
import { TransitionGate } from "../src/transition-gate.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";

/**
 * Real World/Player/Gameplay/Wildlife and archive owners in an authored room.
 * Wildlife restores and protects respawns normally, with natural spawning off.
 * Scene objects are real Three resources; UI/audio observers are counters, not
 * a browser, GPU rendering, natural acquisition or a visual walkthrough.
 */
export async function projectileHostFixture(
  t,
  {
    mode = "survival",
    health = 20,
    saved = null,
    activate = true,
    seed = saved?.world?.seed ?? "pearl-host-fixture",
  } = {}
) {
  mode = saved?.gameplay?.mode ?? mode;
  const world = new World(seed, { generatorVersion: 3, useWorker: false });
  if (saved?.world) world.loadEdits(saved.world);
  await world.ensureArea({ x: 8, y: 70, z: 8 }, 1);
  if (!saved) {
    const changes = [];
    for (let x = 3; x <= 13; x++)
      for (let z = 3; z <= 13; z++)
        for (let y = 69; y <= 75; y++) {
          const after = { id: y === 69 ? BLOCK.STONE : BLOCK.AIR };
          changes.push({ x, y, z, before: world.getCell(x, y, z), after });
        }
    assert.equal(world.applyCells(changes), true);
  }
  const context = createWorldContext(world);
  const coordinator = world.coordinator;
  const ownership = { context, coordinator };
  const gameplay = new Gameplay({ mode, ...ownership });
  if (saved?.gameplay) assert.equal(gameplay.load(saved.gameplay), true);
  else {
    const initial = gameplay._prepareState(
      (draft) => {
        draft.owned.slots.fill(null);
        draft.owned.slots[0] = { id: ITEM.ENDER_PEARL, count: 6 };
        draft.owned.offhand = { id: ITEM.ENDER_PEARL, count: 3 };
        draft.health = health;
        return true;
      },
      { notify: false }
    );
    assert.ok(initial);
    assert.equal(coordinator.commit([initial]).ok, true);
  }
  if (mode === "creative")
    assert.equal(gameplay.assignSlot(0, ITEM.ENDER_PEARL), true);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1.5, 0.1, 512);
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.pointerLockElement = null;
  const element = { ownerDocument: document, dataset: {} };
  const player = new Player(camera, world, element, {
    inputMode: "remote",
    mouseSensitivity: 1,
  });
  player.allowFlight = mode === "creative";
  player.setPosition(saved?.player ?? { x: 8.5, y: 70, z: 8.5 });
  player.yaw = saved?.player?.yaw ?? -Math.PI / 2;
  player.pitch = saved?.player?.pitch ?? -0.5;
  player._syncCamera(0);
  player.enabled = true;
  const observed = {
    saves: 0,
    hud: 0,
    targets: 0,
    sounds: [],
    hurt: [],
    death: 0,
  };
  const game = Object.create(VoxelGame.prototype);
  Object.assign(game, {
    world,
    coordinator,
    worldContext: context,
    player,
    graphics: { scene, camera, renderRadius: 1, rebuildDirty() {} },
    elapsed: 10,
    paused: false,
    building: false,
    failed: false,
    overlayOpen: false,
    closingScreens: false,
    started: true,
    miningKey: "",
    miningProgress: 0,
    currentTime: 0.36,
    quality: "low",
    mobStates: structuredClone(saved?.mobStates ?? {}),
    soundEnabled: false,
    target: null,
    mobTarget: null,
    ui: {
      updateHurt() {},
      updateCombat() {},
      closeInventory() {},
      closeAtlas() {},
      toast() {},
      setLoading() {},
      ready() {},
      showMenu() {},
    },
    effects: {
      swing: 0,
      offhand: { swing: 0 },
      sound: (...values) => observed.sounds.push(values),
    },
    scheduleSave() {
      observed.saves++;
    },
    refreshHud() {
      observed.hud++;
    },
    updateTarget() {
      observed.targets++;
    },
    createWildlife(data, options) {
      VoxelGame.prototype.createWildlife.call(this, data, options);
      this.wildlife.autoSpawn = false;
    },
  });
  game.gameplay = game.bindGameplay(gameplay);
  const hurt = gameplay.onHurt;
  gameplay.onHurt = (event) => {
    observed.hurt.push(event);
    hurt(event);
  };
  const death = gameplay.onDeath;
  gameplay.onDeath = (cause) => {
    observed.death++;
    death(cause);
  };
  game.useActions = new GameUseActions(game);
  game.settlement = new Settlement(ownership);
  assert.equal(game.settlement.bindWorld(world), true);
  game.overflow = new DropOverflow(ownership);
  game.fuses = new Fuses(ownership);
  game.pickups = new Pickups(scene, world, ownership);
  game.experienceOrbs = new ExperienceOrbs(scene, world, ownership);
  game.inventoryActions = new GameInventoryActions(game);
  game.transitionGate = new TransitionGate();
  game.storage = new WorldStorage({
    indexedDB: new IDBFactory(),
    name: "pearl-host-test",
  });
  game.archive = new GameArchive(game, game.storage);
  game.createWildlife(saved?.mobStates?.[world.dimension] ?? saved?.mobs);
  const service = new GameProjectileServices({
    world,
    gameplay,
    context,
    saved,
  });
  if (activate) assert.equal(service.activate(game).ok, true);
  t.after(() => {
    service.dispose();
    game.wildlife.dispose();
    player.dispose();
    game.pickups.dispose();
    game.experienceOrbs.dispose();
    game.fuses.dispose();
    game.overflow.dispose();
    game.settlement.dispose();
    gameplay.dispose();
    world.dispose();
    game.storage.database?.close();
  });
  return {
    game,
    world,
    player,
    gameplay,
    context,
    coordinator,
    service,
    observed,
    scene,
  };
}

export function finishPearlFlight(fixture, limit = 40) {
  for (let tick = 0; tick < limit && fixture.service.projectiles.size; tick++) {
    fixture.service.frame(0.05);
    fixture.service.render();
  }
  assert.equal(
    fixture.service.projectiles.size,
    0,
    "the actual swept flight must finish"
  );
}
