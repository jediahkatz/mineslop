/** Observe post-collision fluid samples, never infer water from the floor block.
 * Seed/reset at spawn and teleport. Hysteresis ignores water-surface chatter.
 */
export class WaterAudioTracker {
  constructor(play) {
    this.play = play;
    this.reset();
  }

  reset() {
    this.wet = null;
    this.poseRevision = undefined;
  }

  observe(sample, {
    flying = false, seated = false, jumping = false, poseRevision, reset = false,
  } = {}) {
    if (!sample?.valid || sample.loaded === false || sample.eyeLoaded === false ||
      !Number.isFinite(sample.waterImmersion)) {
      this.reset();
      return false;
    }
    const immersion = sample.waterImmersion;
    const wet = immersion >= 0.025 || (this.wet === true && immersion > 0);
    const seed = reset || this.wet === null || this.poseRevision !== poseRevision || flying || seated;
    const previous = this.wet;
    this.wet = wet;
    this.poseRevision = poseRevision;
    if (seed || previous === wet) return false;
    if (wet) return this.play("water-entry");
    if (jumping) return this.play("water-jump");
    return false;
  }
}
