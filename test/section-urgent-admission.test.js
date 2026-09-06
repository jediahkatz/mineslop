import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { meshRevisionCurrent, MESH_APRON } from "../src/mesh-snapshot.js";
import { clearSectionJobs, detailMeshResources, REGIONAL_MESH_LIMITS } from "../src/section-renderer.js";
import { World } from "../src/world.js";
import { createWorldContext } from "../src/world-spec.js";
import { authoredColumns, shapeRenderer, disposeShapeRenderer } from "./shape-fixture.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";
import { controlFixture } from "./control-fixture.js";

const nearKey = "0,0,0";
function until(renderer, done, limit = 200) {
  let calls = 0;
  while (!done() && calls < limit) { renderer.rebuildDirty(1); calls++; }
  assert.ok(done(), `work did not finish within ${limit} calls`);
  return calls;
}
function fixture(t) {
  let clock = 0, charge = () => 0;
  t.mock.method(performance, "now", () => clock);
  const world = authoredColumns([[0, 0]], [[8, 8, 8, BLOCK.STONE]]);
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(8, 8, 12);
  renderer.camera.lookAt(8, 8, 8);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); });
  until(renderer, () => world.dirtySectionRevisions.size === 0);
  const get = world.dirtySectionRevisions.get.bind(world.dirtySectionRevisions);
  t.mock.method(world.dirtySectionRevisions, "get", (key) => { clock += charge(key); return get(key); });
  return { world, renderer, charge: (fn) => { charge = fn; } };
}
function physical(renderer) {
  const column = renderer.chunks.get("0,0"), section = column.userData.sections.get(0);
  const source = section.group.children.find((mesh) => mesh.userData.sectionSource);
  const range = column.userData.sectionRanges.get(source), page = range.mesh.geometry, xyz = [];
  assert.equal(range.mesh.parent, column.userData.sectionRegion);
  for (let i = range.start; i < range.start + range.count; i++) {
    const v = page.index.array[i], p = page.attributes.position, origin = range.mesh.parent.position;
    xyz.push(p.getX(v) + origin.x, p.getY(v) + origin.y, p.getZ(v) + origin.z);
  }
  return { ticket: section.stamp.ticket, indices: range.count,
    maxX: Math.max(...xyz.filter((_, i) => i % 3 === 0)),
    hash: createHash("sha256").update(new Float32Array(xyz)).digest("hex"),
    fresh: !renderer.world.dirtySectionRevisions.has(nearKey) &&
      meshRevisionCurrent(renderer.world, { ...section.stamp, ticket: undefined }) };
}

test("paid near placement becomes physically fresh before the 4032-section far cohort drains", (t) => {
  const world = new World("urgent-paid-edit", { generatorVersion: 4, useWorker: false,
    generatorFactory(seed, dimension, version) {
      const generator = emptyFixtureGenerator(seed, dimension, version), generate = generator.generateChunk;
      generator.generateChunk = (cx, cz) => {
        const packet = generate(cx, cz);
        packet.blocks[(8 - packet.minY) * 256 + 8 * 16 + 8] = BLOCK.STONE;
        return packet;
      };
      return generator;
    },
  });
  world.generate(0);
  const renderer = shapeRenderer(world);
  renderer.camera.position.set(8, 8, 12);
  renderer.camera.lookAt(8, 8, 8);
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  const gameplay = new Gameplay({ mode: "survival", context: createWorldContext(world), coordinator: world.coordinator });
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); gameplay.dispose(); world.dispose(); });
  until(renderer, () => world.dirtySectionRevisions.size === 0);
  const before = physical(renderer);
  world.generate(6);
  assert.equal(world.chunks.size, 169);
  assert.equal(gameplay.add(BLOCK.STONE, 2), true);
  assert.equal(gameplay.assignSlot(0, BLOCK.STONE), true);
  gameplay.select(0);
  const stack = gameplay.getHandStack("main");
  const cost = gameplay.prepareHandCost("main", {
    stack, handRevision: gameplay.getHandRevision("main"), count: 1, notify: false,
  });
  const mutation = world.prepareMutation([{ x: 9, y: 8, z: 8,
    before: world.getCell(9, 8, 8), after: { id: BLOCK.STONE, state: 0, fluid: 0 } }]);
  assert.ok(cost && mutation);
  assert.equal(world.coordinator.commit([mutation, cost]).ok, true);
  const ticket = world.dirtySectionRevisions.get(nearKey), started = performance.now();
  assert.equal(gameplay.getHandStack("main").count, 1);
  assert.equal(world.get(9, 8, 8), BLOCK.STONE);
  assert.equal(physical(renderer).hash, before.hash);
  let calls = 0;
  while (world.dirtySectionRevisions.has(nearKey) && calls < 64 && performance.now() - started < 10000) {
    renderer.rebuildDirty(2);
    calls++;
  }
  const after = physical(renderer);
  assert.equal(after.fresh, true);
  assert.equal(after.ticket, ticket);
  assert.equal(before.indices, 36);
  assert.equal(after.indices, 60);
  assert.equal(after.maxX, 10);
  assert.notEqual(after.hash, before.hash);
  assert.ok(renderer.meshStats.sections < 100, "the far cohort did not have to drain");
  assert.ok(world.dirtySectionRevisions.size > 3900);
  assert.equal(renderer.meshStats.limits.maxSliceMs, 8);
  assert.equal(renderer.meshStats.limits.maxJobs, 1);
  assert.equal(renderer.meshStats.limits.maxGpuBytes, REGIONAL_MESH_LIMITS.maxGpuBytes);
  assert.equal(renderer.meshStats.budgetRejections, 0);
  t.diagnostic(JSON.stringify({ calls, elapsedMs: performance.now() - started, ticket,
    before, after, remainingDirty: world.dirtySectionRevisions.size, installedSections: renderer.meshStats.sections,
    limitations: "Authored CPU fixture, real transaction and physical regional geometry; not GPU/FPS/native acceptance." }));
});

