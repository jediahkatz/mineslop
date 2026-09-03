import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { createEcologyState, normalizeEcologySnapshot } from "../src/expansion-ecology.js";
import { GameEcologyServices } from "../src/game-ecology-services.js";
import { normalizeGameMobArchive } from "../src/game-mob-state.js";
import { normalizeVehicleServicesSnapshot } from "../src/game-vehicle-state.js";
import { horseMotion, horseSeat } from "../src/horse-definitions.js";
import { emptyHorseSnapshot } from "../src/horse-save.js";
import { ITEM } from "../src/items.js";
import { MAX_MOBS } from "../src/mob-species.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { Wildlife } from "../src/wildlife.js";
import { createWorldContext } from "../src/world-spec.js";
import { mobRecord, mobSnapshot } from "./entity-context-fixtures.js";
import { gameMobFixture } from "./game-mob-integration-fixture.js";
import { horseFixture, horseRecord } from "./horse-fixture.js";

const context = createWorldContext({ seed: "  unchanged seed\n", generatorVersion: 4 });
const base = (id = "horse:archive") => mobRecord(context, "overworld", {
  id, kind: "horse", health: 24, position: { x: 8.5, y: 65, z: 8.5 },
});
function archive() {
  const horses = { ...emptyHorseSnapshot(context), entries: [horseRecord("horse:archive")] };
  const mobs = mobSnapshot(context, "overworld", [base()]);
  const nether = mobSnapshot(context, "nether", [
    mobRecord(context, "nether", { id: "nether:legacy", kind: "enderman", health: 40 }),
  ]);
  const mobStates = { overworld: mobs, nether };
  return {
    world: { version: 3, seed: context.seed, generatorVersion: 4, dimension: "overworld", edits: [] },
    horses, mobs, mobStates: structuredClone(mobStates),
    mobsByDimension: structuredClone(mobStates),
    ecology: {
      version: 1, ecology: normalizeEcologySnapshot(undefined, context),
      mobsByDimension: structuredClone(mobStates),
    },
  };
}

test("legacy base archives preserve ordinary horses and inactive mobs in every supported context", (t) => {
  for (const generatorVersion of [1, 2, 3, 4, 5]) {
    const f = horseFixture(t, { seed: "  raw seed\n", generatorVersion });
    f.spawn("legacy:horse");
    assert.ok(f.wildlife.spawn("pig", { x: 3.5, y: 1, z: 3.5 }, { id: "legacy:pig" }));
    const before = f.wildlife.serialize();
    const normalized = normalizeWorldComponents({ world: f.world.serialize(), mobs: before });
    assert.deepEqual(normalized.horses.entries, []);
    assert.deepEqual(normalized.mobs, before);
    assert.deepEqual(normalized.ecology.mobsByDimension.overworld, before);
    assert.deepEqual(normalized.mobStates, normalized.mobsByDimension);
    assert.equal(normalized.horses.seed, f.world.seed);
    assert.equal(normalized.horses.generatorVersion, generatorVersion);
    assert.deepEqual(f.wildlife.serialize(), before, "preflight cannot mutate the old owner");
  }
});

test("all compatibility locations agree on complete base poses and RNG/corpse metadata", () => {
  const saved = archive(), normalized = normalizeGameMobArchive(saved, context);
  assert.deepEqual(normalized.mobStates, saved.mobStates);
  assert.deepEqual(normalized.ecology.mobsByDimension, saved.mobStates);
  for (const key of ["mobs", "mobStates", "mobsByDimension", "ecology"]) {
    for (const mutate of [
      (value) => { value.entities[0].position.x += 0.25; },
      (value) => { value.entities[0].health -= 1; },
      (value) => { value.entities[0].yaw += 0.1; },
      (value) => { value.entities[0].angry += 1; },
      (value) => { value.entities[0].attackCooldown += 0.1; },
      (value) => { value.entities[0].fuse += 0.1; },
      (value) => { value.entities[0].pacified += 1; },
      (value) => { value.randomState += 1; },
      (value) => { value.nextId += 1; },
      (value) => { value.killed.push("old:corpse"); },
    ]) {
      const changed = structuredClone(saved);
      mutate(key === "mobs" ? changed.mobs : key === "ecology"
        ? changed.ecology.mobsByDimension.overworld : changed[key].overworld);
      assert.throws(() => normalizeGameMobArchive(changed, context), /saved|copies|links/);
    }
  }
});

