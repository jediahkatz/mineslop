import assert from "node:assert/strict";
import test from "node:test";
import { BedSystem } from "../src/bed-system.js";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { BuildingActions } from "../src/building-actions.js";
import {
  DEFAULT_BUILDING_TIME,
  GameBuildingServices,
  JAVA_DAY_TICKS as BUILDING_JAVA_DAY_TICKS,
  normalizeBuildingServicesSnapshot,
  projectBuildingClock,
} from "../src/game-building-services.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import {
  advanceTraderCalendar,
  JAVA_DAY_TICKS,
  MAX_DAILY_RESTOCKS,
  MAX_WORLD_DAY,
  normalizeTradeClock,
  RESTOCK_WORK_END,
  RESTOCK_WORK_START,
} from "../src/trading-calendar.js";
import { TransactionInvariantError } from "../src/transactions.js";
import {
  DAWN_TIME,
  DAY_SECONDS,
  sleepWorldClock,
  WorldClock,
  WORLD_CLOCK_BYTES,
} from "../src/world-clock.js";
import { createWorldContext } from "../src/world-spec.js";
import {
  drainSupport,
  servicesFixture,
  supportIdle,
} from "./game-building-services-fixture.js";

const state = (time, day = 0) => ({ version: 1, day, time });
const beds = (context) => ({
  version: 1,
  spawn: {
    seed: context.seed,
    generatorVersion: context.generatorVersion,
    dimension: "overworld",
    x: 5,
    y: -59,
    z: 7,
    id: BLOCK.WHITE_BED,
    facing: 0,
  },
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-12);
const reserve = (t, coordinator, bytes, allowOverBudget = false) => {
  const owner = {};
  assert.equal(coordinator.register(owner, bytes, { allowOverBudget }), true);
  t.after(() => coordinator.release(owner));
  return owner;
};

test("pure sidecar normalization is detached and has an explicit legacy renderer-time fallback", () => {
  const context = createWorldContext({
    seed: "authored-building-clock",
    generatorVersion: 4,
  });
  assert.deepEqual(normalizeBuildingServicesSnapshot(null, context), {
    beds: { version: 1, spawn: null },
    worldClock: state(DEFAULT_BUILDING_TIME),
  });
  for (const [time, expected] of [
    [0, 0],
    [1, 0],
    [1.25, 0.25],
    [-0.25, 0.75],
  ])
    assert.deepEqual(
      normalizeBuildingServicesSnapshot({ time }, context).worldClock,
      state(expected)
    );
  const saved = { beds: beds(context), worldClock: state(0.5, 8), time: 0.9 };
  const normalized = normalizeBuildingServicesSnapshot(saved, context);
  assert.deepEqual(normalized, {
    beds: saved.beds,
    worldClock: saved.worldClock,
  });
  normalized.beds.spawn.x++;
  normalized.worldClock.day++;
  assert.equal(saved.beds.spawn.x, 5);
  assert.equal(saved.worldClock.day, 8);
  assert.deepEqual(
    normalizeBuildingServicesSnapshot(
      {
        time: NaN,
        worldClock: state(0.5, 8),
      },
      context
    ).worldClock,
    state(0.5, 8),
    "a canonical clock is authoritative over the legacy alias"
  );
});

test("malformed explicit sidecars, legacy times and all-dimension contexts cannot disappear into defaults", () => {
  const context = createWorldContext({
    seed: "authored-building-clock",
    generatorVersion: 4,
  });
  for (const saved of [
    [],
    { beds: null },
    { beds: { version: 2, spawn: null } },
    { worldClock: null },
    { worldClock: state(1) },
    { worldClock: state(0.5, -1) },
    { time: "0.5" },
    { time: null },
    { time: Infinity },
    { time: NaN },
    { beds: { ...beds(context), extra: true } },
  ])
    assert.equal(normalizeBuildingServicesSnapshot(saved, context), null);
  const historical = createWorldContext({
    seed: context.seed,
    generatorVersion: 3,
  });
  const oldBounds = beds(historical);
  assert.equal(
    normalizeBuildingServicesSnapshot({ beds: oldBounds }, historical),
    null
  );
  const malformed = {
    ...context,
    specForDimension: (dimension) => ({
      ...context.specForDimension(dimension),
      ...(dimension === "end" ? { maxY: 999 } : {}),
    }),
  };
  assert.equal(normalizeBuildingServicesSnapshot({}, malformed), null);
  assert.equal(
    normalizeBuildingServicesSnapshot({ beds: beds(context) }, historical),
    null
  );
});

test("the shared pure calendar preserves constants, numeric bounds and detached data records", () => {
  assert.equal(JAVA_DAY_TICKS, 24000);
  assert.equal(BUILDING_JAVA_DAY_TICKS, JAVA_DAY_TICKS);
  assert.equal(MAX_WORLD_DAY, 2_147_483_647);
  assert.equal(MAX_DAILY_RESTOCKS, 2);
  assert.equal(RESTOCK_WORK_START, 2000);
  assert.equal(RESTOCK_WORK_END, 9000);
  for (const value of [
    { day: 0, time: 0 },
    Object.assign(Object.create(null), {
      day: MAX_WORLD_DAY,
      time: JAVA_DAY_TICKS - 1,
    }),
    Object.freeze({ day: 4, time: 6000 }),
  ]) {
    const before = { day: value.day, time: value.time };
    const normalized = normalizeTradeClock(value);
    assert.deepEqual(normalized, before);
    assert.notEqual(normalized, value);
    assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
    normalized.day++;
    normalized.time++;
    assert.deepEqual({ day: value.day, time: value.time }, before);
  }
  for (const value of [
    {},
    { day: 0 },
    { time: 0 },
    { day: -1, time: 0 },
    { day: 0.5, time: 0 },
    { day: MAX_WORLD_DAY + 1, time: 0 },
    { day: Number.MAX_SAFE_INTEGER, time: 0 },
    { day: "0", time: 0 },
    { day: NaN, time: 0 },
    { day: 0, time: -1 },
    { day: 0, time: JAVA_DAY_TICKS },
    { day: 0, time: 0.5 },
    { day: 0, time: "0" },
    { day: 0, time: null },
    { day: 0, time: Infinity },
  ])
    assert.throws(() => normalizeTradeClock(value), {
      name: "RangeError",
      message: "Invalid villager calendar",
    });
});

test("the pure calendar retains strict prototypes and own-field descriptors without evaluating accessors", () => {
  for (const value of [
    null,
    undefined,
    false,
    0,
    "clock",
    [],
    new Date(0),
    new Map(),
    () => ({}),
    Object.create({ day: 0, time: 0 }),
  ])
    assert.throws(() => normalizeTradeClock(value), {
      name: "RangeError",
      message: "Invalid progression record",
    });
  let accessed = 0;
  const invalid = [
    { day: 0, time: 0, elapsedSeconds: 100000 },
    { day: 0, time: 0, [Symbol("extra")]: 0 },
    Object.defineProperty({ day: 0, time: 0 }, "extra", {
      value: 0,
      enumerable: false,
    }),
  ];
  for (const field of ["day", "time"]) {
    invalid.push(
      Object.defineProperty({ day: 0, time: 0 }, field, {
        value: 0,
        enumerable: false,
      }),
      Object.defineProperty({ day: 0, time: 0 }, field, {
        enumerable: true,
        get() {
          accessed++;
          return 0;
        },
      }),
      Object.defineProperty({ day: 0, time: 0 }, field, {
        enumerable: true,
        set(_value) {
          accessed++;
        },
      })
    );
  }
  for (const value of invalid)
    assert.throws(() => normalizeTradeClock(value), {
      name: "RangeError",
      message: "Unknown or non-data progression field",
    });
  assert.equal(accessed, 0);
});

test("the pure calendar keeps same-day allowances, rejects rewinds and only resets on a later day", () => {
  const npc = Object.freeze({
    clock: Object.freeze({ day: 4, time: 6000 }),
    restocks: 2,
    lastRestockTime: 5000,
    offers: Object.freeze([Object.freeze({ uses: 12 })]),
  });
  const before = structuredClone(npc);
  for (const time of [6000, 8999, JAVA_DAY_TICKS - 1]) {
    const next = { day: 4, time };
    const calendar = advanceTraderCalendar(npc, next);
    next.time = 0;
    assert.deepEqual(calendar, {
      clock: { day: 4, time },
      restocks: 2,
      lastRestockTime: 5000,
    });
  }
  for (const day of [5, 100, MAX_WORLD_DAY])
    assert.deepEqual(advanceTraderCalendar(npc, { day, time: 0 }), {
      clock: { day, time: 0 },
      restocks: 0,
      lastRestockTime: null,
    });
  for (const value of [
    { day: 3, time: JAVA_DAY_TICKS - 1 },
    { day: 4, time: 5999 },
  ])
    assert.throws(() => advanceTraderCalendar(npc, value), {
      name: "RangeError",
      message: "Villager calendar cannot move backwards",
    });
  assert.deepEqual(
    npc,
    before,
    "projection never changes offers, work, or the source calendar"
  );
});

test("clock projection matches renderer sunrise and Java trading ticks, including the initial pre-dawn day", () => {
  for (const [time, day, ticks] of [
    [0, 0, 18000],
    [0.125, 0, 21000],
    [0.25, 1, 0],
    [0.28, 1, 720],
    [0.36, 1, 2640],
    [0.5, 1, 6000],
    [0.75, 1, 12000],
  ]) {
    const projection = projectBuildingClock(state(time));
    assert.deepEqual(projection, {
      day: 0,
      time,
      tradingClock: { day, time: ticks },
    });
    assert.deepEqual(
      normalizeTradeClock(projection.tradingClock),
      projection.tradingClock
    );
  }
  assert.equal(projectBuildingClock(state(1)), null);
  assert.equal(
    projectBuildingClock(state(0.5, Number.MAX_SAFE_INTEGER)).tradingClock,
    null
  );
  assert.equal(
    projectBuildingClock(state(0.1, MAX_WORLD_DAY)).tradingClock.day,
    MAX_WORLD_DAY
  );
  assert.equal(
    projectBuildingClock(state(0.5, MAX_WORLD_DAY)).tradingClock,
    null
  );
});

test("valid oversized WorldClock sidecars still activate and serialize when trading cannot represent their day", (t) => {
  const worldClock = state(0.5, Number.MAX_SAFE_INTEGER);
  const f = servicesFixture(t, { saved: { worldClock } });
  assert.deepEqual(f.services.serialize().worldClock, worldClock);
  assert.deepEqual(f.services.clockProjection(), {
    day: Number.MAX_SAFE_INTEGER,
    time: 0.5,
    tradingClock: null,
  });
  assert.equal(f.game.currentTime, 0.5);
});

test("trading allowances survive midnight and reset once at sunrise or sleep, without backwards ticks", () => {
  let trader = {
    clock: projectBuildingClock(state(0.99, 4)).tradingClock,
    restocks: 2,
    lastRestockTime: 8000,
  };
  trader = {
    ...trader,
    ...advanceTraderCalendar(
      trader,
      projectBuildingClock(state(0, 5)).tradingClock
    ),
  };
  assert.equal(trader.restocks, 2);
  trader = {
    ...trader,
    ...advanceTraderCalendar(
      trader,
      projectBuildingClock(state(0.24, 5)).tradingClock
    ),
  };
  assert.equal(trader.restocks, 2);
  trader = {
    ...trader,
    ...advanceTraderCalendar(
      trader,
      projectBuildingClock(state(0.25, 5)).tradingClock
    ),
  };
  assert.equal(trader.restocks, 0);
  assert.equal(trader.lastRestockTime, null);
  const night = state(0.9, 5);
  trader = {
    clock: projectBuildingClock(night).tradingClock,
    restocks: 2,
    lastRestockTime: 8000,
  };
  const slept = advanceTraderCalendar(
    trader,
    projectBuildingClock(sleepWorldClock(night)).tradingClock
  );
  assert.deepEqual(slept, {
    clock: { day: 7, time: 720 },
    restocks: 0,
    lastRestockTime: null,
  });
});

test("staging constructs the real owners without subscriptions, live callbacks or an implicit second BedSystem", (t) => {
  const f = servicesFixture(t, { stage: false });
  const callback = f.world.onMutation;
  const before = f.snapshot(),
    bytes = f.coordinator.budget.totalBytes;
  const saved = { beds: beds(f.context), worldClock: state(0.8, 12) };
  const service = f.create({ saved });
  assert.ok(service.beds instanceof BedSystem);
  assert.ok(service.worldClock instanceof WorldClock);
  assert.ok(service.buildingActions instanceof BuildingActions);
  assert.equal(service.buildingActions.beds, service.beds);
  assert.equal(service.buildingActions._ownsBeds, false);
  assert.equal(service.buildingActions.context, f.context);
  assert.equal(service.buildingActions.coordinator, f.world.coordinator);
  assert.notEqual(service.buildingActions.game, f.game);
  assert.equal(service.buildingActions.game.building, true);
  assert.equal(
    service.buildingActions.place("main", BLOCK.STONE, f.hit()),
    false
  );
  assert.equal(service.beds.onChange, undefined);
  assert.equal(service.worldClock.onChange, undefined);
  assert.equal(f.world.onMutation, callback);
  assert.equal(f.game.beds, undefined);
  assert.equal(f.game.worldClock, undefined);
  assert.equal(f.game.currentTime, 0.99);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.calls.hud, 0);
  assert.deepEqual(f.calls.projections, []);
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(service.serialize(), { ...saved, time: 0.8 });
  assert.equal(
    f.coordinator.budget.totalBytes - bytes,
    encodedBytes(saved.beds) + WORLD_CLOCK_BYTES
  );
  assert.equal(service.dispose(), true);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
});

