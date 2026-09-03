import { synchronousEcologyHook } from "./aquatic-ai.js";
import { isMobId } from "./mob-save.js";

export const ECOLOGY_EFFECT_LIMIT = 32;
const definitions = Object.freeze({
  dolphins_grace: Object.freeze({ duration: 1.5, swimSpeedMultiplier: 1.6 }),
  mining_fatigue: Object.freeze({ duration: 40, level: 2, miningSpeedMultiplier: 0.0027 }),
});
const neutral = Object.freeze({
  swimSpeedMultiplier: 1, miningSpeedMultiplier: 1, miningFatigueLevel: null,
});

/** Ephemeral, source-scoped modifiers. Feeding/elder ownership is persistent
 * elsewhere; losing that live source, life or dimension clears its modifier.
 * Never edits potion state, Gameplay inventory, Player fields or a global map.
 */
export class EcologyEffects {
  constructor({ sourceActive } = {}) {
    if (!synchronousEcologyHook(sourceActive))
      throw new TypeError("Ecology effects require a live-source reader");
    this.sourceActive = sourceActive;
    this._effects = new Map();
    this._dimension = null;
    this._target = null;
    this._disposed = false;
  }

  apply(effect, { dimension, targetKey, health } = {}) {
    const definition = effect && Object.hasOwn(definitions, effect.id) ? definitions[effect.id] : null;
    if (this._disposed || !definition || !isMobId(effect.source) ||
      typeof targetKey !== "string" || !targetKey.length || !(health > 0) ||
      dimension !== this._dimension || targetKey !== this._target ||
      effect.duration !== definition.duration ||
      (effect.id === "dolphins_grace"
        ? effect.swimSpeedMultiplier !== definition.swimSpeedMultiplier
        : effect.level !== definition.level) ||
      this.sourceActive(effect.source, effect.id) !== true) return false;
    const key = `${effect.id}/${effect.source}`;
    if (!this._effects.has(key) && this._effects.size >= ECOLOGY_EFFECT_LIMIT) return false;
    this._effects.set(key, Object.freeze({
      id: effect.id, source: effect.source, remaining: definition.duration,
    }));
    return true;
  }

  step(dt, { dimension, targetKey, health } = {}) {
    if (this._disposed) return;
    if (dimension !== this._dimension || targetKey !== this._target || !(health > 0))
      this._effects.clear();
    this._dimension = dimension;
    this._target = targetKey;
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(0.2, dt)) : 0;
    for (const [key, effect] of this._effects) {
      const remaining = effect.remaining - step;
      if (remaining <= 0 || this.sourceActive(effect.source, effect.id) !== true)
        this._effects.delete(key);
      else if (step > 0) this._effects.set(key, Object.freeze({ ...effect, remaining }));
    }
  }

  clearSource(source) {
    for (const [key, effect] of this._effects)
      if (effect.source === source) this._effects.delete(key);
  }

  modifiers() {
    if (!this._effects.size) return neutral;
    let grace = false, fatigue = false;
    for (const effect of this._effects.values()) {
      grace ||= effect.id === "dolphins_grace";
      fatigue ||= effect.id === "mining_fatigue";
    }
    return Object.freeze({
      swimSpeedMultiplier: grace ? definitions.dolphins_grace.swimSpeedMultiplier : 1,
      miningSpeedMultiplier: fatigue ? definitions.mining_fatigue.miningSpeedMultiplier : 1,
      miningFatigueLevel: fatigue ? definitions.mining_fatigue.level : null,
    });
  }

  get size() { return this._effects.size; }
  clear() { this._effects.clear(); }
  dispose() { this.clear(); this._disposed = true; }
}
