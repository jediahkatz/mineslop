import assert from "node:assert/strict";
import test from "node:test";
import {
  BedSystem,
  BED_EXPLOSION_RADIUS,
  hasNearbySleepThreat,
  normalizeBedSnapshot,
} from "../src/bed-system.js";
import { isSafeRespawnPosition } from "../src/bed-spawn.js";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "../src/transactions.js";
import { DAWN_TIME } from "../src/world-clock.js";
import { createWorldContext } from "../src/world-spec.js";
import { WORLD_MAX } from "../src/terrain.js";
import { placedBed } from "./building-fixture.js";

const clockState = (time, day = 0) => ({ version: 1, time, day });
const monster = (x = 4, y = 21, z = 3) => ({
  position: { x, y, z },
  health: 20,
  spec: { temperament: "hostile" },
});

function obstructExits(f) {
  for (let x = 1; x <= 3; x++)
    for (let z = 1; z <= 4; z++) {
      if (x === 2 && [2, 3].includes(z)) continue;
      for (const y of [21, 22]) f.put(x, y, z, BLOCK.STONE);
    }
}

test("daytime use of either half records the same Overworld respawn identity without sleeping", (t) => {
  const f = placedBed(t);
  const beforeWorld = f.world.serialize(),
    beforePlayer = f.gameplay.serialize();
  const beforeClock = f.clock.serialize();
  for (const hit of [f.foot, f.head]) {
    const result = f.actions.tryUse(hit);
    assert.equal(result.ok, true);
    assert.equal(result.spawnSet, true);
    assert.equal(result.slept, false);
    assert.deepEqual(f.beds.getRespawn(), {
      seed: f.world.seed,
      generatorVersion: 4,
      dimension: "overworld",
      x: 2,
      y: 21,
      z: 3,
      id: BLOCK.WHITE_BED,
      facing: 0,
    });
  }
  assert.deepEqual(f.world.serialize(), beforeWorld);
  assert.deepEqual(f.gameplay.serialize(), beforePlayer);
  assert.deepEqual(f.clock.serialize(), beforeClock);
  assert.equal(f.calls.teleports.length, 0);
});

test("night sleep publishes spawn and dawn together without healing or advancing station/simulation time", (t) => {
  const f = placedBed(t);
  f.clock.load(clockState(0.9, 6));
  f.gameplay.health = 7;
  f.gameplay.hunger = 6;
  const before = f.gameplay.serialize();
  f.game.settlement = {
    update: () => assert.fail("sleep must not cook or grow crops"),
  };
  f.game.brewing = { update: () => assert.fail("sleep must not brew") };
  const elapsed = f.game.elapsed;
  f.clock.onChange = (state) => {
    assert.equal(f.beds._busy, false);
    assert.equal(f.beds.getRespawn().id, BLOCK.WHITE_BED);
    f.game.currentTime = state.time; // The explicit parent frame/renderer bridge.
  };
  const result = f.actions.tryUse(f.head);
  assert.equal(result.ok, true);
  assert.equal(result.slept, true);
  assert.deepEqual(f.clock.serialize(), clockState(DAWN_TIME, 7));
  assert.equal(f.game.currentTime, DAWN_TIME);
  assert.deepEqual(f.gameplay.serialize(), before);
  assert.equal(f.game.elapsed, elapsed);
  assert.equal(f.calls.teleports.length, 0);
  assert.equal(
    f.actions.tryUse(f.foot).slept,
    false,
    "waking cannot immediately skip another day"
  );
});

test("early-night sleep uses the current midnight day counter instead of adding another day", (t) => {
  const f = placedBed(t);
  f.clock.load(clockState(0.1, 7));
  assert.equal(f.actions.tryUse(f.foot).ok, true);
  assert.deepEqual(f.clock.serialize(), clockState(DAWN_TIME, 7));
});

test("nearby hostiles and angry neutrals block sleep, not daytime spawn setting", (t) => {
  const f = placedBed(t);
  f.game.wildlife.entities = [monster()];
  assert.equal(f.actions.tryUse(f.head).ok, true);
  f.clock.load(clockState(0.9));
  const before = f.snapshot();
  assert.match(f.actions.tryUse(f.head).message, /monsters/);
  assert.deepEqual(f.snapshot(), before);
  f.game.wildlife.entities = [
    { ...monster(), spec: { temperament: "neutral" }, angry: 10 },
  ];
  assert.equal(f.actions.tryUse(f.foot).ok, false);
  f.game.wildlife.entities = [
    { ...monster(), spec: { temperament: "passive" } },
  ];
  assert.equal(f.actions.tryUse(f.foot).ok, true);
});

