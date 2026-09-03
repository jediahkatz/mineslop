import assert from "node:assert/strict";
import { CombatRuntime } from "../src/combat-runtime.js";
import { captureEntityContext } from "../src/entity-context.js";
import { Gameplay } from "../src/gameplay.js";
import { ProgressionGearEffects } from "../src/progression-gear-effects.js";
import { StatusEffects } from "../src/status-effects.js";
import { createWorldContext } from "../src/world-spec.js";
import { combatWorld } from "./combat-collision-fixtures.js";

/**
 * DATA-OWNER SCOPE ONLY: real World/coordinator/geometry, opaque actor identity
 * observations, and (when needed) actual Gameplay/gear health preparations.
 * No Game bridge, canonical mob routing, source authorization or playable
 * friendly fire is asserted. A Gameplay health peer demonstrates composition,
 * NOT that an opaque mob descriptor is authorized to use that victim owner.
 */
export function runtimeActorFixture(world, changes = {}) {
  const actor = {
    kind: "mob", id: "runtime/mob/source", ref: {}, incarnation: 1,
    dimension: world.dimension, worldEpoch: world.epoch,
    box: [1, 19, 4, 2, 21, 5], ...changes,
  };
  if (actor.kind === "player" && actor.life === undefined) actor.life = 3;
  return actor;
}

const sameIdentity = (a, b) => !!a && ["kind", "id", "ref", "incarnation", "dimension", "worldEpoch", "life"]
  .every((field) => (a[field] ?? null) === (b[field] ?? null));

