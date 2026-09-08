import { synchronous } from "./enchantment-domain.js";
import { encodedBytes } from "./save-budget.js";
import {
  advanceStatusEffects,
  createStatusEffects,
  normalizeStatusEffects,
  planPotionApplication,
  statusModifiers,
} from "./status-effects.js";
import { TransactionCoordinator } from "./transactions.js";
import { DIMENSIONS, isDimension } from "./world-spec.js";

export const MOB_STATUS_EFFECTS_VERSION = 1;
export const MAX_MOB_STATUS_ENTRIES = 1024;
export const MOB_STATUS_HEADER_BYTES = 1024;
export const MOB_STATUS_ENTRY_BYTES = 2048;

const record = (value) => value !== null && typeof value === "object" &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keyOf = ({ dimension, entityId, life }) => `${dimension}\0${entityId}\0${life}`;
const clone = (value) => structuredClone(value);
const freeze = (value, seen = new WeakSet()) => {
  if (value && typeof value === "object") {
    if (seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
};
const empty = (context) => ({
  version: MOB_STATUS_EFFECTS_VERSION,
  seed: String(context.seed),
  generatorVersion: context.generatorVersion,
  entries: [],
});

export function normalizeMobStatusEffects(value, context, mobsByDimension = {}) {
  if (value === undefined) value = empty(context);
  if (!record(value) || value.version !== MOB_STATUS_EFFECTS_VERSION ||
    value.seed !== String(context.seed) ||
    value.generatorVersion !== context.generatorVersion ||
    !Array.isArray(value.entries) || value.entries.length > MAX_MOB_STATUS_ENTRIES ||
    Object.keys(value).some((key) =>
      !["version", "seed", "generatorVersion", "entries"].includes(key)))
    return null;
  const roster = new Map();
  for (const dimension of DIMENSIONS) {
    const snapshot = mobsByDimension[dimension];
    for (const mob of snapshot?.entities ?? [])
      roster.set(keyOf({ dimension, entityId: mob.id, life: mob.life }), mob);
  }
  const seen = new Set(), entries = [];
  for (const entry of value.entries) {
    if (!record(entry) ||
      Object.keys(entry).some((key) =>
        !["dimension", "entityId", "life", "effects"].includes(key)) ||
      !isDimension(entry.dimension) || typeof entry.entityId !== "string" ||
      !entry.entityId.length || entry.entityId.length > 100 ||
      !Number.isSafeInteger(entry.life) || entry.life < 1)
      return null;
    const key = keyOf(entry);
    if (seen.has(key) || (Object.keys(mobsByDimension).length && !roster.has(key)))
      return null;
    let effects;
    try { effects = normalizeStatusEffects(entry.effects); } catch { return null; }
    if (!effects.effects.length || encodedBytes(effects) > MOB_STATUS_ENTRY_BYTES)
      return null;
    seen.add(key);
    entries.push({
      dimension: entry.dimension,
      entityId: entry.entityId,
      life: entry.life,
      effects,
    });
  }
  entries.sort((a, b) => a.dimension.localeCompare(b.dimension) ||
    a.entityId.localeCompare(b.entityId) || a.life - b.life);
  return freeze({ ...empty(context), entries });
}

export class MobStatusEffects {
  #state;
  #revision = 0;
  #bytes;
  #disposed = false;

  constructor({ coordinator, context, state, mobsByDimension, allowOverBudget = false } = {}) {
    const normalized = normalizeMobStatusEffects(state, context, mobsByDimension);
    if (!(coordinator instanceof TransactionCoordinator) || !normalized)
      throw new RangeError("Invalid mob status effects owner");
    Object.defineProperties(this, {
      coordinator: { value: coordinator },
      context: { value: context },
    });
    this.#state = normalized;
    this.#bytes = MOB_STATUS_HEADER_BYTES +
      normalized.entries.length * MOB_STATUS_ENTRY_BYTES;
    if (!coordinator.register(this, this.#bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve mob status effects");
  }

  get revision() { return this.#revision; }
  get reservedBytes() { return this.#bytes; }
  serialize({ mobsByDimension } = {}) {
    if (mobsByDimension === undefined) return clone(this.#state);
    const live = new Set();
    for (const [dimension, snapshot] of Object.entries(mobsByDimension)) {
      if (!isDimension(dimension) || !Array.isArray(snapshot?.entities))
        throw new RangeError("Invalid mob status roster");
      for (const mob of snapshot.entities)
        live.add(keyOf({ dimension, entityId: mob.id, life: mob.life }));
    }
    return {
      ...clone(this.#state),
      entries: this.#state.entries.filter((entry) => live.has(keyOf(entry)))
        .map(clone),
    };
  }

  effectsFor(target) {
    const entry = this.#state.entries.find((item) => keyOf(item) === keyOf(target));
    return clone(entry?.effects ?? createStatusEffects());
  }

  modifiers(target) {
    return statusModifiers(this.effectsFor(target));
  }

  prepareApplications(applications, { validate = () => true, retire = [] } = {}) {
    if (this.#disposed || !Array.isArray(applications) ||
      applications.length > 32 || !Array.isArray(retire) || retire.length > 32 ||
      !synchronous(validate))
      return null;
    const current = new Map(this.#state.entries.map((entry) => [keyOf(entry), clone(entry)]));
    const outcomes = [];
    for (const application of applications) {
      if (!record(application) || !record(application.target) ||
        typeof application.entityId !== "string" ||
        !Number.isSafeInteger(application.life) ||
        !isDimension(application.dimension))
        return null;
      const key = keyOf(application);
      let result;
      try {
        result = planPotionApplication(
          current.get(key)?.effects ?? createStatusEffects(),
          application.potion,
          { splash: application.splash, target: application.target }
        );
      } catch {
        return null;
      }
      if (result.state.effects.length) current.set(key, {
        dimension: application.dimension,
        entityId: application.entityId,
        life: application.life,
        effects: result.state,
      });
      else current.delete(key);
      outcomes.push(freeze({
        target: application,
        applied: result.applied,
        splashWater: result.splashWater,
        gameplayPlan: result.gameplayPlan,
      }));
    }
    for (const target of retire) current.delete(keyOf(target));
    const next = normalizeMobStatusEffects({
      ...empty(this.context),
      entries: [...current.values()],
    }, this.context);
    if (!next) return null;
    return {
      participant: JSON.stringify(next) === JSON.stringify(this.#state)
        ? null : this.#prepare(next, validate),
      outcomes: Object.freeze(outcomes),
    };
  }

  prepareAdvance(targets, dt, { validate = () => true } = {}) {
    if (this.#disposed || !Array.isArray(targets) || targets.length > 32 ||
      !Number.isFinite(dt) || dt < 0 || !synchronous(validate))
      return null;
    const live = new Map(targets.map((target) => [keyOf(target), target]));
    if (live.size !== targets.length) return null;
    const entries = [], outcomes = [];
    for (const entry of this.#state.entries) {
      const target = live.get(keyOf(entry));
      if (!target) {
        entries.push(clone(entry));
        continue;
      }
      const result = advanceStatusEffects(entry.effects, dt);
      if (result.state.effects.length) entries.push({ ...clone(entry), effects: result.state });
      outcomes.push(freeze({
        target: {
          dimension: target.dimension,
          entityId: target.entityId,
          life: target.life,
          target: { ...(target.target ?? {}) },
        },
        gameplayPlan: result.gameplayPlan,
        segments: result.segments,
        expired: result.expired,
      }));
    }
    const next = normalizeMobStatusEffects({ ...empty(this.context), entries }, this.context);
    return next ? {
      participant: JSON.stringify(next) === JSON.stringify(this.#state)
        ? null : this.#prepare(next, validate),
      outcomes: Object.freeze(outcomes),
    } : null;
  }

  prepareRetire(targets, { validate = () => true } = {}) {
    if (!Array.isArray(targets) || !synchronous(validate)) return null;
    const keys = new Set(targets.map(keyOf));
    const next = normalizeMobStatusEffects({
      ...empty(this.context),
      entries: this.#state.entries.filter((entry) => !keys.has(keyOf(entry))),
    }, this.context);
    return next && JSON.stringify(next) !== JSON.stringify(this.#state)
      ? this.#prepare(next, validate) : null;
  }

  prepareReconcile(mobsByDimension, { validate = () => true } = {}) {
    if (!record(mobsByDimension) || !synchronous(validate)) return null;
    const live = new Set();
    for (const [dimension, snapshot] of Object.entries(mobsByDimension)) {
      if (!isDimension(dimension) || !Array.isArray(snapshot?.entities)) return null;
      for (const mob of snapshot.entities)
        live.add(keyOf({ dimension, entityId: mob.id, life: mob.life }));
    }
    const next = normalizeMobStatusEffects({
      ...empty(this.context),
      entries: this.#state.entries.filter((entry) => live.has(keyOf(entry))),
    }, this.context);
    return next && JSON.stringify(next) !== JSON.stringify(this.#state)
      ? this.#prepare(next, validate) : null;
  }

  #prepare(next, validate) {
    const previous = this.#state, revision = this.#revision, beforeBytes = this.#bytes;
    const afterBytes = MOB_STATUS_HEADER_BYTES + next.entries.length * MOB_STATUS_ENTRY_BYTES;
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () => !used && !this.#disposed && this.#state === previous &&
        this.#revision === revision && this.coordinator.usage(this) === beforeBytes &&
        validate() === true,
      publish: () => {
        used = true;
        this.#state = next;
        this.#bytes = afterBytes;
        this.#revision++;
      },
    });
  }

  dispose() {
    if (this.#disposed) return true;
    if (!this.coordinator.release(this)) return false;
    this.#disposed = true;
    this.#revision++;
    return true;
  }
}