test("invalid preparation does not mutate the host or leave any reservation", (t) => {
  const f = servicesFixture(t, { stage: false });
  const before = f.snapshot(),
    bytes = f.coordinator.budget.totalBytes;
  for (const options of [
    { saved: { worldClock: null } },
    {
      context: createWorldContext({
        seed: "another-world",
        generatorVersion: 4,
      }),
    },
    { gameplay: { coordinator: {} } },
    { support: { cells: 0 } },
    { support: { columns: 513 } },
    { support: { candidates: 65 } },
    { support: { scanCells: Infinity } },
    { support: { unknown: 1 } },
    { allowOverBudget: "true" },
  ]) {
    assert.throws(
      () =>
        new GameBuildingServices({
          world: f.world,
          gameplay: f.gameplay,
          context: f.context,
          ...options,
        }),
      RangeError
    );
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("a failed bed load or later clock reservation releases all earlier staged owners", (t) => {
  for (const failure of ["bed-load", "clock"]) {
    const f = servicesFixture(t, { stage: false });
    const empty = encodedBytes({ version: 1, spawn: null });
    const free = empty + (failure === "clock" ? WORLD_CLOCK_BYTES - 1 : 0);
    reserve(
      t,
      f.coordinator,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes - free
    );
    const before = f.coordinator.budget.totalBytes;
    assert.throws(
      () =>
        f.create({
          saved: failure === "bed-load" ? { beds: beds(f.context) } : null,
        }),
      RangeError
    );
    assert.equal(f.coordinator.budget.totalBytes, before);
    assert.equal(f.world._disposed, false);
    assert.equal(f.gameplay._disposed, false);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.game.buildingActions, undefined);
  }
});

test("accepted over-budget restoration forwards admission to both owners and their loads", (t) => {
  const f = servicesFixture(t, { stage: false });
  reserve(t, f.coordinator, MAX_RESERVED_BYTES + 2048, true);
  const bytes = f.coordinator.budget.totalBytes;
  assert.throws(
    () => f.create({ saved: { beds: beds(f.context) } }),
    RangeError
  );
  assert.equal(f.coordinator.budget.totalBytes, bytes);
  const saved = { beds: beds(f.context), worldClock: state(0.4, 42) };
  const service = f.create({ saved, allowOverBudget: true });
  assert.equal(service.buildingActions.beds, service.beds);
  assert.equal(f.coordinator.usage(service), 0);
  assert.equal(
    f.coordinator.budget.totalBytes,
    bytes + encodedBytes(saved.beds) + WORLD_CLOCK_BYTES
  );
  assert.equal(service.activate(f.game).ok, true);
  assert.equal(
    service.frame(1, { simulating: true }).ok,
    true,
    "fixed-size calendar advancement remains possible"
  );
  assert.equal(service.beds.getRespawn().y, -59);
  assert.equal(service.dispose(), true);
  assert.equal(f.coordinator.budget.totalBytes, bytes);
});

test("activation requires the staged world/player and publishes all aliases before projecting", (t) => {
  const f = servicesFixture(t, {
    activate: false,
    saved: { worldClock: state(0.5, 3) },
  });
  const other = servicesFixture(t, { stage: false });
  assert.equal(f.services.activate(other.game).ok, false);
  assert.equal(other.game.beds, undefined);
  assert.equal(f.game.currentTime, 0.99);
  f.game.graphics.setTime = (time) => {
    assert.equal(f.game.beds, f.services.beds);
    assert.equal(f.game.worldClock, f.services.worldClock);
    assert.equal(f.game.buildingActions, f.services.buildingActions);
    assert.equal(f.game.buildingServices, f.services);
    assert.equal(f.game.currentTime, time);
  };
  assert.equal(f.services.activate(f.game).ok, true);
  assert.equal(f.services.buildingActions.game, f.game);
  assert.equal(f.services.active, true);
  assert.equal(
    f.services.activate(f.game).ok,
    true,
    "activation is idempotent for its live host"
  );
});

test("a changed staging epoch or an occupied/nonconfigurable host cannot be partially activated", (t) => {
  const stale = servicesFixture(t, { activate: false });
  stale.world.setDimension("nether");
  assert.equal(stale.services.activate(stale.game).ok, false);
  assert.throws(() => stale.services.serialize(), /stale/);
  assert.equal(stale.game.buildingServices, undefined);
  assert.deepEqual(stale.calls.projections, []);
  const f = servicesFixture(t);
  const replacement = f.create({ saved: { worldClock: state(0.8) } });
  assert.equal(replacement.activate(f.game).ok, false);
  assert.equal(f.game.beds, f.services.beds);
  assert.equal(replacement.dispose(), true);
  assert.equal(f.services.beds._disposed, false);
  const blocked = servicesFixture(t, { activate: false });
  Object.defineProperty(blocked.game, "buildingActions", {
    value: null,
    configurable: false,
  });
  assert.equal(blocked.services.activate(blocked.game).ok, false);
  assert.equal(blocked.game.worldClock, undefined);
  assert.equal(blocked.game.currentTime, 0.99);
});

test("serialization reloads spawn and calendar together without invoking live owners during replacement", (t) => {
  const f = servicesFixture(t);
  const { foot } = f.placeBed();
  assert.equal(f.services.buildingActions.tryUse(foot).spawnSet, true);
  assert.equal(f.services.setTime(0.9).ok, true);
  assert.equal(f.services.buildingActions.tryUse(foot).slept, true);
  const saved = f.services.serialize(),
    saves = f.calls.saves;
  const staged = f.create({ saved });
  assert.deepEqual(staged.serialize(), saved);
  assert.equal(f.calls.saves, saves);
  assert.equal(f.services.dispose(), true);
  f.services = staged;
  assert.equal(staged.activate(f.game).ok, true);
  assert.equal(f.game.currentTime, DAWN_TIME);
  assert.equal(f.game.worldClock.day, 1);
  assert.ok(
    f.game.beds.findRespawn(f.world),
    "the same GameTravel bed alias finds an authored safe exit"
  );
  const detached = staged.serialize();
  detached.beds.spawn.x++;
  detached.worldClock.day++;
  assert.deepEqual(staged.serialize(), saved);
});

test("lifecycle operations refuse coordinator validation reentry without partial disposal or activation", (t) => {
  for (const operation of ["dispose", "activate"]) {
    const f = servicesFixture(t, { activate: operation === "dispose" });
    const before = f.services.serialize(),
      bytes = f.coordinator.budget.totalBytes;
    const player = f.gameplay.prepareInventory(() => true);
    let accepted;
    const result = f.coordinator.commit([
      {
        ...player,
        validate: () => {
          accepted =
            operation === "dispose"
              ? f.services.dispose()
              : f.services.activate(f.game).ok;
          return player.validate();
        },
      },
    ]);
    assert.equal(accepted, false);
    assert.equal(result.ok, false);
    assert.equal(f.services.beds._disposed, false);
    assert.equal(f.services.worldClock._disposed, false);
    assert.equal(f.services.buildingActions._disposed, false);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.deepEqual(f.services.serialize(), before);
  }
});

test("frames advance only active simulation time and do not drive any other owner or timer", (t) => {
  const f = servicesFixture(t, { saved: { worldClock: state(0.5, 3) } });
  const original = f.services.serialize(),
    player = f.gameplay.serialize();
  for (const name of ["settlement", "brewing", "statusEffects"])
    f.game[name] = {
      update: () =>
        assert.fail(`${name} must receive dt only from the parent frame`),
    };
  for (const flag of ["paused", "building", "failed"]) {
    f.game[flag] = true;
    assert.equal(f.services.frame(60, { simulating: true }).advanced, false);
    f.game[flag] = false;
    assert.deepEqual(f.services.serialize(), original);
  }
  assert.equal(f.services.frame(60, { simulating: false }).advanced, false);
  for (const dt of [-1, NaN, Infinity])
    assert.equal(f.services.frame(dt, { simulating: true }).ok, false);
  assert.equal(f.services.frame(60, { simulating: true }).advanced, true);
  close(f.game.currentTime, 0.55);
  assert.equal(f.game.worldClock.day, 3);
  assert.equal(f.game.elapsed, 123);
  assert.deepEqual(f.gameplay.serialize(), player);
  assert.equal(
    f.calls.saves,
    0,
    "ordinary frame advancement does not schedule a save every tick"
  );
  f.gameplay.damage(100, "authored fixture");
  const deadClock = f.services.serialize().worldClock;
  assert.equal(f.services.frame(60, { simulating: true }).advanced, false);
  assert.deepEqual(f.services.serialize().worldClock, deadClock);
});

test("sleep changes spawn and calendar but never health, elapsed time, pose, effects or station work", (t) => {
  const f = servicesFixture(t);
  const { foot } = f.placeBed();
  f.gameplay.damage(5, "authored fixture");
  assert.equal(f.services.setTime(0.9).ok, true);
  const before = f.gameplay.serialize(),
    position = { ...f.player.position };
  const observed = [];
  f.game.scheduleSave = () =>
    observed.push({
      time: f.game.currentTime,
      saved: f.services.serialize(),
    });
  for (const name of ["settlement", "brewing", "statusEffects"])
    f.game[name] = {
      update: () =>
        assert.fail("sleep must not synthesize skipped simulation work"),
    };
  f.game.effects.update = () => assert.fail("sleep must not tick effects");
  const used = f.game.buildingActions.tryUse(foot);
  assert.equal(used.ok, true);
  assert.equal(used.slept, true);
  assert.deepEqual(f.game.worldClock.serialize(), state(DAWN_TIME, 1));
  assert.equal(f.game.currentTime, DAWN_TIME);
  assert.equal(f.game.elapsed, 123);
  assert.deepEqual(f.gameplay.serialize(), before);
  assert.deepEqual(f.player.position, position);
  assert.equal(f.game.beds.getRespawn().id, BLOCK.WHITE_BED);
  assert.ok(observed.length > 0);
  for (const observation of observed) {
    assert.equal(observation.time, DAWN_TIME);
    assert.deepEqual(observation.saved.worldClock, state(DAWN_TIME, 1));
    assert.equal(observation.saved.beds.spawn.id, BLOCK.WHITE_BED);
  }
});

test("a paused slider selects the next phase without rewinding the Java trading ledger", (t) => {
  const f = servicesFixture(t, { saved: { worldClock: state(0.9, 3) } });
  f.game.paused = true;
  let trader = {
    clock: f.services.clockProjection().tradingClock,
    restocks: 2,
    lastRestockTime: 8000,
  };
  assert.equal(f.services.setTime(0.1).ok, true);
  close(f.game.currentTime, 0.1);
  assert.equal(f.game.worldClock.day, 4);
  trader = {
    ...trader,
    ...advanceTraderCalendar(trader, f.services.clockProjection().tradingClock),
  };
  assert.equal(trader.restocks, 2);
  assert.equal(f.services.setTime(0.5).ok, true);
  trader = {
    ...trader,
    ...advanceTraderCalendar(trader, f.services.clockProjection().tradingClock),
  };
  assert.equal(trader.restocks, 0);
  assert.equal(f.services.setTime("0.5").ok, false);
  assert.equal(f.game.elapsed, 123);
});

test("observer exceptions do not reject activated or committed clock ownership and later observers still run", (t) => {
  const f = servicesFixture(t, { activate: false });
  const render = new Error("renderer"),
    hud = new Error("HUD"),
    save = new Error("save observer");
  f.game.graphics.setTime = () => {
    throw render;
  };
  const activated = f.services.activate(f.game);
  assert.equal(activated.ok, true);
  assert.deepEqual(activated.observerErrors, [render]);
  f.game.refreshHud = () => {
    throw hud;
  };
  f.game.scheduleSave = () => {
    throw save;
  };
  const changed = f.services.setTime(0.5);
  assert.equal(changed.ok, true);
  assert.equal(f.game.currentTime, 0.5);
  assert.equal(f.game.worldClock.time, 0.5);
  assert.equal(changed.observerErrors.length, 1);
  assert.deepEqual(changed.observerErrors[0].errors, [render, hud, save]);
  const frame = f.services.frame(1, { simulating: true });
  assert.equal(frame.ok, true);
  assert.equal(frame.advanced, true);
  close(f.game.currentTime, 0.5 + 1 / DAY_SECONDS);
  assert.deepEqual(frame.observerErrors[0].errors, [render]);
});

test("fatal observer invariants still propagate after the calendar publication", (t) => {
  const f = servicesFixture(t);
  const fatal = new TransactionInvariantError(
    "nested publication",
    new Error("injected")
  );
  f.game.graphics.setTime = () => {
    throw fatal;
  };
  assert.throws(
    () => f.services.setTime(0.5),
    (error) => error === fatal
  );
  assert.equal(f.game.worldClock.time, 0.5);
  assert.equal(f.game.currentTime, 0.5);
});

test("stale world replacement stops time, callbacks, archive projection and support work", (t) => {
  const f = servicesFixture(t),
    other = servicesFixture(t);
  const event = f.put(5, f.y + 1, 7, BLOCK.LADDER);
  const clock = f.services.worldClock.serialize(),
    calls = f.calls.projections.length;
  Object.assign(f.game, {
    world: other.world,
    gameplay: other.gameplay,
    buildingServices: other.services,
    buildingActions: other.services.buildingActions,
    beds: other.services.beds,
    worldClock: other.services.worldClock,
  });
  assert.equal(f.services.frame(60, { simulating: true }).ok, false);
  assert.equal(f.services.setTime(0.8).ok, false);
  assert.equal(f.services.onMutation(f.world, event), false);
  assert.equal(
    f.services.onChunkLoaded(other.world, other.admission(0, 0)),
    false
  );
  assert.throws(() => f.services.serialize(), /stale/);
  assert.deepEqual(f.services.worldClock.serialize(), clock);
  assert.equal(f.calls.projections.length, calls);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  assert.equal(f.services.dispose(), true);
  assert.equal(f.game.beds, other.services.beds);
  assert.equal(f.game.worldClock, other.services.worldClock);
});

test("replacement during loot preparation vetoes every participant without dropping into either world", (t) => {
  const f = servicesFixture(t),
    other = servicesFixture(t, { stage: false });
  f.put(5, f.y + 1, 7, BLOCK.LADDER);
  const prepare = f.game.prepareDropItems;
  let prepared = false;
  f.game.prepareDropItems = (...args) => {
    const participant = prepare(...args);
    prepared = true;
    f.game.world = other.world;
    return participant;
  };
  const result = drainSupport(f, () => prepared);
  assert.equal(result.support.ok, false);
  assert.equal(f.world.get(5, f.y + 1, 7), BLOCK.LADDER);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  assert.equal(other.drops(BLOCK.LADDER), 0);
});

test("replacement from a clock observer does not run later HUD/save observers against the new host", (t) => {
  const f = servicesFixture(t),
    other = servicesFixture(t, { stage: false });
  f.game.graphics.setTime = () => {
    f.game.world = other.world;
  };
  const changed = f.services.setTime(0.5);
  assert.equal(changed.ok, true);
  assert.equal(
    f.services.worldClock.time,
    0.5,
    "the committed calendar is not reported as rejected"
  );
  assert.equal(f.calls.hud, 0);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.services.active, false);
});

test("mutation and admission notifications only schedule work, including notifications from repairs", (t) => {
  const f = servicesFixture(t);
  let notificationDepth = 0,
    repairs = 0;
  const notify = f.world.onMutation;
  f.world.onMutation = (event) => {
    notificationDepth++;
    try {
      notify(event);
    } finally {
      notificationDepth--;
    }
  };
  const reconcile = f.services.buildingActions.reconcileSupport.bind(
    f.services.buildingActions
  );
  f.services.buildingActions.reconcileSupport = (...args) => {
    assert.equal(notificationDepth, 0);
    repairs++;
    return reconcile(...args);
  };
  f.put(5, f.y + 1, 7, BLOCK.LADDER);
  assert.equal(f.admit(0, 0), true);
  assert.equal(repairs, 0);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.ok(repairs > 0);
  drainSupport(f);
  assert.equal(f.drops(BLOCK.LADDER), 1);
});

test("a loot or World veto retains both bed halves, and later repair publishes one retained bed atomically", (t) => {
  for (const veto of ["loot", "world"]) {
    const f = servicesFixture(t);
    const { foot, head } = f.placeBed();
    f.put(foot.x, f.y, foot.z, BLOCK.AIR);
    const player = f.gameplay.serialize();
    const prepareDrops = f.game.prepareDropItems;
    const prepareWorld = f.world.prepareMutation.bind(f.world);
    let attempts = 0,
      fallback = 0;
    f.game.preparePlayerDrops = () => {
      fallback++;
      return null;
    };
    f.game.prepareDropItems = (...args) => {
      attempts++;
      assert.equal(f.world.get(foot.x, foot.y, foot.z), BLOCK.WHITE_BED);
      assert.equal(f.world.get(head.x, head.y, head.z), BLOCK.WHITE_BED);
      return veto === "loot" ? null : prepareDrops(...args);
    };
    if (veto === "world")
      f.world.prepareMutation = (...args) => {
        const participant = prepareWorld(...args);
        return participant && { ...participant, validate: () => false };
      };
    const rejected = drainSupport(f, () => attempts > 0);
    assert.equal(rejected.support.ok, false);
    assert.equal(
      fallback,
      0,
      "an explicit arbitrary-position reservation refusal has no fallback"
    );
    assert.equal(f.world.get(foot.x, foot.y, foot.z), BLOCK.WHITE_BED);
    assert.equal(f.world.get(head.x, head.y, head.z), BLOCK.WHITE_BED);
    assert.equal(f.drops(BLOCK.WHITE_BED), 0);
    f.world.prepareMutation = prepareWorld;
    f.game.prepareDropItems = (...args) => {
      const participant = prepareDrops(...args);
      return (
        participant && {
          ...participant,
          notify: () => {
            assert.equal(f.world.get(foot.x, foot.y, foot.z), BLOCK.AIR);
            assert.equal(f.world.get(head.x, head.y, head.z), BLOCK.AIR);
            assert.equal(f.drops(BLOCK.WHITE_BED), 1);
            participant.notify?.();
          },
        }
      );
    };
    const repaired = drainSupport(f, () => f.drops(BLOCK.WHITE_BED) === 1);
    assert.equal(repaired.support.removed, 2);
    assert.deepEqual(f.gameplay.serialize(), player);
    drainSupport(f);
    assert.equal(f.drops(BLOCK.WHITE_BED), 1);
  }
});

test("prepared source-position loot retains waterlogged ladder water and has no eager-only fallback", (t) => {
  const f = servicesFixture(t);
  f.put(5, f.y + 1, 7, BLOCK.LADDER, 0, FLUID.WATER_SOURCE);
  const prepare = f.game.prepareDropItems;
  delete f.game.prepareDropItems;
  delete f.game.preparePlayerDrops;
  f.game.dropItems = () =>
    assert.fail("eager drops are not a retention participant");
  let refused = false;
  for (let i = 0; i < 32 && !refused; i++)
    refused = f.services.frame(0, { simulating: true }).support.ok === false;
  assert.equal(refused, true);
  assert.equal(f.world.get(5, f.y + 1, 7), BLOCK.LADDER);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  f.game.prepareDropItems = prepare;
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(f.world.get(5, f.y + 1, 7), BLOCK.WATER);
  const entry = f.overflow.serialize().entries[0];
  assert.deepEqual([entry.x, entry.y, entry.z], [5.5, f.y + 1.5, 7.5]);
});

test("full save capacity leaves multipart repair owned by World until retained loot can fit", (t) => {
  const f = servicesFixture(t);
  const { foot, head } = f.placeBed();
  f.put(foot.x, f.y, foot.z, BLOCK.AIR);
  const filler = reserve(
    t,
    f.coordinator,
    MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
  );
  const before = f.snapshot(),
    prepare = f.game.prepareDropItems;
  let attempts = 0;
  f.game.prepareDropItems = (...args) => {
    attempts++;
    return prepare(...args);
  };
  const rejected = drainSupport(f, () => attempts > 0);
  assert.equal(rejected.support.ok, false);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.coordinator.budget.totalBytes, MAX_RESERVED_BYTES);
  assert.equal(f.coordinator.release(filler), true);
  drainSupport(f, () => f.drops(BLOCK.WHITE_BED) === 1);
  assert.equal(f.world.get(foot.x, foot.y, foot.z), BLOCK.AIR);
  assert.equal(f.world.get(head.x, head.y, head.z), BLOCK.AIR);
});

