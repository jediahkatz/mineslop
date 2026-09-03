import assert from "node:assert/strict";
import test from "node:test";
import {
  ecologyCompletionLinksValid,
  normalizeEcologyServicesSnapshot,
} from "../src/ecology-save.js";
import {
  createEcologyState,
  ecologyMobLinksValid,
  ECOLOGY_CONTENT_PROPOSALS,
  ECOLOGY_SPECIES,
  ExpansionEcology,
  normalizeEcologySnapshot,
  normalizeEcologyState,
} from "../src/expansion-ecology.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";
import { ecologyFixture, ecologyState, ecologyWorld, monumentFixture } from "./ecology-fixtures.js";

test("species/content proposals are deeply immutable without registration or raw content IDs", () => {
  assert.ok(Object.isFrozen(ECOLOGY_SPECIES));
  assert.ok(Object.isFrozen(ECOLOGY_SPECIES.dolphin.foodNames));
  assert.ok(Object.isFrozen(ECOLOGY_CONTENT_PROPOSALS.newItems.SCUTE));
  assert.throws(() => { ECOLOGY_SPECIES.dolphin.health = 999; }, TypeError);
  assert.throws(() => { ECOLOGY_CONTENT_PROPOSALS.existingContent.push("TRIDENT"); }, TypeError);
  for (const spec of Object.values(ECOLOGY_SPECIES)) {
    assert.ok([spec.radius, spec.height, spec.eyeHeight, spec.speed, spec.cooldown].every(Number.isFinite));
    assert.ok(spec.radius > 0 && spec.eyeHeight <= spec.height);
    assert.deepEqual(spec.drops, [], "death ownership goes through prepared symbolic rewards");
  }
});

test("contextual normalization is detached, sorted, deterministic and rejects unknown fields", () => {
  const world = ecologyWorld();
  const entries = [
    ecologyState(world, "turtle", "z-turtle", { x: 1, y: -30, z: 1 }),
    ecologyState(world, "dolphin", "a-dolphin", { x: 0, y: -20, z: 0 }),
  ];
  const input = { version: 1, seed: world.seed, generatorVersion: 4, entries, eggs: [], elders: [] };
  const normalized = normalizeEcologySnapshot(input, world);
  assert.deepEqual(normalized.entries.map((state) => state.id), ["a-dolphin", "z-turtle"]);
  input.entries[0].home.x = 40;
  assert.equal(normalized.entries[1].home.x, 1);
  assert.deepEqual(normalizeEcologySnapshot(JSON.parse(JSON.stringify(normalized)), world), normalized);
  for (const mutate of [
    (data) => { data.version++; },
    (data) => { data.seed = "different-seed"; },
    (data) => { data.generatorVersion = 3; },
    (data) => { data.runtime = {}; },
    (data) => { data.entries[0].secretMobSaveFields = {}; },
    (data) => { data.entries[0].home.dimension = "overworld"; },
    (data) => { data.entries[0].air = NaN; },
    (data) => { data.entries.push(data.entries[0]); },
  ]) {
    const data = structuredClone(normalized);
    mutate(data);
    assert.equal(normalizeEcologySnapshot(data, world), null);
  }
  const legacy = createWorldContext({ seed: world.seed, generatorVersion: 3 });
  assert.equal(normalizeEcologyState(normalized.entries[0], legacy), null, "signed v4 homes do not migrate into legacy bounds");
  const forgedContext = { ...world, specForDimension: () => ({ minY: -9999, maxY: 9999 }) };
  assert.equal(normalizeEcologySnapshot(normalized, forgedContext), null);
});

test("drowned state cannot smuggle weapons or drop-bearing conversion variants through the archive", () => {
  const world = ecologyWorld();
  const base = createEcologyState("drowned", "converted-zombie", { x: 0, y: 2, z: 0 }, world);
  assert.equal(base.variant, "unarmed");
  for (const extra of [
    { variant: "trident" },
    { trident: true },
    { equipment: { main: "TRIDENT" } },
    { drops: [{ name: "TRIDENT", count: 1 }] },
  ])
    assert.equal(normalizeEcologyState({ ...base, ...extra }, world), null);
  assert.equal(createEcologyState("drowned", "invalid", null, world), null);
});