test("present null, undefined, accessors and malformed canonical archives fail before getter execution", () => {
  let reads = 0;
  for (const key of ["horses", "ecology", "mobs", "mobStates", "mobsByDimension"]) {
    for (const value of [null, undefined, [], { version: 99 }])
      assert.throws(() => normalizeWorldComponents({ ...archive(), [key]: value }));
    const saved = archive();
    Object.defineProperty(saved, key, {
      enumerable: true, get() { reads++; return null; },
    });
    assert.throws(() => normalizeWorldComponents(saved));
  }
  const saved = archive();
  Object.defineProperty(saved.ecology.mobsByDimension.overworld.entities[0].position, "x", {
    enumerable: true, get() { reads++; return 8.5; },
  });
  assert.throws(() => normalizeWorldComponents(saved));
  assert.equal(reads, 0);
});

test("horse/ecology IDs, egg IDs and unborn child IDs cannot alias across any compatibility map", () => {
  for (const alias of ["entry", "egg", "child"]) {
    const saved = archive();
    const turtle = createEcologyState("turtle", alias === "entry" ? "horse:archive" : "turtle:parent",
      { x: 20, y: 65, z: 20 }, { ...context, dimension: "overworld" });
    assert.ok(turtle);
    if (alias === "entry") turtle.alive = false;
    else turtle.clutchSerial = 1;
    saved.ecology.ecology.entries = [turtle];
    if (alias !== "entry") {
      const record = mobRecord(context, "overworld", {
        id: turtle.id, kind: "turtle", health: 30, position: turtle.home,
      });
      for (const copy of [saved.mobs, saved.mobStates.overworld, saved.mobsByDimension.overworld,
        saved.ecology.mobsByDimension.overworld]) copy.entities.push(record);
      saved.ecology.ecology.eggs = [{
        id: alias === "egg" ? "horse:archive" : "turtle:egg",
        parentId: turtle.id, childId: alias === "child" ? "horse:archive" : "turtle:child",
        serial: 1, dimension: "overworld", position: turtle.home,
        remaining: 30, status: "incubating",
      }];
    }
    assert.ok(normalizeEcologySnapshot(saved.ecology.ecology, context), "valid ecology shape precedes cross-ID checks");
    assert.throws(() => normalizeGameMobArchive(saved, context), /identity links|saved mobs/);
  }
  const saved = archive();
  saved.mobStates.nether.entities[0].id = "horse:archive";
  assert.throws(() => normalizeGameMobArchive(saved, context));
});

test("dead horse IDs have no live base or legacy killed marker; retained caps do not enlarge active admission", () => {
  const saved = archive();
  saved.horses.entries = [{ id: "horse:archive", dimension: "overworld", alive: false }];
  assert.throws(() => normalizeGameMobArchive(saved, context));
  for (const copy of [saved.mobs, saved.mobStates.overworld, saved.mobsByDimension.overworld,
    saved.ecology.mobsByDimension.overworld]) {
    copy.entities = [];
    copy.killed = ["horse:archive"];
  }
  assert.throws(() => normalizeGameMobArchive(saved, context));
  const horses = { ...emptyHorseSnapshot(context), entries: [horseRecord("horse:archive")] };
  const mobs = mobSnapshot(context, "overworld", [
    ...Array.from({ length: MAX_MOBS }, (_, i) => mobRecord(context, "overworld", { id: `legacy:${i}` })),
    base(),
  ]);
  assert.equal(normalizeGameMobArchive({ horses, mobs }, context).mobs.entities.length, MAX_MOBS + 1);
});

test("a sole rider must match its active horse seat and cannot also appear in Boats", () => {
  const saved = archive();
  saved.horses.entries[0] = horseRecord("horse:archive", { rider: "player", motion: horseMotion() });
  saved.player = { ...horseSeat(base().position), yaw: 0, pitch: 0, flying: false };
  assert.ok(normalizeWorldComponents(saved));
  assert.throws(() => normalizeWorldComponents({
    ...saved, player: { ...saved.player, x: saved.player.x + 1 },
  }), /rider/);
  const vehicles = normalizeVehicleServicesSnapshot(saved, context);
  vehicles.boats.nextId = 2;
  vehicles.boats.boats.push({
    id: 1, wood: "oak", stack: { id: ITEM.OAK_BOAT, count: 1 }, dimension: "overworld",
    x: 8.5, y: 65, z: 8.5, yaw: 0, vx: 0, vy: 0, vz: 0,
    turnVelocity: 0, submergedTime: 0, bubbleTime: 0, bubbleDirection: 0, paddlePhase: 0,
    passengers: ["player", null],
  });
  assert.equal(normalizeVehicleServicesSnapshot({ ...saved, ...vehicles }, context), null);
});

