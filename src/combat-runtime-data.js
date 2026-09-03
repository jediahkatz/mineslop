import { COMBAT_COLLISION_LIMITS } from "./combat-collision.js";
import { BLAZE_IMPACT_DAMAGE, classifyCombatAttack, combatVictimOwner } from "./combat-rules.js";
import { dataRecord, synchronous } from "./enchantment-domain.js";
import { validPearlLife, validPearlOwnerId } from "./pearl-save.js";
import { progressArray } from "./progression-common.js";
import { isWorldPose } from "./world-spec.js";

/** Allocation/validation ceilings, NOT new flight, damage or AI policy. */
export const COMBAT_RUNTIME_LIMITS = Object.freeze({
  legacyShots: 12, blazeShots: 12, actors: 29, mobs: 28, players: 1,
  blasts: 4, victimsPerBlast: 29, derived: 8,
  shotSeconds: 6, blazeSeconds: 3, blastSeconds: 1, derivedSeconds: 0.5,
  batchOperations: 128, readGuards: 256, peerParticipants: 128,
  rawDamage: 1024, vectorMagnitude: 64, gravity: 64, blastRadius: 16,
});

export const checkRuntime = (condition, reason) => {
  if (!condition) throw new RangeError(reason);
};
export const runtimeRefusal = (reason) => Object.freeze({ ok: false, reason });
export const runtimeSuccess = (fields = {}) => Object.freeze({ ok: true, ...fields });
export const integer = (value) => Number.isSafeInteger(value) && value >= 0;
export const finite = (value, maximum = Infinity) =>
  Number.isFinite(value) && value >= 0 && value <= maximum;
export const runtimeId = (value) => typeof value === "string" &&
  value.length > 0 && value.length <= COMBAT_COLLISION_LIMITS.idLength;
export const actorKey = (actor) => JSON.stringify([actor.kind, actor.id]);
export const guardFunction = (value) => {
  checkRuntime(synchronous(value), "read-guard-required");
  return value;
};
export const runtimeFields = (value, fields) => dataRecord(value, fields, "combat runtime data");

export const runtimeArray = (value, maximum) => progressArray(value, maximum);