test("egg/growth consistency and the non-evicting elder ledger reject duplicate or missing identities", () => {
  const world = ecologyWorld();
  const parent = ecologyState(world, "turtle", "parent", { x: 0, y: 1, z: 0 }, { clutchSerial: 1 });
  const child = ecologyState(world, "turtle", "child", { x: 1, y: 1, z: 0 }, { baby: true });
  const egg = {
    id: "egg", parentId: parent.id, childId: child.id, serial: 1, dimension: "overworld",
    position: parent.home, remaining: 0, status: "hatched",
  };
  const input = { version: 1, seed: world.seed, generatorVersion: 4, entries: [parent, child], eggs: [egg], elders: [] };
  assert.ok(normalizeEcologySnapshot(input, world));
  for (const mutate of [
    (data) => { data.entries.pop(); },
    (data) => { data.eggs[0].status = "incubating"; },
    (data) => { data.entries[0].clutchSerial = 0; },
    (data) => { data.entries[1].scuteClaimed = true; },
    (data) => { data.eggs.push({ ...data.eggs[0], id: "same-clutch-other-egg" }); },
    (data) => { data.eggs[0].dimension = "nether"; },
  ]) {
    const data = structuredClone(input);
    mutate(data);
    assert.equal(normalizeEcologySnapshot(data, world), null);
  }
  const { structure, markers } = monumentFixture();
  const marker = markers[0];
  const elder = ecologyState(world, "elder_guardian", marker.id, { x: -6.5, y: 2, z: 0.5 }, { structureId: structure.id });
  const ledger = { id: marker.id, entityId: elder.id, structureId: structure.id, key: marker.key, dimension: "overworld", status: "alive" };
  const snapshot = { ...input, entries: [elder], eggs: [], elders: [ledger] };
  assert.ok(normalizeEcologySnapshot(snapshot, world));
  assert.equal(normalizeEcologySnapshot({ ...snapshot, elders: [] }, world), null);
  assert.equal(normalizeEcologySnapshot({ ...snapshot, elders: [{ ...ledger, status: "defeated" }] }, world), null);
  assert.equal(normalizeEcologySnapshot({ ...snapshot, entries: [] }, world), null);
});

test("archive links require retained persistent residents and reject resurrected/kind-mismatched base mobs", () => {
  const world = ecologyWorld();
  const turtle = ecologyState(world, "turtle", "resident", { x: 0, y: 1, z: 0 });
  const snapshot = normalizeEcologySnapshot({
    version: 1, seed: world.seed, generatorVersion: 4, entries: [turtle], eggs: [], elders: [],
  }, world);
  const mobs = [{ dimension: "overworld", entities: [{ id: turtle.id, kind: turtle.kind }] }];
  assert.equal(ecologyMobLinksValid(snapshot, mobs), true);
  assert.equal(ecologyMobLinksValid(snapshot, [{ dimension: "overworld", entities: [] }]), false);
  assert.equal(ecologyMobLinksValid(snapshot, [{ dimension: "nether", entities: mobs[0].entities }]), false);
  assert.equal(ecologyMobLinksValid(snapshot, [{ dimension: "overworld", entities: [{ id: turtle.id, kind: "dolphin" }] }]), false);
  assert.equal(ecologyMobLinksValid({ ...snapshot, entries: [{ ...turtle, alive: false }] }, mobs), false);
});

