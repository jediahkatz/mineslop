import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { Gameplay } from "../src/gameplay.js";
import { MAX_LIVING_HORSES, MAX_RETAINED_HORSE_IDS } from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { Horses } from "../src/horses.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { Wildlife } from "../src/wildlife.js";
import { createWorldContext } from "../src/world-spec.js";
import { ecologyHostFixture } from "./ecology-host-fixture.js";
import { ecologyHorseFixture } from "./ecology-horse-fixture.js";
import { mobRecord } from "./entity-context-fixtures.js";

function rejectUnchanged(t, f, options = {}, wildlife = f.wildlife) {
  const before = f.adoptionState(wildlife), candidate = f.host._candidate;
  const bases = wildlife.byId, borrower = wildlife.horseServices, ecology = wildlife.ecologyServices;
  const revision = f.host._revision, attacks = f.host.attacks;
  const contextGuard = f.host._wildlifeContexts.get(wildlife);
  const guarded = [
    t.mock.method(wildlife, "load"),
    t.mock.method(f.coordinator, "register"),
    t.mock.method(f.coordinator, "release"),
  ];
  try {
    assert.equal(f.host.bindRestoredWildlife(wildlife, options), false);
    assert.deepEqual(f.adoptionState(wildlife), before);
    assert.equal(f.host._candidate, candidate);
    assert.equal(f.host._revision, revision);
    assert.equal(f.host.attacks, attacks);
    assert.equal(f.host._wildlifeContexts.get(wildlife), contextGuard);
    assert.equal(wildlife.byId, bases);
    assert.equal(wildlife.horseServices, borrower);
    assert.equal(wildlife.ecologyServices, ecology);
    for (const call of guarded) assert.equal(call.mock.callCount(), 0);
  } finally {
    for (const call of guarded) call.mock.restore();
  }
}

test("adoption preserves the single loaded base, RNG, resources and registration until explicit activation", (t) => {
  const f = ecologyHorseFixture(t);
  assert.equal(f.hookReads, 1, "construction consults the current hook");
  const before = f.adoptionState(), bases = f.wildlife.byId;
  const load = t.mock.method(f.wildlife, "load");
  const register = t.mock.method(f.coordinator, "register");
  const release = t.mock.method(f.coordinator, "release");
  assert.equal(f.host.bindRestoredWildlife(f.wildlife, { horses: f.horses.serialize() }), true);
  assert.deepEqual(f.adoptionState(), before);
  assert.equal(f.wildlife.byId, bases);
  assert.equal(f.host.wildlife, null);
  assert.equal(f.wildlife.ecologyServices, null);
  assert.equal(f.host.attacks, null);
  assert.equal(f.coordinator.usage(f.host.ecology), undefined);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(register.mock.callCount(), 0);
  assert.equal(release.mock.callCount(), 0);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(register.mock.callCount(), 1, "only Ecology's own sidecar is registered");
  assert.equal(register.mock.calls[0].arguments[0], f.host.ecology);
  assert.equal(f.hookReads, 3, "adoption and activation each read the current sidecar");
  assert.equal(f.host.wildlife, f.wildlife);
  assert.equal(f.wildlife.horseServices, f.horses);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.wildlife._ownsRegistration, true);
  assert.equal(f.host.activate(f.wildlife), false);
  assert.equal(f.host.activate(), false);
  assert.equal(f.host.restoreWildlife(f.wildlife), false);
  assert.equal(load.mock.callCount(), 0);
});

