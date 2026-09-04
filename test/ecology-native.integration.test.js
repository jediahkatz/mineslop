import assert from "node:assert/strict";
import test from "node:test";
import {
  admitEcologySpawn, ecologyBodySample, ecologyCanOccupy, ecologyDistance,
  ecologyWaterColumn,
} from "../src/aquatic-ai.js";
import { BLOCK } from "../src/blocks.js";
import { ECOLOGY_HOST_LIMITS } from "../src/ecology-population.js";
import { ecologyCollider } from "../src/expansion-ecology.js";
import { ITEM } from "../src/items.js";
import { describeStructure, locateStructure } from "../src/structure-catalog.js";
import { structurePoint } from "../src/structure-layouts.js";
import { World } from "../src/world.js";
import { ecologyHostFixture, ecologyTotals } from "./ecology-host-fixture.js";
import { findNaturalColumn } from "./terrain-v4-helpers.js";

// Real native-v4 World admissions, not authored/edited habitat fields. Discovery
// chooses the FIRST matching natural site and then checks its actual cells.
// No retry after bad geometry, fake generator, forced descriptor or skip-on-miss.
// Structure search: <=3 seeds * 4 windows * 625 owner cells / 12,288 samples.
// Habitat search: <=9,409 coarse columns, <=8 extra neighbors per beach candidate.
// Each selected case admits <=16 real chunks; active runtime must generate NONE.
// Drowned light is covered by explicit authored controls in the owner suite.
// These native cases leave readHabitat unset: missing light must not imply dark.
const SEEDS = ["cedar-valley", "tidal-archive", "basalt-crossing"];
const ORIGINS = [
  { x: -4096, z: -4096 }, { x: 0, z: 0 },
  { x: 6144, z: 4096 }, { x: -6144, z: 6144 },
];
const SEARCH = { radius: 12, maxCells: 625, maxSamples: 12288 };
const feet = (point) => ({ x: point.x + 0.5, y: point.y, z: point.z + 0.5 });

function nativeWorld(t, seed = SEEDS[0], dimension = "overworld") {
  const world = new World(seed, { dimension, generatorVersion: 4, useWorker: false });
  t.after(() => world.dispose());
  return world;
}

async function loadArea(world, area) {
  const minCX = Math.floor(area.minX / 16), maxCX = Math.floor((area.maxX - 1) / 16);
  const minCZ = Math.floor(area.minZ / 16), maxCZ = Math.floor((area.maxZ - 1) / 16);
  assert.ok((maxCX - minCX + 1) * (maxCZ - minCZ + 1) <= 16);
  const before = world.generator.counters.chunkGenerations;
  const columns = [];
  for (let cz = minCZ; cz <= maxCZ; cz++)
    for (let cx = minCX; cx <= maxCX; cx++) columns.push({ cx, cz });
  const centerCX = Math.floor((minCX + maxCX) / 2);
  const centerCZ = Math.floor((minCZ + maxCZ) / 2);
  // Request precisely the selected rectangle, with normal admission pins.
  // The last request leaves retention centered on it, not on the origin or
  // its far corner. No extra chunks or private World safety overrides.
  columns.sort((a, b) =>
    Math.max(Math.abs(b.cx - centerCX), Math.abs(b.cz - centerCZ)) -
    Math.max(Math.abs(a.cx - centerCX), Math.abs(a.cz - centerCZ)));
  await Promise.all(columns.map(({ cx, cz }) =>
    world.ensureArea({ x: cx * 16 + 8, z: cz * 16 + 8 }, 0)));
  assert.equal(world.generator.counters.chunkGenerations - before,
    (maxCX - minCX + 1) * (maxCZ - minCZ + 1));
  assert.equal(world.chunks.size, (maxCX - minCX + 1) * (maxCZ - minCZ + 1));
  assert.equal(world.removedChunks.size, 0, "all selected native columns remain resident");
  assert.equal(world._pins.size, 0, "staging releases its admission pins");
  assert.ok([...world.chunks.values()].every((chunk) => chunk.blocks instanceof Uint16Array &&
    Number.isSafeInteger(chunk.incarnation) && chunk.minY === world.spec.minY));
}