test("monster proximity checks distinguish bounds, dead/tamed entities and inactive dimensions", () => {
  const at = { x: 0, y: 20, z: 0 };
  assert.equal(hasNearbySleepThreat([monster(8, 25, 8)], at), true);
  for (const mob of [
    monster(8.01, 20, 0),
    monster(0, 25.01, 0),
    monster(0, 20, -8.01),
    { ...monster(0, 20, 0), dead: true },
    { ...monster(0, 20, 0), health: 0 },
    { ...monster(0, 20, 0), tamed: true },
    { ...monster(0, 20, 0), pacified: 20 },
    { ...monster(0, 20, 0), dimension: "nether" },
  ])
    assert.equal(hasNearbySleepThreat([mob], at), false);
});

test("obstructed bedding or exits, bad links and missing support never advance the clock", (t) => {
  for (const cause of ["roof", "exits", "partner", "support", "distance"]) {
    const f = placedBed(t);
    f.clock.load(clockState(0.9));
    if (cause === "roof") f.put(2, 22, 2, BLOCK.STONE);
    if (cause === "exits") obstructExits(f);
    if (cause === "partner") f.put(2, 21, 2, BLOCK.AIR);
    if (cause === "support") f.put(2, 20, 2, BLOCK.AIR);
    if (cause === "distance")
      Object.assign(f.player.position, { x: 20, y: 21, z: 20 });
    const before = f.snapshot();
    assert.equal(f.actions.tryUse(f.foot).ok, false, cause);
    assert.deepEqual(f.snapshot(), before, cause);
  }
});

test("explicit clock veto and shared capacity refusal preserve both old spawn and old time", (t) => {
  for (const cause of ["clock", "capacity"]) {
    const f = placedBed(t);
    f.clock.load(clockState(0.9));
    if (cause === "clock") {
      const prepare = f.clock.prepareSleep.bind(f.clock);
      f.clock.prepareSleep = () => ({ ...prepare(), validate: () => false });
    } else {
      const owner = {};
      assert.equal(
        f.coordinator.register(
          owner,
          MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
        ),
        true
      );
      t.after(() => f.coordinator.release(owner));
    }
    const before = f.snapshot();
    assert.equal(f.actions.tryUse(f.head).ok, false, cause);
    assert.deepEqual(f.snapshot(), before, cause);
  }
});

test("Nether and End beds atomically remove both cells then call the real explosion entry", (t) => {
  for (const dimension of ["nether", "end"]) {
    const f = placedBed(t, { dimension });
    const beforeClock = f.clock.serialize(),
      beforePlayer = f.gameplay.serialize();
    f.game.explode = (at, radius, damagePlayer) => {
      assert.equal(f.world.get(2, 21, 3), BLOCK.AIR);
      assert.equal(f.world.get(2, 21, 2), BLOCK.AIR);
      assert.equal(f.beds._busy, false);
      assert.equal(radius, BED_EXPLOSION_RADIUS);
      assert.equal(damagePlayer, true);
      f.calls.explosions.push(at);
    };
    const result = f.actions.tryUse(f.head);
    assert.equal(result.ok, true);
    assert.equal(result.exploded, true);
    assert.equal(f.calls.explosions.length, 1);
    assert.equal(f.beds.getRespawn(), null);
    assert.deepEqual(f.clock.serialize(), beforeClock);
    assert.deepEqual(
      f.gameplay.serialize(),
      beforePlayer,
      "damage is exclusively the explosion entry's job"
    );
    assert.equal(
      f.overflow.size,
      0,
      "an exploding bed does not also drop a free bed"
    );
    assert.equal(f.actions.tryUse(f.foot).ok, false);
    assert.equal(f.calls.explosions.length, 1);
  }
});

