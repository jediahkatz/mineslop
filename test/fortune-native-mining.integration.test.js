import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { supportContacts } from "../src/collision.js";
import { nextEnchantingSeed } from "../src/enchantment-domain.js";
import { ITEM } from "../src/items.js";
import { EYE_HEIGHT, PLAYER_WIDTH } from "../src/player.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { raycast, World } from "../src/world.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";

const SEARCH_RADIUS = 1;
const GAME_ADMISSION_RADIUS = 1;
const MAX_PUBLIC_RADIUS = 2;
const MAX_PUBLIC_COLUMNS = 25;
const REACH = 4.5;

function columnFootprint(position, radius) {
  const cx = Math.floor(position.x / 16), cz = Math.floor(position.z / 16);
  const columns = [];
  for (let dz = -radius; dz <= radius; dz++)
    for (let dx = -radius; dx <= radius; dx++)
      columns.push({ cx: cx + dx, cz: cz + dz, key: `${cx + dx},${cz + dz}`, distance: dx * dx + dz * dz });
  return columns.sort((a, b) => a.distance - b.distance || a.cz - b.cz || a.cx - b.cx);
}

function generationCounts(world) {
  return {
    chunks: world.generator.counters.chunkGenerations,
    regions: world.generator.counters.regionGenerations,
  };
}

