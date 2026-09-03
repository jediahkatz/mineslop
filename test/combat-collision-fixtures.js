import assert from "node:assert/strict";
import { normalizeCell } from "../src/block-state.js";
import { traceCombatSegment } from "../src/combat-collision.js";
import { World } from "../src/world.js";
import { emptyFixtureGenerator } from "./world-foundation-fixtures.js";

/** Real World admissions/mutations with authored empty terrain, NOT mock damage
 * owners, natural spawning, launch authority, or a playable-friendly-fire test.
 */
export function combatWorld(t, options = {}) {
  const world = new World("combat-collision-fixture", {
    generatorVersion: 4, useWorker: false, generatorFactory: emptyFixtureGenerator,
    ...options,
  });
  world.generate(1);
  t.after(() => world.dispose());
  return world;
}

export function combatCell(world, x, y, z, id, state = 0, fluid) {
  assert.equal(world.applyCells([{
    x, y, z, before: world.getCell(x, y, z),
    after: normalizeCell({ id, state, fluid }),
  }]), true, "authored geometry uses a real World mutation");
}

/** Opaque identity + scalar collider, not a fabricated successful owner plan. */
export function combatActor(world, overrides = {}) {
  const actor = {
    kind: "mob", id: "combat/actor/target", incarnation: 1,
    ref: Object.freeze({}), dimension: world.dimension, worldEpoch: world.epoch,
    box: Object.freeze([7, 19, 4, 8, 22, 5]), ...overrides,
  };
  if (actor.kind === "player" && actor.life === undefined) actor.life = 0;
  return Object.freeze(actor);
}

export function combatFacts(world, overrides = {}) {
  return Object.freeze({
    world,
    ticket: Object.freeze({
      id: "combat/contact/6e0d261c-86a2-4383-89f0-9162c1c10662",
      runtimeEpoch: 1, revision: 0,
    }),
    from: Object.freeze({ x: 4, y: 20, z: 4.5 }),
    to: Object.freeze({ x: 10, y: 20, z: 4.5 }),
    radius: 0.125,
    candidates: Object.freeze([]),
    sourceEnvelope: null,
    ...overrides,
  });
}

/** Static roster reader for geometry-only cases; guard tests supply fresh facts. */
export const combatTrace = (facts) => traceCombatSegment(facts, () => facts);

export function combatClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-9, `${actual} != ${expected}`);
}

export function assertCombatScalars(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), "all exposed records/arrays must be frozen");
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "ref", "canonical mutable actor identity must stay private");
    if (key === "validate") assert.equal(typeof child, "function");
    else {
      assert.notEqual(typeof child, "function");
      assertCombatScalars(child);
    }
  }
}