test("absent explosion wiring refuses explicitly; an observer throw cannot pay or explode twice", (t) => {
  const f = placedBed(t, { dimension: "nether" });
  f.game.explode = undefined;
  const before = f.snapshot();
  const refused = f.actions.tryUse(f.foot);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /explosion handler/);
  assert.deepEqual(f.snapshot(), before);
  let explosions = 0;
  f.game.explode = () => {
    explosions++;
    throw new Error("explosion observer");
  };
  const accepted = f.actions.tryUse(f.foot);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.observerErrors.length, 1);
  assert.equal(f.world.get(2, 21, 3), BLOCK.AIR);
  assert.equal(f.actions.tryUse(f.foot).ok, false);
  assert.equal(explosions, 1);
});

test("bed explosions and nested observers do not hide fatal publication invariants", (t) => {
  for (const source of ["explosion", "observer"]) {
    const f = placedBed(t, { dimension: "nether" });
    const error = new TransactionInvariantError(
      "nested publication",
      new Error("injected")
    );
    const fail = () => {
      throw error;
    };
    if (source === "explosion") f.game.explode = fail;
    else f.world.onMutation = fail;
    assert.throws(
      () => f.actions.tryUse(f.foot),
      (value) => value === error
    );
    assert.equal(f.world.get(2, 21, 3), BLOCK.AIR);
    assert.equal(f.world.get(2, 21, 2), BLOCK.AIR);
    assert.equal(f.beds.getRespawn(), null);
    assert.equal(f.overflow.size, 0);
  }
});

test("respawn inspection checks the pair and exact standing geometry without moving or building", (t) => {
  const f = placedBed(t);
  assert.equal(f.actions.tryUse(f.foot).ok, true);
  const worldBefore = f.world.serialize();
  const landing = f.beds.findRespawn(f.world);
  assert.ok(landing);
  assert.equal(isSafeRespawnPosition(f.world, landing), true);
  assert.equal(landing.dimension, "overworld");
  assert.equal(f.calls.teleports.length, 0);
  assert.deepEqual(f.world.serialize(), worldBefore);
  f.put(3, 20, 2, BLOCK.OAK_SLAB);
  const slabLanding = f.beds.findRespawn(f.world);
  assert.equal(
    slabLanding.y,
    20.51,
    "respawn follows a partial support top, not a full-cube guess"
  );
  f.put(3, 20, 2, BLOCK.MAGMA_BLOCK);
  const safe = f.beds.findRespawn(f.world);
  assert.ok(safe);
  assert.notEqual(safe.x, 3.5, "magma is not safe footing");
});

test("missing, mismatched and obstructed saved beds yield no bed landing", (t) => {
  for (const cause of ["missing", "facing", "roof", "exits"]) {
    const f = placedBed(t);
    assert.equal(f.actions.tryUse(f.foot).ok, true);
    if (cause === "missing") f.put(2, 21, 2, BLOCK.AIR);
    if (cause === "facing") f.put(2, 21, 2, BLOCK.WHITE_BED, S.PART | 1);
    if (cause === "roof") f.put(2, 22, 2, BLOCK.STONE);
    if (cause === "exits") obstructExits(f);
    const before = f.world.serialize();
    assert.equal(f.beds.findRespawn(f.world), null, cause);
    assert.deepEqual(f.world.serialize(), before, cause);
    assert.equal(f.calls.teleports.length, 0);
  }
});

test("bed state normalizes and round-trips context, identity and negative-Y bounds", (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  const saved = f.beds.serialize();
  const normalized = normalizeBedSnapshot(saved, f.context);
  assert.deepEqual(normalized, saved);
  normalized.spawn.x++;
  assert.equal(saved.spawn.x, 2);
  const copy = new BedSystem({
    coordinator: f.coordinator,
    context: f.context,
  });
  const beforeBytes = f.coordinator.budget.totalBytes;
  assert.equal(copy.load(saved), true);
  saved.spawn.x++;
  assert.equal(copy.getRespawn().x, 2);
  assert.equal(copy.findRespawn(f.world).dimension, "overworld");
  const deep = { ...copy.serialize(), spawn: { ...copy.getRespawn(), y: -63 } };
  assert.ok(normalizeBedSnapshot(deep, f.context));
  assert.equal(
    normalizeBedSnapshot(
      { ...deep, spawn: { ...deep.spawn, y: -64 } },
      f.context
    ),
    null
  );
  const historical = createWorldContext({
    seed: f.world.seed,
    generatorVersion: 3,
  });
  const old = {
    version: 1,
    spawn: { ...copy.getRespawn(), generatorVersion: 3, y: 1 },
  };
  assert.ok(normalizeBedSnapshot(old, historical));
  assert.equal(
    normalizeBedSnapshot({ ...old, spawn: { ...old.spawn, y: 0 } }, historical),
    null
  );
  assert.ok(f.coordinator.budget.totalBytes > beforeBytes);
  copy.dispose();
  assert.equal(f.coordinator.usage(copy), undefined);
});

