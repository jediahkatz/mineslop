import { hotbarSlotView } from "./slot-model.js";
import { createStackSlot } from "./slots.js";

export function createHotbar(container, { listen, onSelect }) {
  let state = { hotbar: Array(9).fill(0), selected: 0 };
  const slots = Array.from({ length: 9 }, (_, index) => {
    const slot = createStackSlot({
      label: `Hotbar ${index + 1}`,
      className: "hotbar-slot",
      interactive: Boolean(onSelect),
    });
    slot.node.dataset.slot = String(index);
    container.append(slot.node);
    return slot;
  });

  listen(container, "click", (event) => {
    const button = event.target.closest("[data-slot]");
    if (button && !button.disabled && container.contains(button))
      onSelect?.(Number(button.dataset.slot));
  });
  listen(container, "keydown", (event) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (delta === undefined && !["Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 8
          : (state.selected + delta + 9) % 9;
    onSelect?.(next);
    slots[next].node.focus();
  });

  return {
    update(next) {
      state = next;
      slots.forEach((slot, index) => {
        const { stack, unlimited } = hotbarSlotView(state, index);
        const active = index === state.selected;
        slot.update(stack, { unlimited, selected: active });
        slot.node.setAttribute("aria-pressed", String(active));
        slot.node.tabIndex = active ? 0 : -1;
      });
    },
  };
}
