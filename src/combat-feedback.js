// Mirrors Game.primary's existing shared action gate; this is not a new balance
// rule. Mining may also update lastAction. The caller remains the only authority
// that dispatches damage, spends items or changes that timestamp.
export const MELEE_COOLDOWN_SECONDS = 0.5;
export const COMBAT_ACK_SECONDS = 0.18;
const ACK_INTERVAL_SECONDS = MELEE_COOLDOWN_SECONDS;

export function meleeReadiness(now, lastAction = -Infinity) {
  const valid =
    Number.isFinite(now) &&
    (lastAction === -Infinity || Number.isFinite(lastAction));
  const age = valid ? now - lastAction : 0;
  const progress = Math.max(0, Math.min(1, age / MELEE_COOLDOWN_SECONDS));
  return {
    ready: valid && age >= MELEE_COOLDOWN_SECONDS,
    progress,
    remaining: (1 - progress) * MELEE_COOLDOWN_SECONDS,
  };
}

/**
 * Ephemeral, constant-size feedback. Observes attempts; never accepts, queues or
 * repeats an attack. All times use Game.elapsed, so no timers/listeners or saves
 * are needed. Reset on input/lifecycle reset, without resetting Game.lastAction.
 */
export class CombatFeedback {
  constructor() {
    this.reset();
  }

  reset() {
    this.blockedAt = -Infinity;
    this.blockedReason = null;
    this.acknowledgedAt = -Infinity;
  }

  noteAttempt({
    now,
    lastAction,
    active = false,
    hasTarget = false,
    usingItem = false,
    pressed = true,
  } = {}) {
    const readiness = meleeReadiness(now, lastAction);
    const reason = !active
      ? "inactive"
      : !hasTarget
        ? "no-target"
        : !pressed
          ? "held"
          : usingItem
            ? "using-item"
            : !readiness.ready
              ? "cooldown"
              : null;
    let acknowledged = false;
    if (reason === null) {
      // Eligibility is NOT proof of a hit. Only remove the old refusal tint.
      this.blockedAt = -Infinity;
      this.blockedReason = null;
    } else if (
      (reason === "cooldown" || reason === "using-item") &&
      Number.isFinite(now) &&
      now - this.acknowledgedAt >= ACK_INTERVAL_SECONDS
    ) {
      this.blockedAt = this.acknowledgedAt = now;
      this.blockedReason = reason;
      acknowledged = true;
    }
    return { eligible: reason === null, reason, acknowledged };
  }

  view({
    now,
    lastAction,
    active = false,
    hasTarget = false,
    usingItem = false,
    hudVisible = true,
  } = {}) {
    const readiness = meleeReadiness(now, lastAction);
    const age = now - this.blockedAt;
    const visible = Boolean(
      active && hasTarget && hudVisible && Number.isFinite(now)
    );
    return {
      visible,
      ...readiness,
      ready: readiness.ready && !usingItem,
      phase: usingItem ? "using-item" : readiness.ready ? "ready" : "cooldown",
      // Retain a near-boundary refusal briefly even if readiness just became
      // full. It describes the previous press, never a successful hit.
      blockedReason:
        visible && age >= 0 && age < COMBAT_ACK_SECONDS
          ? this.blockedReason
          : null,
    };
  }
}
