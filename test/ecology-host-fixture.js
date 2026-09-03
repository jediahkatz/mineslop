import assert from "node:assert/strict";
import * as THREE from "three";
import { BIOMES } from "../src/biomes.js";
import { BLOCK } from "../src/blocks.js";
import { defaultFluidFor, normalizeCell } from "../src/block-state.js";
import { ecologyDistance } from "../src/aquatic-ai.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { ExperienceOrbs } from "../src/experience-orbs.js";
import { ExplorationState } from "../src/exploration-state.js";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { Gameplay } from "../src/gameplay.js";
import { getItem, ITEM } from "../src/items.js";
import { Trading } from "../src/trading.js";
import { Wildlife } from "../src/wildlife.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";

/** Controlled cell-volume habitat, NOT a substitute for native-v4 coverage.
 * Uses the real World ingestion/mutation/incarnation/save/coordinator owners.
 */
export function authoredEcologyWorld({
  seed = "ecology-host-fixture", generatorVersion = 4, dimension = "overworld",
  floor = 0, water = 6, waterId = BLOCK.WATER, biomeId = "ocean",
  radius = 1, initial = [],
} = {}) {
  let generated = 0;
  const biome = BIOMES.findIndex((entry) => entry.id === biomeId);
  assert.ok(biome >= 0, `Real biome required: ${biomeId}`);
  const generatorFactory = (seed, dimension, version) => {
    const spec = getWorldSpec(version, dimension);
    return {
      getSpawn: () => ({ x: 8.5, y: floor + 1, z: 8.5 }),
      generateChunk(cx, cz) {
        generated++;
        const ArrayType = version >= 4 ? Uint16Array : Uint8Array;
        const blocks = new ArrayType((spec.maxY - spec.minY) * 256);
        for (let y = spec.minY; y < spec.maxY; y++) {
          const id = y <= floor ? BLOCK.SAND : y <= water ? waterId : BLOCK.AIR;
          blocks.fill(id, (y - spec.minY) * 256, (y - spec.minY + 1) * 256);
        }
        const sections = new Map();
        const cells = initial.filter(([x, y, z]) =>
          Math.floor(x / 16) === cx && Math.floor(z / 16) === cz && y >= spec.minY && y < spec.maxY
        ).map(([x, y, z, value]) => ({
          x, y, z, cell: normalizeCell(typeof value === "number" ? { id: value } : value),
        }));
        for (const { x, y, z, cell } of cells)
          blocks[(y - spec.minY) * 256 + (z - cz * 16) * 16 + x - cx * 16] = cell.id;
        for (const { x, y, z, cell } of cells) {
          if (!cell.state && cell.fluid === defaultFluidFor(cell.id)) continue;
          const sy = Math.floor(y / 16);
          if (!sections.has(sy)) sections.set(sy, { sy });
          const section = sections.get(sy);
          const at = (y - sy * 16) * 256 + (z - cz * 16) * 16 + x - cx * 16;
          if (cell.state) {
            section.states ??= new Uint16Array(4096);
            section.states[at] = cell.state;
          }
          if (cell.fluid !== defaultFluidFor(cell.id)) {
            if (!section.fluids) {
              section.fluids = new Uint8Array(4096);
              const start = (sy * 16 - spec.minY) * 256;
              for (let i = 0; i < 4096; i++) section.fluids[i] = defaultFluidFor(blocks[start + i]);
            }
            section.fluids[at] = cell.fluid;
          }
        }
        return { cx, cz, minY: spec.minY, maxY: spec.maxY, blocks,
          biomes: new Uint8Array(256).fill(biome), sections: [...sections.values()] };
      },
    };
  };
  const world = new World(seed, { dimension, generatorVersion, useWorker: false, generatorFactory }).generate(radius);
  return { world, generated: () => generated };
}

/** Test bridge with the exact rich-marker reader API expected from the parent.
 * The native suite supplies real admitted catalog descriptors to this bridge;
 * other suites deliberately supply authored markers and make no native claim.
 */
export function ecologyMarkerIndex(world) {
  const structures = new Map(), markers = new Map(), requests = [];
  const loaded = (entry) => entry?.dimension === world.dimension &&
    world.isLoaded(Math.floor(entry.position.x), Math.floor(entry.position.z));
  const api = {
    getMarker: (id) => loaded(markers.get(id)) ? markers.get(id) : null,
    getStructure: (id) => structures.get(id)?.dimension === world.dimension ? structures.get(id) : null,
    nearbyMarkers(position, options) {
      requests.push({ method: "markers", ...options });
      return [...markers.values()].filter((marker) => loaded(marker) &&
        options.entities.includes(marker.entity) &&
        ecologyDistance(marker.position, position) <= options.radius
      ).slice(0, options.limit);
    },
    nearbyStructures(position, options) {
      requests.push({ method: "structures", ...options });
      return [...structures.values()].filter((structure) =>
        structure.dimension === options.dimension && options.kinds.includes(structure.kind) &&
        ecologyDistance(structure.origin, position) <= options.radius
      ).slice(0, options.limit);
    },
  };
  return {
    api, structures, markers, requests,
    add(structure, members = structure.markers ?? []) {
      structures.set(structure.id, structure);
      for (const marker of members) markers.set(marker.id, marker);
      return structure;
    },
  };
}

