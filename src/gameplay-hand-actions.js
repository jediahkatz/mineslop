import { ownedSlot, takeItem } from "./inventory-domain.js";
import { isValidStack, takeStack } from "./inventory-slots.js";
import { sameStackKind, stackIdentity } from "./item-stack-data.js";
import { getItem, ITEM } from "./items.js";

const hands = new Set(["main", "offhand"]);
const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const cost = (value) => Number.isSafeInteger(value) && value >= 0;

export const draftHand = (owned, hand, selected) =>
  ownedSlot(
    owned,
    hand === "main" ? "inventory" : "offhand",
    hand === "main" ? selected : 0
  );

/** Detached edit only. The final durability use still pays for its action. */
export function wearDraftHand(owned, hand, selected, amount) {
  const slot = draftHand(owned, hand, selected);
  const stack = slot.get();
  if (!stack?.durability) return false;
  const remaining = stack.durability - amount;
  slot.set(remaining > 0 ? { ...stack, durability: remaining } : null);
  return remaining <= 0;
}

export function withBrokenToolNotice(participant, gameplay, stack, broken) {
  if (!participant || !broken) return participant;
  return Object.freeze({
    ...participant,
    notify() {
      try {
        participant.notify?.();
      } finally {
        gameplay.onToast(`${getItem(stack.id).name} broke`);
      }
    },
  });
}

/**
 * A prepared held-stack debit, including a no-cost Creative identity guard.
 * Pass the stack/revision captured before preparing World work to reject a
 * replacement during that preparation. Count/wear never strip decoration.
 */
export function prepareHandCost(gameplay, hand, options = {}) {
  if (!hands.has(hand) || !record(options)) return null;
  const {
    count = 0,
    wear = 0,
    stack = gameplay.getHandStack(hand),
    handRevision = gameplay.getHandRevision(hand),
    notify = true,
  } = options;
  const current = gameplay.getHandStack(hand);
  if (
    !cost(count) ||
    !cost(wear) ||
    (!count && !wear) ||
    !isValidStack(stack, gameplay.context) ||
    !current ||
    !sameStackKind(current, stack, gameplay.context) ||
    handRevision !== gameplay.getHandRevision(hand) ||
    current.count < count ||
    (wear && (!current.durability || count))
  )
    return null;
  const selected = gameplay.selected;
  let broken = false;
  const participant = gameplay._prepareState(
    ({ owned }) => {
      if (gameplay.mode === "creative") return true;
      const slot = draftHand(owned, hand, selected);
      if (count) {
        const cells = [slot.get()];
        if (!takeStack(cells, 0, count)) return false;
        slot.set(cells[0]);
      }
      if (wear) broken = wearDraftHand(owned, hand, selected, wear);
      return true;
    },
    { notify, selfUseHands: [hand] }
  );
  return withBrokenToolNotice(participant, gameplay, current, broken);
}

/** One Gameplay publication pays both the chosen arrow and the exact bow. */
export function prepareBowShot(gameplay, shot, options = {}) {
  if (!record(shot) || !record(options) || !hands.has(shot.hand)) return null;
  const {
    hand,
    itemId,
    stackIdentity: identity,
    handRevision,
    strength,
  } = shot;
  const stack = gameplay.getHandStack(hand);
  if (
    !stack ||
    stack.id !== itemId ||
    getItem(stack.id)?.tool !== "bow" ||
    typeof identity !== "string" ||
    stackIdentity(stack, gameplay.context) !== identity ||
    !Number.isSafeInteger(handRevision) ||
    gameplay.getHandRevision(hand) !== handRevision ||
    !Number.isFinite(strength) ||
    strength < 0.1 ||
    strength > 1
  )
    return null;
  const otherHand = hand === "main" ? "offhand" : "main";
  const selected = gameplay.selected;
  let broken = false;
  const participant = gameplay._prepareState(
    ({ owned }) => {
      if (gameplay.mode === "creative") return true;
      const ammo = draftHand(owned, otherHand, selected);
      if (ammo.get()?.id === ITEM.ARROW) {
        const cells = [ammo.get()];
        if (!takeStack(cells, 0, 1)) return false;
        ammo.set(cells[0]);
      } else if (!takeItem(owned.slots, ITEM.ARROW, 1, selected)) {
        // A generic backpack search may spend only plain arrows.
        return false;
      }
      broken = wearDraftHand(owned, hand, selected, 1);
      return true;
    },
    { notify: options.notify ?? true, selfUseHands: [hand, otherHand] }
  );
  return withBrokenToolNotice(participant, gameplay, stack, broken);
}