test("owner staging has no implicit reservation and retained data fits its explicit archive budget", () => {
  const world = ecologyWorld();
  const coordinator = new TransactionCoordinator();
  const owner = new ExpansionEcology({ context: world, coordinator });
  assert.equal(coordinator.usage(owner), undefined);
  assert.ok(owner.reservedBytes >= encodedBytes(owner.serialize()));
  const state = ecologyState(world, "dolphin", "saved-dolphin", { x: 0, y: 2, z: 0 }, {
    air: 12, assistTime: 6,
    guide: { id: "wreck", kind: "shipwreck", position: { x: 20, y: 2, z: 0 }, remaining: 7 },
  });
  const f = ecologyFixture({ world, entries: [state] });
  const serialized = f.owner.serialize();
  assert.ok(f.owner.reservedBytes >= encodedBytes(serialized));
  assert.equal(f.coordinator.usage(f.owner), f.owner.reservedBytes);
  const copy = ecologyFixture({ world, entries: serialized.entries });
  assert.deepEqual(copy.owner.serialize(), serialized);
  assert.ok(Object.isFrozen(copy.owner.state(state.id).guide.position));
  const before = copy.owner.serialize();
  copy.owner.update(copy.mobs.get(state.id), 0, copy.ctx);
  assert.deepEqual(copy.owner.serialize(), before);
});

function baseMob(state, kind = state.kind) {
  return {
    id: state.id, kind, position: { ...state.home }, health: 5, yaw: 0,
    tamed: false, angry: 0, attackCooldown: 0, fuse: 0, pacified: 0,
  };
}

function hostSnapshot(world, entries, eggs = []) {
  const mobsByDimension = {};
  for (const state of entries) {
    if (!state.alive) continue;
    const mobs = mobsByDimension[state.dimension] ??= {
      version: 1, seed: world.seed, dimension: state.dimension,
      randomState: 7, nextId: entries.length, killed: [], entities: [],
    };
    mobs.entities.push(baseMob(state));
  }
  return {
    version: 1,
    ecology: { version: 1, seed: world.seed, generatorVersion: 4, entries, eggs, elders: [] },
    mobsByDimension,
  };
}

test("only an absent host sidecar migrates; a present sidecar cannot silently lose its ecology owner", () => {
  const world = ecologyWorld();
  const empty = normalizeEcologyServicesSnapshot(undefined, world);
  assert.ok(empty);
  assert.deepEqual(empty.ecology.entries, []);
  assert.deepEqual(empty.mobsByDimension, {});
  for (const invalid of [
    null, {}, { version: 1, mobsByDimension: {} },
    { ...empty, ecology: undefined }, { ...empty, ecology: null },
    { ...empty, mobsByDimension: undefined },
  ])
    assert.equal(normalizeEcologyServicesSnapshot(invalid, world), null);
  assert.deepEqual(normalizeEcologyServicesSnapshot(empty, world), empty);
});

test("host preflight pairs complete live bases across inactive dimensions and never drops corrupt residents", () => {
  const world = ecologyWorld();
  const dolphin = ecologyState(world, "dolphin", "overworld:ecology:0", { x: 1.5, y: 2, z: 1.5 });
  const blaze = ecologyState(world, "blaze", "nether:ecology:1", { x: 4.5, y: 32, z: 4.5 });
  const value = hostSnapshot(world, [dolphin, blaze]);
  const normalized = normalizeEcologyServicesSnapshot(value, world);
  assert.ok(normalized);
  assert.deepEqual(normalizeEcologyServicesSnapshot(structuredClone(normalized), world), normalized);
  value.mobsByDimension.nether.entities[0].position.x = 500;
  assert.equal(normalized.mobsByDimension.nether.entities[0].position.x, 4.5);
  for (const mutate of [
    (data) => { delete data.mobsByDimension.nether; },
    (data) => { data.ecology.entries.pop(); },
    (data) => { data.ecology.entries[0].alive = false; },
    (data) => { data.mobsByDimension.overworld.entities[0].equipment = {}; },
    (data) => { data.mobsByDimension.nether.dimension = "overworld"; },
    (data) => { data.mobsByDimension.overworld.entities[0].kind = "guardian"; },
    (data) => { data.mobsByDimension.overworld.entities.length = 0; },
  ]) {
    const malformed = structuredClone(normalized);
    mutate(malformed);
    assert.equal(normalizeEcologyServicesSnapshot(malformed, world), null);
  }
});