export function runtimePoint(value, scope) {
  runtimeFields(value, ["x", "y", "z"]);
  checkRuntime(isWorldPose(value, scope.context, scope.dimension), "invalid-point");
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

export function runtimeVector(value) {
  runtimeFields(value, ["x", "y", "z"]);
  checkRuntime(["x", "y", "z"].every((axis) => Number.isFinite(value[axis])) &&
    Math.hypot(value.x, value.y, value.z) <= COMBAT_RUNTIME_LIMITS.vectorMagnitude,
  "invalid-vector");
  return Object.freeze({ x: value.x, y: value.y, z: value.z });
}

export const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;

/** Only the descriptor is frozen. The canonical ref is NEVER traversed. */
export function runtimeActor(value, scope) {
  runtimeFields(value, ["kind", "id", "ref", "incarnation", "dimension", "worldEpoch", "life", "box"]);
  checkRuntime(["mob", "player"].includes(value.kind) && runtimeId(value.id) &&
    value.ref !== null && typeof value.ref === "object" &&
    integer(value.incarnation) && value.dimension === scope.dimension &&
    value.worldEpoch === scope.worldEpoch &&
    (value.kind === "player" ? validPearlLife(value.life) : value.life == null),
  "invalid-actor");
  return Object.freeze({
    kind: value.kind, id: value.id, ref: value.ref, incarnation: value.incarnation,
    dimension: value.dimension, worldEpoch: value.worldEpoch,
    life: value.kind === "player" ? value.life : null,
  });
}

export const sameActor = (a, b) => !!a && !!b &&
  a.kind === b.kind && a.id === b.id && a.ref === b.ref &&
  a.incarnation === b.incarnation && a.dimension === b.dimension &&
  a.worldEpoch === b.worldEpoch && a.life === b.life;

export function actorView(actor) {
  if (!actor) return null;
  const { kind, id, incarnation, dimension, worldEpoch, life } = actor;
  return Object.freeze({ kind, id, incarnation, dimension, worldEpoch, life });
}

export function runtimeActors(values, scope) {
  runtimeArray(values, COMBAT_RUNTIME_LIMITS.actors);
  const actors = values.map((value) => runtimeActor(value, scope));
  checkRuntime(new Set(actors.map(actorKey)).size === actors.length &&
    new Set(actors.map((actor) => actor.ref)).size === actors.length,
  "duplicate-actor");
  checkRuntime(actors.filter((actor) => actor.kind === "mob").length <= COMBAT_RUNTIME_LIMITS.mobs &&
    actors.filter((actor) => actor.kind === "player").length <= COMBAT_RUNTIME_LIMITS.players,
  "actor-capacity");
  return actors;
}

export function runtimeEnvelope(value, scope) {
  if (value === null) return null;
  runtimeFields(value, ["exited", "box", "members"]);
  const box = runtimeArray(value.box, 6).slice();
  checkRuntime(box.length === 6 && box.every(Number.isFinite) &&
    [0, 1, 2].every((axis) => box[axis] < box[axis + 3] &&
      box[axis + 3] - box[axis] <= COMBAT_COLLISION_LIMITS.actorExtent) &&
    typeof value.exited === "boolean", "invalid-envelope");
  runtimePoint({ x: box[0], y: box[1], z: box[2] }, scope);
  runtimePoint({ x: box[3], y: box[4], z: box[5] }, scope);
  const members = runtimeActors(runtimeArray(value.members, COMBAT_COLLISION_LIMITS.envelopeMembers), scope);
  checkRuntime(members.length > 0, "empty-envelope");
  return Object.freeze({ exited: value.exited, box: Object.freeze(box), members: Object.freeze(members) });
}

/**
 * Detached, immutable provenance, not authorization or a reward grant.
 * Only the existing four-second blaze payload is supported; no burn cadence,
 * overlap/refresh policy, TNT migration, arbitrary status payload or RNG quote.
 */
export function runtimeProvenance(value, scope) {
  runtimeFields(value, ["attackKind", "responsible", "responsibleKind", "responsibleSpecies", "playerOwnerId",
    "sourcePosition", "rawDamage", "impulse", "effects", "damageOverTime"]);
  const responsible = value.responsible === null ? null : runtimeActor(value.responsible, scope);
  const responsibleKind = responsible?.kind ?? "environment";
  checkRuntime(value.responsibleKind === undefined || value.responsibleKind === responsibleKind,
    "mismatched-responsibility");
  classifyCombatAttack({ attackKind: value.attackKind, responsibleKind, victimKind: "player" });
  checkRuntime(value.attackKind !== "tnt_explosion", "tnt-provenance-deferred");
  checkRuntime(finite(value.rawDamage, COMBAT_RUNTIME_LIMITS.rawDamage), "invalid-raw-damage");
  if (responsibleKind === "mob")
    combatVictimOwner({ kind: "mob", species: value.responsibleSpecies });
  else checkRuntime(value.responsibleSpecies === null, "invalid-source-species");
  checkRuntime(value.playerOwnerId === null ||
    (validPearlOwnerId(value.playerOwnerId) &&
      (responsibleKind === "player" || value.responsibleSpecies === "wolf")),
  "invalid-reward-provenance");
  checkRuntime(value.damageOverTime === (value.attackKind === "fire_tick"), "invalid-dot-provenance");
  const effects = runtimeArray(value.effects, 1).map((effect) => {
    runtimeFields(effect, ["kind", "durationSeconds"]);
    checkRuntime(value.attackKind === "blaze_fireball" && effect.kind === "fire" &&
      effect.durationSeconds === 4, "unsupported-effect-payload");
    return Object.freeze({ kind: "fire", durationSeconds: 4 });
  });
  checkRuntime(value.attackKind !== "blaze_fireball" ||
    (value.rawDamage === BLAZE_IMPACT_DAMAGE && effects.length === 1), "invalid-blaze-payload");
  return Object.freeze({
    attackKind: value.attackKind, responsible, responsibleKind,
    responsibleSpecies: value.responsibleSpecies, playerOwnerId: value.playerOwnerId,
    sourcePosition: runtimePoint(value.sourcePosition, scope), rawDamage: value.rawDamage,
    impulse: runtimeVector(value.impulse), effects: Object.freeze(effects),
    damageOverTime: value.damageOverTime,
  });
}

export function provenanceView(value) {
  return Object.freeze({ ...value, responsible: actorView(value.responsible) });
}

export function runtimeLifetime(duration, maximum) {
  checkRuntime(finite(duration, maximum) && duration > 0, "invalid-lifetime");
  return Object.freeze({ duration, elapsedSeconds: 0, compensation: 0 });
}

/** Compensated admitted-time addition; never reset by motion, waiting or retry. */
export function advanceRuntimeLifetime(clock, dt) {
  if (dt === 0) return clock;
  if (dt >= clock.duration) return null;
  const increment = dt - clock.compensation;
  const elapsedSeconds = clock.elapsedSeconds + increment;
  if (elapsedSeconds >= clock.duration) return null;
  return Object.freeze({
    duration: clock.duration, elapsedSeconds,
    compensation: (elapsedSeconds - clock.elapsedSeconds) - increment,
  });
}

export function emptyRuntimeState() {
  return { nextId: 1, shots: new Map(), blasts: new Map(), derived: new Map(), actors: new Map() };
}

export function cloneRuntimeState(state) {
  return { nextId: state.nextId, shots: new Map(state.shots), blasts: new Map(state.blasts),
    derived: new Map(state.derived), actors: new Map(state.actors) };
}

export function runtimeToken(state, scope, kind, previous = null) {
  const revision = previous ? previous.revision + 1 : 0;
  checkRuntime(integer(revision) && Number.isSafeInteger(state.nextId + 1), "identity-exhausted");
  const id = previous?.id ?? `combat:${scope.runtimeEpoch}:${state.nextId++}`;
  return Object.freeze({ id, kind, runtimeEpoch: scope.runtimeEpoch, revision });
}

/** Identity lookup, not a deserialized/string-key lookup. At most 24/4/8 reads. */
export function ticketRecord(records, token) {
  for (const record of records.values()) if (record.token === token) return record;
  return null;
}

export function shotView(shot) {
  return Object.freeze({
    ticket: shot.token, pool: shot.pool, provenance: provenanceView(shot.provenance),
    position: shot.position, velocity: shot.velocity, radius: shot.radius, gravity: shot.gravity,
    lifetime: shot.lifetime, acknowledged: shot.acknowledged,
    sourceEnvelope: shot.envelope && Object.freeze({
      ...shot.envelope, members: Object.freeze(shot.envelope.members.map(actorView)),
    }),
    pending: shot.pending && Object.freeze({
      kind: shot.pending.kind, from: shot.pending.from, to: shot.pending.to,
      contact: shot.pending.contact ?? null, victim: actorView(shot.pending.victim),
    }),
  });
}

export function blastView(blast) {
  return Object.freeze({
    ticket: blast.token, provenance: provenanceView(blast.provenance),
    center: blast.center, radius: blast.radius, lifetime: blast.lifetime, cursor: blast.cursor,
    victims: Object.freeze(blast.victims.map((victim) => Object.freeze({
      actor: actorView(victim.actor), exposure: victim.exposure, rawDamage: victim.rawDamage,
      outcome: victim.outcome,
    }))),
  });
}

export function derivedView(record) {
  return Object.freeze({
    ticket: record.token, originId: record.originId, provenance: provenanceView(record.provenance),
    victim: actorView(record.victim), lifetime: record.lifetime,
  });
}

export function metadataView(record) {
  return Object.freeze({
    actor: actorView(record.actor), hurt: record.hurt, credit: record.credit,
    target: actorView(record.target),
  });
}
