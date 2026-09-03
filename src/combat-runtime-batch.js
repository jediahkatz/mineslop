import { advanceCombatCredit, advanceHurtWindow } from "./combat-rules.js";
import { COMBAT_COLLISION_LIMITS } from "./combat-collision.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  COMBAT_RUNTIME_LIMITS as limits, actorKey, actorView, advanceRuntimeLifetime,
  checkRuntime, cloneRuntimeState, emptyRuntimeState, finite, guardFunction,
  provenanceView, runtimeActor, runtimeActors, runtimeArray, runtimeEnvelope,
  runtimeFields, runtimeLifetime, runtimePoint, runtimeProvenance, runtimeRefusal,
  runtimeSuccess, runtimeToken, runtimeVector, sameActor, samePoint, ticketRecord,
} from "./combat-runtime-data.js";
import { traceRuntimeContact, traceRuntimeMotion } from "./combat-runtime-geometry.js";
import {
  runtimeDamage, runtimeDamagingMetadata, runtimeHurtQuote, runtimeOwnerDamage, runtimePeer,
} from "./combat-runtime-hits.js";

const skips = ["stale", "unavailable", "capacity", "immune", "blocked", "unsupported"];

/**
 * A bounded detached contribution batch, NOT a committable action until sealed.
 * Any refused contribution poisons the entire batch. Prepare a new batch to
 * retry; never salvage a success-looking subset after an owner/capacity veto.
 */
export class CombatRuntimeBatch {
  #scope;
  #draft;
  #guards = [];
  #touched = new Set();
  #required = new Map();
  #quotes = new Map();
  #origins = new Map();
  #operations = 0;
  #changed = false;
  #failed = null;
  #closed = false;
  #busy = false;

  constructor(scope, state) {
    this.#scope = scope;
    this.#draft = cloneRuntimeState(state);
  }