async function loadPoints(world, points) {
  await loadArea(world, {
    minX: Math.floor(Math.min(...points.map((p) => p.x))) - 2,
    maxX: Math.floor(Math.max(...points.map((p) => p.x))) + 3,
    minZ: Math.floor(Math.min(...points.map((p) => p.z))) - 2,
    maxZ: Math.floor(Math.max(...points.map((p) => p.z))) + 3,
  });
}

async function discover(t, kind, dimension) {
  const attempts = [];
  for (const seed of SEEDS) {
    const world = nativeWorld(t, seed, dimension), generator = world.generator;
    const context = { seed, dimension, spec: generator.spec, sampleColumn: generator.sampleColumn };
    for (const from of ORIGINS) {
      const before = generator.counters;
      const located = locateStructure(kind, context, from, SEARCH);
      assert.ok(located.examinedCells <= SEARCH.maxCells);
      assert.ok(located.sampledColumns <= SEARCH.maxSamples);
      assert.equal(generator.counters.chunkGenerations, before.chunkGenerations);
      assert.equal(generator.counters.regionGenerations, before.regionGenerations);
      attempts.push({ seed, from, cells: located.examinedCells, samples: located.sampledColumns });
      if (!located.target) continue;
      const described = describeStructure(kind, context, located.target.gx, located.target.gz);
      assert.ok(described);
      assert.equal(described.id, located.target.id);
      const b = described.bounds;
      await loadArea(world, { minX: b.minX - 2, maxX: b.maxX + 2, minZ: b.minZ - 2, maxZ: b.maxZ + 2 });
      // Use the actual transported/admitted descriptor, not the discovery object.
      const descriptor = [...world.chunks.values()]
        .flatMap((chunk) => chunk.structures ?? []).find((entry) => entry.id === described.id);
      assert.ok(descriptor, "native admission must supply the canonical structure metadata");
      assert.deepEqual(descriptor.markers, described.markers);
      t.diagnostic(JSON.stringify({ nativeEcology: kind, seed, id: descriptor.id,
        admittedChunks: world.chunks.size, attempts }));
      return { world, descriptor };
    }
    world.dispose();
  }
  assert.fail(`No native ${kind} in the fixed discovery budget: ${JSON.stringify(attempts)}`);
}

function nativeHost(t, world, descriptor) {
  const f = ecologyHostFixture(t, { world, hooks: { readHabitat: undefined } });
  if (descriptor) f.markerIndex.add(descriptor);
  t.mock.method(world, "getBiome", () => assert.fail("live ecology must read admitted biome bytes"));
  t.mock.method(world, "surfaceYAt", () => assert.fail("live ecology must not scan/generate a surface"));
  return f;
}

test("native ocean cells admit a naturally scheduled dolphin without a generated-height or raw-WATER shortcut", async (t) => {
  const world = nativeWorld(t), generator = world.generator;
  const column = findNaturalColumn(generator, (col) =>
    /(^|_)ocean$/.test(col.id) && !col.frozen && !/frozen/.test(col.id) &&
    col.waterLevel !== null && col.waterLevel - col.top >= 8,
  "deep non-frozen dolphin habitat");
  const at = { x: column.x + 0.5, y: world.spec.seaLevel - 3, z: column.z + 0.5 };
  const player = { ...at, z: at.z - 26 }; // Natural scheduler's first candidate, not a forced spawn.
  await loadPoints(world, [at, player]);
  const f = nativeHost(t, world);
  f.player.position = player;
  const before = generator.counters, edits = world.serialize();
  assert.equal(f.host.habitat(at).biomeId, column.id);
  const work = f.host.populate();
  assert.ok(work.admitted > 0 && work.admitted <= ECOLOGY_HOST_LIMITS.admissions);
  const dolphin = f.wildlife.entities.find((mob) => mob.kind === "dolphin" &&
    ecologyDistance(mob.position, at) < 0.01);
  assert.ok(dolphin, "the first real ocean candidate must pass its actual collider and fluid volume");
  assert.equal(f.wildlife.entities.some((mob) => mob.kind === "drowned"), false,
    "missing actual local light never fabricates a dark spawn");
  f.tick(2);
  assert.ok(f.wildlife.mesh.count > 0);
  assert.equal(f.host.ecology.state(dolphin.id).alive, true);
  assert.deepEqual(generator.counters, before);
  assert.deepEqual(world.serialize(), edits);
});

