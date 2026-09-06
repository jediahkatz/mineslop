import assert from "node:assert/strict";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { getItem, ITEM } from "../src/items.js";
import { groundAt } from "../src/mob-navigation.js";
import { parseWorldFile, exportWorldFile } from "../src/storage.js";
import { World, raycast } from "../src/world.js";
import { potionStack } from "./brewing-fixture.js";
import { gameMobFixture, point } from "./game-mob-integration-fixture.js";

export const countItem = (f, id) => f.gameplay.slots.reduce(
  (sum, stack) => sum + (stack?.id === id ? stack.count : 0), 0,
);
export const looseItem = (f, id) => f.game.pickups.serialize().items.filter((stack) => stack.id === id);
export const standRecord = (f, at) => f.progression.services.stations.get(at).record;

/** Finite authored equipment and brewing prerequisites, never eyes or tears. */
export function starterKit(f) {
  const stack = (id, count = 1) => ({
    id, count, ...(getItem(id).durability ? { durability: getItem(id).durability } : {}),
  });
  assert.equal(f.gameplay.inventoryTransaction((draft) => {
    assert.equal(draft.slots.every((entry) => entry === null), true);
    draft.slots[0] = stack(ITEM.DIAMOND_SWORD);
    draft.slots[1] = stack(ITEM.BOW);
    draft.slots[2] = stack(ITEM.ARROW, 12);
    draft.slots[3] = stack(ITEM.NETHER_WART);
    draft.slots[4] = stack(ITEM.BLAZE_POWDER);
    draft.slots[5] = potionStack(f.progression.services.catalog, "water");
    return true;
  }), true);
}

/** Production generation + unchanged autoSpawn/populate in real Game frames.
 * Player starting positions and night are authored; no mob or terrain edits.
 * A supplied seed is an authored encounter prerequisite, not a loot/RNG override.
 */
export async function nativeIngredientMob(t, kind, { seed: selectedSeed } = {}) {
  const dimension = kind === "ghast" ? "nether" : "overworld";
  assert.ok(selectedSeed === undefined || (typeof selectedSeed === "string" && selectedSeed.length > 0));
  const seeds = selectedSeed === undefined
    ? ["cedar-valley", "tidal-archive", "basalt-crossing"] : [selectedSeed];
  const attempts = [];
  for (const seed of seeds) {
    const world = new World(seed, { dimension, generatorVersion: 4, useWorker: false });
    const f = await gameMobFixture(t, {
      world, generatorFactory: null, autoSpawn: true, admissionRadius: 3,
    });
    assert.equal(f.building.setTime(0).ok, true, "authored nighttime prerequisite");
    for (let batch = 0; batch < 6; batch++) {
      f.frame(batch === 0 ? 1 : 31);
      const mob = f.wildlife.entities.find((entry) => entry.kind === kind);
      if (mob) {
        assert.match(mob.id, new RegExp(`^${dimension}:-?\\d+,-?\\d+:h$`));
        assert.deepEqual(world.serialize().edits, [], "native admission makes no authored world edits");
        assert.equal(mob.health, mob.spec.health);
        const evidence = {
          kind, seed, generatorVersion: world.generatorVersion, dimension,
          id: mob.id, position: point(mob.position), player: point(f.player.position),
          frames: 1 + batch * 31, chunks: world.chunks.size,
        };
        t.diagnostic(`native admission ${JSON.stringify(evidence)}`);
        return { f, mob, evidence };
      }
      assert.equal(f.gameplay.dead, false, "bounded native search must stay alive");
    }
    attempts.push({
      seed, player: point(f.player.position),
      mobs: f.wildlife.entities.map((mob) => ({ kind: mob.kind, id: mob.id, at: point(mob.position) })),
    });
    f.game.paused = true;
  }
  assert.fail(`No native ${kind} admitted in ${seeds.length} seeds × 156 real frames: ${JSON.stringify(attempts)}`);
}