  #run(edit) {
    if (this.#closed || this.#failed) return runtimeRefusal(this.#failed ?? "closed-batch");
    if (this.#busy) {
      this.#failed = "reentrant-preparation";
      return runtimeRefusal(this.#failed);
    }
    this.#busy = true;
    let entered = false;
    try {
      entered = this.#scope.enter();
      checkRuntime(entered, "reentrant-preparation");
      checkRuntime(++this.#operations <= limits.batchOperations, "batch-capacity");
      checkRuntime(this.#scope.current(), "stale-runtime");
      const next = cloneRuntimeState(this.#draft);
      const result = edit(next);
      checkRuntime(!this.#failed && this.#scope.current(), this.#failed ?? "stale-runtime");
      this.#draft = next;
      return result;
    } catch (error) {
      this.#failed = error instanceof RangeError ? error.message : "preparation-reader-failed";
      if (error instanceof TransactionInvariantError) throw error;
      return runtimeRefusal(this.#failed);
    } finally {
      if (entered) this.#scope.leave();
      this.#busy = false;
    }
  }

  #guard(validate) {
    guardFunction(validate);
    checkRuntime(this.#guards.length < limits.readGuards, "guard-capacity");
    checkRuntime(validate() === true, "read-guard-refused");
    this.#guards.push(validate);
  }

  #touch(key) {
    checkRuntime(!this.#touched.has(key), "conflicting-runtime-edit");
    this.#touched.add(key);
    this.#changed = true;
  }

  #actor(state, value) {
    const actor = runtimeActor(value, this.#scope);
    const record = state.actors.get(actorKey(actor));
    checkRuntime(record && sameActor(record.actor, actor), "stale-actor");
    return record;
  }

  #shot(state, ticket, published = true) {
    const shot = ticketRecord(state.shots, ticket);
    checkRuntime(shot && (!published || this.#scope.hasTicket(ticket)), "stale-shot-ticket");
    return shot;
  }

  #ticket(state, pool, ticket) {
    const record = ticketRecord(state[pool], ticket);
    checkRuntime(record && this.#scope.hasTicket(ticket), "stale-runtime-ticket");
    return record;
  }

  #allowed(provenance, difficulty) {
    checkRuntime(!runtimeDamage(provenance, difficulty, "player").suppressed, "peaceful-suppressed");
  }

  /** Complete admitted roster, not an archive. Only matching identities retain
   * clocks/memory. Replacing one player life does NOT retire shots or blasts.
   */
  syncActors(actors, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["validate"]);
      const { validate } = options;
      checkRuntime(this.#touched.size === 0, "roster-must-precede-edits");
      this.#guard(validate);
      const values = runtimeActors(actors, this.#scope), next = new Map();
      for (const actor of values) {
        const previous = state.actors.get(actorKey(actor));
        next.set(actorKey(actor), sameActor(previous?.actor, actor) ? previous
          : Object.freeze({ actor, hurt: null, credit: null, target: null }));
      }
      for (const [key, record] of next) {
        if (record.target && !sameActor(next.get(actorKey(record.target))?.actor, record.target))
          next.set(key, Object.freeze({ ...record, target: null }));
      }
      state.actors = next;
      this.#touch("roster");
      return runtimeSuccess({ actors: next.size });
    });
  }

  /** Supplied validated target memory only: no acquisition, revenge policy or AI. */
  rememberTarget(actor, target, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["validate"]);
      const { validate } = options;
      this.#guard(validate);
      const record = this.#actor(state, actor);
      const next = target === null ? null : this.#actor(state, target).actor;
      this.#touch(`target:${actorKey(record.actor)}`);
      state.actors.set(actorKey(record.actor), Object.freeze({ ...record, target: next }));
      return runtimeSuccess();
    });
  }

  launch(spec) {
    return this.#run((state) => {
      runtimeFields(spec, ["provenance", "position", "velocity", "radius", "gravity",
        "ttl", "sourceEnvelope", "difficulty", "validate"]);
      this.#guard(spec.validate);
      const provenance = runtimeProvenance(spec.provenance, this.#scope);
      checkRuntime(["arrow", "ghast_fireball", "blaze_fireball"].includes(provenance.attackKind),
        "unsupported-shot");
      this.#allowed(provenance, spec.difficulty);
      this.#actor(state, provenance.responsible);
      const pool = provenance.attackKind === "blaze_fireball" ? "blaze" : "legacy";
      checkRuntime([...state.shots.values()].filter((shot) => shot.pool === pool).length <
        (pool === "blaze" ? limits.blazeShots : limits.legacyShots), "shot-capacity");
      checkRuntime(finite(spec.radius, COMBAT_COLLISION_LIMITS.radius) &&
        finite(spec.gravity, limits.gravity), "invalid-flight-parameters");
      const envelope = runtimeEnvelope(spec.sourceEnvelope, this.#scope);
      checkRuntime(!envelope || (!envelope.exited &&
        envelope.members.some((actor) => sameActor(actor, provenance.responsible))),
      "invalid-launch-envelope");
      const token = runtimeToken(state, this.#scope, "shot");
      const shot = Object.freeze({
        token, pool, provenance, position: runtimePoint(spec.position, this.#scope),
        velocity: runtimeVector(spec.velocity), radius: spec.radius, gravity: spec.gravity,
        lifetime: runtimeLifetime(spec.ttl, pool === "blaze" ? limits.blazeSeconds : limits.shotSeconds),
        envelope, acknowledged: false, pending: null,
      });
      this.#touch(`shot:${token.id}`);
      state.shots.set(token.id, shot);
      return runtimeSuccess({ ticket: token });
    });
  }

  /**
   * Renderer bridge must prove COMPLETED presentation of this exact ticket.
   * No launch-batch acknowledgement; no acknowledgement+motion shortcut in one
   * batch. Positive CPU dt is never a presentation signal.
   */
  acknowledgePresentation(ticket, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["validateCompleted"]);
      const { validateCompleted } = options;
      const shot = this.#shot(state, ticket);
      checkRuntime(!shot.acknowledged, "already-acknowledged");
      this.#guard(validateCompleted);
      this.#touch(`shot:${ticket.id}`);
      const token = runtimeToken(state, this.#scope, "shot", ticket);
      state.shots.set(token.id, Object.freeze({ ...shot, token, acknowledged: true }));
      return runtimeSuccess({ ticket: token });
    });
  }

  /** Supplied bounded next pose/velocity, not a kinematic integrator. Contact
   * and frontier keep the previous pose; they cannot move through a refused body.
   */
  motion(ticket, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["to", "velocity", "readCandidates", "difficulty", "validate"]);
      const { to, velocity, readCandidates, difficulty, validate } = options;
      const shot = this.#shot(state, ticket);
      checkRuntime(shot.pool !== "blaze" || shot.acknowledged, "presentation-required");
      checkRuntime(shot.pending?.kind !== "contact", "pending-contact-blocks-motion");
      this.#guard(validate);
      this.#allowed(shot.provenance, difficulty);
      const destination = runtimePoint(to, this.#scope), nextVelocity = runtimeVector(velocity);
      checkRuntime(!shot.pending ||
        (samePoint(shot.pending.to, destination) && samePoint(shot.pending.velocity, nextVelocity)),
      "pending-segment-changed");
      const { trace, victim } = traceRuntimeMotion(this.#scope, shot, destination, readCandidates);
      this.#guard(trace.validate);
      this.#touch(`shot:${ticket.id}`);
      const token = runtimeToken(state, this.#scope, "shot", ticket);
      const flying = trace.kind === "flight";
      state.shots.set(token.id, Object.freeze({
        ...shot, token, position: flying ? destination : shot.position,
        velocity: flying ? nextVelocity : shot.velocity,
        envelope: flying && shot.envelope
          ? Object.freeze({ ...shot.envelope, exited: trace.sourceEnvelopeExited }) : shot.envelope,
        pending: flying ? null : Object.freeze({
          kind: trace.kind, from: shot.position, to: destination, velocity: nextVelocity,
          ...(trace.kind === "contact" ? { contact: trace.contact, victim,
            sourceEnvelopeExited: trace.sourceEnvelopeExited } : {}),
        }),
      }));
      return runtimeSuccess({ ticket: token, kind: trace.kind, contact: trace.contact ?? null });
    });
  }

  /** Advance ONCE using admitted dt. Host pause supplies zero. No fixed tick,
   * wall/render/update-call clock, catch-up queue, or refreshed pending deadline.
   */
  advanceClocks(dt, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["validate"]);
      const { validate } = options;
      checkRuntime(finite(dt), "invalid-admitted-dt");
      this.#guard(validate);
      checkRuntime(!this.#touched.has("clock"), "duplicate-clock-advance");
      this.#touched.add("clock");
      if (dt === 0) return runtimeSuccess({ changed: false });
      let changed = false;
      for (const pool of ["shots", "blasts", "derived"]) {
        for (const [id, record] of state[pool]) {
          const lifetime = advanceRuntimeLifetime(record.lifetime, dt);
          if (lifetime) state[pool].set(id, Object.freeze({ ...record, lifetime }));
          else state[pool].delete(id);
          changed = true;
        }
      }
      for (const [key, record] of state.actors) {
        if (!record.hurt && !record.credit) continue;
        state.actors.set(key, Object.freeze({
          ...record, hurt: advanceHurtWindow(record.hurt, dt),
          credit: advanceCombatCredit(record.credit, dt),
        }));
        changed = true;
      }
      this.#changed ||= changed;
      return runtimeSuccess({ changed });
    });
  }