test("native beach sand admits the scheduled turtle using full-footprint dry support", async (t) => {
  const world = nativeWorld(t), generator = world.generator;
  const column = findNaturalColumn(generator, (col) => {
    if (col.id !== "beach" || col.waterLevel !== null || col.top < 60 || col.top > 68) return false;
    for (const dz of [-1, 0, 1])
      for (const dx of [-1, 0, 1]) {
        if (dx === 0 && dz === 0) continue;
        const neighbor = generator.sampleColumn(col.x + dx, col.z + dz);
        if (neighbor.id !== "beach" || neighbor.top !== col.top || neighbor.waterLevel !== null) return false;
      }
    return true;
  }, "flat native beach");
  const at = { x: column.x + 0.5, y: column.top + 1, z: column.z + 0.5 };
  const player = { x: at.x - Math.sin(2.399963229728653) * 33, y: at.y,
    z: at.z - Math.cos(2.399963229728653) * 33 };
  await loadPoints(world, [at, player]);
  const f = nativeHost(t, world);
  f.player.position = player;
  f.player.swimming = false;
  const before = generator.counters;
  const work = f.host.populate();
  assert.ok(work.admitted > 0 && work.admitted <= ECOLOGY_HOST_LIMITS.admissions);
  const turtle = f.wildlife.entities.find((mob) => mob.kind === "turtle" &&
    ecologyDistance(mob.position, at) < 0.01);
  assert.ok(turtle, "the actual native sand must support the entire adult turtle");
  assert.equal(world.get(Math.floor(at.x), at.y - 1, Math.floor(at.z)), BLOCK.SAND);
  assert.deepEqual(f.host.ecology.state(turtle.id).homeBeach, at);
  assert.deepEqual(generator.counters, before);
});

test("native monument markers admit exactly three distinct elders and ordinary region-bound guardians", async (t) => {
  const { world, descriptor } = await discover(t, "ocean_monument", "overworld");
  const f = nativeHost(t, world, descriptor);
  f.player.position = feet(descriptor.entries[0]);
  const before = world.generator.counters, edits = world.serialize();
  const admission = f.host.populate();
  const elders = f.wildlife.entities.filter((mob) => mob.kind === "elder_guardian");
  const markers = descriptor.markers.filter((marker) => marker.entity === "elder_guardian");
  const crown = markers.find((marker) => marker.key === "elder_crown");
  const collider = ecologyCollider("elder_guardian"), position = feet(crown.position);
  const lantern = structurePoint(descriptor, 0, 11, -10);
  assert.equal(world.get(lantern.x, lantern.y, lantern.z), BLOCK.SEA_LANTERN);
  assert.equal(ecologyCanOccupy(world, position, collider), true);
  assert.equal(ecologyBodySample(world, position, collider).waterImmersion, 1);
  assert.equal(ecologyWaterColumn(world, position, collider, 3), false,
    "the native overhead lantern intersects the inflated query, not the elder");
  assert.equal(ecologyWaterColumn(world, position, { ...collider, radius: 0.5 }, 3), true,
    "the real marker column still meets the unchanged three-block depth requirement");
  assert.equal(admitEcologySpawn("elder_guardian", position, collider, {
    world, structure: descriptor, marker: crown,
  }), true);
  assert.equal(admission.admitted, 3);
  assert.equal(elders.length, 3);
  t.diagnostic(JSON.stringify({ nativeElders: elders.length, crown: position,
    bodyImmersion: ecologyBodySample(world, position, collider).waterImmersion,
    columnImmersion: ecologyBodySample(world, position, { ...collider, radius: 0.5, height: 3 }).waterImmersion }));
  assert.deepEqual(new Set(elders.map((mob) => f.host.ecology.state(mob.id).markerId)),
    new Set(markers.map((marker) => marker.id)));
  for (const marker of markers) {
    const entityId = f.host.ecology.entityIdForMarker(marker.id);
    assert.ok(entityId && entityId !== marker.id && entityId.length <= 100);
    assert.equal(f.host.prepareAdmission("elder_guardian", feet(marker.position),
      { structure: descriptor, marker }), null);
  }
  assert.ok(f.host.populate().admitted > 0);
  const guardian = f.wildlife.entities.find((mob) => mob.kind === "guardian");
  assert.ok(guardian);
  assert.equal(f.host.ecology.state(guardian.id).structureId, descriptor.id);
  f.tick();
  assert.equal(f.wildlife.entities.filter((mob) => mob.kind === "elder_guardian").length, 3);
  assert.ok(f.wildlife.mesh.count > 0);
  assert.deepEqual(world.generator.counters, before);
  assert.deepEqual(world.serialize(), edits);
});

