import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { BIOMES, getBiomeById } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { Fuses } from "../src/fuses.js";
import { VoxelGame } from "../src/game.js";
import { GameArchive } from "../src/game-archive.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { GameTravel } from "../src/game-travel.js";
import { createTravelPreviewWorld } from "../src/game-travel-stage.js";
import { GameUseActions } from "../src/game-use-actions.js";
import { ITEM } from "../src/items.js";
import { Pickups } from "../src/pickups.js";
import { collidesWithWorld, Player } from "../src/player.js";
import { PlayerVisual } from "../src/player-visual.js";
import { Settlement } from "../src/settlement.js";
import { TransitionGate } from "../src/transition-gate.js";
import { DEFAULT_VIEW_PREFERENCES } from "../src/view-preferences.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";

const noop = () => {};

// Authored flat terrain only; World still owns ingestion, edits and safe spawn.
// The same factory supplies the independent destination preview.
function respawnWorld() {
  let spawnHint = { x: 0.5, y: 9.01, z: 0.5 };
  const biome = getBiomeById("plains");
  const world = new World("ecosystem-test", {
    generatorVersion: 2,
    useWorker: false,
    generatorFactory: (_seed, dimension, generatorVersion) => {
      const spec = getWorldSpec(generatorVersion, dimension);
      return {
        getSpawn: () => ({ ...spawnHint }),
        getBiome: () => biome,
        generateChunk(cx, cz) {
          const blocks = new Uint16Array((spec.maxY - spec.minY) * 256);
          blocks.fill(BLOCK.STONE, 0, (8 - spec.minY) * 256);
          blocks.fill(BLOCK.GRASS, (8 - spec.minY) * 256, (9 - spec.minY) * 256);
          return {
            cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
            biomes: new Uint8Array(256).fill(BIOMES.indexOf(biome)),
          };
        },
      };
    },
  });
  Object.defineProperty(world, "spawnHint", {
    get: () => ({ ...spawnHint }),
    set: (position) => { spawnHint = { ...position }; },
  });
  return world.generate(2);
}