  cancel(ticket) {
    return this.#run((state) => {
      for (const pool of ["shots", "blasts", "derived"]) {
        const record = ticketRecord(state[pool], ticket);
        if (!record) continue;
        this.#touch(`${pool === "shots" ? "shot" : pool}:${ticket.id}`);
        state[pool].delete(ticket.id);
        return runtimeSuccess({ cancelled: true });
      }
      throw new RangeError("stale-runtime-ticket");
    });
  }

  cancelAll() {
    return this.#run((state) => {
      checkRuntime(this.#touched.size === 0, "cancel-all-conflict");
      const nextId = state.nextId;
      Object.assign(state, emptyRuntimeState(), { nextId });
      this.#touch("cancel-all");
      return runtimeSuccess();
    });
  }

  #blast(state, { provenance, center, radius, ttl, victims }) {
    checkRuntime(state.blasts.size < limits.blasts, "blast-capacity");
    checkRuntime(finite(radius, limits.blastRadius) && radius > 0, "invalid-blast-radius");
    runtimeArray(victims, limits.victimsPerBlast);
    runtimeActors(victims.map((victim) => victim.actor), this.#scope);
    const captured = victims.map((victim) => {
      runtimeFields(victim, ["actor", "exposure", "rawDamage"]);
      const actor = this.#actor(state, victim.actor).actor;
      checkRuntime(finite(victim.exposure, 1) && finite(victim.rawDamage, limits.rawDamage),
        "invalid-blast-exposure");
      return Object.freeze({ actor, exposure: victim.exposure, rawDamage: victim.rawDamage, outcome: "pending" });
    });
    const token = runtimeToken(state, this.#scope, "blast");
    const blast = Object.freeze({
      token, provenance, center: runtimePoint(center, this.#scope), radius,
      lifetime: runtimeLifetime(ttl, limits.blastSeconds),
      cursor: 0, victims: Object.freeze(captured),
    });
    this.#touch(`blasts:${token.id}`);
    state.blasts.set(token.id, blast);
    return token;
  }

  /** Creeper admission metadata only. The future bridge MUST join real source
   * retirement/resources; this does not detonate, kill, reward or edit terrain.
   * Ghasts may enter ONLY through the atomic shot-retirement path.
   */
  admitBlast(spec) {
    return this.#run((state) => {
      runtimeFields(spec, ["provenance", "center", "radius", "ttl", "victims", "difficulty", "validate"]);
      this.#guard(spec.validate);
      const provenance = runtimeProvenance(spec.provenance, this.#scope);
      checkRuntime(provenance.attackKind === "creeper_explosion", "unsupported-blast-admission");
      this.#actor(state, provenance.responsible);
      this.#allowed(provenance, spec.difficulty);
      const ticket = this.#blast(state, { ...spec, provenance });
      return runtimeSuccess({ ticket });
    });
  }

  /** Full-pool veto leaves the published pending shot completely unchanged.
   * Retry uses the SAME original segment/contact and ORIGINAL shot lifetime.
   * No direct ghast impact damage or fallback explosion path exists here.
   */
  admitGhastBlast(ticket, spec) {
    return this.#run((state) => {
      runtimeFields(spec, ["radius", "ttl", "victims", "difficulty", "readCandidates", "validate"]);
      const shot = this.#shot(state, ticket);
      checkRuntime(shot.provenance.attackKind === "ghast_fireball", "ghast-shot-required");
      checkRuntime(state.blasts.size < limits.blasts, "blast-capacity");
      this.#guard(spec.validate);
      this.#allowed(shot.provenance, spec.difficulty);
      const probe = traceRuntimeContact(this.#scope, shot, spec.readCandidates);
      this.#guard(probe.trace.validate);
      const provenance = runtimeProvenance({
        ...shot.provenance, attackKind: "ghast_explosion", effects: [],
      }, this.#scope);
      const blastTicket = this.#blast(state, {
        ...spec, provenance, center: shot.pending.contact.center,
      });
      this.#touch(`shot:${ticket.id}`);
      state.shots.delete(ticket.id);
      return runtimeSuccess({ ticket: blastTicket, retiredShot: ticket.id });
    });
  }

  #quote(state, victim, provenance, difficulty, subject) {
    const actor = this.#actor(state, victim);
    const decision = runtimeHurtQuote(actor, provenance, difficulty);
    const quote = Object.freeze({
      ok: true, scope: "data-owner-only", victim: actorView(actor.actor),
      provenance: provenanceView(provenance), adjusted: decision.adjusted,
      preArmorDamage: decision.preArmorDamage,
    });
    this.#quotes.set(quote, { actor, provenance, decision, subject, used: false });
    return quote;
  }

  /** Direct-hit CLOCK metadata. No melee/beam/DoT scheduling or owner call. */
  quoteHit(options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["victim", "provenance", "difficulty", "validate"]);
      const { victim, provenance, difficulty, validate } = options;
      this.#guard(validate);
      const source = runtimeProvenance(provenance, this.#scope);
      checkRuntime(["melee", "guardian_beam", "fire_tick"].includes(source.attackKind),
        "direct-cause-unsupported");
      if (source.attackKind !== "fire_tick") this.#actor(state, source.responsible);
      return this.#quote(state, victim, source, difficulty, { kind: "direct" });
    });
  }

  quoteContact(ticket, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["difficulty", "readCandidates", "validate"]);
      const { difficulty, readCandidates, validate } = options;
      const shot = this.#shot(state, ticket);
      checkRuntime(shot.provenance.attackKind !== "ghast_fireball", "ghast-is-blast-only");
      checkRuntime(shot.pool !== "blaze" || shot.acknowledged, "presentation-required");
      this.#guard(validate);
      const probe = traceRuntimeContact(this.#scope, shot, readCandidates);
      this.#guard(probe.trace.validate);
      checkRuntime(probe.victim !== null, "actor-contact-required");
      return this.#quote(state, probe.victim, shot.provenance, difficulty, { kind: "contact", ticket });
    });
  }

  quoteBlastVictim(ticket, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["difficulty", "validate"]);
      const { difficulty, validate } = options;
      const blast = this.#ticket(state, "blasts", ticket);
      const victim = blast.victims[blast.cursor];
      checkRuntime(victim?.outcome === "pending", "no-pending-victim");
      this.#guard(validate);
      const provenance = Object.freeze({ ...blast.provenance, rawDamage: victim.rawDamage });
      return this.#quote(state, victim.actor, provenance, difficulty,
        { kind: "blast", ticket, cursor: blast.cursor });
    });
  }

  quoteDerived(ticket, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["difficulty", "validate"]);
      const { difficulty, validate } = options;
      const derived = this.#ticket(state, "derived", ticket);
      this.#guard(validate);
      return this.#quote(state, derived.victim, derived.provenance, difficulty, { kind: "derived", ticket });
    });
  }

  #advanceVictim(state, ticket, outcome) {
    const blast = this.#ticket(state, "blasts", ticket);
    checkRuntime(blast.victims[blast.cursor]?.outcome === "pending", "no-pending-victim");
    this.#touch(`blasts:${ticket.id}`);
    const victims = blast.victims.slice(), cursor = blast.cursor + 1;
    victims[blast.cursor] = Object.freeze({ ...victims[blast.cursor], outcome });
    if (cursor === victims.length) {
      state.blasts.delete(ticket.id);
      return null;
    }
    const token = runtimeToken(state, this.#scope, "blast", ticket);
    state.blasts.set(token.id, Object.freeze({ ...blast, token, cursor, victims: Object.freeze(victims) }));
    return token;
  }

  /** The bridge must commit this runtime-only skip after any victim refusal,
   * including a rejected composite commit. Never retry that victim after space
   * frees. Preparation alone is not an attempt receipt or cursor publication.
   */
  skipBlastVictim(ticket, reason, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["validate"]);
      const { validate } = options;
      checkRuntime(skips.includes(reason), "invalid-skip-reason");
      this.#guard(validate);
      return runtimeSuccess({ ticket: this.#advanceVictim(state, ticket, `skipped:${reason}`) });
    });
  }

  /**
   * Join metadata/consumption with actual prepared owner health loss. This
   * function NEVER invokes damage/publish/notify. finalize must receive every
   * exact owner participant (already composed by its domain).
   */
  acceptHit(quote, ownerPlan) {
    return this.#run((state) => {
      const pending = this.#quotes.get(quote);
      checkRuntime(pending && !pending.used && pending.decision.preArmorDamage > 0 &&
        !pending.decision.adjusted.suppressed, "invalid-hit-quote");
      const { actor, provenance, decision, subject } = pending;
      checkRuntime(state.actors.get(actorKey(actor.actor)) === actor, "stale-hit-clock");
      const owner = runtimeOwnerDamage(ownerPlan, decision.preArmorDamage, this.#scope.coordinator, this.#scope.owner);
      this.#guard(owner.current);
      // Requirements are not publishers. The final caller supplies a unique
      // complete owner list; no concatenation or callback deduplication occurs.
      for (const peer of owner.peers) {
        const required = this.#required.get(peer.owner);
        checkRuntime(!required || required.participant === peer.participant, "conflicting-owner-plans");
        checkRuntime(required || this.#required.size < limits.peerParticipants, "peer-capacity");
        this.#required.set(peer.owner, peer);
      }
      let nextTicket = null;
      if (subject.kind === "contact") {
        this.#shot(state, subject.ticket);
        this.#touch(`shot:${subject.ticket.id}`);
        state.shots.delete(subject.ticket.id);
      } else if (subject.kind === "blast") {
        const blast = this.#ticket(state, "blasts", subject.ticket);
        checkRuntime(blast.cursor === subject.cursor, "stale-victim-cursor");
        nextTicket = this.#advanceVictim(state, subject.ticket, "accepted");
      } else if (subject.kind === "derived") {
        this.#ticket(state, "derived", subject.ticket);
        this.#touch(`derived:${subject.ticket.id}`);
        state.derived.delete(subject.ticket.id);
      }
      this.#touch(`hit:${actorKey(actor.actor)}`);
      state.actors.set(actorKey(actor.actor), runtimeDamagingMetadata(actor, provenance, decision, owner.damage));
      pending.used = true;
      const origin = subject.kind === "derived" ? null : runtimeToken(state, this.#scope, "origin");
      if (origin) this.#origins.set(origin, { actor: actor.actor, provenance, used: false });
      return runtimeSuccess({ ticket: nextTicket, origin, healthDamage: owner.damage });
    });
  }

  /** One non-recursive derived guardian reflection per accepted origin. It is
   * admitted atomically WITH that hit, but cannot be consumed until AFTER it.
   */
  admitDerived(origin, options = {}) {
    return this.#run((state) => {
      runtimeFields(options, ["provenance", "victim", "ttl", "validate"]);
      const { provenance, victim, ttl, validate } = options;
      const parent = this.#origins.get(origin);
      checkRuntime(parent && !parent.used, "accepted-origin-required");
      checkRuntime(state.derived.size < limits.derived, "derived-capacity");
      this.#guard(validate);
      const source = runtimeProvenance(provenance, this.#scope);
      const target = this.#actor(state, victim).actor;
      checkRuntime(source.attackKind === "guardian_thorns" &&
        ["guardian", "elder_guardian"].includes(source.responsibleSpecies) &&
        sameActor(source.responsible, parent.actor) &&
        sameActor(target, parent.provenance.responsible), "unsupported-derived-contact");
      const token = runtimeToken(state, this.#scope, "derived");
      state.derived.set(token.id, Object.freeze({
        token, originId: origin.id, provenance: source, victim: target,
        lifetime: runtimeLifetime(ttl, limits.derivedSeconds),
      }));
      parent.used = true;
      this.#touch(`derived:${token.id}`);
      return runtimeSuccess({ ticket: token });
    });
  }

  /**
   * Exactly ONE runtime participant. All peers must already be uniquely
   * composed by Wildlife/Horses/Ecology, Gameplay and StatusEffects owners.
   */
  finalize(options = {}) {
    if (this.#busy) this.#failed = "reentrant-preparation";
    if (this.#closed || this.#failed)
      return runtimeRefusal(this.#failed ?? "closed-batch");
    this.#closed = true;
    let entered = false;
    try {
      entered = this.#scope.enter();
      checkRuntime(entered, "reentrant-preparation");
      runtimeFields(options, ["participants", "notify"]);
      const { participants = [], notify } = options;
      checkRuntime(this.#scope.current(), "stale-runtime");
      if (notify !== undefined) guardFunction(notify);
      const peers = runtimeArray(participants, limits.peerParticipants)
        .map((part) => runtimePeer(part, this.#scope.coordinator, this.#scope.owner));
      checkRuntime(new Set(peers.map((peer) => peer.owner)).size === peers.length, "duplicate-peer-owner");
      for (const required of this.#required.values())
        checkRuntime(required.current() &&
          peers.some((peer) => peer.participant === required.participant), "missing-owner-participant");
      if (!this.#changed) {
        checkRuntime(peers.length === 0, "empty-runtime-batch");
        return runtimeSuccess({ changed: false, participants: Object.freeze([]) });
      }
      const scope = this.#scope, next = this.#draft, guards = this.#guards.slice();
      const receipt = Object.freeze({ scope: "data-owner-only", runtimeEpoch: scope.runtimeEpoch,
        revision: scope.revision + 1, operations: this.#operations });
      let published = false, notified = false;
      const participant = Object.freeze({
        owner: scope.owner, beforeBytes: 0, afterBytes: 0,
        validate() {
          return this === participant && !published && scope.publishable() &&
            guards.every((validate) => validate() === true) &&
            peers.every((peer) => peer.current());
        },
        publish() {
          published = true;
          scope.install(next);
        },
        ...(notify === undefined ? {} : { notify() {
          if (!published || notified) return;
          notified = true;
          return notify(receipt);
        } }),
      });
      return runtimeSuccess({
        prepared: true, changed: true, scope: "data-owner-only", participant,
        participants: Object.freeze([participant, ...peers.map((peer) => peer.participant)]),
        receipt,
      });
    } catch (error) {
      this.#failed = error instanceof RangeError ? error.message : "invalid-finalization";
      if (error instanceof TransactionInvariantError) throw error;
      return runtimeRefusal(this.#failed);
    } finally {
      if (entered) this.#scope.leave();
    }
  }
}
