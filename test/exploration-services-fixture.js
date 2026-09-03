import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import {
  explorationAdmission,
  nativeExplorationContext,
} from "../src/exploration-host-state.js";
import { GameExplorationServices } from "../src/game-exploration-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { harvestDrops } from "../src/gameplay-harvest.js";
import { insertStack } from "../src/inventory-slots.js";
import { getItem, ITEM } from "../src/items.js";
import { lootNeedsMap, rollStructureLoot } from "../src/loot-tables.js";
import { Settlement } from "../src/settlement.js";
import {
  describeStructure,
  locateStructure,
  resolveStructureMapTarget,
} from "../src/structure-catalog.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { describeV5Structure } from "../src/terrain-v5-manifest.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";

export const NATIVE_EXPLORATION_SEARCH = Object.freeze({
  radius: 12,
  maxCells: 625,
  maxSamples: 12288,
});
const origins = [
  { x: -4096, z: -4096 },
  { x: 0, z: 0 },
  { x: 6144, z: 4096 },
  { x: -6144, z: 6144 },
];
const sites = new Map();

/**
 * Real default-factory World and bare native sampler. No injected generator,
 * patched material catalog, authored columns or forced structure coordinates.
 * At most four bounded searches per seed/kind/variant; inspect the FIRST match.
 */
export function nativeExplorationSite(
  world,
  kind = "village",
  variant = "",
  required = true
) {
  const key = JSON.stringify([world.seed, world.generatorVersion, world.dimension, kind, variant]);
  if (sites.has(key)) return sites.get(key);
  const context = nativeExplorationContext(world);
  const attempts = [];
  for (const from of origins) {
    const located = locateStructure(
      kind,
      context,
      from,
      NATIVE_EXPLORATION_SEARCH
    );
    assert.ok(located.examinedCells <= NATIVE_EXPLORATION_SEARCH.maxCells);
    assert.ok(located.sampledColumns <= NATIVE_EXPLORATION_SEARCH.maxSamples);
    attempts.push({ from, ...located });
    if (!located.target) continue;
    const describe = world.generatorVersion === 5 ? describeV5Structure : describeStructure;
    const descriptor = describe(
      kind,
      context,
      located.target.gx,
      located.target.gz
    );
    assert.ok(descriptor);
    let matched =
      !variant ||
      (variant === "whole" && descriptor.plan.damage === "whole") ||
      (variant === "annex" && descriptor.plan.annex) ||
      descriptor.variant.startsWith(variant);
    if (["mapped", "unmapped"].includes(variant)) {
      const chart = descriptor.markers.find(
        (marker) => marker.type === "container" && marker.mapTarget
      );
      if (chart) {
        // Destination presence is the scenario criterion, never a retry after
        // invalid geometry/ownership. Each query keeps its native declaration's
        // <=625 owner / <=16384 column bounds; at most four queries per seed.
        const resolution = resolveStructureMapTarget(chart.mapTarget, context);
        matched = (resolution.target !== null) === (variant === "mapped");
      }
    }
    if (!matched) continue;
    sites.set(key, descriptor);
    return descriptor;
  }
  if (required)
    assert.fail(
      `No native ${kind}/${variant} in four bounded windows: ${JSON.stringify(attempts)}`
    );
  return null;
}

export async function admitNativeStructure(world, descriptor) {
  const { bounds } = descriptor;
  const minX = Math.floor(bounds.minX / 16),
    maxX = Math.floor((bounds.maxX - 1) / 16);
  const minZ = Math.floor(bounds.minZ / 16),
    maxZ = Math.floor((bounds.maxZ - 1) / 16);
  const cx = Math.floor((minX + maxX) / 2),
    cz = Math.floor((minZ + maxZ) / 2);
  const radius = Math.max(cx - minX, maxX - cx, cz - minZ, maxZ - cz);
  // Pin the complete native footprint together. Sequential radius-zero loads
  // can evict the far anchors of a village/fortress before the fixture is ready.
  // The lifecycle suite separately replays these real envelopes in reverse.
  await world.ensureArea({ x: cx * 16, z: cz * 16 }, radius);
  assert.deepEqual(world.admissionObserverErrors, []);
}