// Real player physics, gameplay, wildlife, travel, frame, and archive snapshots.
// Only authored terrain, browser/GPU, audio, and disk transports are substituted.
function fixture(t, timeOfDay = 0) {
  const previousDocument = globalThis.document;
  const previousRaf = globalThis.requestAnimationFrame;
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    defaultView: new EventTarget(),
  });
  const element = {
    ownerDocument: document,
    requestPointerLock() {
      document.pointerLockElement = element;
      document.dispatchEvent(new Event("pointerlockchange"));
    },
  };
  document.exitPointerLock = () => {
    document.pointerLockElement = null;
    document.dispatchEvent(new Event("pointerlockchange"));
  };
  globalThis.document = document;
  globalThis.requestAnimationFrame = () => 1;
  const world = respawnWorld();
  const coordinator = world.coordinator;
  assert.equal(coordinator.usage(world), 0);
  const context = createWorldContext(world);
  const ownership = { coordinator, context };
  const camera = new THREE.PerspectiveCamera();
  const scene = new THREE.Scene();
  const game = Object.assign(Object.create(VoxelGame.prototype), {
    world,
    coordinator,
    worldContext: context,
    mobStates: {},
    paused: true,
    building: false,
    overlayOpen: false,
    started: false,
    failed: false,
    elapsed: 0,
    lastFrame: 0,
    fps: 60,
    hudTimer: 0,
    streamTimer: 0,
    autosaveTimer: 0,
    portalCooldown: 3,
    currentTime: timeOfDay,
    quality: "low",
    viewPreferences: { ...DEFAULT_VIEW_PREFERENCES },
    renderDirection: new THREE.Vector3(),
    heldAction: null,
    lastAction: -Infinity,
    lastOverflowToast: -Infinity,
    player: new Player(camera, world, element),
    graphics: {
      scene,
      camera,
      renderRadius: 1,
      rebuildDirty: noop,
      setTime: noop,
      setTarget: noop,
      update: noop,
      render: noop,
    },
    ui: {
      closeInventory: noop,
      closeAtlas: noop,
      setLoading: noop,
      ready: noop,
      showMenu: noop,
      hideMenu: noop,
      toast: noop,
      update(snapshot) {
        game.hud = snapshot;
      },
    },
    containerUI: { close: noop, refresh: noop },
    effects: {
      swing: 0,
      offhand: { swing: 0 },
      unlockAudio: noop,
      update: noop,
      select: noop,
      selectOffhand: noop,
      sound: noop,
      shoot: noop,
    },
    settlement: new Settlement(ownership),
    fuses: new Fuses(ownership),
    overflow: new DropOverflow(ownership),
    pickups: new Pickups(scene, world, ownership),
    scheduleSave: noop,
    refreshHud: noop,
    updateTarget: noop,
    createWildlife(saved, options) {
      VoxelGame.prototype.createWildlife.call(this, saved, options);
      this.wildlife.autoSpawn = false;
    },
  });
  game.useActions = new GameUseActions(game);
  game.inventoryActions = new GameInventoryActions(game);
  game.player.onInputReset = () => game.resetActions();
  game.player.setPosition(world.getSpawn());
  game.player.allowFlight = false;
  game.gameplay = game.createGameplay("survival", ownership);
  game.experienceOrbs = new ExperienceOrbs(scene, world, {
    ...ownership,
    prepareCollect: (amount) => game.gameplay.prepareExperience(amount),
  });
  game.playerVisual = new PlayerVisual(scene);
  game.player.onFall = (distance) =>
    game.gameplay.damage(Math.ceil(distance - 3), "fall");
  game.transitionGate = new TransitionGate();
  const previews = [];
  game.travel = new GameTravel(game, {
    worldFactory(source, dimension) {
      const preview = createTravelPreviewWorld(source, dimension);
      assert.notEqual(preview, source);
      assert.notEqual(preview.coordinator, source.coordinator);
      assert.equal(game.player.world, source);
      previews.push(preview);
      return preview;
    },
  });
  game.archive = new GameArchive(game, {
    async save(data) {
      game.saved = structuredClone(data);
    },
  });
  const buildingServices = new GameBuildingServices({
    world,
    gameplay: game.gameplay,
    context,
    saved: { time: timeOfDay },
  });
  assert.equal(buildingServices.activate(game).ok, true);
  game.bindWorldServiceEvents();
  game.createWildlife();
  t.after(() => {
    game.unbindWorldEvents();
    game.wildlife.dispose();
    game.pickups.dispose();
    game.experienceOrbs.dispose();
    game.playerVisual.dispose();
    game.player.dispose();
    buildingServices.dispose();
    game.gameplay.dispose();
    game.settlement.dispose();
    game.fuses.dispose();
    game.overflow.dispose();
    world.dispose();
    for (const preview of previews) {
      assert.equal(preview._disposed, true);
      assert.equal(preview.coordinator.budget.totalBytes, 0);
    }
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = previousRaf;
  });
  return game;
}

function frames(game, seconds) {
  for (let i = 0; i < Math.ceil(seconds / 0.05); i++) {
    const dt = Math.min(0.05, seconds - i * 0.05);
    game.frame(game.lastFrame + dt * 1000);
  }
}

function spawn(game, kind, dx, dz = 0) {
  const p = game.player.position;
  const mob = game.wildlife.spawn(kind, { x: p.x + dx, y: 9, z: p.z + dz });
  assert.ok(mob);
  mob.walking = false;
  mob.wanderTimer = 100;
  return mob;
}

function camp(game, kind, count) {
  for (let i = 0; i < count; i++) {
    const angle = (i * Math.PI * 2) / count;
    const mob = spawn(game, kind, Math.cos(angle) * 1.2, Math.sin(angle) * 1.2);
    mob.angry = 20;
    mob.attackCooldown = 0;
  }
  spawn(game, "wolf", 5).angry = 20;
  const pet = spawn(game, "wolf", 7, 3);
  pet.tamed = true;
  pet.health = 12;
  spawn(game, "sheep", 10, -3);
  spawn(game, "creeper", 6, 6).fuse = 1.6;
  const archer = spawn(game, "skeleton", 10, 5);
  game.wildlife.update(0, 0, game.player.position, {
    mode: "survival",
    timeOfDay: game.currentTime,
  });
  game.wildlife.shoot(archer);
  assert.equal(game.wildlife.projectiles.length, 1);
  return pet.id;
}

