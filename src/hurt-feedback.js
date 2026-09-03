import { Matrix4 } from "three";

export const HURT_SECONDS = 0.28;
export const HURT_MAX_ROLL = 0.085;
export const HURT_MAX_FLASH = 0.24;

/**
 * Transient presentation, fed ONLY by Gameplay.onHurt after health publication.
 * Advance with active simulation seconds, never wall time or day/sleep jumps.
 * One pulse is refreshed by further hits, not added to a queue or saved.
 * Reset on owner/life/input replacement; death clears rather than freezing it.
 */
export class HurtFeedback {
  constructor({
    motionPreference = globalThis.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ),
  } = {}) {
    // MediaQueryList.matches stays current without a listener per game/hit.
    this.motionPreference = motionPreference;
    this.disposed = false;
    this._rendering = false;
    this._projection = new Matrix4();
    this._inverse = new Matrix4();
    this._roll = new Matrix4();
    this.reset();
  }

  reset() {
    this.remaining = 0;
    this.strength = 0;
  }

  noteHealthLoss({ previousHealth, health, damage, dead } = {}) {
    if (
      this.disposed ||
      !Number.isFinite(previousHealth) ||
      !Number.isFinite(health) ||
      previousHealth > 20 ||
      health < 0 ||
      health >= previousHealth ||
      damage !== previousHealth - health ||
      typeof dead !== "boolean" ||
      dead !== (health === 0)
    )
      return false;
    if (dead) {
      this.reset();
      return false;
    }
    this.remaining = HURT_SECONDS;
    this.strength = Math.max(this.strength, Math.min(1, 0.55 + damage / 12));
    return true;
  }

  update(dt, { simulating = true, visible = true, dead = false } = {}) {
    if (this.disposed || dead) this.reset();
    else if (simulating && Number.isFinite(dt) && dt > 0) {
      this.remaining = Math.max(0, this.remaining - dt);
      if (!this.remaining) this.strength = 0;
    }
    const envelope =
      simulating && visible
        ? this.strength * (this.remaining / HURT_SECONDS) ** 2
        : 0;
    return {
      visible: envelope > 0,
      roll:
        envelope > 0 && !this.motionPreference?.matches
          ? -HURT_MAX_ROLL * envelope
          : 0,
      flash: HURT_MAX_FLASH * envelope,
      tint: envelope,
    };
  }

  /**
   * Wrap ONLY the final synchronous draw, after physics, rays and camera sync.
   * P * Rz rolls the image around the view axis just like camera-local roll.
   * It leaves camera pose/eye/quaternion/forward (and the center ray) untouched.
   * Restoring both matrices verbatim avoids quaternion/Euler round-trip drift,
   * including huge unwrapped yaw, pause, F5, exceptions and renderer replacement.
   */
  render(camera, view, draw) {
    if (
      this.disposed ||
      this._rendering ||
      this.remaining <= 0 ||
      !camera?.isCamera ||
      !view?.visible ||
      this.motionPreference?.matches ||
      !Number.isFinite(view.roll) ||
      view.roll === 0
    )
      return draw();
    const projection = camera.projectionMatrix;
    const inverse = camera.projectionMatrixInverse;
    this._projection.copy(projection);
    this._inverse.copy(inverse);
    this._rendering = true;
    try {
      const roll = Math.max(-HURT_MAX_ROLL, Math.min(HURT_MAX_ROLL, view.roll));
      projection.multiply(this._roll.makeRotationZ(-roll));
      inverse.copy(projection).invert();
      return draw();
    } finally {
      projection.copy(this._projection);
      inverse.copy(this._inverse);
      this._rendering = false;
    }
  }

  dispose() {
    this.reset();
    this.disposed = true;
    this.motionPreference = null;
  }
}
