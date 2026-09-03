import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export const WORLD_CLOCK_VERSION = 1;
export const DAY_SECONDS = 1200;
// The renderer's cycle has midnight at 0 and sunrise at .25. Wake just after
// sunrise, within the existing mobs' daylight interval, never into another sleep.
export const DAWN_TIME = 0.28;
export const NIGHT_START = 0.75;
export const NIGHT_END = 0.25;
export const WORLD_CLOCK_BYTES = 128;

export const isSleepTime = (time) =>
  Number.isFinite(time) &&
  time >= 0 &&
  time < 1 &&
  (time >= NIGHT_START || time < NIGHT_END);

/** day counts midnight crossings; time is the existing renderer's [0,1) phase. */
export function normalizeWorldClock(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    Object.keys(data).some(
      (key) => !["version", "day", "time"].includes(key)
    ) ||
    data.version !== WORLD_CLOCK_VERSION ||
    !Number.isSafeInteger(data.day) ||
    data.day < 0 ||
    !Number.isFinite(data.time) ||
    data.time < 0 ||
    data.time >= 1
  )
    return null;
  return { version: WORLD_CLOCK_VERSION, day: data.day, time: data.time };
}

/** Pure calendar advancement. Simulation elapsed time remains the caller's dt. */
export function advanceWorldClock(data, seconds) {
  const state = normalizeWorldClock(data);
  if (!state || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = state.time + seconds / DAY_SECONDS;
  const crossings = Math.floor(total);
  const day = state.day + crossings;
  if (!Number.isSafeInteger(day) || day < 0) return null;
  return { version: WORLD_CLOCK_VERSION, day, time: total - crossings };
}

/** Only the calendar changes. This does not call update(), heal, or grant work. */
export function sleepWorldClock(data) {
  const state = normalizeWorldClock(data);
  if (!state || !isSleepTime(state.time)) return null;
  const day = state.day + (state.time >= NIGHT_START ? 1 : 0);
  return Number.isSafeInteger(day)
    ? { version: WORLD_CLOCK_VERSION, day, time: DAWN_TIME }
    : null;
}

/**
 * Small shared owner for atomic bed-spawn + dawn publication. Parent calls
 * advance(dt) only for active simulation and projects .time into currentTime /
 * renderer/HUD. Sleep never supplies skipped calendar seconds to any simulator.
 */
export class WorldClock {
  constructor({
    coordinator = new TransactionCoordinator(),
    onChange,
    snapshot = { version: WORLD_CLOCK_VERSION, day: 0, time: 0.36 },
    allowOverBudget = false,
  } = {}) {
    const state = normalizeWorldClock(snapshot);
    if (!state) throw new RangeError("Invalid world clock");
    this.coordinator = coordinator;
    this.onChange = onChange;
    this._state = Object.freeze(state);
    this._revision = 0;
    this._disposed = false;
    this.observerErrors = [];
    // Bounded safe-integer day + finite phase; no JSON encoding per frame.
    if (!coordinator.register(this, WORLD_CLOCK_BYTES, { allowOverBudget }))
      throw new RangeError("Cannot reserve world clock");
  }

  get time() {
    return this._state.time;
  }
  get day() {
    return this._state.day;
  }
  get revision() {
    return this._revision;
  }

  _prepare(next) {
    if (this._disposed || !next) return null;
    const before = this._state;
    const revision = this._revision;
    const coordinator = this.coordinator;
    const state = Object.freeze(next);
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes: WORLD_CLOCK_BYTES,
      afterBytes: WORLD_CLOCK_BYTES,
      validate: () =>
        !used &&
        !this._disposed &&
        this._state === before &&
        this._revision === revision &&
        this.coordinator === coordinator,
      publish: () => {
        used = true;
        this._state = state;
        this._revision++;
      },
      notify: () => this.onChange?.(this.serialize()),
    });
  }

  prepareAdvance(seconds) {
    return this._prepare(advanceWorldClock(this._state, seconds));
  }

  _commit(participant) {
    if (!participant) return false;
    const result = this.coordinator.commit([participant]);
    this.observerErrors = result.observerErrors ?? [];
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    return result.ok;
  }

  advance(seconds) {
    return this._commit(this.prepareAdvance(seconds));
  }

  prepareSleep() {
    return this._prepare(sleepWorldClock(this._state));
  }

  /** Explicit clock-setting UI: change the phase, not the day or simulation dt. */
  prepareTime(time) {
    if (!Number.isFinite(time)) return null;
    const phase = time >= 0 && time < 1 ? time : ((time % 1) + 1) % 1;
    return this._prepare({ ...this._state, time: phase });
  }

  setTime(time) {
    return this._commit(this.prepareTime(time));
  }

  serialize() {
    return { ...this._state };
  }

  load(data, options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      return false;
    const { allowOverBudget = false } = options;
    const state = normalizeWorldClock(data);
    if (
      this._disposed ||
      !state ||
      !this.coordinator.register(this, WORLD_CLOCK_BYTES, { allowOverBudget })
    )
      return false;
    this._state = Object.freeze(state);
    this._revision++;
    return true;
  }

  dispose() {
    if (this._disposed) return true;
    if (!this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    this.onChange = undefined;
    return true;
  }
}