for (const [kind, count, timeOfDay] of [
  ["zombie", 4, 0],
  ["enderman", 2, 0.5],
]) {
  test(`real respawn breaks repeated ${kind} camping without changing the backpack, pets, or loose loot`, async (t) => {
    const game = fixture(t, timeOfDay);
    const petId = camp(game, kind, count);
    game.gameplay.add(ITEM.WOOD_PICKAXE, 1, { durability: [7] });
    assert.equal(
      game.pickups.spawn(ITEM.DIAMOND, 3, { x: 12.5, y: 9.2, z: 12.5 }),
      true
    );
    assert.equal(
      game.overflow.enqueue(
        [{ id: ITEM.GOLD_INGOT, count: 64 }],
        { x: 1, y: 9, z: 1 },
        "nether"
      ),
      true
    );
    const backpack = game.gameplay.serialize();
    const pickups = game.pickups.serialize();
    const overflow = game.overflow.serialize();
    for (let cycle = 1; cycle <= 2; cycle++) {
      for (const mob of game.wildlife.entities) {
        if (mob.kind === "enderman") mob.angry = 20;
      }
      game.gameplay.damage(100, "test setup");
      assert.equal(game.gameplay.dead, true);
      const oldWildlife = game.wildlife;
      const result = await game.respawn();
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(result.observerErrors, []);
      assert.equal(oldWildlife.disposed, true);
      assert.equal(game.coordinator.usage(oldWildlife), undefined);
      assert.equal(game.coordinator.usage(game.wildlife), 0);
      assert.equal(oldWildlife.projectiles.length, 0);
      assert.equal(game.wildlife.projectiles.length, 0);
      assert.equal(game.paused, true);
      assert.equal(game.gameplay.health, 20);
      assert.equal(game.wildlife.spawnGrace, 8);
      assert.equal(collidesWithWorld(game.world, game.player.position), false);
      assert.ok(game.wildlife.entities.every((mob) => !mob.angry));
      assert.ok(
        game.wildlife.entities.every(
          (mob) => mob.spec.temperament !== "hostile"
        )
      );
      assert.equal(game.wildlife.byId.get(petId).health, 12);
      assert.equal(game.wildlife.byId.get(petId).tamed, true);
      assert.deepEqual(game.saved.mobs, game.saved.mobStates.overworld);
      assert.deepEqual(game.saved.mobsByDimension, game.saved.mobStates);
      assert.deepEqual(game.mobStates.overworld, game.saved.mobs);
      assert.deepEqual(game.saved.world, game.world.serialize());
      assert.deepEqual(game.saved.gameplay.inventory, backpack.inventory);
      assert.deepEqual(game.saved.gameplay.durability, backpack.durability);
      assert.deepEqual(
        game.saved.pickups,
        cycle === 1 ? pickups : game.pickups.serialize()
      );
      assert.deepEqual(game.saved.overflow, overflow);
      frames(game, 30);
      assert.equal(
        game.wildlife.spawnGrace,
        8,
        "the respawn menu consumes no grace"
      );
      await game.play();
      frames(game, 0.1);
      assert.equal(game.gameplay.health, 20, "the old 12-HP burst is gone");
      frames(game, 12.9);
      assert.equal(game.gameplay.dead, false);
      assert.equal(
        game.gameplay.health,
        20,
        "ordinary daylight need not erase anger globally"
      );
      assert.equal(game.wildlife.spawnGrace, 0);
      assert.equal(
        game.pickups
          .serialize()
          .items.reduce((sum, item) => sum + item.count, 0),
        3
      );
      assert.deepEqual(game.overflow.serialize(), overflow);
      t.diagnostic(
        `${kind} cycle ${cycle}: 20 HP after 0.1s and 13s; no repeat death; pet and loot retained`
      );
    }
  });
}

test("loaded-world arrival clears saved local aggression before the first playable frame", async (t) => {
  const game = fixture(t, 0.5);
  camp(game, "enderman", 2);
  await game.save();
  const saved = structuredClone(game.saved);
  assert.equal(game.gameplay.load(saved.gameplay), true);
  game.wildlife.dispose();
  // This is the same explicit boundary initialize uses after safe player restore.
  game.createWildlife(saved.mobStates.overworld, { safeSpawn: true });
  assert.equal(game.wildlife.spawnGrace, 8);
  assert.ok(game.wildlife.entities.every((mob) => mob.angry === 0));
  frames(game, 30);
  assert.equal(game.wildlife.spawnGrace, 8);
  await game.play();
  frames(game, 2);
  assert.equal(game.gameplay.health, 20);
  assert.ok(Math.abs(game.wildlife.spawnGrace - 6) < 1e-8);
});

