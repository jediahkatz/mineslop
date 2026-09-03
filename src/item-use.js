import { isValidStack } from "./inventory-slots.js";
import { stackIdentity } from "./item-stack-data.js";
import { POTION_DRINK_SECONDS } from "./potion-rules.js";

export const FOOD_USE_SECONDS = 1.6;
export const BOW_DRAW_SECONDS = 1;
export const SHIELD_RAISE_SECONDS = 0.25;
export const MIN_BOW_STRENGTH = 0.1;

const kinds = new Set(["food", "drink", "bow", "shield"]);
const hands = new Set(["main", "offhand"]);
const finitePosition = (value) =>
  value && [value.x, value.y, value.z].every(Number.isFinite);

export function itemUseKind(item) {
  if (item?.potionForm === "drinkable") return "drink";
  if (item?.kind === "food" || Number(item?.food?.hunger) > 0) return "food";
  if (item?.tool === "bow") return "bow";
  if (
    item?.kind === "shield" ||
    item?.tool === "shield" ||
    item?.shield === true
  )
    return "shield";
  return null;
}

export function bowStrength(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const pull = Math.min(1, seconds / BOW_DRAW_SECONDS);
  return Math.min(1, (pull * pull + 2 * pull) / 3);
}

/** Held-use timing only. Inventory, world changes and damage remain with the caller. */
export class ItemUse {
  constructor() {
    this.cancel();
  }

  get active() {
    return this.kind !== null;
  }

  get blocking() {
    return this.kind === "shield" && this.elapsed >= SHIELD_RAISE_SECONDS;
  }

  get progress() {
    if (!this.active) return 0;
    const duration =
      this.kind === "drink"
        ? POTION_DRINK_SECONDS
        : this.kind === "food"
        ? FOOD_USE_SECONDS
        : this.kind === "bow"
          ? BOW_DRAW_SECONDS
          : SHIELD_RAISE_SECONDS;
    return Math.min(1, this.elapsed / duration);
  }

  /**
   * Actual callers pass (kind,hand,Stack,getHandRevision(hand)). ID-only calls
   * remain a timing-test adapter. Wear/count are not a replacement identity.
   */
  start(kind, hand, stackOrId, handRevision) {
    const legacy = typeof stackOrId === "number";
    const itemId = legacy ? stackOrId : stackOrId?.id;
    if (
      !kinds.has(kind) ||
      !hands.has(hand) ||
      !Number.isSafeInteger(itemId) ||
      itemId <= 0 ||
      (!legacy && !isValidStack(stackOrId)) ||
      (handRevision !== undefined &&
        (!Number.isSafeInteger(handRevision) || handRevision < 0))
    )
      return false;
    const identity = legacy ? null : stackIdentity(stackOrId);
    if (
      this.kind === kind &&
      this.hand === hand &&
      this.itemId === itemId &&
      this.identity === identity &&
      this.handRevision === handRevision
    )
      return false;
    this.kind = kind;
    this.hand = hand;
    this.itemId = itemId;
    this.identity = identity;
    this.handRevision = handRevision;
    this.elapsed = 0;
    return true;
  }

  matches(stack, handRevision) {
    if (
      !this.active ||
      stack?.id !== this.itemId ||
      !Number.isSafeInteger(stack.count) ||
      stack.count <= 0 ||
      (this.handRevision !== undefined && handRevision !== this.handRevision)
    )
      return false;
    return (
      this.identity === null ||
      (isValidStack(stack) && stackIdentity(stack) === this.identity)
    );
  }

  /** Returns true when one food/drink cycle is ready; caller owns its commit. */
  advance(dt) {
    if (!this.active || !Number.isFinite(dt) || dt <= 0) return false;
    const maximum = this.kind === "drink" ? POTION_DRINK_SECONDS :
      this.kind === "food" ? FOOD_USE_SECONDS : BOW_DRAW_SECONDS;
    this.elapsed = Math.min(maximum, this.elapsed + Math.min(dt, 0.25));
    return ["food", "drink"].includes(this.kind) && this.elapsed >= maximum - 1e-9;
  }

  completeFoodCycle() {
    if (this.kind !== "food" || this.elapsed < FOOD_USE_SECONDS - 1e-9)
      return false;
    this.elapsed = 0;
    return true;
  }

  completeDrinkCycle() {
    if (this.kind !== "drink" || this.elapsed < POTION_DRINK_SECONDS - 1e-9)
      return false;
    this.cancel();
    return true;
  }

  release() {
    const strength = this.kind === "bow" ? bowStrength(this.elapsed) : 0;
    const shot =
      strength >= MIN_BOW_STRENGTH
        ? {
            hand: this.hand,
            itemId: this.itemId,
            strength,
            ...(this.identity === null ? {} : { stackIdentity: this.identity }),
            ...(this.handRevision === undefined
              ? {}
              : { handRevision: this.handRevision }),
          }
        : null;
    this.cancel();
    return shot;
  }

  /** Blur, menus, selection and world changes cancel instead of firing a bow. */
  cancel() {
    this.kind = null;
    this.hand = null;
    this.itemId = 0;
    this.identity = null;
    this.handRevision = undefined;
    this.elapsed = 0;
  }

  snapshot() {
    return {
      active: this.active,
      kind: this.kind,
      hand: this.hand,
      itemId: this.itemId,
      stackIdentity: this.identity,
      handRevision: this.handRevision,
      progress: this.progress,
      blocking: this.blocking,
    };
  }
}

/** Shield coverage is the forward horizontal hemisphere, not ambient protection. */
export function canShieldBlock({ blocking, eye, forward, source, kind }) {
  if (
    !blocking ||
    !["melee", "projectile", "explosion"].includes(kind) ||
    !finitePosition(eye) ||
    !finitePosition(forward) ||
    !finitePosition(source)
  )
    return false;
  const dx = source.x - eye.x;
  const dz = source.z - eye.z;
  const sourceLength = Math.hypot(dx, dz);
  const forwardLength = Math.hypot(forward.x, forward.z);
  if (sourceLength < 1e-9 || forwardLength < 1e-9) return false;
  return (dx * forward.x + dz * forward.z) / sourceLength / forwardLength > 0;
}