/** Authored approach only; no relocated mob, bypassed collision, or forced hit. */
export function approach(f, mob, ranged = false) {
  const radii = ranged ? [28, 30, 24, 20, 16] : [2.5, 2, 3];
  for (const radius of radii) {
    for (let direction = 0; direction < 16; direction++) {
      const angle = direction * Math.PI / 8;
      const x = mob.position.x + Math.sin(angle) * radius;
      const z = mob.position.z + Math.cos(angle) * radius;
      const heights = ranged
        ? [mob.position.y, mob.position.y - 4, mob.position.y - 8, mob.position.y - 12]
        : [mob.position.y];
      for (const nearY of heights) {
        const y = groundAt(f.world, x, z, { radius: 0.3, height: 1.8 }, {
          nearY, stepHeight: 2, maxDrop: 6, avoidHazards: true,
        });
        if (y === null || !isSafeRespawnPosition(f.world, { x, y, z })) continue;
        f.player.setPosition({ x, y, z });
        f.aim(mob);
        f.game.updateTarget();
        if (!ranged && f.game.meleeTarget?.entity === mob) return;
        if (ranged) {
          const hit = f.wildlife.raycast(f.player.eyePosition, f.player.forward, 32);
          const block = raycast(f.world, f.player.eyePosition, f.player.forward, 32);
          if (hit?.entity === mob && (!block || hit.distance < block.distance)) return;
        }
      }
    }
  }
  assert.fail(`No loaded safe ${ranged ? "bow" : "melee"} approach to ${mob.id} at ${JSON.stringify(point(mob.position))}`);
}

export function paidKill(f, mob, kind) {
  const ranged = kind === "ghast";
  f.gameplay.select(ranged ? 1 : 0);
  const before = f.gameplay.getHandStack();
  const arrows = countItem(f, ITEM.ARROW);
  let hits = 0;
  while (!mob.dead && hits < 8) {
    approach(f, mob, ranged);
    const health = mob.health;
    if (ranged) {
      assert.equal(f.game.useActions.begin("brewing-acquisition"), true);
      f.frame(22);
      approach(f, mob, true);
      assert.equal(f.game.useActions.end("brewing-acquisition"), true);
    } else {
      f.game.updateTarget();
      assert.equal(f.game.meleeTarget?.entity === mob, true);
      f.game.primary(0.05, true);
    }
    hits++;
    assert.ok(mob.health < health, `${kind} hit ${hits} must deal actual damage`);
    assert.equal(f.gameplay.getHandStack().durability, before.durability - hits);
    assert.equal(countItem(f, ITEM.ARROW), arrows - (ranged ? hits : 0));
    if (!mob.dead && !ranged) f.frame(11);
  }
  assert.equal(mob.dead, true, "finite paid combat must kill the actual admitted mob");
  assert.equal(f.wildlife.byId.has(mob.id), false);
  assert.equal(f.wildlife.killed.has(mob.id), true);
  return { hits, arrowsSpent: ranged ? hits : 0, durabilitySpent: hits };
}

/** Parser/export + every detached real owner, not a JSON-only reload mock. */
export async function archiveReload(t, f, label) {
  // Quiesce optional streaming and finish required resident admission before
  // taking the checkpoint. Otherwise a timer from the SOURCE Game can publish
  // unrelated fluid admission metadata while the new World awaits generation.
  f.world.clearStreaming();
  await f.world.ensureArea(f.player.position, 3);
  const text = exportWorldFile(f.snapshot());
  const before = JSON.parse(text);
  const saved = parseWorldFile(text);
  assert.deepEqual(saved, before, `${label}: export/parser preserve all component bytes`);
  const restored = await gameMobFixture(t, {
    saved, generatorFactory: null, autoSpawn: false, admissionRadius: 3,
  });
  // The shared fixture initializes a presentation clock; use its real clock owner.
  restored.game.currentTime = restored.building.worldClock.time;
  const after = restored.snapshot();
  for (const key of Object.keys(before)) {
    if (key !== "fluids") assert.deepEqual(after[key], before[key], `${label}: ${key} restores exactly`);
  }
  // Activation deliberately re-admits resident columns to the fluid scheduler.
  // Only scan cursors/regions/generation may change, never fluid resource work,
  // fluid time, context, terrain edits, or any other archived owner.
  const resourceFluids = (fluids) => ({
    ...fluids,
    dimensions: fluids.dimensions.map(({ scans, regions, generation, ...owned }) => owned),
  });
  assert.deepEqual(resourceFluids(after.fluids), resourceFluids(before.fluids),
    `${label}: fluid resources/clock survive resident scan re-admission`);
  assert.equal(exportWorldFile(f.snapshot()), text, `${label}: detached load cannot mutate source bytes`);
  assert.equal(restored.world.generatorVersion, f.world.generatorVersion);
  assert.equal(restored.world.seed, f.world.seed);
  f.game.paused = true;
  t.diagnostic(`archive ${label}: ${Buffer.byteLength(text)} bytes; exact resource owners; fluid admission scans rebuilt`);
  return restored;
}