function firstSupportedCoal(world, columns) {
  const allowed = new Set(columns.map(({ key }) => key));
  const initial = generationCounts(world);
  const offsets = [];
  // A cube face can be within reach even when its center is farther away.
  // Cell-center footprints fit the real player's width, including at chunk seams.
  const horizontalLimit = Math.ceil(REACH + 0.5);
  for (let dz = -horizontalLimit; dz <= horizontalLimit; dz++)
    for (let dx = -horizontalLimit; dx <= horizontalLimit; dx++) {
      const horizontalSquared = Math.max(0, Math.abs(dx) - 0.5) ** 2 +
        Math.max(0, Math.abs(dz) - 0.5) ** 2;
      if (horizontalSquared <= REACH * REACH)
        offsets.push({ dx, dz, horizontalSquared });
    }
  offsets.sort((a, b) => a.dx * a.dx + a.dz * a.dz - b.dx * b.dx - b.dz * b.dz ||
    a.dz - b.dz || a.dx - b.dx);
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let inspected = 0;
  for (const { cx, cz, key } of columns) {
    const chunk = world.chunks.get(key);
    assert.ok(chunk, `The declared search column ${key} must already be publicly admitted`);
    for (let i = 0; i < chunk.blocks.length; i++) {
      inspected++;
      if (chunk.blocks[i] !== BLOCK.COAL_ORE) continue;
      const at = {
        x: cx * 16 + i % 16,
        y: chunk.minY + Math.floor(i / 256),
        z: cz * 16 + Math.floor(i % 256 / 16),
      };
      assert.equal(world.getCell(at.x, at.y, at.z)?.id, BLOCK.COAL_ORE);
      if (!faces.some(([dx, dy, dz]) => {
        const neighbor = world.getCell(at.x + dx, at.y + dy, at.z + dz);
        return neighbor?.id === BLOCK.AIR && neighbor.fluid === 0;
      })) continue;
      for (const { dx, dz, horizontalSquared } of offsets) {
        const x = at.x + 0.5 + dx, z = at.z + 0.5 + dz;
        if (!allowed.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`)) continue;
        // Only actual support tops whose physical eyes could reach the ore's
        // cube are candidates. No terrain-height prediction or guessed dy list.
        const referenceY = at.y + 0.5 - EYE_HEIGHT;
        const verticalReach = 0.5 + Math.sqrt(REACH * REACH - horizontalSquared);
        const contacts = supportContacts(world, { x, y: referenceY, z }, {
          radius: PLAYER_WIDTH / 2, maxDrop: verticalReach, maxRise: verticalReach,
        });
        const heights = [...new Set(contacts.map(({ height }) => height))]
          .sort((a, b) => Math.abs(a - referenceY) - Math.abs(b - referenceY) || a - b);
        for (const height of heights) {
          const stand = { x, y: height, z };
          const safe = isSafeRespawnPosition(world, stand);
          if (!safe) continue;
          const eye = { ...stand, y: stand.y + EYE_HEIGHT };
          const vector = { x: at.x + 0.5 - eye.x, y: at.y + 0.5 - eye.y, z: at.z + 0.5 - eye.z };
          const length = Math.hypot(vector.x, vector.y, vector.z);
          const direction = Object.fromEntries(Object.entries(vector).map(([axis, n]) => [axis, n / length]));
          const hit = raycast(world, eye, direction, REACH);
          const accepted = hit?.id === BLOCK.COAL_ORE &&
            hit.x === at.x && hit.y === at.y && hit.z === at.z;
          if (!accepted) continue;
          const selected = { at, stand, inspected, supportHeight: height, hitDistance: hit.distance, column: key };
          assert.deepEqual(generationCounts(world), initial, "site selection only reads admitted terrain");
          return selected;
        }
      }
    }
  }
  assert.deepEqual(generationCounts(world), initial, "exhausting the finite search cannot generate terrain");
  assert.fail(`No supported physical coal ray in ${inspected} cells of the declared R1/${columns.length} footprint`);
}

test("native cave coal yields real Fortune pickups through normal mining and cold save restoration", async (t) => {
  const world = new World("cedar-valley", { generatorVersion: 4, useWorker: false });
  t.after(() => world.dispose());
  const spawn = world.getSpawn();
  const searchColumns = columnFootprint(spawn, SEARCH_RADIUS);
  await world.ensureArea(spawn, SEARCH_RADIUS);
  assert.equal(world.chunks.size, 9);
  const searchGeneration = generationCounts(world);
  assert.equal(searchGeneration.chunks, 9, "the search starts with exactly the original nine generated columns");
  // This new fixture no longer assumes a support top at one of twenty authored
  // offsets in the spawn chunk. All nine already-admitted columns are a finite,
  // central-first search; neither this selector nor the old fixtures load more.
  const selected = firstSupportedCoal(world, searchColumns);
  assert.ok(selected.inspected <= (world.spec.maxY - world.spec.minY) * 256 * searchColumns.length);
  assert.deepEqual(generationCounts(world), searchGeneration);
  assert.equal(world.edits.size, 0, "the qualifying coal and floor must be unedited native terrain");

  // Game's ordinary R1 stage around the selected approach may need additional
  // neighbors. Declare that exact footprint before admission and count it
  // separately from the nine-column search; its union stays inside spawn R2/25.
  const gameColumns = columnFootprint(selected.stand, GAME_ADMISSION_RADIUS);
  const declaredColumns = new Set([...searchColumns, ...gameColumns].map(({ key }) => key));
  const maximumColumns = new Set(columnFootprint(spawn, MAX_PUBLIC_RADIUS).map(({ key }) => key));
  assert.ok(declaredColumns.size <= MAX_PUBLIC_COLUMNS);
  assert.ok([...declaredColumns].every((key) => maximumColumns.has(key)));
  const extraColumns = gameColumns.filter(({ key }) => !world.chunks.has(key)).map(({ key }) => key);
  await world.ensureArea(selected.stand, GAME_ADMISSION_RADIUS);
  const publicAdmissionGeneration = generationCounts(world);
  // Only the finite held tool and starting cave approach are prerequisites.
  // No block edits, generator substitution, manual target or safety override.
  const f = await gameMobFixture(t, {
    world, generatorFactory: null, spawnPosition: selected.stand, activate: false,
    admissionRadius: GAME_ADMISSION_RADIUS,
  });
  const generation = generationCounts(world);
  assert.equal(publicAdmissionGeneration.chunks - searchGeneration.chunks, extraColumns.length);
  assert.equal(generation.chunks, publicAdmissionGeneration.chunks, "Game staging cannot admit undeclared cells");
  assert.ok(generation.chunks <= MAX_PUBLIC_COLUMNS);
  assert.ok([...world.chunks.keys()].every((key) => declaredColumns.has(key)));
  assert.equal(isSafeRespawnPosition(world, selected.stand), true);
  const stations = f.progression.services.stations;
  const randomState = 0x12345678;
  assert.equal(stations.load({ ...stations.serialize(), randomState }), true);
  f.activate();
  f.hold("DIAMOND_PICKAXE", {
    data: { version: 1, name: "Native prospector", enchantments: { fortune: 3 } },
  });
  f.frame(2);
  f.aim({ x: selected.at.x + 0.5, y: selected.at.y + 0.5, z: selected.at.z + 0.5 });
  f.game.updateTarget();
  assert.equal(f.player.grounded, true);
  assert.equal(f.game.target?.id, BLOCK.COAL_ORE);
  assert.deepEqual(
    { x: f.game.target.x, y: f.game.target.y, z: f.game.target.z }, selected.at);
  const held = f.gameplay.getHandStack();
  let updates = 0;
  while (world.get(selected.at.x, selected.at.y, selected.at.z) !== BLOCK.AIR && updates++ < 32)
    f.game.primary(0.05);
  assert.ok(updates <= 32);
  assert.equal(world.get(selected.at.x, selected.at.y, selected.at.z), BLOCK.AIR);
  assert.equal(f.gameplay.getHandStack().durability, held.durability - 1);
  assert.equal(stations.randomState, nextEnchantingSeed(nextEnchantingSeed(randomState)));
  assert.deepEqual(generationCounts(world), generation, "the interaction cannot generate more terrain");
  const archived = f.snapshot();
  const indexedDB = new IDBFactory();
  const writer = new WorldStorage({ indexedDB });
  t.after(() => writer.close());
  await writer.save(archived);
  await writer.close();
  const reader = new WorldStorage({ indexedDB });
  t.after(() => reader.close());
  const saved = parseWorldFile(exportWorldFile(await reader.load()));
  assert.deepEqual(saved, archived, "reopened chunk storage and file export/import retain every owner");
  const coal = saved.pickups.items.filter(({ id }) => id === ITEM.COAL)
    .reduce((sum, item) => sum + item.count, 0);
  assert.equal(coal, 2);
  const restored = await gameMobFixture(t, { saved, generatorFactory: null });
  assert.deepEqual(restored.world.serialize(), saved.world);
  assert.deepEqual(restored.gameplay.serialize(), saved.gameplay);
  assert.deepEqual(restored.game.pickups.serialize(), saved.pickups);
  assert.deepEqual(restored.progression.serialize(), f.progression.serialize());
  t.diagnostic(JSON.stringify({
    native: true, seed: world.seed, generatorVersion: world.generatorVersion,
    selected: selected.at, standing: selected.stand, supportHeight: selected.supportHeight,
    physicalRayDistance: selected.hitDistance, inspected: selected.inspected,
    searchRadius: SEARCH_RADIUS, searchGeneratedChunks: searchGeneration.chunks,
    gameAdmissionRadius: GAME_ADMISSION_RADIUS, extraColumns,
    declaredColumnCount: declaredColumns.size, maximumPublicColumns: MAX_PUBLIC_COLUMNS,
    generatedChunks: generation.chunks, primaryUpdates: updates, coal,
    wear: 1, savedRng: stations.randomState, indexedDbReopened: true, coldArchiveRestored: true,
  }));
});