test("respawn cleanup centers on the resolved safe landing, not the corpse or requested altitude", async (t) => {
  const game = fixture(t);
  const zombie = spawn(game, "zombie", 23.9);
  game.world.spawnHint = { x: 0.5, y: 60, z: 0.5 };
  game.player.setPosition({ x: 100.5, y: 9, z: 0.5 });
  game.gameplay.damage(100);
  const result = await game.respawn();
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.observerErrors, []);
  assert.ok(
    game.player.position.distanceTo(new THREE.Vector3(0.5, 9.01, 0.5)) < 0.001
  );
  assert.equal(game.wildlife.byId.has(zombie.id), false);
  assert.equal(game.gameplay.health, 20);
});

test("failed terrain loading leaves the player dead and the existing ecosystem untouched", async (t) => {
  const game = fixture(t);
  camp(game, "enderman", 2);
  const before = game.wildlife.serialize();
  const worldBefore = game.world.serialize(), epoch = game.world.epoch;
  const wildlife = game.wildlife, position = game.player.position.clone();
  const createPreview = game.travel.worldFactory;
  let preview;
  game.travel.worldFactory = (source, dimension) => {
    preview = createPreview(source, dimension);
    t.mock.method(preview, "ensureArea", async () => {
      throw new Error("terrain unavailable");
    });
    return preview;
  };
  game.gameplay.damage(100);
  const result = await game.respawn();
  assert.equal(result.ok, false);
  assert.equal(result.message, "terrain unavailable");
  assert.equal(preview._disposed, true);
  assert.equal(game.world.epoch, epoch);
  assert.deepEqual(game.world.serialize(), worldBefore);
  assert.ok(game.player.position.equals(position));
  assert.equal(game.wildlife, wildlife);
  assert.equal(game.gameplay.dead, true);
  assert.equal(game.gameplay.health, 0);
  assert.equal(game.wildlife.spawnGrace, 0);
  assert.deepEqual(game.wildlife.serialize(), before);
  assert.equal(game.saved, undefined);
});

test("grace expires after simulated play, survives pause and hidden tabs, and never renews on resume", async (t) => {
  const game = fixture(t);
  game.wildlife.protectSpawn(game.player.position);
  const zombie = spawn(game, "zombie", 1.2);
  zombie.attackCooldown = 0;
  await game.play();
  frames(game, 7.9);
  assert.equal(game.gameplay.health, 20);
  const remaining = game.wildlife.spawnGrace;
  assert.equal(await game.pause(), true);
  frames(game, 30);
  assert.equal(game.wildlife.spawnGrace, remaining);
  await game.play();
  globalThis.document.hidden = true;
  frames(game, 30);
  globalThis.document.hidden = false;
  assert.equal(game.wildlife.spawnGrace, remaining);
  frames(game, 0.05);
  assert.equal(game.gameplay.health, 20);
  frames(game, 0.15);
  assert.equal(game.wildlife.spawnGrace, 0);
  assert.equal(game.gameplay.health, 17);
  assert.equal(await game.pause(), true);
  await game.play();
  assert.equal(game.wildlife.spawnGrace, 0);
  frames(game, 1.6);
  assert.ok(game.gameplay.health < 17, "normal melee cooldowns still run");
  VoxelGame.prototype.refreshHud.call(game);
  assert.equal(game.hud.spawnGrace, 0);
});

test("inventory simulation consumes grace, while environmental damage is never masked", async (t) => {
  const game = fixture(t);
  game.wildlife.protectSpawn(game.player.position);
  await game.play();
  game.overlayOpen = true;
  game.player.enabled = false;
  frames(game, 1);
  assert.ok(Math.abs(game.wildlife.spawnGrace - 7) < 1e-8);
  assert.equal(game.world.set(0, 9, 0, BLOCK.LAVA), true);
  frames(game, 0.5);
  assert.equal(game.gameplay.health, 16);
  VoxelGame.prototype.refreshHud.call(game);
  assert.ok(Math.abs(game.hud.spawnGrace - 6.5) < 1e-8);
});

test("ordinary travel preserves encounters and does not grant fresh protection", async (t) => {
  const game = fixture(t);
  const zombie = spawn(game, "zombie", 1.2);
  zombie.angry = 20;
  zombie.attackCooldown = 0;
  const result = await game.teleport(game.world.getSpawn());
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(result.observerErrors, []);
  assert.equal(game.wildlife.byId.get(zombie.id).angry, 20);
  assert.equal(game.wildlife.spawnGrace, 0);
  await game.play();
  frames(game, 0.1);
  assert.equal(game.gameplay.health, 17);
});

