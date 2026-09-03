import { captureEntityContext } from "./entity-context.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { TransactionCoordinator } from "./transactions.js";
import { World } from "./world.js";
import { CombatRuntimeBatch } from "./combat-runtime-batch.js";
import {
  actorKey, actorView, blastView, derivedView, emptyRuntimeState, integer,
  metadataView, runtimeActor, sameActor, shotView, ticketRecord,
} from "./combat-runtime-data.js";

export { COMBAT_RUNTIME_LIMITS } from "./combat-runtime-data.js";

const owners = new WeakMap();
let nextEpoch = 1;

/**
 * INACTIVE DATA OWNER ONLY. Normal Game does not import or activate this class.
 *
 * Owns transient bounded shots, contacts, blast/derived tickets and actor clocks.
 * Owns NO canonical HP/pose/inventory, sidecar, archive, saved RNG or save bytes.
 * There is deliberately no update(), render(), damage(), serialize() or load().
 *
 * Before live use, a bridge must supply complete fresh canonical facts/guards
 * (including Game scope, difficulty value+revision, source action, actor life,
 * actual owners and physical roster/exposure), the real owner result and ALL
 * uniquely composed participants. Player owner/life comes from the existing
 * pearl services; stable reward ownership is NOT current attack authority.
 * Presentation acknowledgement requires a completed renderer observation.
 *
 * Structural validation and runtime token identity DO NOT establish those
 * authorizations. No placeholder bridge, victim fallback or fake owner success
 * is supplied. Legacy radii/flight policy, lethal rewards/RNG, burn scheduling,
 * AI/retaliation consumers, terrain damage and live cutover remain gated.
 */
export class CombatRuntime {
  #state = emptyRuntimeState();
  #revision = 0;
  #runtimeEpoch;
  #worldEpoch;
  #dimension;
  #scopeGuard;
  #disposed = false;
  #preparing = false;

  constructor({ world, context = world } = {}) {
    const normalized = normalizeProgressionContext(context);
    if (!(world instanceof World) || !(world.coordinator instanceof TransactionCoordinator) ||
        world._disposed || world.coordinator.usage(world) === undefined ||
        world.seed !== normalized.seed || world.generatorVersion !== normalized.generatorVersion ||
        !integer(world.epoch) || owners.has(world) || !Number.isSafeInteger(nextEpoch + 1))
      throw new RangeError("CombatRuntime requires one registered live World/context");
    Object.defineProperties(this, {
      world: { value: world }, context: { value: normalized },
      coordinator: { value: world.coordinator },
    });
    this.#scopeGuard = captureEntityContext(world, context);
    this.#worldEpoch = world.epoch;
    this.#dimension = world.dimension;
    this.#runtimeEpoch = nextEpoch++;
    if (!this.coordinator.register(this, 0))
      throw new RangeError("Cannot register transient combat runtime");
    owners.set(world, this);
  }

  get revision() { return this.#revision; }
  get runtimeEpoch() { return this.#runtimeEpoch; }
  get reservedBytes() { return 0; }
  get disposed() { return this.#disposed; }
  get available() {
    return !this.#disposed && owners.get(this.world) === this && this.#scopeGuard() &&
      this.world.coordinator === this.coordinator &&
      this.coordinator.usage(this.world) !== undefined && this.coordinator.usage(this) === 0;
  }

  #scope() {
    return { context: this.context, dimension: this.#dimension, worldEpoch: this.#worldEpoch };
  }

  /** Each batch is caller-held and bounded; the runtime retains no batch ledger. */
  begin() {
    if (this.#preparing || !this.available || !Number.isSafeInteger(this.#revision + 1)) return null;
    const state = this.#state, revision = this.#revision;
    const current = () => this.available && this.#state === state && this.#revision === revision;
    return new CombatRuntimeBatch(Object.freeze({
      ...this.#scope(), owner: this, world: this.world, coordinator: this.coordinator,
      runtimeEpoch: this.#runtimeEpoch, revision, current,
      publishable: () => !this.#preparing && current(),
      enter: () => {
        if (this.#preparing) return false;
        this.#preparing = true;
        return true;
      },
      leave: () => { this.#preparing = false; },
      hasTicket: (ticket) => current() && ["shots", "blasts", "derived"].some(
        (pool) => ticketRecord(state[pool], ticket) !== null),
      install: (next) => { this.#state = next; this.#revision = revision + 1; },
    }), state);
  }

  get shots() { return Object.freeze(this.available ? [...this.#state.shots.values()].map(shotView) : []); }
  get blasts() { return Object.freeze(this.available ? [...this.#state.blasts.values()].map(blastView) : []); }
  get derived() { return Object.freeze(this.available ? [...this.#state.derived.values()].map(derivedView) : []); }
  get actors() { return Object.freeze(this.available ? [...this.#state.actors.values()].map(metadataView) : []); }

  shot(ticket) {
    const shot = this.available && ticketRecord(this.#state.shots, ticket);
    return shot ? shotView(shot) : null;
  }

  blast(ticket) {
    const blast = this.available && ticketRecord(this.#state.blasts, ticket);
    return blast ? blastView(blast) : null;
  }

  derivedContact(ticket) {
    const record = this.available && ticketRecord(this.#state.derived, ticket);
    return record ? derivedView(record) : null;
  }

  actor(identity) {
    if (!this.available) return null;
    try {
      const actor = runtimeActor(identity, this.#scope());
      const record = this.#state.actors.get(actorKey(actor));
      return sameActor(record?.actor, actor) ? metadataView(record) : null;
    } catch {
      return null;
    }
  }

  /** matchesRoster is an identity check, NOT proof of live victim authorization. */
  blastVictim(ticket) {
    const blast = this.available && ticketRecord(this.#state.blasts, ticket);
    const victim = blast && blast.victims[blast.cursor];
    return victim ? Object.freeze({
      ticket: blast.token, cursor: blast.cursor, victim: actorView(victim.actor),
      exposure: victim.exposure, rawDamage: victim.rawDamage,
      matchesRoster: sameActor(this.#state.actors.get(actorKey(victim.actor))?.actor, victim.actor),
    }) : null;
  }

  /** World epoch changes immediately hide/reject ALL work, including zero-dt
   * calls. On World-object replacement the bridge disposes the old owner.
   * Disposal releases only this zero-byte owner, never Wildlife or borrowers.
   */
  dispose() {
    if (this.#disposed) return true;
    if (this.#preparing) return false;
    if (this.coordinator.usage(this) !== undefined && !this.coordinator.release(this)) return false;
    this.#disposed = true;
    this.#state = emptyRuntimeState();
    if (owners.get(this.world) === this) owners.delete(this.world);
    return true;
  }
}
