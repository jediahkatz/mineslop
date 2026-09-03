import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { intersectsPlacement } from "../src/collision.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { GameBuildingServices } from "../src/game-building-services.js";
import { GameInventoryActions } from "../src/game-inventory-actions.js";
import { Gameplay } from "../src/gameplay.js";
import { createWorldContext } from "../src/world-spec.js";
import { fixtureWorld } from "./world-foundation-fixtures.js";

/** Authored empty columns, real owners/geometry/loot bridge; no natural terrain or GUI. */
export function servicesFixture(
  t,
  {
    stage = true,
    activate = true,
    saved,
    support,
    generatorVersion = 4,
    radius = 0,
  } = {}
) {
  const world = fixtureWorld(t, { generatorVersion }).generate(radius);
  const context = createWorldContext(world),
    coordinator = world.coordinator;
  const gameplay = new Gameplay({ coordinator, context });
  const overflow = new DropOverflow({ coordinator, context });
  const y = world.minY + 4;
  const position = { x: 8.5, y: y + 3, z: 8.5 };
  const calls = {
    saves: 0,
    hud: 0,
    projections: [],
    mutations: [],
    toasts: [],
    explosions: [],
  };
  const player = {
    position,
    forward: { x: 0, y: 0, z: -1 },
    get eyePosition() {
      return { ...position, y: position.y + 1.62 };
    },
    intersectsPlacement: (changes) =>
      intersectsPlacement(world, position, changes, {
        radius: 0.3,
        height: 1.8,
      }),
  };
  const game = {
    world,
    worldContext: context,
    coordinator,
    gameplay,
    overflow,
    player,
    paused: false,
    building: false,
    failed: false,
    elapsed: 123,
    currentTime: 0.99,
    lastOverflowToast: 0,
    get simulating() {
      return !this.paused && !this.building && !this.gameplay.dead;
    },
    graphics: {
      setTime: (time) => calls.projections.push(time),
      rebuildDirty() {},
    },
    ui: { toast: (message) => calls.toasts.push(message) },
    wildlife: { dimension: world.dimension, entities: [] },
    effects: { offhand: {}, sound() {} },
    scheduleSave: () => {
      calls.saves++;
    },
    refreshHud: () => {
      calls.hud++;
    },
    updateTarget() {},
    explode: (...args) => calls.explosions.push(args),
  };
  const inventory = new GameInventoryActions(game);
  game.prepareDropItems = (...args) => inventory.prepareDropItems(...args);
  game.preparePlayerDrops = (...args) => inventory.preparePlayerDrops(...args);
  const f = {
    world,
    context,
    coordinator,
    gameplay,
    overflow,
    player,
    game,
    calls,
    y,
    services: null,
  };
  // Explicit parent-style multiplexing, not a subscription installed by the adapter.
  world.onMutation = (event) => {
    calls.mutations.push(event);
    f.services?.onMutation(world, event);
  };
  f.create = (options = {}) => {
    const service = new GameBuildingServices({
      world,
      gameplay,
      context,
      ...options,
    });
    t.after(() => service.dispose());
    return service;
  };
  if (stage) {
    f.services = f.create({ saved, support });
    if (activate) assert.equal(f.services.activate(game).ok, true);
  }
  t.after(() => {
    gameplay.dispose();
    overflow.dispose();
  });
  f.put = (x, atY, z, id, state = 0, fluid) => {
    const before = world.getCell(x, atY, z);
    const after = normalizeCell({
      id,
      state,
      ...(fluid === undefined ? {} : { fluid }),
    });
    if (cellsEqual(before, after)) return null;
    assert.equal(world.applyCells([{ x, y: atY, z, before, after }]), true);
    return calls.mutations.at(-1);
  };
  f.hit = (x = 5, atY = y, z = 7) => ({
    x,
    y: atY,
    z,
    id: world.get(x, atY, z),
    dimension: world.dimension,
    normal: { x: 0, y: 1, z: 0 },
    localPoint: { x: 0.5, y: 1, z: 0.5 },
  });
  f.hold = (id, count = 2) => {
    const participant = gameplay.prepareInventory((owned) => {
      owned.slots[gameplay.selected] = { id, count };
      return true;
    });
    assert.ok(participant);
    assert.equal(coordinator.commit([participant]).ok, true);
  };
  f.placeBed = () => {
    const changes = [];
    for (let x = 3; x <= 8; x++)
      for (let z = 4; z <= 9; z++)
        changes.push({
          x,
          y,
          z,
          before: world.getCell(x, y, z),
          after: normalizeCell({ id: BLOCK.STONE }),
        });
    assert.equal(world.applyCells(changes), true);
    f.hold(BLOCK.WHITE_BED);
    assert.equal(
      f.services.buildingActions.place("main", BLOCK.WHITE_BED, f.hit()),
      true
    );
    Object.assign(position, { x: 7.5, y: y + 1.01, z: 7.5 });
    return { foot: f.hit(5, y + 1, 7), head: f.hit(5, y + 1, 6) };
  };
  f.admission = (cx, cz) => ({
    epoch: world.epoch,
    dimension: world.dimension,
    cx,
    cz,
    incarnation: world.chunks.get(`${cx},${cz}`)?.incarnation,
  });
  f.admit = (cx, cz) => f.services.onChunkLoaded(world, f.admission(cx, cz));
  f.drops = (id) =>
    overflow
      .serialize()
      .entries.filter((entry) => entry.id === id)
      .reduce((sum, entry) => sum + entry.count, 0);
  f.snapshot = () => ({
    world: world.serialize(),
    gameplay: gameplay.serialize(),
    overflow: overflow.serialize(),
    ...(f.services ? { building: f.services.serialize() } : {}),
  });
  return f;
}

export function supportIdle(service) {
  const work = service.supportStatus();
  return (
    !work.queuedCells &&
    !work.queuedColumns &&
    !work.scanning &&
    !work.recovering &&
    !work.recoveryRequested
  );
}

export function drainSupport(
  f,
  until = () => supportIdle(f.services),
  maxFrames = 1024
) {
  let result;
  for (let frame = 0; frame < maxFrames && !until(); frame++) {
    result = f.services.frame(0, { simulating: true });
    assert.equal(result.ok, true);
    assert.ok(result.support.scanned <= f.services.limits.scanCells);
    assert.ok((result.support.checked ?? 0) <= f.services.limits.candidates);
    const work = f.services.supportStatus();
    assert.ok(work.queuedCells <= f.services.limits.cells);
    assert.ok(work.queuedColumns <= f.services.limits.columns);
    assert.ok(work.deferredColumns <= f.services.limits.columns);
  }
  assert.equal(
    until(),
    true,
    "bounded fixture repair eventually reaches its expected state"
  );
  return result;
}