export function stationAction(f, action) {
  const result = f.progression.action({
    ...action, sessionToken: f.progression.services.session?.token,
  });
  assert.equal(result.ok, true, `${JSON.stringify(action)}: ${result.reason}`);
  return result;
}

export function insert(f, inventoryIndex, stationIndex) {
  stationAction(f, { type: "click", area: "inventory", index: inventoryIndex, button: 0 });
  stationAction(f, { type: "click", area: "container", index: stationIndex, button: 0 });
  assert.equal(f.gameplay.cursor, null);
}

/** Supplied physical stand and safe work platform, not Survival-from-zero. */
export async function authoredBench(f) {
  // Isolate the supplied workshop from the still-live native encounter. This
  // authors travel, not a mob removal: the ordinary Game distance rules cull
  // distant legacy mobs on their next frame.
  const x = Math.floor(f.player.position.x) + 128, z = Math.floor(f.player.position.z);
  const y = Math.floor(f.player.position.y);
  f.world.clearStreaming();
  await f.world.ensureArea({ x, y, z }, 3);
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 3; dz++) {
      f.put(x + dx, y - 1, z + dz, BLOCK.STONE);
      for (let dy = 0; dy <= 3; dy++) f.put(x + dx, y + dy, z + dz, BLOCK.AIR);
    }
  }
  const at = { dimension: f.world.dimension, x, y, z };
  f.put(x, y, z, BLOCK.BREWING_STAND);
  f.player.setPosition({ x: x + 0.5, y, z: z + 2.5 });
  return at;
}

export function openBench(f, at) {
  f.aim({ x: at.x + 0.5, y: at.y, z: at.z + 0.5 }, 0.5);
  f.game.updateTarget();
  assert.equal(f.game.target?.id, BLOCK.BREWING_STAND);
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(f.progression.isOpen, true);
}

export async function closeBench(f) {
  assert.equal(f.progression.close("brewing-acquisition").ok, true);
  if (f.game.screenClose) await f.game.screenClose;
  await Promise.resolve();
  assert.equal(f.game.active, true);
}

/** Exactly 400 × 50 ms, split by a genuine paid-batch archive at tick 200. */
export async function brewBatch(t, f, at, ingredientId, output, fuel) {
  const initial = standRecord(f, at);
  const ingredientCount = initial.slots[3].count;
  assert.equal(initial.slots[3].id, ingredientId);
  f.frame(200);
  let record = standRecord(f, at);
  assert.equal(record.progressTicks, 200);
  assert.equal(record.tickRemainder, 0);
  assert.equal(record.fuelOperations, fuel);
  assert.equal(record.slots[4], null, "only one authored fuel item; no implicit refill");
  assert.equal(record.slots[3].count, ingredientCount, "ingredient pays at completion");
  f = await archiveReload(t, f, `${output}-tick-200`);
  f.frame(199);
  record = standRecord(f, at);
  assert.equal(record.progressTicks, 399);
  assert.notEqual(record.slots[0].data.potion.id, output);
  assert.equal(record.slots[3].count, ingredientCount);
  f.frame();
  record = standRecord(f, at);
  assert.equal(record.batch, null);
  assert.equal(record.progressTicks, 0);
  assert.equal(record.fuelOperations, fuel);
  assert.equal(record.slots[3]?.count ?? 0, ingredientCount - 1);
  assert.equal(record.slots[0].data.potion.id, output);
  assert.equal(record.slots[0].count, 1);
  assert.deepEqual(record.slots.slice(1, 3), [null, null]);
  const completed = structuredClone(record);
  f = await archiveReload(t, f, `${output}-completed`);
  f.frame(8);
  assert.deepEqual(standRecord(f, at), completed, "completed batch cannot repay or replay on reload");
  return f;
}