test("native village residents keep canonical home/jobsite IDs and reach a real librarian work site", async (t) => {
  const { world, descriptor } = await discover(t, "village", "overworld");
  const f = nativeHost(t, world, descriptor);
  f.player.position = feet(descriptor.entries[0]);
  f.player.swimming = false;
  const before = world.generator.counters, edits = world.serialize();
  f.host.populate();
  f.host.populate();
  const members = descriptor.markers.filter((marker) => marker.type === "member");
  assert.equal(members.length, 4);
  assert.equal(f.wildlife.entities.filter((mob) => mob.kind === "villager").length, 4);
  const member = members.find((entry) => entry.profession === "librarian");
  const entityId = f.host.ecology.entityIdForMarker(member.id);
  const mob = f.wildlife.byId.get(entityId);
  assert.ok(mob);
  assert.equal(f.trading.get(entityId), null, "NPC admission never rolls trade stock");
  f.tick(50);
  const site = descriptor.markers.find((marker) => marker.id === member.jobSiteId);
  const jobsite = { id: site.id, kind: site.block, dimension: site.dimension, position: site.position };
  assert.equal(world.get(site.position.x, site.position.y, site.position.z), BLOCK[site.block]);
  assert.equal(f.host.assignment(entityId).home.id, member.homeId);
  assert.equal(f.host.jobsiteUsable(entityId, jobsite), true);
  assert.equal(mob.npcIntent, "work");
  const plan = f.trading.prepareRegister({ id: entityId, profession: "librarian", jobsite }, {
    clock: { day: 0, time: 2000 }, validate: () => f.host.ecology.state(entityId)?.alive === true,
    readAvailability: (id) => f.host.readAvailability(id, { interaction: false }),
    jobsiteUsable: (id, value) => f.host.jobsiteUsable(id, value),
  });
  assert.ok(plan);
  assert.equal(f.trading.commit(plan).ok, true);
  assert.ok(f.trading.offers(entityId).length > 0);
  const stock = f.trading.serialize();
  f.tick(2);
  assert.deepEqual(f.trading.serialize(), stock);
  assert.deepEqual(world.generator.counters, before);
  assert.deepEqual(world.serialize(), edits);
});

test("native fortress spawner produces a real blaze whose player-credited death retains brewing input and XP", async (t) => {
  const { world, descriptor } = await discover(t, "nether_fortress", "nether");
  const f = nativeHost(t, world, descriptor);
  const marker = descriptor.markers.find((entry) => entry.entity === "blaze");
  f.player.position = feet(structurePoint(descriptor, 13, 4, 2));
  f.player.swimming = false;
  const before = world.generator.counters;
  assert.equal(world.get(marker.position.x, marker.position.y, marker.position.z), BLOCK.SPAWNER);
  assert.ok(f.host.populate().admitted > 0);
  const blaze = f.wildlife.entities.find((mob) => mob.kind === "blaze");
  assert.ok(blaze && ecologyCanOccupy(world, blaze.position, ecologyCollider("blaze")));
  assert.equal(f.host.ecology.state(blaze.id).structureId, descriptor.id);
  f.hold("IRON_SWORD", { durability: 8 });
  const cost = f.gameplay.prepareHandCost("main", {
    stack: f.gameplay.getHandStack(), handRevision: f.gameplay.getHandRevision("main"), wear: 1,
  });
  // Scripted owner-level lethal input; not a replacement for Game's verified
  // physical range/cooldown/input assertions or a claim of a played boss fight.
  const death = f.host.prepareHit(blaze.id, 1000, null, {
    playerKill: true, validate: () => true, participants: [cost],
  });
  assert.ok(death);
  assert.equal(f.host.commit(death).ok, true);
  assert.equal(f.gameplay.getHandStack().durability, 7);
  assert.deepEqual(ecologyTotals(f), { drops: { [ITEM.BLAZE_ROD]: 1 }, xp: 10 });
  assert.equal(f.wildlife.byId.has(blaze.id), false);
  f.put(marker.position.x, marker.position.y, marker.position.z, BLOCK.AIR);
  assert.equal(f.host.populate().admitted, 0, "an edited-away native spawner cannot generate another blaze");
  assert.deepEqual(world.generator.counters, before);
});
