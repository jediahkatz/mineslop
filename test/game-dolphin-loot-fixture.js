import assert from "node:assert/strict";
import { ecologyDistance } from "../src/aquatic-ai.js";
import { collidesWithWorld } from "../src/player.js";
import { World } from "../src/world.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";
import { nativeExplorationSite } from "./exploration-services-fixture.js";

export const DOLPHIN_LOOT_SEED = "beached-map-640";

/**
 * Native v7 cells + real Game, Wildlife, Ecology, Exploration, Settlement and
 * input/payment owners. Fish and a physical player approach are finite authored
 * prerequisites. Admission uses the real ocean/body checks, not an empty
 * Wildlife facade. This is CPU ownership evidence, not GUI/performance proof.
 */
export async function nativeDolphinLootGame(t, { saved = null } = {}) {
  const world = new World(saved?.world.seed ?? DOLPHIN_LOOT_SEED, {
    generatorVersion: 7, useWorker: false,
  });
  const descriptor = nativeExplorationSite(world, "shipwreck", "mapped");
  const f = await gameMobFixture(t, {
    world, saved, generatorFactory: null, autoSpawn: false, admissionRadius: 3,
    spawnPosition: {
      x: descriptor.origin.x + 0.5, y: world.spec.seaLevel - 2,
      z: descriptor.origin.z + 0.5,
    },
  });
  f.descriptor = f.mobs.markers.getStructure(descriptor.id);
  assert.ok(f.descriptor, "real v7 admission must supply the wreck");
  f.entries = f.descriptor.markers.filter((marker) => marker.type === "container")
    .map((marker) => f.exploration.index.byId(marker.id));
  assert.equal(f.entries.length, 2, "the audited native wreck has two chests");
  assert.ok(f.entries.every(Boolean));
  f.settlement = f.game.settlement;
  f.hit = (entry) => ({
    ...entry.marker.position, dimension: world.dimension,
    ...world.getCell(entry.marker.position.x, entry.marker.position.y, entry.marker.position.z),
  });
  f.observe = () => f.exploration.observeLootAvailability([f.descriptor]);
  f.statuses = () => Object.fromEntries(f.observe().structures[0].containers
    .map((container) => [container.id, container.status]));
  f.game.containerUI = {
    isOpen: false,
    open(atWorld, hit, gameplay, settlement, { validate }) {
      assert.equal(validate(), true);
      this.isOpen = !!settlement.getContainerState(atWorld, hit, gameplay);
      return this.isOpen;
    },
    close() { this.isOpen = false; return true; },
    refresh() {},
  };
  f.open = (entry) => {
    const { x, y, z } = entry.marker.position;
    f.player.setPosition({ x: x + 0.5, y: y + 1, z: z + 0.5 });
    assert.equal(f.game.inventoryActions.openStation(f.hit(entry)), true);
    assert.equal(f.game.containerUI.close(), true);
    return f.settlement.inspectContainer(world, f.hit(entry)).slots;
  };
  f.drain = (entry, limit = 27) => {
    const moved = [];
    for (let index = 0; index < 27 && moved.length < limit; index++) {
      const stack = f.settlement.inspectContainer(world, f.hit(entry)).slots[index];
      if (!stack) continue;
      const result = f.settlement.containerAction(world, f.hit(entry), f.gameplay, {
        type: "quickMove", area: "container", index,
      });
      assert.equal(result.ok, true, result.message);
      moved.push(stack);
    }
    return moved;
  };
  f.approach = () => {
    for (const y of [f.mob.position.y, f.mob.position.y + 1])
      for (const radius of [2, 1.5, 2.5])
        for (const [dx, dz] of [[0, radius], [0, -radius], [radius, 0], [-radius, 0]]) {
          const at = { x: f.mob.position.x + dx, y, z: f.mob.position.z + dz };
          if (collidesWithWorld(world, at, f.player.height)) continue;
          f.player.setPosition(at);
          if (f.mob.dormant) f.stepGuide();
          f.aim(f.mob);
          if (f.game.mobActions.capture(f.mob)) return;
        }
    assert.fail("native dolphin must be physically in reach and unobstructed");
  };
  f.feed = () => {
    f.approach();
    f.game.elapsed += 0.25;
    f.key("KeyV");
    f.key("KeyV", false);
  };
  f.stepGuide = () => {
    const view = f.mobs.readPlayer();
    f.game.elapsed += 0.05;
    f.wildlife.update(0.05, f.game.elapsed, view.position, {
      timeOfDay: f.game.currentTime, mode: view.mode, health: view.health,
      playerEye: view.eye, playerSwimming: view.swimming,
      playerInvulnerable: view.invulnerable, playerTargetKey: view.targetKey,
      playerDimension: view.dimension,
    });
  };
  if (saved) {
    f.mob = f.wildlife.entities.find((mob) => mob.kind === "dolphin") ??
      [...f.wildlife.dormantEcology.values()].find((mob) => mob.kind === "dolphin");
    assert.ok(f.mob, "cold restore must retain the actual dolphin base and sidecar");
    return f;
  }
  // Bounded test setup in already-admitted native water. No forced biome,
  // fabricated body sampler, direct spawn or terrain edits.
  const candidates = [];
  for (let dx = -44; dx <= 44; dx += 4)
    for (let dz = -44; dz <= 44; dz += 4)
      // Include the real column's upper body alignment, above selectable
      // seagrass, without deleting plants or weakening physical ray guards.
      for (const depth of [0.3, 1, 1.3, 2, 2.3, 3]) {
        const at = {
          x: descriptor.origin.x + dx + 0.5, y: world.spec.seaLevel - depth,
          z: descriptor.origin.z + dz + 0.5,
        };
        const distance = ecologyDistance(at, descriptor.origin);
        if (distance >= 8 && distance <= 48) candidates.push(at);
      }
  candidates.sort((a, b) => ecologyDistance(a, descriptor.origin) -
    ecologyDistance(b, descriptor.origin));
  for (const at of candidates) {
    f.player.setPosition({ ...at, z: at.z + 2 });
    const plan = f.ecology.prepareAdmission("dolphin", at);
    if (!plan) continue;
    assert.equal(f.ecology.commit(plan).ok, true);
    f.mob = f.wildlife.byId.get(plan.result.id);
    break;
  }
  assert.ok(f.mob, "a live naturally valid v7 ocean body near the wreck is required");
  assert.equal(f.ecology.habitat(f.mob.position, "dolphin").biomeId.includes("ocean"), true);
  f.approach();
  f.gameplay.select(8);
  f.hold("RAW_COD", { count: 2 });
  f.nativeProof = {
    seed: world.seed, generatorVersion: world.generatorVersion,
    structureId: f.descriptor.id, dolphinId: f.mob.id, dolphinLife: f.mob.life,
    dolphinPosition: point(f.mob.position),
    chests: f.entries.map((entry) => ({
      id: entry.marker.id, role: entry.marker.role, position: entry.marker.position,
    })),
  };
  return f;
}