for (const maxJobs of [1, 2]) test(`repeated near edits and new coverage both progress with maxJobs=${maxJobs}`, (t) => {
  const { world, renderer } = fixture(t);
  renderer.meshLimits.maxJobs = maxJobs;
  world.admit(4, 0);
  world.admit(5, 0);
  world.put(9, 8, 8, BLOCK.STONE);
  const begin = world.acknowledgments.length, fairness = renderer.sectionAdmissionFairness;
  let edits = 1;
  for (let i = 0; i < 40; i++) {
    // Rebuilding the view lattice cannot renew the urgent allowance.
    renderer.camera.rotation.y = i % 2 ? 0.4 : 0;
    renderer.rebuildDirty(1);
    if (!world.dirtySectionRevisions.has(nearKey)) {
      world.put(9, 8, 8, edits++ % 2 ? BLOCK.AIR : BLOCK.STONE);
    }
    assert.equal(renderer.sectionAdmissionFairness, fairness);
  }
  const acknowledgments = world.acknowledgments.slice(begin);
  const near = acknowledgments.filter((a) => `${a.cx},${a.cz},${a.sy}` === nearKey);
  const far = acknowledgments.filter((a) => a.cx >= 4);
  assert.ok(near.length >= 8 && far.length >= 8, JSON.stringify({ near: near.length, far: far.length }));
  if (maxJobs === 1) {
    for (let i = 1; i < acknowledgments.length; i++)
      assert.notEqual(acknowledgments[i].cx === 0, acknowledgments[i - 1].cx === 0);
  }
});

test("urgent references are at most 27 live slots and track section-boundary camera moves", (t) => {
  const { world, renderer } = fixture(t);
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++)
    if (x || z) world.admit(x, z);
  // These maxima match Game.updateTarget / Player._syncCamera. Even adding
  // the mesher's neighbor apron is less than one section in every axis.
  assert.ok(5 + 4 + 1 + MESH_APRON + 0.025 < 16);
  for (const at of [0.001, 15.999, 16.001, -0.001]) {
    renderer.camera.position.set(at, at, at);
    renderer.rebuildDirty(0);
    const layout = renderer.sectionQueueLayout, s = Math.floor(at / 16);
    assert.equal(layout.urgentSlots.length, 27);
    for (const slot of layout.urgentSlots) {
      assert.ok(layout.slots.includes(slot));
      assert.ok(Math.abs(slot.cx - s) <= 1 && Math.abs(slot.cz - s) <= 1 && Math.abs(slot.sy - s) <= 1);
    }
  }
});