/** Real Wildlife + World + Gameplay + retained drops + XP + progression.
 * No DOM, fake corpse, direct inventory map writes, or generated trade stock.
 */
export function ecologyHostFixture(t, {
  world: suppliedWorld, saved, activate = true, withExploration = true,
  maxEntries, maxEntities, hooks = {}, allowOverBudget = false, ...worldOptions
} = {}) {
  const terrain = suppliedWorld ? { world: suppliedWorld } : authoredEcologyWorld(worldOptions);
  const { world } = terrain, coordinator = world.coordinator, context = createWorldContext(world);
  if (saved?.world) assert.equal(world.loadEdits(saved.world), true);
  const scene = new THREE.Scene();
  const gameplay = new Gameplay({ coordinator, context, mode: "survival" });
  const overflow = new DropOverflow({ coordinator, context, maxEntries });
  const experienceOrbs = new ExperienceOrbs(scene, world, {
    coordinator, context, prepareCollect: (amount) => gameplay.prepareExperience(amount),
  });
  const exploration = withExploration ? new ExplorationState({ coordinator, context }) : undefined;
  const trading = new Trading({ coordinator, context });
  if (saved) {
    assert.equal(gameplay.load(saved.gameplay, { context, notify: false, allowOverBudget }), true);
    assert.equal(overflow.load(saved.overflow, { context, allowOverBudget }), true);
    assert.equal(experienceOrbs.load(saved.experience, { context, allowOverBudget }), true);
    if (exploration) assert.equal(exploration.load(saved.exploration, { allowOverBudget }), true);
    assert.equal(trading.load(saved.trading, { allowOverBudget }), true);
  }
  const markerIndex = ecologyMarkerIndex(world), services = [], renderers = [];
  const player = {
    position: { x: 8.5, y: 2, z: 12.5 }, targetKey: "player:life:1",
    swimming: true, invulnerable: false,
  };
  const f = {
    ...terrain, world, coordinator, context, scene, gameplay, overflow, experienceOrbs, exploration,
    trading, markerIndex, player, timeOfDay: 0.5, elapsed: 0, damage: [], changes: 0,
    host: null, wildlife: null,
    view: () => ({
      ...player, position: { ...player.position },
      eye: { ...player.position, y: player.position.y + 1.62 },
      dimension: player.dimension ?? world.dimension, health: gameplay.health, mode: gameplay.mode,
    }),
    createHost(extra = {}) {
      const host = new GameEcologyServices({
        world, coordinator, context, gameplay, overflow, experienceOrbs, exploration, trading,
        markers: markerIndex.api, saved: saved?.ecology, allowOverBudget,
        readPlayer: () => f.view(),
        readHabitat: () => ({ biomeId: worldOptions.biomeId ?? "ocean", blockLight: 0, skyLight: 0 }),
        prepareVillagerDeath: ({ entityId }) => {
          const plan = trading.prepareReleaseJobsite(entityId, {
            clock: trading.get(entityId)?.clock ?? { day: 0, time: 2000 }, validate: () => true,
          });
          return plan?.participants[0] ?? null;
        },
        onChange: () => { f.changes++; },
        ...hooks, ...extra,
      });
      services.push(host);
      return host;
    },
    createWildlife() {
      const wildlife = new Wildlife(scene, world, {
        autoSpawn: false, context, maxEntities,
        onDrop: () => assert.fail("Ecology must not use legacy drop callbacks"),
        onDamage: (amount, cause, mob, attack) => {
          f.damage.push({ amount, cause, source: mob?.id, attack, visible: f.host?.attacks.mesh?.count ?? 0 });
          gameplay.damage(amount, cause);
          return { health: gameplay.health };
        },
      });
      renderers.push(wildlife);
      return wildlife;
    },
    tick(count = 1, dt = 0.05) {
      for (let i = 0; i < count; i++) {
        const view = f.view();
        f.elapsed += dt;
        f.wildlife.update(dt, f.elapsed, view.position, {
          timeOfDay: f.timeOfDay, mode: view.mode, health: view.health,
          playerEye: view.eye, playerSwimming: view.swimming, playerInvulnerable: view.invulnerable,
          playerTargetKey: view.targetKey, playerDimension: view.dimension,
        });
      }
    },
    admit(kind, position, options) {
      const plan = f.host.prepareAdmission(kind, position, options);
      assert.ok(plan, `Expected admitted ${kind}`);
      assert.equal(f.host.commit(plan).ok, true);
      return f.wildlife.byId.get(plan.result.id);
    },
    hold(name, { count = 1, hand = "main", data, durability } = {}) {
      const id = ITEM[name] ?? BLOCK[name], item = getItem(id);
      assert.ok(item, `Parent checkpoint must provide real ${name}`);
      const stack = { id, count,
        ...(item.durability ? { durability: durability ?? item.durability } : {}),
        ...(data ? { data } : {}),
      };
      assert.equal(gameplay.inventoryTransaction((draft) => {
        if (hand === "main") draft.slots[gameplay.selected] = stack;
        else draft.offhand = stack;
        return true;
      }), true);
      return stack;
    },
    put(x, y, z, value) {
      const before = world.getCell(x, y, z);
      const after = normalizeCell(typeof value === "number" ? { id: value } : value);
      assert.ok(before);
      assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
    },
    snapshot: () => ({
      world: world.serialize(), gameplay: gameplay.serialize(), overflow: overflow.serialize(),
      experience: experienceOrbs.serialize(), exploration: exploration?.serialize(),
      trading: trading.serialize(), ecology: f.host.serialize(),
    }),
    ownership: () => ({
      world: world.serialize(), gameplay: gameplay.serialize(), overflow: overflow.serialize(),
      experience: experienceOrbs.serialize(), exploration: exploration?.serialize(),
      trading: trading.serialize(), ecology: f.host.ecology.serialize(), mobs: f.wildlife.serialize(),
      bytes: coordinator.budget.totalBytes,
    }),
  };
  world.onMutation = (event) => f.host?.onMutation(world, event);
  world.onChunkAdmitted = (event) => f.host?.onChunkAdmitted(world, event);
  t.after(() => {
    for (const host of services) host.dispose();
    for (const wildlife of renderers) wildlife.dispose();
    experienceOrbs.dispose();
    overflow.dispose();
    exploration?.dispose();
    trading.dispose();
    gameplay.dispose();
    world.dispose();
  });
  f.host = f.createHost();
  f.wildlife = f.createWildlife();
  if (activate) {
    assert.equal(f.host.restoreWildlife(f.wildlife), true);
    assert.equal(f.host.activate(f.wildlife), true);
  }
  f.tick(1, 0);
  return f;
}

