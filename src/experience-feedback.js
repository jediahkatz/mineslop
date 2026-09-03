import {
  experienceForLevel,
  experienceState,
  experienceToNextLevel,
  isValidExperience,
} from "./experience.js";

export const EXPERIENCE_PULSE_SECONDS = 0.65;
export const LEVEL_NOTICE_SECONDS = 2.4;
export const LEVEL_SOUND_INTERVAL = 5;

/** Derive the readable bar from canonical total XP; never save these fields. */
export function experienceProgress(total) {
  const state = experienceState(total);
  const needed = experienceToNextLevel(state.level);
  const earned = total - experienceForLevel(state.level);
  return {
    ...state,
    earned,
    needed,
    remaining: needed - earned,
    label: `Level ${state.level} · ${earned} / ${needed} XP · ${needed - earned} XP to level ${state.level + 1}`,
  };
}

/**
 * Presentation only. A receipt describes ONE already-published XP gain, not a
 * Gameplay snapshot. Loading, respawning and spending levels never call earned.
 * The receipt object is single-use, including across reset; no saved reward IDs,
 * timers, extra XP balance or second player-life counter are introduced here.
 */
export class ExperienceFeedback {
  constructor() {
    this._receipts = new WeakSet();
    this._sequence = 0;
    this.disposed = false;
    this.reset();
  }

  reset() {
    this.spent();
    this.soundRemaining = 0;
  }

  /** Spending hides the old earned level, without resetting the chime cooldown. */
  spent() {
    this.pulseRemaining = 0;
    this.noticeRemaining = 0;
    this.level = 0;
  }

  earned(receipt) {
    if (
      this.disposed ||
      !receipt ||
      typeof receipt !== "object" ||
      this._receipts.has(receipt) ||
      !isValidExperience(receipt.previousTotal) ||
      !isValidExperience(receipt.total) ||
      receipt.total <= receipt.previousTotal
    )
      return null;
    this._receipts.add(receipt);
    const previous = experienceState(receipt.previousTotal);
    const next = experienceState(receipt.total);
    const levels = next.level - previous.level;
    this.pulseRemaining = EXPERIENCE_PULSE_SECONDS;
    if (levels > 0) {
      this.level = next.level;
      this.noticeRemaining = LEVEL_NOTICE_SECONDS;
      this._sequence++;
    }
    // Java's distinctive chime marks five-level milestones, with a five-second
    // cooldown. One large reward crosses a milestone once, not once per level.
    const milestone = Math.floor(next.level / 5) * 5;
    const soundLevel =
      milestone > previous.level && this.soundRemaining === 0
        ? next.level
        : null;
    if (soundLevel !== null) this.soundRemaining = LEVEL_SOUND_INTERVAL;
    return {
      amount: receipt.total - receipt.previousTotal,
      level: next.level,
      levels,
      soundLevel,
    };
  }

  view({ visible = true } = {}) {
    const pulse = visible ? this.pulseRemaining / EXPERIENCE_PULSE_SECONDS : 0;
    const levelUp = visible && this.noticeRemaining > 0;
    return {
      visible: pulse > 0 || levelUp,
      pulse,
      levelUp,
      level: this.level,
      sequence: this._sequence,
      opacity: levelUp ? Math.min(1, this.noticeRemaining / 0.5) : 0,
    };
  }

  update(dt, { simulating = true, visible = true, dead = false, mode = "survival" } = {}) {
    if (this.disposed || dead || mode !== "survival") this.reset();
    else if (simulating && Number.isFinite(dt) && dt > 0) {
      const elapsed = Math.min(dt, 0.25);
      this.pulseRemaining = Math.max(0, this.pulseRemaining - elapsed);
      this.noticeRemaining = Math.max(0, this.noticeRemaining - elapsed);
      this.soundRemaining = Math.max(0, this.soundRemaining - elapsed);
    }
    return this.view({ visible: visible && simulating && !this.disposed });
  }

  dispose() {
    this.reset();
    this.disposed = true;
  }
}