for (const bow of [false, true]) {
  test(`${bow ? "bow" : "melee"} combat ends grace without giving free damage or duplicating loot`, async (t) => {
    const game = fixture(t);
    game.wildlife.protectSpawn(game.player.position);
    const zombie = spawn(game, "zombie", 1.2);
    zombie.attackCooldown = 0;
    game.mobTarget = { entity: zombie, distance: 1.2 };
    let shots = 0;
    game.effects.shoot = () => shots++;
    if (bow) {
      game.gameplay.add(ITEM.BOW, 1, { durability: [7] });
      game.gameplay.assignSlot(0, ITEM.BOW);
      await game.play();
      assert.equal(game.beginUse(), false);
      assert.equal(game.endUse(), false);
      assert.equal(
        game.wildlife.spawnGrace,
        8,
        "an empty bow has not attacked"
      );
      assert.equal(zombie.health, zombie.spec.health);
      assert.equal(game.gameplay.getHandStack().durability, 7);
      assert.equal(shots, 0);
      game.gameplay.add(ITEM.ARROW, 1);
      frames(game, 0.25);
      assert.equal(game.beginUse(), true);
      frames(game, 1);
      assert.ok(Math.abs(game.wildlife.spawnGrace - 6.75) < 1e-8);
      assert.equal(game.gameplay.health, 20);
      assert.equal(zombie.health, zombie.spec.health);
      assert.equal(game.gameplay.count(ITEM.ARROW), 1);
      assert.equal(game.gameplay.getHandStack().durability, 7);
      assert.equal(shots, 0);

      const aim = zombie.position
        .clone()
        .add(new THREE.Vector3(0, zombie.spec.height * 0.7, 0))
        .sub(game.player.eyePosition);
      game.player.yaw = Math.atan2(-aim.x, -aim.z);
      game.player.pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z));
      game.player.update(0.001);
      assert.equal(
        game.wildlife.raycast(game.player.eyePosition, game.player.forward, 32)
          ?.entity,
        zombie
      );
      assert.equal(game.endUse(), true);
      assert.equal(game.endUse(), false);
      assert.equal(shots, 1);
      assert.equal(game.gameplay.getHandStack().durability, 6);
    } else {
      await game.play();
      game.meleeTarget = { entity: zombie, distance: 1.2 };
      game.primary(0.05);
    }
    assert.equal(game.wildlife.spawnGrace, 0);
    assert.equal(game.wildlife.context.spawnProtected, false);
    assert.ok(zombie.health < zombie.spec.health);
    assert.ok(zombie.angry > 0);
    assert.equal(game.pickups.size, 0);
    if (bow) assert.equal(game.gameplay.count(ITEM.ARROW), 0);
    frames(game, 0.1);
    assert.equal(
      game.gameplay.health,
      17,
      "the attacked mob can retaliate immediately"
    );
  });
}

test("a preserved distant undead mob can die naturally once, without respawn duplicating its loot", async (t) => {
  const game = fixture(t, 0.5);
  const zombie = spawn(game, "zombie", 30);
  game.gameplay.damage(100);
  const first = await game.respawn();
  assert.equal(first.ok, true, first.message);
  assert.deepEqual(first.observerErrors, []);
  assert.equal(game.wildlife.byId.get(zombie.id).health, 20);
  assert.equal(game.pickups.size, 0);
  await game.play();
  frames(game, 9.9);
  assert.equal(game.pickups.size, 0, "safe arrival did not generate a drop");
  assert.ok(game.wildlife.byId.get(zombie.id).health <= 4);
  frames(game, 0.3);
  assert.equal(game.wildlife.byId.has(zombie.id), false);
  assert.equal(game.wildlife.killed.has(zombie.id), true);
  const loot = game.pickups.serialize().items;
  assert.equal(loot.length, 1);
  assert.equal(loot[0].id, ITEM.BONE);
  assert.ok(loot[0].count >= 1 && loot[0].count <= 2);
  game.gameplay.damage(100);
  const second = await game.respawn();
  assert.equal(second.ok, true, second.message);
  assert.deepEqual(second.observerErrors, []);
  assert.equal(game.wildlife.byId.has(zombie.id), false);
  assert.deepEqual(game.saved.pickups.items, loot);
  assert.equal(game.gameplay.health, 20);
});