export function ecologyTotals(f) {
  const drops = {};
  for (const entry of f.overflow.serialize().entries)
    drops[entry.id] = (drops[entry.id] ?? 0) + entry.count;
  return { drops, xp: f.experienceOrbs.serialize().orbs.reduce((sum, orb) => sum + orb.amount, 0) };
}

export function ecologyVeto(coordinator, validate = () => false) {
  const owner = {};
  assert.equal(coordinator.register(owner, 0), true);
  return { owner, beforeBytes: 0, afterBytes: 0, validate,
    publish: () => assert.fail("Veto must run before all publication") };
}

export function ecologyVillage(f) {
  const structure = {
    id: "fixture:village", kind: "village", dimension: "overworld",
    origin: { x: 8, y: 1, z: 8 },
    bounds: { minX: 0, minY: 1, minZ: 0, maxX: 25, maxY: 10, maxZ: 25 },
  };
  const member = {
    id: `${structure.id}/member/grower`, structureId: structure.id, dimension: "overworld",
    type: "member", key: "grower", role: "resident", entity: "villager", unique: true,
    profession: "farmer", position: { x: 8, y: 1, z: 8 },
    homeId: `${structure.id}/home/farm`, jobSiteId: `${structure.id}/job_site/composter`,
  };
  const home = { id: member.homeId, structureId: structure.id, dimension: "overworld",
    type: "home", position: { x: 8, y: 1, z: 11 } };
  const site = { id: member.jobSiteId, structureId: structure.id, dimension: "overworld",
    type: "job_site", memberId: member.id, profession: "farmer",
    block: "COMPOSTER", position: { x: 10, y: 1, z: 8 } };
  f.markerIndex.add(structure, [member, home, site]);
  f.put(10, 1, 8, BLOCK.COMPOSTER);
  return { structure, member, home, site };
}

export function ecologyFortress(f) {
  const structure = { id: "fixture:fortress", kind: "nether_fortress", dimension: "nether",
    origin: { x: 12, y: 2, z: 8 },
    bounds: { minX: 0, minY: 1, minZ: 0, maxX: 31, maxY: 16, maxZ: 25 } };
  const marker = {
    id: `${structure.id}/encounter/blaze_nest`, structureId: structure.id, dimension: "nether",
    type: "encounter", key: "blaze_nest", role: "blaze_spawner", entity: "blaze",
    mechanism: "spawner", block: "SPAWNER", position: { x: 12, y: 2, z: 8 },
    bounds: structure.bounds,
  };
  f.markerIndex.add(structure, [marker]);
  f.put(12, 2, 8, BLOCK.SPAWNER);
  return { structure, marker };
}
