export const FPS_WINDOW_MS = 500;

/**
 * Rendered frames divided by their actual elapsed time, not an average of
 * reciprocal frame times. Constant storage/work; no timers or frame arrays.
 * Call after a completed draw with the unclamped RAF interval. Reset across
 * hidden/loading gaps; the first subsequent interval is not a complete sample.
 */
export class FrameRate {
  constructor() {
    this.reset();
  }

  reset() {
    this.fps = null;
    this.frameMs = null;
    this._frames = 0;
    this._elapsedMs = 0;
    this._continuous = false;
  }

  observe(frameMs) {
    if (!Number.isFinite(frameMs) || frameMs <= 0) {
      this.reset();
      return false;
    }
    if (!this._continuous) {
      this._continuous = true;
      return false;
    }
    this._frames++;
    this._elapsedMs += frameMs;
    if (!Number.isFinite(this._elapsedMs)) {
      this.reset();
      return false;
    }
    if (this._elapsedMs < FPS_WINDOW_MS) return false;
    this.fps = (1000 * this._frames) / this._elapsedMs;
    this.frameMs = this._elapsedMs / this._frames;
    this._frames = 0;
    this._elapsedMs = 0;
    return true;
  }
}
