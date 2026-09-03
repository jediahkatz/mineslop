import assert from "node:assert/strict";
import { BuildingActions } from "../src/building-actions.js";
import { BLOCK } from "../src/blocks.js";
import { cellsEqual, normalizeCell } from "../src/block-state.js";
import { intersectsPlacement } from "../src/collision.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { Gameplay } from "../src/gameplay.js";
import { cloneStack } from "../src/inventory-slots.js";
import { WorldClock } from "../src/world-clock.js";
import { createWorldContext } from "../src/world-spec.js";
import { fixtureWorld } from "./world-foundation-fixtures.js";

/** Real coordinator, inventory, overflow, World and geometry; no renderer/generator claim. */
export function buildingFixture(t, options = {}) {
  const world = fixtureWorld(t, { generatorVersion: 4, ...options }).generate(
    1
  );
  const context = createWorldContext(world);
  const coordinator = world.coordinator;
  const gameplay = new Gameplay({ coordinator, context });
  const clock = new WorldClock({ coordinator });
  const overflow = new DropOverflow({ coordinator, context });
  const position = { x: 8.5, y: 23, z: 8.5 };
  Object.defineProperty(position, "clone", {
    value: () => ({ x: position.x, y: position.y, z: position.z }),
  });
  const calls = {
    teleports: [],
    sounds: [],
    saves: 0,
    rebuilds: 0,
    explosions: [],
  };
  const player = {
    position,
    forward: { x: 0, y: 0, z: -1 },
    yaw: 1.8,
    pitch: 0,
    height: 1.8,
    flying: false,
    enabled: true,
    intersectsPlacement: (changes) =>
      intersectsPlacement(world, position, changes, {
        radius: 0.3,
        height: 1.8,
      }),
    setPosition({ x, y, z }) {
      calls.teleports.push({ x, y, z });
      Object.assign(position, { x, y, z });
    },
    unlock() {},
    update() {},
  };
  const game = {
    world,
    worldContext: context,
    coordinator,
    gameplay,
    player,
    worldClock: clock,
    building: false,
    elapsed: 123,
    currentTime: clock.time,
    wildlife: { entities: [], dimension: world.dimension },
    effects: { offhand: {}, sound: (...args) => calls.sounds.push(args) },
    graphics: { rebuildDirty: () => calls.rebuilds++ },
    scheduleSave: () => calls.saves++,
    refreshHud() {},
    updateTarget() {},
    preparePlayerDrops: (stacks) =>
      overflow.prepareEnqueue(stacks, position, world.dimension),
    explode: (at, radius, damagePlayer) =>
      calls.explosions.push({ at, radius, damagePlayer }),
  };
  const actions = new BuildingActions(game);
  game.buildingActions = actions;
  game.beds = actions.beds;
  t.after(() => {
    actions.dispose();
    gameplay.dispose();
    clock.dispose();
    overflow.dispose();
  });
  const put = (x, y, z, id, state = 0, fluid) => {
    const after = normalizeCell({
      id,
      state,
      ...(fluid === undefined ? {} : { fluid }),
    });
    const before = world.getCell(x, y, z);
    if (cellsEqual(before, after)) return;
    assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
  };
  const floor = (y = 20, from = -2, to = 10) => {
    const changes = [];
    for (let x = from; x <= to; x++)
      for (let z = from; z <= to; z++) {
        const before = world.getCell(x, y, z);
        const after = normalizeCell({ id: BLOCK.STONE });
        if (!cellsEqual(before, after))
          changes.push({ x, y, z, before, after });
      }
    if (changes.length) assert.equal(world.applyCells(changes), true);
  };
  const hold = (id, count = 8, hand = "main", data) => {
    const participant = gameplay.prepareInventory((owned) => {
      const stack = cloneStack(
        { id, count, ...(data ? { data } : {}) },
        context
      );
      if (hand === "offhand") owned.offhand = stack;
      else owned.slots[gameplay.selected] = stack;
      return true;
    });
    assert.ok(participant);
    assert.equal(coordinator.commit([participant]).ok, true);
  };
  const hit = (
    x = 2,
    y = 20,
    z = 3,
    normal = { x: 0, y: 1, z: 0 },
    localPoint = { x: 0.5, y: 1, z: 0.5 }
  ) => ({
    x,
    y,
    z,
    id: world.get(x, y, z),
    normal,
    localPoint,
    dimension: world.dimension,
  });
  const snapshot = () => ({
    world: world.serialize(),
    gameplay: gameplay.serialize(),
    beds: actions.beds.serialize(),
    clock: clock.serialize(),
    overflow: overflow.serialize(),
  });
  put(2, 20, 3, BLOCK.STONE);
  return {
    world,
    context,
    coordinator,
    gameplay,
    clock,
    overflow,
    game,
    player,
    actions,
    beds: actions.beds,
    calls,
    put,
    floor,
    hold,
    hit,
    snapshot,
  };
}

export function placedBed(t, options) {
  const fixture = buildingFixture(t, options);
  fixture.floor();
  fixture.hold(BLOCK.WHITE_BED, 2);
  assert.equal(
    fixture.actions.place("main", BLOCK.WHITE_BED, fixture.hit()),
    true
  );
  Object.assign(fixture.player.position, { x: 4.5, y: 21.01, z: 3.5 });
  return {
    ...fixture,
    foot: fixture.hit(2, 21, 3),
    head: fixture.hit(2, 21, 2),
  };
}