export function combatRuntimeFixture(t) {
  const world = combatWorld(t), context = createWorldContext(world);
  const runtime = new CombatRuntime({ world, context }), coordinator = world.coordinator;
  t.after(() => runtime.dispose());
  const source = runtimeActorFixture(world);
  const target = runtimeActorFixture(world, {
    kind: "player", id: "local-player", box: [7, 19, 4, 8, 21, 5],
  });
  const worldGuard = captureEntityContext(world, context);
  const f = { world, context, runtime, coordinator, source, target, roster: [source, target],
    difficulty: { value: "normal", revision: 0 } };
  f.guard = (...actors) => {
    const pinned = actors.map((actor) => ({ ...actor }));
    const { value, revision } = f.difficulty;
    return () => worldGuard() && runtime.available &&
      f.difficulty.value === value && f.difficulty.revision === revision &&
      pinned.every((actor) => f.roster.some((current) => sameIdentity(current, actor)));
  };
  f.readCandidates = () => f.roster.map((actor) => ({ ...actor, box: [...actor.box] }));
  f.commit = (plan) => {
    assert.equal(plan?.ok, true, plan?.reason);
    assert.equal(new Set(plan.participants.map((part) => part.owner)).size, plan.participants.length);
    const result = coordinator.commit(plan.participants);
    assert.equal(result.ok, true, result.reason);
    return result;
  };
  f.sync = (actors) => {
    f.roster = actors;
    const batch = runtime.begin(), captured = actors.slice(), identities = f.guard(...actors);
    assert.equal(batch.syncActors(actors, {
      validate: () => identities() && f.roster.length === captured.length,
    }).ok, true);
    f.commit(batch.finalize());
  };
  f.provenance = (attackKind = "arrow", changes = {}) => ({
    attackKind, responsible: source,
    responsibleSpecies: attackKind === "blaze_fireball" ? "blaze"
      : attackKind.startsWith("ghast") ? "ghast"
        : attackKind === "creeper_explosion" ? "creeper" : "skeleton",
    playerOwnerId: null, sourcePosition: { x: 4, y: 20, z: 4.5 },
    rawDamage: attackKind === "blaze_fireball" ? 5 : 2,
    impulse: { x: 0, y: 0, z: 0 },
    effects: attackKind === "blaze_fireball" ? [{ kind: "fire", durationSeconds: 4 }] : [],
    damageOverTime: attackKind === "fire_tick", ...changes,
  });
  f.shotSpec = (kind = "arrow", changes = {}) => ({
    provenance: f.provenance(kind), position: { x: 4, y: 20, z: 4.5 },
    velocity: { x: kind === "blaze_fireball" ? 9 : kind === "ghast_fireball" ? 6 : 12, y: 0, z: 0 },
    // Authored scalar probe sizes, NOT a resolution of the legacy-radius gate.
    radius: kind === "blaze_fireball" ? 0.15 : 0.125,
    gravity: kind === "arrow" ? 2.8 : 0, ttl: kind === "blaze_fireball" ? 3 : 6,
    sourceEnvelope: null, difficulty: f.difficulty.value, validate: f.guard(source), ...changes,
  });
  f.launch = (kind = "arrow", changes = {}) => {
    const batch = runtime.begin(), result = batch.launch(f.shotSpec(kind, changes));
    assert.equal(result.ok, true, result.reason);
    f.commit(batch.finalize());
    return result.ticket;
  };
  f.motionOptions = (ticket, changes = {}) => ({
    to: { x: 10, y: 20, z: 4.5 }, velocity: runtime.shot(ticket).velocity,
    readCandidates: f.readCandidates, difficulty: f.difficulty.value, validate: f.guard(), ...changes,
  });
  f.present = (ticket) => {
    // Authored completed observation tests the gate; this is NOT a renderer demo.
    const completed = { ticket, done: true }, current = f.guard();
    const batch = runtime.begin(), result = batch.acknowledgePresentation(ticket, {
      validateCompleted: () => current() && completed.done && completed.ticket === ticket,
    });
    assert.equal(result.ok, true, result.reason);
    f.commit(batch.finalize());
    return result.ticket;
  };
  f.pending = (kind = "arrow", changes = {}) => {
    let ticket = f.launch(kind, changes);
    if (kind === "blaze_fireball") ticket = f.present(ticket);
    const batch = runtime.begin(), result = batch.motion(ticket, f.motionOptions(ticket));
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.kind, "contact");
    f.commit(batch.finalize());
    return result.ticket;
  };
  f.advance = (dt) => {
    const batch = runtime.begin();
    assert.equal(batch.advanceClocks(dt, { validate: f.guard() }).ok, true);
    return f.commit(batch.finalize());
  };
  f.blastSpec = (actors = [target], changes = {}) => ({
    provenance: f.provenance("creeper_explosion"), center: { x: 7, y: 20, z: 4.5 },
    radius: 1.8, ttl: 1,
    victims: actors.map((actor) => ({ actor, exposure: 1, rawDamage: 2 })),
    difficulty: f.difficulty.value, validate: f.guard(...actors, source), ...changes,
  });
  f.blast = (actors = [target], changes = {}) => {
    const batch = runtime.begin(), result = batch.admitBlast(f.blastSpec(actors, changes));
    assert.equal(result.ok, true, result.reason);
    f.commit(batch.finalize());
    return result.ticket;
  };
  f.sync(f.roster);
  return f;
}

/** Actual prepared owner result/participants; never a fake health success. */
export function runtimeHealthPeer(t, f) {
  const hurt = [];
  const gameplay = new Gameplay({ coordinator: f.coordinator, context: f.context,
    onHurt: (event) => hurt.push(event) });
  const effects = new StatusEffects({ coordinator: f.coordinator });
  const gear = new ProgressionGearEffects(gameplay, effects, null);
  t.after(() => { effects.dispose(); gameplay.dispose(); });
  return {
    gameplay, effects, hurt,
    prepare(quote, validate = f.guard()) {
      assert.equal(quote.ok, true, quote.reason);
      const plan = gear.prepareDamage(quote.preArmorDamage, {
        validate, kind: quote.adjusted.damageType, isFire: quote.adjusted.isFire,
        cause: "runtime-data-owner-fixture",
      });
      assert.equal(plan?.ok, true, "real owner must prepare the health edit");
      return plan;
    },
  };
}

export function assertRuntimeScalars(value) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  for (const [key, child] of Object.entries(value)) {
    assert.notEqual(key, "ref", "views must not publish canonical refs");
    assert.notEqual(typeof child, "function");
    assertRuntimeScalars(child);
  }
}