test("malformed bed components/contexts reject without replacing state or leaking reservations", (t) => {
  const f = placedBed(t);
  f.actions.tryUse(f.foot);
  const saved = f.beds.serialize();
  const bytes = f.coordinator.budget.totalBytes;
  for (const value of [
    null,
    { version: 2, spawn: null },
    { version: 1 },
    { ...saved, extra: true },
    { ...saved, spawn: { ...saved.spawn, id: BLOCK.STONE } },
    { ...saved, spawn: { ...saved.spawn, id: String(BLOCK.WHITE_BED) } },
    { ...saved, spawn: { ...saved.spawn, dimension: "nether" } },
    { ...saved, spawn: { ...saved.spawn, seed: "other world" } },
    { ...saved, spawn: { ...saved.spawn, generatorVersion: 3 } },
    { ...saved, spawn: { ...saved.spawn, facing: 4 } },
    { ...saved, spawn: { ...saved.spawn, x: WORLD_MAX - 1, facing: 1 } },
    { ...saved, spawn: { ...saved.spawn, x: 0.5 } },
    { ...saved, spawn: { ...saved.spawn, name: "unknown field" } },
  ]) {
    assert.equal(f.beds.load(value), false);
    assert.deepEqual(f.beds.serialize(), saved);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
  }
  const badContext = {
    ...f.context,
    specForDimension: () => ({ minY: -999, maxY: 320 }),
  };
  assert.equal(f.beds.load(saved, { context: badContext }), false);
  assert.throws(
    () => new BedSystem({ coordinator: f.coordinator, context: badContext }),
    RangeError
  );
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  const foreign = new TransactionCoordinator();
  f.game.worldClock = {
    ...f.clock,
    coordinator: foreign,
    serialize: () => f.clock.serialize(),
  };
  assert.equal(f.actions.tryUse(f.foot).ok, false);
});

test("bed and clock observers see both committed states with guards released", (t) => {
  const f = placedBed(t);
  f.clock.load(clockState(0.9));
  f.beds.onChange = () => {
    assert.equal(f.beds._busy, false);
    assert.equal(f.clock.time, DAWN_TIME);
    assert.equal(f.beds.getRespawn().id, BLOCK.WHITE_BED);
    throw new Error("bed observer");
  };
  f.clock.onChange = () => {
    throw new Error("clock observer");
  };
  const result = f.actions.tryUse(f.head);
  assert.equal(result.ok, true);
  assert.equal(result.observerErrors.length, 2);
  assert.equal(f.clock.time, DAWN_TIME);
  assert.equal(f.beds.getRespawn().id, BLOCK.WHITE_BED);
});

test("world obstruction and arriving monsters during preparation veto spawn and dawn together", (t) => {
  for (const cause of ["world", "monster"]) {
    const f = placedBed(t);
    f.clock.load(clockState(0.9));
    const prepare = f.clock.prepareSleep.bind(f.clock);
    f.clock.prepareSleep = () => {
      const participant = prepare();
      if (cause === "world") f.put(2, 22, 2, BLOCK.STONE);
      else f.game.wildlife.entities.push(monster());
      return participant;
    };
    const beforeClock = f.clock.serialize(),
      beforePlayer = f.gameplay.serialize();
    assert.equal(f.actions.tryUse(f.foot).ok, false, cause);
    assert.deepEqual(f.clock.serialize(), beforeClock);
    assert.deepEqual(f.gameplay.serialize(), beforePlayer);
    assert.equal(f.beds.getRespawn(), null);
    assert.equal(f.world.get(2, 21, 3), BLOCK.WHITE_BED);
    assert.equal(f.world.get(2, 21, 2), BLOCK.WHITE_BED);
  }
});

test("daytime bed use also refuses a disposed shared clock", (t) => {
  const f = placedBed(t);
  assert.equal(f.clock.dispose(), true);
  const before = f.snapshot();
  const result = f.actions.tryUse(f.foot);
  assert.equal(result.ok, false);
  assert.match(result.message, /clock/);
  assert.deepEqual(f.snapshot(), before);
});
