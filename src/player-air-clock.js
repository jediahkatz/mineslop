// 300 fixed air-decrement opportunities in the existing 15-second air supply.
// Only Respiration needs a fractional tick. Plain breathing keeps its continuous
// legacy trajectory. Both this phase and the RNG peer publish with Gameplay.
export const AIR_TICK_SECONDS = 1 / 20;
const AIR_PER_TICK = 20 / 300;
const EPSILON = 1e-9;

export function airTickCount(phase, dt) {
  return Math.floor((phase + dt + EPSILON) / AIR_TICK_SECONDS);
}

/** Mutates a detached Gameplay draft; returns damage pulses, never applies them. */
export function advancePlayerAir(state, dt, {
  underwater = false, restoreAir = false, protectedSeconds = 0,
  respiration = false, losesAir = () => true,
} = {}) {
  if (restoreAir) {
    state.air = 20;
    state.airPhase = state.timers.drowning = 0;
    return 0;
  }
  if (!underwater) {
    state.air = Math.min(20, state.air + dt * 4);
    state.airPhase = state.timers.drowning = 0;
    return 0;
  }
  if (protectedSeconds > 0) {
    state.air = Math.min(20, state.air + protectedSeconds * (20 / 3.75));
    state.airPhase = state.timers.drowning = 0;
    dt = Math.max(0, dt - protectedSeconds);
  }
  let drowning = 0;
  if (respiration) {
    const ticks = airTickCount(state.airPhase, dt);
    state.airPhase = Math.max(0, state.airPhase + dt - ticks * AIR_TICK_SECONDS);
    for (let tick = 0; tick < ticks; tick++) {
      // The SAME roll gates air loss and the negative-air drowning countdown.
      if (!losesAir(tick)) continue;
      const breathing = Math.min(AIR_TICK_SECONDS, state.air / (20 / 15));
      state.air = Math.max(0, state.air - AIR_PER_TICK);
      if (state.air < EPSILON) state.air = 0;
      drowning += Math.max(0, AIR_TICK_SECONDS - breathing);
    }
  } else {
    state.airPhase = 0;
    const breathing = Math.min(dt, state.air / (20 / 15));
    state.air = Math.max(0, state.air - dt * (20 / 15));
    drowning = Math.max(0, dt - breathing);
  }
  const elapsed = state.timers.drowning + drowning;
  const hits = Math.floor(elapsed + EPSILON);
  state.timers.drowning = Math.max(0, elapsed - hits);
  return hits;
}