test("actual first/back/front Player cameras keep reachable placements and aprons in the urgent neighborhood", (t) => {
  const { player, camera } = controlFixture(t);
  const columns = [];
  for (let z = -3; z <= 3; z++) for (let x = -3; x <= 3; x++) columns.push([x, z]);
  const renderer = shapeRenderer(authoredColumns(columns));
  renderer.renderDistanceOverride = 12;
  renderer.meshLimits = { regionalPages: true };
  t.after(() => { clearSectionJobs(renderer); disposeShapeRenderer(renderer); });
  for (const perspective of ["first", "back", "front"])
    for (const at of [0.001, 15.999, -0.001])
      for (const pitch of [-1, 0, 1]) {
        player.setPosition({ x: at, y: 31.5, z: at });
        player.perspective = perspective;
        player.pitch = pitch;
        player.yaw = Math.PI / 4;
        player._bob = 0.025;
        player._syncCamera(0);
        assert.equal(player.perspective, perspective);
        renderer.camera.position.copy(camera.position);
        renderer.rebuildDirty(0);
        const keys = new Set(renderer.sectionQueueLayout.urgentSlots.map((slot) => slot.key));
        const target = player.eyePosition.clone().addScaledVector(player.forward, 5);
        // One adjacent placement cell and the complete shape apron.
        for (const dx of [-3, 3]) for (const dy of [-3, 3]) for (const dz of [-3, 3]) {
          const x = Math.floor((Math.floor(target.x) + dx) / 16);
          const y = Math.floor((Math.floor(target.y) + dy) / 16);
          const z = Math.floor((Math.floor(target.z) + dz) / 16);
          assert.ok(keys.has(`${x},${z},${y}`), `${perspective} ${at} ${pitch}: ${x},${z},${y}`);
        }
      }
});

test("deadline-retained urgent work rereads its ticket and spends no turn until admission", (t) => {
  const f = fixture(t), { world, renderer } = f;
  world.admit(4, 0);
  world.put(9, 8, 8, BLOCK.STONE);
  const old = world.dirtySectionRevisions.get(nearKey);
  f.charge((key) => key === nearKey ? 9 : 0);
  assert.equal(renderer.rebuildDirty(1), 0);
  assert.equal(renderer.sectionQueueLayout.candidate.key, nearKey);
  assert.equal(renderer.sectionQueueLayout.candidate.urgentAdmission, true);
  assert.equal(renderer.sectionJobs.size, 0);
  assert.equal(renderer.sectionAdmissionFairness.urgentNext, true);
  world.put(10, 8, 8, BLOCK.STONE);
  const latest = world.dirtySectionRevisions.get(nearKey);
  f.charge(() => 0);
  until(renderer, () => !world.dirtySectionRevisions.has(nearKey));
  assert.ok(!world.acknowledgments.some((ack) => ack.ticket === old));
  assert.equal(physical(renderer).ticket, latest);
  assert.equal(physical(renderer).fresh, true);
  assert.equal(renderer.sectionAdmissionFairness.urgentNext, false);
});

test("a retained normal candidate keeps liveness when an urgent edit arrives", (t) => {
  const f = fixture(t), { renderer, world } = f;
  world.admit(4, 0);
  f.charge((key) => key.startsWith("4,0,") ? 9 : 0);
  assert.equal(renderer.rebuildDirty(1), 0);
  const retained = renderer.sectionQueueLayout.candidate.key;
  assert.ok(retained.startsWith("4,0,"));
  world.put(9, 8, 8, BLOCK.STONE);
  f.charge(() => 0);
  const begin = world.acknowledgments.length;
  until(renderer, () => !world.dirtySectionRevisions.has(nearKey));
  assert.equal(world.acknowledgments[begin].cx, 4);
  assert.ok(world.acknowledgments.slice(begin).some((a) => `${a.cx},${a.cz},${a.sy}` === nearKey));
});

test("retained jobs advance first and a cancelled urgent job cannot acknowledge a newer edit", (t) => {
  const { world, renderer } = fixture(t);
  world.admit(4, 0);
  for (let sy = -4; sy < 20; sy++) world.put(72, sy * 16 + 8, 8, BLOCK.STONE);
  renderer.sectionMeshLimits = { maxCellsPerSlice: 32 };
  renderer.rebuildDirty(1);
  const retained = [...renderer.sectionJobs.values()][0];
  assert.ok(retained && !retained.done);
  const cursor = retained.mesher.cursor;
  world.put(9, 8, 8, BLOCK.STONE);
  renderer.rebuildDirty(1);
  assert.ok(retained.mesher.cursor > cursor);
  assert.equal(renderer.sectionJobs.has(nearKey), false);
  until(renderer, () => renderer.sectionJobs.has(nearKey));
  const urgent = renderer.sectionJobs.get(nearKey), old = urgent.stamp.ticket;
  const dispose = t.mock.method(urgent, "dispose");
  world.put(10, 8, 8, BLOCK.STONE);
  const latest = world.dirtySectionRevisions.get(nearKey);
  renderer.rebuildDirty(1);
  assert.equal(dispose.mock.callCount(), 1);
  until(renderer, () => !world.dirtySectionRevisions.has(nearKey));
  assert.ok(!world.acknowledgments.some((a) => a.ticket === old));
  assert.equal(physical(renderer).ticket, latest);
  assert.equal(physical(renderer).fresh, true);
});