test("a host with only the existing prepared player-retention callback still retains support loot", (t) => {
  const f = servicesFixture(t);
  delete f.game.prepareDropItems;
  f.put(5, f.y + 1, 7, BLOCK.LADDER);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(f.world.get(5, f.y + 1, 7), BLOCK.AIR);
  const entry = f.overflow.serialize().entries[0];
  assert.equal(entry.x, f.player.position.x);
  assert.equal(entry.z, f.player.position.z);
});

test("post-publication observer failures do not retry already committed support loot", (t) => {
  const f = servicesFixture(t),
    error = new Error("world observer");
  const notify = f.world.onMutation;
  f.world.onMutation = (event) => {
    notify(event);
    if (
      event.changes.some(
        (change) =>
          change.before.id === BLOCK.LADDER && change.after.id === BLOCK.AIR
      )
    )
      throw error;
  };
  f.put(5, f.y + 1, 7, BLOCK.LADDER);
  const repaired = drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(repaired.support.ok, true);
  assert.ok(repaired.observerErrors.includes(error));
  drainSupport(f);
  assert.equal(f.drops(BLOCK.LADDER), 1);
});

test("unloaded boundary geometry is deferred, then a neighbor admission repairs it even after coarse saturation", async (t) => {
  const f = servicesFixture(t, {
    support: { columns: 1, cells: 1, scanCells: 16384 },
  });
  f.put(15, f.y + 1, 7, BLOCK.LADDER, 3);
  drainSupport(f);
  assert.equal(f.world.get(15, f.y + 1, 7), BLOCK.LADDER);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  assert.equal(f.services.supportStatus().deferredColumns, 1);
  const requests = f.world._requests.size;
  assert.equal(f.services.frame(0, { simulating: true }).support.checked, 0);
  assert.equal(
    f.world._requests.size,
    requests,
    "deferred repair does not request chunks"
  );
  await f.world.ensureArea({ x: 16.5, z: 7.5 }, 0);
  assert.equal(f.world.get(15, f.y + 1, 7), BLOCK.LADDER);
  assert.equal(f.admit(1, 0), true);
  assert.equal(f.services.supportStatus().coarsened, true);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(f.world.get(15, f.y + 1, 7), BLOCK.AIR);
});