test("host preflight reserves every egg/child ID against legacy bases and killed caches in every dimension", () => {
  const world = ecologyWorld();
  const parent = ecologyState(world, "turtle", "parent", { x: 1.5, y: 1, z: 1.5 }, { clutchSerial: 1 });
  const egg = {
    id: "nest", parentId: parent.id, childId: "hatchling", serial: 1,
    dimension: "overworld", position: { x: 1, y: 1, z: 1 }, remaining: 1, status: "incubating",
  };
  const value = hostSnapshot(world, [parent], [egg]);
  value.mobsByDimension.nether = {
    version: 1, seed: world.seed, dimension: "nether",
    randomState: 7, nextId: 1, killed: [], entities: [],
  };
  assert.ok(normalizeEcologyServicesSnapshot(value, world));
  for (const status of ["incubating", "broken"])
    for (const dimension of ["overworld", "nether"])
      for (const id of [egg.id, egg.childId, parent.id]) {
        const occupied = structuredClone(value);
        occupied.ecology.eggs[0].status = status;
        occupied.mobsByDimension[dimension].entities.push(baseMob({
          id, home: { x: 2.5, y: 2, z: 2.5 },
        }, dimension === "nether" ? "piglin" : "sheep"));
        assert.equal(normalizeEcologyServicesSnapshot(occupied, world), null);
        const killed = structuredClone(value);
        killed.ecology.eggs[0].status = status;
        killed.mobsByDimension[dimension].killed.push(id);
        assert.equal(normalizeEcologyServicesSnapshot(killed, world), null);
      }
  const fractional = structuredClone(value);
  fractional.ecology.eggs[0].position.x += 0.5;
  assert.equal(normalizeEcologyServicesSnapshot(fractional, world), null,
    "a World egg is a cell, not a detached fractional actor pose");
});

test("host preflight uses a baby's physical half-collider but never lets an adult borrow that clearance", () => {
  const world = ecologyWorld();
  const baby = ecologyState(world, "turtle", "small-turtle", { x: 1.5, y: 1, z: 1.5 }, { baby: true });
  const value = hostSnapshot(world, [baby]);
  value.mobsByDimension.overworld.entities[0].position.y = world.spec.maxY - 0.275;
  assert.ok(normalizeEcologyServicesSnapshot(value, world));
  value.ecology.entries[0].growthRemaining = 0;
  assert.ok(normalizeEcologyServicesSnapshot(value, world),
    "growth blocked by adult clearance or drop capacity retains the baby");
  value.ecology.entries[0].scuteClaimed = true;
  assert.equal(normalizeEcologyServicesSnapshot(value, world), null);
});

test("unique completion cross-check requires the full exact elder identity, independently of resident caches", () => {
  const { markers } = monumentFixture();
  const ecology = { elders: markers.map((marker, i) => ({
    id: marker.id, status: i === 0 ? "defeated" : "alive",
  })) };
  const exploration = {
    encounters: [{ marker: { id: markers[0].id }, completed: true }],
  };
  assert.equal(ecologyCompletionLinksValid(ecology, exploration), true);
  assert.equal(ecologyCompletionLinksValid(ecology, { encounters: [] }), false);
  assert.equal(ecologyCompletionLinksValid(ecology, {
    encounters: [{ marker: { id: markers[0].key }, completed: true }],
  }), false);
  assert.equal(ecologyCompletionLinksValid(ecology, {
    encounters: markers.map((marker) => ({ marker: { id: marker.id }, completed: true })),
  }), false);
  assert.equal(ecologyCompletionLinksValid(ecology, {
    encounters: [...exploration.encounters, { marker: { id: "another-site/encounter/elder_crown" }, completed: true }],
  }), true);
});