test("urgent reservation refusal does not spend the turn or block empty coverage, and retries after relief", (t) => {
  const { renderer, world } = fixture(t);
  world.admit(4, 0);
  world.put(9, 8, 8, BLOCK.STONE);
  const ticket = world.dirtySectionRevisions.get(nearKey), before = physical(renderer);
  // Leave room for empty publication / existing-page headroom, but not the
  // nonempty job's mandatory 384 KiB snapshot reservation.
  renderer.meshLimits.maxCpuBytes = detailMeshResources(renderer).combinedCpuBytes + 64 * 1024;
  renderer.rebuildDirty(1);
  assert.ok(renderer.sectionRejections.has(nearKey));
  assert.equal(world.dirtySectionRevisions.get(nearKey), ticket);
  assert.equal(physical(renderer).hash, before.hash);
  assert.equal(renderer.sectionAdmissionFairness.urgentNext, true);
  assert.ok(world.acknowledgments.some((a) => a.cx === 4),
    JSON.stringify({ blocked: renderer.meshStats.blocked, resources: detailMeshResources(renderer) }));
  delete renderer.meshLimits.maxCpuBytes;
  until(renderer, () => !world.dirtySectionRevisions.has(nearKey));
  assert.equal(physical(renderer).ticket, ticket);
  assert.equal(physical(renderer).fresh, true);
});

test("urgent cancellation and source ABA cannot acknowledge the old ticket", (t) => {
  const f = fixture(t), { renderer, world } = f;
  world.put(9, 8, 8, BLOCK.STONE);
  f.charge((key) => key === nearKey ? 9 : 0);
  renderer.rebuildDirty(1);
  const old = renderer.sectionQueueLayout.candidate, ticket = old.ticket;
  const incarnation = world.chunks.get("0,0").incarnation;
  world.chunks.delete("0,0");
  world.removedChunks.add("0,0");
  world.admit(0, 0);
  world.put(10, 8, 8, BLOCK.STONE);
  f.charge(() => 0);
  until(renderer, () => !world.dirtySectionRevisions.has(nearKey));
  assert.notEqual(world.chunks.get("0,0").incarnation, incarnation);
  assert.ok(!world.acknowledgments.some((a) => a.ticket === ticket));
  assert.equal(physical(renderer).fresh, true);
});

test("reentrant publication edits retain the newer ticket while both lanes keep progressing", (t) => {
  const { renderer, world } = fixture(t);
  world.admit(4, 0);
  world.put(9, 8, 8, BLOCK.STONE);
  const old = world.dirtySectionRevisions.get(nearKey);
  const acknowledge = world.acknowledgeSectionMesh;
  let latest;
  t.mock.method(world, "acknowledgeSectionMesh", function (cx, cz, sy, ticket) {
    if (ticket === old) {
      world.put(10, 8, 8, BLOCK.STONE);
      latest = world.dirtySectionRevisions.get(nearKey);
    }
    return acknowledge.call(this, cx, cz, sy, ticket);
  });
  until(renderer, () => latest !== undefined && !world.dirtySectionRevisions.has(nearKey));
  assert.ok(!world.acknowledgments.some((a) => a.ticket === old));
  assert.ok(world.acknowledgments.some((a) => a.cx === 4));
  assert.equal(physical(renderer).ticket, latest);
  assert.equal(physical(renderer).fresh, true);
});

test("view changes discard urgent candidates; world switches reset credit and leave old tickets pending", (t) => {
  const f = fixture(t), { renderer, world } = f;
  world.admit(4, 0);
  world.put(9, 8, 8, BLOCK.STONE);
  f.charge((key) => key === nearKey ? 9 : 0);
  renderer.rebuildDirty(1);
  const layout = renderer.sectionQueueLayout, old = world.dirtySectionRevisions.get(nearKey);
  f.charge(() => 0);
  renderer.camera.position.set(72, 8, 12);
  renderer.rebuildDirty(1);
  assert.notEqual(renderer.sectionQueueLayout, layout);
  assert.equal(world.dirtySectionRevisions.get(nearKey), old, "far replacement returns to normal policy");
  const fairness = renderer.sectionAdmissionFairness;
  const replacement = authoredColumns([[4, 0]], [[72, 8, 8, BLOCK.STONE]]);
  renderer.world = replacement;
  renderer.rebuildDirty(0);
  assert.notEqual(renderer.sectionAdmissionFairness, fairness);
  assert.equal(renderer.sectionAdmissionFairness.world, replacement);
  assert.equal(renderer.sectionAdmissionFairness.urgentNext, true);
  assert.ok(renderer.sectionQueueLayout.urgentSlots.every((slot) => slot.cx === 4));
  until(renderer, () => replacement.dirtySectionRevisions.size === 0);
  assert.equal(world.dirtySectionRevisions.get(nearKey), old);
});