test("bounded fine-queue overflow makes forward scan progress, including a one-candidate frame limit", (t) => {
  const f = servicesFixture(t, {
    support: {
      cells: 1,
      columns: 1,
      candidates: 1,
      scanCells: 128,
      mutationChanges: 1,
    },
  });
  for (const x of [5, 6, 7]) f.put(x, f.y + 1, 7, BLOCK.LADDER);
  assert.equal(f.services.supportStatus().coarsened, true);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 3, 128);
  for (const x of [5, 6, 7])
    assert.equal(f.world.get(x, f.y + 1, 7), BLOCK.AIR);
});

test("saturated admission queues recover across all resident columns rather than keeping only the last one", (t) => {
  const f = servicesFixture(t, {
    radius: 1,
    support: { columns: 1, scanCells: 16384 },
  });
  f.put(5, f.y + 1, 7, BLOCK.LADDER);
  f.put(21, f.y + 1, 7, BLOCK.LADDER);
  for (const chunk of f.world.chunks.values())
    assert.equal(f.admit(chunk.cx, chunk.cz), true);
  assert.equal(f.services.supportStatus().coarsened, true);
  assert.ok(f.services.supportStatus().queuedColumns <= 1);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 2);
  assert.equal(f.world.get(5, f.y + 1, 7), BLOCK.AIR);
  assert.equal(f.world.get(21, f.y + 1, 7), BLOCK.AIR);
});

