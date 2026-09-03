export const RENDER_SCALE_DEFAULTS = Object.freeze({
  minRatio: 0.5,
  maxRatio: 1,
  targetFrameMs: 1000 / 45,
  step: 0.05,
  warmupMs: 1500,
  cooldownMs: 2000,
  windowMs: 750,
  maxDimension: 4096,
});

const MAX_SAMPLE_MS = 250;
const MIN_WINDOW_FRAMES = 4;
const SLOW_WINDOWS = 2;
const FAST_WINDOWS = 4;
const SLOW_THRESHOLD = 1.1;
const FAST_THRESHOLD = 0.8;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function number(value, name, min, max) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw new RangeError(`${name} must be a finite number in [${min}, ${max}]`);
  return value;
}

function configuration(options) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    throw new TypeError("Render scale options must be an object");
  const config = { ...RENDER_SCALE_DEFAULTS, ...options };
  number(config.width, "width", 1, Number.MAX_SAFE_INTEGER);
  number(config.height, "height", 1, Number.MAX_SAFE_INTEGER);
  number(config.minRatio, "minRatio", Number.MIN_VALUE, 4);
  number(config.maxRatio, "maxRatio", Number.MIN_VALUE, 4);
  number(config.step, "step", 0.001, 0.1);
  number(config.targetFrameMs, "targetFrameMs", 4, 100);
  number(config.warmupMs, "warmupMs", 0, 60000);
  number(config.cooldownMs, "cooldownMs", 0, 60000);
  number(config.windowMs, "windowMs", 100, 5000);
  number(config.maxDimension, "maxDimension", 1, 16384);
  if (!Number.isInteger(config.maxDimension))
    throw new RangeError("maxDimension must be an integer");
  const maxRatio = Math.min(
    config.maxRatio,
    config.maxDimension / config.width,
    config.maxDimension / config.height
  );
  const shortSide = Math.min(config.width, config.height);
  let onePixelRatio = 1 / shortSide;
  if (shortSide * onePixelRatio < 1)
    onePixelRatio = (1 + Number.EPSILON) / shortSide;
  if (maxRatio < onePixelRatio)
    throw new RangeError(
      "Viewport and ratio cap cannot fit a safe drawing buffer"
    );
  // Safety and the quality cap take precedence over the preferred minimum.
  const minRatio = Math.min(maxRatio, Math.max(config.minRatio, onePixelRatio));
  const initial =
    config.pixelRatio === undefined
      ? config.maxRatio
      : number(config.pixelRatio, "pixelRatio", Number.MIN_VALUE, 4);
  return {
    config,
    minRatio,
    maxRatio,
    pixelRatio: clamp(initial, minRatio, maxRatio),
  };
}

/**
 * Pure recommendation controller: no renderer, timers, DOM, or simulation changes.
 * Supply CSS width/height and the quality/device DPR cap as maxRatio.
 * Apply returned pixelRatio values separately from quality features.
 */
export class RenderScaleController {
  constructor(options) {
    const settings = configuration(options);
    this._config = settings.config;
    this._minRatio = settings.minRatio;
    this._maxRatio = settings.maxRatio;
    this._pixelRatio = settings.pixelRatio;
    this._restart();
  }

  get pixelRatio() {
    return this._pixelRatio;
  }

  get minRatio() {
    return this._minRatio;
  }

  get maxRatio() {
    return this._maxRatio;
  }

  _clearWindow() {
    this._windowTime = 0;
    this._windowFrames = 0;
  }

  _clearEvidence() {
    this._clearWindow();
    this._slowWindows = 0;
    this._fastWindows = 0;
  }

  _restart() {
    this._clearEvidence();
    this._warmupRemaining = this._config.warmupMs;
    this._cooldownRemaining = 0;
    this._suspended = false;
  }

  _recommend(pixelRatio, reason, averageFrameMs = null) {
    const previousRatio = this._pixelRatio;
    if (pixelRatio === previousRatio) return null;
    this._pixelRatio = pixelRatio;
    return { pixelRatio, previousRatio, reason, averageFrameMs };
  }

  /**
   * Call on resize, quality change, or an externally applied DPR change.
   * Restarts learning, retaining the current ratio unless pixelRatio is supplied
   * or new bounds clamp it. Invalid settings leave the controller untouched.
   */
  reset(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new TypeError("Render scale options must be an object");
    const settings = configuration({
      ...this._config,
      pixelRatio: this._pixelRatio,
      ...options,
    });
    this._config = settings.config;
    this._minRatio = settings.minRatio;
    this._maxRatio = settings.maxRatio;
    this._restart();
    return this._recommend(settings.pixelRatio, "reset");
  }

  /**
   * Raw, unclamped RAF interval in milliseconds, not smoothed HUD FPS or dt.
   * Returns null unless the recommended ratio changes; callers should apply a
   * recommendation or reset with their actual ratio before collecting more data.
   * Each interval contributes at most 250ms to timers and the reported window
   * mean, limiting hitch influence without changing elapsed simulation time.
   * Forward pause/visibility transitions even when RAF work is otherwise skipped.
   */
  observe(frameMs, { paused = false, hidden = false } = {}) {
    if (paused || hidden) {
      if (!this._suspended) {
        this._clearEvidence();
        this._warmupRemaining = this._config.warmupMs;
      }
      this._suspended = true;
      return null;
    }
    if (this._suspended) {
      this._suspended = false;
      return null; // This interval may span the pause; do not train on it.
    }
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    const sample = Math.min(frameMs, MAX_SAMPLE_MS);
    const waiting = this._warmupRemaining > 0 || this._cooldownRemaining > 0;
    this._warmupRemaining = Math.max(0, this._warmupRemaining - sample);
    this._cooldownRemaining = Math.max(0, this._cooldownRemaining - sample);
    if (waiting) return null;

    this._windowTime += sample;
    this._windowFrames++;
    if (
      this._windowTime < this._config.windowMs ||
      this._windowFrames < MIN_WINDOW_FRAMES
    )
      return null;
    const averageFrameMs = this._windowTime / this._windowFrames;
    this._clearWindow();
    if (averageFrameMs > this._config.targetFrameMs * SLOW_THRESHOLD) {
      this._slowWindows++;
      this._fastWindows = 0;
    } else if (averageFrameMs < this._config.targetFrameMs * FAST_THRESHOLD) {
      this._fastWindows++;
      this._slowWindows = 0;
    } else {
      this._slowWindows = this._fastWindows = 0;
    }
    const direction =
      this._slowWindows >= SLOW_WINDOWS
        ? -1
        : this._fastWindows >= FAST_WINDOWS
          ? 1
          : 0;
    if (!direction) return null;
    this._clearEvidence();
    const step = this._config.step;
    const next = clamp(
      Math.round((this._pixelRatio + direction * step) * 1e6) / 1e6,
      Math.max(this._minRatio, this._pixelRatio - step),
      Math.min(this._maxRatio, this._pixelRatio + step)
    );
    const change = this._recommend(
      next,
      direction < 0 ? "slow" : "recovery",
      averageFrameMs
    );
    if (change) this._cooldownRemaining = this._config.cooldownMs;
    return change;
  }
}