export async function explorationServicesFixture(
  t,
  {
    seed,
    kind = "village",
    variant = "",
    dimension = ["nether_fortress", "bastion_remnant"].includes(kind)
      ? "nether"
      : "overworld",
    stage = true,
    activate = true,
    limits,
    maxEntries,
    saved = null,
    allowOverBudget = false,
    generatorVersion = 4,
  } = {}
) {
  const coordinator = new TransactionCoordinator();
  let world, descriptor;
  for (const candidate of seed === undefined
    ? ["cedar-valley", "tidal-archive", "basalt-crossing"]
    : [seed]) {
    world = new World(candidate, {
      generatorVersion,
      dimension,
      useWorker: false,
      coordinator,
    });
    descriptor = nativeExplorationSite(world, kind, variant, false);
    if (descriptor) break;
    world.dispose();
  }
  assert.ok(
    descriptor,
    `Required native ${kind}/${variant} absent from the bounded seed/windows`
  );
  const context = createWorldContext(world);
  const gameplay = new Gameplay({ context, coordinator, mode: "survival" });
  const settlement = new Settlement({ context, coordinator });
  const overflow = new DropOverflow({ context, coordinator, maxEntries });
  assert.equal(settlement.bindWorld(world), true);
  const services = [];
  const game = {
    world,
    gameplay,
    settlement,
    overflow,
    coordinator,
    worldContext: context,
    paused: false,
    building: false,
    failed: false,
    active: true,
    simulating: true,
    elapsed: 0,
    lastOverflowToast: 0,
    pickups: null,
    saves: 0,
    scheduleSave() {
      this.saves++;
    },
    refreshHud() {},
    ui: { toast() {} },
  };
  const inventoryActions = new GameInventoryActions(game);
  game.prepareDropItems = (stacks, position) =>
    inventoryActions.prepareDropItems(stacks, position);
  const f = {
    world,
    context,
    coordinator,
    gameplay,
    settlement,
    overflow,
    descriptor,
    game,
    service: null,
    create(options = {}) {
      const service = new GameExplorationServices({
        world,
        context,
        gameplay,
        settlement,
        overflow,
        saved,
        allowOverBudget,
        limits,
        ...options,
      });
      services.push(service);
      return service;
    },
    hit(marker) {
      const { x, y, z } = marker.position ?? marker;
      return { x, y, z, dimension: world.dimension, ...world.getCell(x, y, z) };
    },
    admission(marker) {
      const { x, z } = marker.position ?? marker;
      const chunk = world.chunks.get(
        `${Math.floor(x / 16)},${Math.floor(z / 16)}`
      );
      assert.ok(chunk);
      return explorationAdmission(world, chunk);
    },
    entries() {
      return f.service.index
        .list("container")
        .filter(({ marker }) => marker.structureId === descriptor.id);
    },
    snapshot() {
      return {
        world: world.serialize(),
        gameplay: gameplay.serialize(),
        settlement: settlement.serialize(),
        overflow: overflow.serialize(),
        exploration: f.service?.serialize().exploration,
        bytes: coordinator.budget.totalBytes,
      };
    },
    prepareBreak(hit, { explosion = false, ...options } = {}) {
      const harvest = explosion ? null : gameplay.prepareHarvest(hit.id);
      if (!explosion) assert.ok(harvest);
      const drops = explosion
        ? harvestDrops(hit.id, { mode: gameplay.mode, explosion, context })
        : harvest.drops;
      return f.service.prepareBreak(hit, {
        explosion,
        drops,
        participants: harvest ? [harvest.participant] : [],
        prepareDrops: (stacks) =>
          game.prepareDropItems(stacks, {
            x: hit.x + 0.5,
            y: hit.y + 0.5,
            z: hit.z + 0.5,
          }),
        ...options,
      });
    },
  };
  world.onChunkAdmitted = (event) => f.service?.onChunkAdmitted(world, event);
  world.onMutation = (event) => f.service?.onWorldMutation(world, event);
  t.after(() => {
    for (const service of services) service.dispose();
    overflow.dispose();
    settlement.dispose();
    gameplay.dispose();
    world.dispose();
  });
  if (stage) {
    f.service = f.create();
    if (activate) assert.equal(f.service.activate(game).ok, true);
  }
  await admitNativeStructure(world, descriptor);
  return f;
}

/** Restore the real ownership domains before constructing/activating the host. */
export function reloadExplorationOwners(f, saved) {
  assert.equal(f.service, null);
  assert.equal(f.world.loadEdits(saved.world), true);
  assert.equal(
    f.gameplay.load(saved.gameplay, { context: f.context, notify: false }),
    true
  );
  assert.equal(
    f.settlement.load(saved.settlement, { context: f.context, world: f.world }),
    true
  );
  assert.equal(f.overflow.load(saved.overflow, { context: f.context }), true);
  f.service = f.create({ saved: { exploration: saved.exploration } });
  assert.equal(f.service.activate(f.game).ok, true);
  for (const chunk of f.world.chunks.values())
    assert.equal(
      f.service.onChunkAdmitted(f.world, explorationAdmission(f.world, chunk)),
      true
    );
  return f.service;
}

export function holdExplorationTool(f, durability = 9) {
  const held = {
    id: ITEM.IRON_AXE,
    count: 1,
    durability,
    data: { version: 1, name: "Retained ⚒" },
  };
  assert.ok(getItem(held.id)?.durability >= durability);
  const edit = f.gameplay.prepareInventory((owned) => {
    owned.slots.fill(null);
    owned.slots[0] = held;
    return true;
  });
  assert.ok(edit);
  assert.equal(f.coordinator.commit([edit]).ok, true);
  f.gameplay.select(0);
  return held;
}

export function installLegacyChest(f, hit, stacks = []) {
  const plan = f.settlement.prepareContainers(f.world, [
    {
      hit,
      action: "initialize",
      expectedInitialized: false,
      stacks,
    },
  ]);
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
}

export function expectedExplorationSlots(entry, context, target) {
  const slots = Array(27).fill(null);
  const stacks = rollStructureLoot(
    entry.marker,
    context,
    lootNeedsMap(entry.marker.role) ? { mapTarget: target } : {}
  );
  for (const stack of stacks) assert.equal(insertStack(slots, stack), null);
  return slots;
}

export const chestBlockDrops = (f) =>
  harvestDrops(BLOCK.CHEST, {
    mode: f.gameplay.mode,
    context: f.context,
    explosion: true,
  });

export function retainedStacks(f) {
  return f.overflow.serialize().entries.map(({ id, count, wear, data }) => ({
    id,
    count,
    ...(wear === undefined ? {} : { durability: wear }),
    ...(data === undefined ? {} : { data }),
  }));
}

export function itemTotals(stacks) {
  const totals = new Map();
  for (const stack of stacks.filter(Boolean)) {
    const key = JSON.stringify([
      stack.id,
      stack.durability ?? null,
      stack.data ?? null,
    ]);
    totals.set(key, (totals.get(key) ?? 0) + stack.count);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b));
}