test("eviction/readmission rejects old incarnation events and rechecks saved support ownership", async (t) => {
  const f = servicesFixture(t);
  const mutation = f.put(5, f.y + 1, 7, BLOCK.LADDER);
  const oldAdmission = f.admission(0, 0);
  f.world._removeChunk("0,0", f.world.chunks.get("0,0"));
  drainSupport(f);
  assert.equal(supportIdle(f.services), true);
  assert.equal(f.drops(BLOCK.LADDER), 0);
  await f.world.ensureArea({ x: 5.5, z: 7.5 }, 0);
  assert.notEqual(f.admission(0, 0).incarnation, oldAdmission.incarnation);
  assert.equal(f.services.onChunkLoaded(f.world, oldAdmission), false);
  assert.equal(f.admit(0, 0), true);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(
    f.services.onMutation(f.world, mutation),
    true,
    "replayed coordinates only recheck current cells"
  );
  drainSupport(f);
  assert.equal(f.drops(BLOCK.LADDER), 1);
});

test("dimension epochs discard old work and readmission later recovers that dimension's saved blocks", (t) => {
  const f = servicesFixture(t);
  const event = f.put(5, f.y + 1, 7, BLOCK.LADDER);
  const clock = f.game.worldClock.serialize();
  f.world.setDimension("nether").generate(0);
  assert.equal(f.services.onMutation(f.world, event), false);
  assert.equal(f.services.frame(0, { simulating: true }).ok, true);
  assert.equal(f.services.supportStatus().epoch, f.world.epoch);
  assert.equal(f.services.supportStatus().dimension, "nether");
  assert.equal(f.drops(BLOCK.LADDER), 0);
  assert.deepEqual(f.game.worldClock.serialize(), clock);
  f.world.setDimension("overworld").generate(0);
  drainSupport(f, () => f.drops(BLOCK.LADDER) === 1);
  assert.equal(f.overflow.serialize().entries[0].dimension, "overworld");
});