test("real detached Game restore loads Wildlife once, binds both borrowers and preserves one rider", async (t) => {
  const f = await gameMobFixture(t);
  const mob = f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const saved = f.snapshot();
  const original = Wildlife.prototype.load;
  let loads = 0;
  t.mock.method(Wildlife.prototype, "load", function (...args) {
    loads++;
    assert.equal(this.horseServices, null);
    assert.equal(this.ecologyServices, null);
    assert.ok(args[1].horses);
    assert.ok(args[1].ecology);
    return Reflect.apply(original, this, args);
  });
  const restored = await gameMobFixture(t, { saved });
  assert.equal(loads, 1);
  assert.equal(restored.wildlife.horseServices, restored.horses);
  assert.equal(restored.wildlife.ecologyServices, restored.ecology);
  assert.equal(restored.coordinator.usage(restored.wildlife), 0);
  assert.equal(restored.ecology.trading, restored.progression.services.trading);
  assert.equal(restored.horses.mountFor().id, mob.id);
  assert.equal(restored.player.vehicleType, "horse");
  assert.equal(restored.wildlife.byId.size, 1);
  assert.deepEqual(restored.snapshot().mobs, saved.mobs);
  assert.equal(restored.wildlife.load(saved.mobs, { context: restored.context, horses: saved.horses }), false);
});

test("an obstructed staged saved rider rejects without changing an already-live source owner", async (t) => {
  const f = await gameMobFixture(t);
  const mob = f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const before = f.ownership(), saved = structuredClone(before.archive);
  saved.world.edits.push(["overworld", 8, 66, 8, BLOCK.STONE, 0, 0]);
  // A valid edit tuple must reach loaded rider clearance, not fail parsing.
  const original = f.world.prepareMutation([{
    x: 8, y: 66, z: 8, before: f.world.getCell(8, 66, 8),
    after: { id: BLOCK.STONE, state: 0, fluid: 0 },
  }]);
  assert.ok(original);
  assert.equal(f.horses.mountFor().id, mob.id);
  assert.deepEqual(f.ownership(), before, "preparing an edit is not publication");
  await assert.rejects(() => gameMobFixture(t, { saved }), /rider-obstructed/);
  assert.deepEqual(f.ownership(), before);
});

test("Game rejects malformed mob copies before closing or disposing its live owners", async (t) => {
  const f = await gameMobFixture(t), mob = f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const before = f.ownership(), saved = structuredClone(f.snapshot());
  // Break one compatibility copy without changing the canonical current owner.
  saved.mobs = structuredClone(saved.mobs);
  saved.mobs.entities[0].position.x += 0.25;
  t.mock.method(f.game, "closeScreens", () => assert.fail("preflight precedes screen teardown"));
  await assert.rejects(() => f.game.initialize(f.world.seed, saved), /Conflicting saved mob copies/);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.mountFor().id, mob.id);
  assert.equal(f.coordinator.usage(f.wildlife), 0);
});

test("refused Ecology adoption never retries the base load or touches the existing Game", async (t) => {
  const f = await gameMobFixture(t);
  f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const before = f.ownership();
  const load = t.mock.method(Wildlife.prototype, "load");
  const adoption = t.mock.method(GameEcologyServices.prototype, "bindRestoredWildlife", () => false);
  const legacyRestore = t.mock.method(GameEcologyServices.prototype, "restoreWildlife", () =>
    assert.fail("legacy restore would load Wildlife a second time"));
  await assert.rejects(() => gameMobFixture(t, { saved: before.archive }),
    /Ecology cannot adopt the already-restored Wildlife/);
  assert.equal(load.mock.callCount(), 1);
  assert.equal(adoption.mock.callCount(), 1);
  assert.equal(legacyRestore.mock.callCount(), 0);
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.active, true);
  assert.equal(f.ecology.active, true);
});

test("Game never falls back to its initial horse sidecar after the live owner becomes unreadable", async (t) => {
  const f = await gameMobFixture(t);
  f.spawn();
  assert.equal(f.game.useActions.tap(), true);
  const before = f.ownership();
  const unreadable = t.mock.method(f.horses, "serialize", () => null);
  assert.equal(f.mobs.horseSnapshot(), null);
  assert.equal(f.ecology.serialize(), null);
  assert.throws(() => f.snapshot(), /invalid ecology\/horse links/);
  unreadable.mock.restore();
  assert.deepEqual(f.ownership(), before);
  assert.equal(f.horses.active, true);
  assert.equal(f.ecology.active, true);
});