test("adoption ignores only ordering, not owned data, and can resume beside the already-bound Horse borrower", (t) => {
  const f = ecologyHorseFixture(t, { horseCount: 2, legacyCount: 1 });
  const raw = structuredClone(f.saved.mobsByDimension.overworld);
  raw.entities.reverse();
  assert.equal(f.wildlife.load(raw, {
    context: f.context, horses: f.horses.serialize(), ecology: f.host.ecology,
  }), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  const horses = f.horses.serialize();
  horses.entries.reverse();
  assert.equal(f.host.bindRestoredWildlife(f.wildlife, { horses }), true);
  assert.equal(f.host.activate(f.wildlife), true);
  const base = f.wildlife.byId, before = f.wildlife.serialize(), bytes = f.coordinator.budget.totalBytes;
  assert.equal(f.host.suspend(), true);
  assert.equal(f.horses.active, true);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  const load = t.mock.method(f.wildlife, "load");
  assert.equal(f.host.restoreWildlife(f.wildlife), false, "legacy loading cannot replace a bound borrower");
  assert.equal(f.host.bindRestoredWildlife(f.wildlife, { horses: f.horses.serialize() }), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(load.mock.callCount(), 0);
  assert.equal(f.wildlife.byId, base);
  assert.deepEqual(f.wildlife.serialize(), before);
  assert.equal(f.host.dispose(), true);
  assert.equal(f.horses.active, true, "disposing Ecology cannot release the horse or base registration");
  assert.equal(f.coordinator.usage(f.wildlife), 0);
});

for (const [field, mutate] of [
  ["position", (base) => { base.entities[0].position.x += 0.25; }],
  ["health", (base) => { base.entities[0].health -= 1; }],
  ["yaw", (base) => { base.entities[0].yaw += 0.1; }],
  ["kind", (base) => { Object.assign(base.entities[0], { kind: "cow", health: 10 }); }],
  ["wolf taming", (base) => { base.entities[0].tamed = true; }],
  ["anger", (base) => { base.entities[0].angry += 1; }],
  ["cooldown", (base) => { base.entities[0].attackCooldown -= 0.1; }],
  ["fuse", (base) => { base.entities[0].fuse = 0.2; }],
  ["pacification", (base) => { base.entities[0].pacified = 1; }],
  ["RNG", (base) => { base.randomState--; }],
  ["next ID", (base) => { base.nextId++; }],
  ["killed IDs", (base) => { base.killed.push("legacy:killed"); }],
  ["missing legacy actor", (base) => { base.entities.shift(); }],
  ["extra legacy actor", (base, context) => { base.entities.push(mobRecord(context, "overworld", { id: "legacy:extra" })); }],
]) {
  test(`complete canonical adoption refuses a valid but conflicting ${field} projection without mutation`, (t) => {
    const f = ecologyHorseFixture(t, { legacyCount: 1, legacyKind: "wolf" });
    assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
    const raw = structuredClone(f.saved.mobsByDimension.overworld);
    mutate(raw, f.context);
    assert.equal(f.wildlife.load(raw, {
      context: f.context, horses: f.horses.serialize(), ecology: f.host.ecology,
    }), true, "the replacement is independently valid, but disagrees with the canonical owner");
    rejectUnchanged(t, f, { horses: f.horses.serialize() });
    assert.equal(f.host.activate(f.wildlife), false, "a replaced base also invalidates the earlier candidate");
  });
}

test("adoption compares sulfur cargo as well as the shared base projection", (t) => {
  const f = ecologyHorseFixture(t, { legacyCount: 1, legacyKind: "sulfur_cube" });
  const raw = structuredClone(f.saved.mobsByDimension.overworld);
  raw.entities[0].absorbedBlock = BLOCK.STONE;
  assert.equal(f.wildlife.load(raw, {
    context: f.context, horses: f.horses.serialize(), ecology: f.host.ecology,
  }), true);
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
});

test("omitted adoption options consult the hook; explicitly malformed options preserve a prior valid candidate", (t) => {
  const f = ecologyHorseFixture(t);
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  let reads = 0;
  const accessor = Object.defineProperty({}, "horses", {
    enumerable: true, get() { reads++; return f.horses.serialize(); },
  });
  for (const options of [null, [], { extra: true }, accessor,
    ...[undefined, null, {}, [], { version: 99 }].map((horses) => ({ horses }))])
    rejectUnchanged(t, f, options);
  assert.equal(reads, 0);
  const stale = f.horses.serialize();
  stale.entries[0].temper = 5;
  rejectUnchanged(t, f, { horses: stale });
  assert.equal(f.host.activate(f.wildlife), true, "refused options do not erase the previous candidate");
});

for (const fault of ["epoch", "dimension", "context", "runtime-world", "released-registration",
  "not-self-owned", "disposed", "retained-IDs", "duplicate-runtime-resident"]) {
  test(`adoption refuses ${fault} candidates without changing any surviving owner`, (t) => {
    const f = ecologyHorseFixture(t);
    assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
    if (fault === "epoch") assert.equal(f.world.loadEdits(f.world.serialize()), true);
    if (fault === "dimension") f.world.setDimension("nether");
    if (fault === "context")
      f.wildlife.worldContext = createWorldContext({ seed: "foreign", generatorVersion: 4 });
    if (fault === "runtime-world") f.wildlife.context.world = {};
    if (fault === "released-registration") assert.equal(f.coordinator.release(f.wildlife), true);
    if (fault === "not-self-owned") f.wildlife._ownsRegistration = false;
    if (fault === "disposed") assert.equal(f.wildlife.dispose(), true);
    if (fault === "retained-IDs") f.wildlife._retainedHorseIds.clear();
    if (fault === "duplicate-runtime-resident") f.wildlife.entities.push(f.wildlife.entities[0]);
    rejectUnchanged(t, f, { horses: f.horses.serialize() });
    assert.equal(f.host.activate(f.wildlife), false);
    // Restore only the deliberately corrupted registration for normal cleanup.
    if (fault === "released-registration") assert.equal(f.coordinator.register(f.wildlife, 0), true);
    if (fault === "not-self-owned") f.wildlife._ownsRegistration = true;
  });
}

test("foreign worlds, pre-bound Ecology and stale Horse borrowers cannot be adopted", (t) => {
  const f = ecologyHorseFixture(t);
  const foreign = ecologyHorseFixture(t);
  rejectUnchanged(t, f, { horses: f.horses.serialize() }, foreign.wildlife);
  const other = f.createHost();
  assert.equal(other.bindRestoredWildlife(f.wildlife), true);
  assert.equal(other.activate(f.wildlife), true);
  const otherState = other.serialize();
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
  assert.deepEqual(other.serialize(), otherState);
  assert.equal(other.suspend(), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  f.horses._bindingEpoch--;
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
  f.horses._bindingEpoch++;
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
});

test("a live same-world Horse borrower with another Gameplay owner is not the paired borrower", (t) => {
  const f = ecologyHorseFixture(t);
  const gameplay = new Gameplay({ context: f.context, coordinator: f.coordinator, mode: "survival" });
  const foreign = new Horses(null, f.world, {
    gameplay, context: f.context, coordinator: f.coordinator,
  });
  t.after(() => { assert.equal(foreign.dispose(), true); gameplay.dispose(); });
  assert.equal(foreign.load(f.horses.serialize()), true);
  assert.equal(foreign.bindWildlife(f.wildlife), true);
  assert.equal(foreign.active, true);
  const before = foreign.serialize();
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
  assert.deepEqual(foreign.serialize(), before);
  assert.equal(foreign.suspend(), true);
});

test("a suspended Ecology owner refuses a replacement Horse borrower even with identical resources and data", (t) => {
  const f = ecologyHorseFixture(t);
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(f.host.suspend(), true);
  assert.equal(f.horses.suspend(), true);
  const replacement = new Horses(null, f.world, {
    gameplay: f.gameplay, overflow: f.overflow, experienceOrbs: f.experience,
    context: f.context, coordinator: f.coordinator,
  });
  t.after(() => assert.equal(replacement.dispose(), true));
  assert.equal(replacement.load(f.horses.serialize()), true);
  assert.equal(replacement.bindWildlife(f.wildlife), true);
  assert.deepEqual(replacement.serialize(), f.horses.serialize());
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
  assert.equal(replacement.active, true);
  assert.equal(replacement.suspend(), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
});

test("a previously borrowed base cannot be re-adopted after a same-dimension epoch change", (t) => {
  const f = ecologyHorseFixture(t);
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(f.host.suspend(), true);
  assert.equal(f.horses.suspend(), true);
  const epoch = f.world.epoch;
  assert.equal(f.world.loadEdits(f.world.serialize()), true);
  assert.notEqual(f.world.epoch, epoch);
  assert.equal(f.wildlife.dimension, f.world.dimension);
  rejectUnchanged(t, f, { horses: f.horses.serialize() });
  const load = t.mock.method(f.wildlife, "load");
  assert.equal(f.host.restoreWildlife(f.wildlife), false);
  assert.equal(load.mock.callCount(), 0, "stale renderer refusal precedes a legacy load too");
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.host.wildlife, null);
});

test("configured readHorses failures refuse construction, restoration, adoption, activation and serialization", (t) => {
  const f = ecologyHorseFixture(t);
  const horses = f.horses.serialize();
  let reads = 0;
  const accessor = { ...horses };
  Object.defineProperty(accessor, "entries", { enumerable: true, get() { reads++; return []; } });
  const failures = [
    () => undefined, () => null, () => ({}), () => accessor,
    () => ({ ...horses, seed: "foreign" }),
    () => Promise.resolve(horses),
    () => { throw new Error("unavailable current horse snapshot"); },
  ];
  for (const readHorses of [null, async () => horses, function* () { yield horses; }, ...failures]) {
    const before = f.adoptionState();
    assert.throws(() => f.createHost({ readHorses }), /Invalid staged ecology/);
    assert.deepEqual(f.adoptionState(), before);
  }
  const load = t.mock.method(f.wildlife, "load");
  for (const failure of failures) {
    f.readHorses = failure;
    const before = f.adoptionState();
    assert.equal(f.host.restoreWildlife(f.wildlife), false);
    rejectUnchanged(t, f, { horses });
    assert.equal(f.host.serialize(), null);
    assert.deepEqual(f.adoptionState(), before);
    f.readHorses = () => f.horses.serialize();
    assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
    const candidate = f.host._candidate;
    f.readHorses = failure;
    assert.equal(f.host.activate(f.wildlife), false);
    assert.equal(f.host._candidate, candidate);
    assert.deepEqual(f.adoptionState(), before);
  }
  assert.equal(load.mock.callCount(), 0, "configured failures never fall back to a base reload");
  assert.equal(reads, 0);
  f.readHorses = () => f.horses.serialize();
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
});

test("legacy restore reads the changed staged Horse owner once rather than caching its constructor value", (t) => {
  const f = ecologyHorseFixture(t, { load: false });
  const current = f.horses.serialize();
  current.entries[0].temper = 10;
  assert.equal(f.horses.load(current), true);
  const load = t.mock.method(f.wildlife, "load");
  assert.equal(f.host.restoreWildlife(f.wildlife), true);
  assert.equal(load.mock.callCount(), 1);
  assert.deepEqual(load.mock.calls[0].arguments[1].horses, current);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(f.horses.state("horse:retained:0").temper, 10);
  assert.ok(f.host.serialize());
});

test("current horse reads follow real tracking, taming and death; stale same-ID data cannot serialize", (t) => {
  const f = ecologyHorseFixture(t, { horseCount: 0, tombstones: 0 });
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  const mob = f.spawn();
  assert.equal(f.horses.track(mob.id).ok, true);
  const tracked = f.horses.serialize();
  assert.ok(f.host.serialize());
  f.tame(mob);
  assert.equal(f.horses.state(mob.id).tamed, true);
  assert.equal(mob.tamed, false, "horse taming is never the base wolf flag");
  const tamed = f.horses.serialize(), current = f.host.serialize();
  assert.ok(current);
  f.readHorses = () => tracked;
  const before = f.adoptionState();
  assert.equal(f.host.serialize(), null, "a cached pre-taming record is not current ownership");
  assert.deepEqual(f.adoptionState(), before);
  f.readHorses = () => f.horses.serialize();
  assert.deepEqual(f.host.serialize(), current);
  assert.equal(f.horses.releasePassenger("player", { travelling: true }).ok, true);
  assert.equal(f.horses.hurt(mob, 1000).killed, true);
  assert.equal(f.horses.state(mob.id).alive, false);
  const afterDeath = f.host.serialize();
  assert.ok(afterDeath);
  assert.equal(afterDeath.mobsByDimension.overworld.entities.some((entry) => entry.id === mob.id), false);
  assert.equal(afterDeath.mobsByDimension.overworld.killed.includes(mob.id), false);
  f.readHorses = () => tamed;
  assert.equal(f.host.serialize(), null, "a cached live record cannot resurrect the dead horse");
  f.readHorses = () => f.horses.serialize();
  assert.equal(f.host.suspend(), true);
  const load = t.mock.method(f.wildlife, "load");
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(load.mock.callCount(), 0);
  assert.deepEqual(f.host.serialize(), afterDeath);
});

test("a full retained horse archive stages and travels without increasing the active/GPU base cap", (t) => {
  const f = ecologyHorseFixture(t, {
    horseCount: MAX_LIVING_HORSES, legacyCount: MAX_MOBS,
    tombstones: MAX_RETAINED_HORSE_IDS - MAX_LIVING_HORSES,
  });
  assert.throws(() => f.createHost({ readHorses: undefined }), /Invalid staged ecology/,
    "the standalone legacy cap is not silently enlarged");
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  assert.equal(f.host.activate(f.wildlife), true);
  assert.equal(f.wildlife.entities.length, MAX_MOBS);
  assert.equal(f.wildlife.dormantHorses.size, MAX_LIVING_HORSES);
  assert.equal(f.wildlife.byId.size, MAX_MOBS + MAX_LIVING_HORSES);
  const saved = f.host.serialize(), horses = f.horses.serialize();
  assert.ok(saved);
  assert.equal(f.host.suspend(), true);
  assert.equal(f.horses.suspend(), true);
  assert.equal(f.wildlife.dispose(), true);
  f.world.setDimension("nether").generate(1);
  const destination = new Wildlife(f.scene, f.world, { context: f.context, autoSpawn: false });
  t.after(() => destination.dispose());
  const load = t.mock.method(destination, "load");
  assert.equal(f.host.restoreWildlife(destination), true);
  assert.equal(load.mock.callCount(), 1);
  assert.deepEqual(load.mock.calls[0].arguments[1].horses, horses);
  assert.equal(f.horses.bindWildlife(destination), true);
  assert.equal(f.host.activate(destination), true);
  assert.deepEqual(f.host.serialize().mobsByDimension.overworld, saved.mobsByDimension.overworld);
  assert.deepEqual(f.horses.serialize(), horses);
  assert.equal(destination.byId.size, 0, "no horse is transported or given another base");
  assert.equal(f.coordinator.usage(destination), 0);
});

test("failed Ecology capacity admission leaves the horse borrower and base owner intact", (t) => {
  const f = ecologyHorseFixture(t);
  assert.equal(f.host.bindRestoredWildlife(f.wildlife), true);
  assert.equal(f.horses.bindWildlife(f.wildlife), true);
  const blocker = {};
  assert.equal(f.coordinator.register(blocker, MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes), true);
  const before = f.adoptionState(), candidate = f.host._candidate;
  assert.equal(f.host.activate(f.wildlife), false);
  assert.deepEqual(f.adoptionState(), before);
  assert.equal(f.host._candidate, candidate);
  assert.equal(f.host.wildlife, null);
  assert.equal(f.wildlife.ecologyServices, null);
  assert.equal(f.horses.active, true);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
  assert.equal(f.coordinator.usage(f.host.ecology), undefined);
  assert.equal(f.coordinator.release(blocker), true);
  assert.equal(f.host.activate(f.wildlife), true);
});

test("standalone legacy Ecology restores once with no horses option and preserves ordinary mobs", (t) => {
  const f = ecologyHostFixture(t, { seed: "", generatorVersion: 3, water: 0, biomeId: "plains" });
  assert.ok(f.wildlife.spawn("horse", { x: 8.5, y: 1, z: 8.5 }, { id: "legacy:horse" }));
  assert.ok(f.wildlife.spawn("sheep", { x: 4.5, y: 1, z: 4.5 }, { id: "legacy:sheep" }));
  const saved = f.snapshot();
  const restored = ecologyHostFixture(t, {
    seed: "", generatorVersion: 3, water: 0, biomeId: "plains", saved, activate: false,
  });
  const load = t.mock.method(restored.wildlife, "load");
  assert.equal(restored.host.restoreWildlife(restored.wildlife), true);
  assert.equal(load.mock.callCount(), 1);
  assert.equal(Object.hasOwn(load.mock.calls[0].arguments[1], "horses"), false);
  assert.equal(restored.host.bindRestoredWildlife(restored.wildlife, { horses: undefined }), false);
  assert.equal(restored.host.bindRestoredWildlife(restored.wildlife, {
    horses: emptyHorseSnapshot(restored.context),
  }), true);
  assert.equal(restored.host.activate(restored.wildlife), true);
  assert.equal(restored.wildlife.byId.size, 2);
  assert.deepEqual(restored.host.serialize(), saved.ecology);
  assert.equal(restored.host.suspend(), true);
  assert.equal(restored.host.bindRestoredWildlife(restored.wildlife), true);
  assert.equal(restored.host.activate(restored.wildlife), true);
  assert.equal(load.mock.callCount(), 1);
});
