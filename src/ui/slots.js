import { getItem } from "../items.js";
import { appendItemIcon, element, setText } from "./dom.js";
import { durabilityView } from "./model.js";
import {
  displayStack,
  stackDescription,
  stackMetadataDetails,
} from "./slot-model.js";

export function createStackSlot({
  area,
  index = 0,
  label = "Slot",
  className = "",
  placeholder = "",
  interactive = true,
  tag = "button",
} = {}) {
  const node = element(tag, `stack-slot ${className}`.trim());
  if (tag === "button") node.type = "button";
  if (area) {
    node.dataset.area = area;
    node.dataset.index = String(index);
  }
  const picture = element("span", "slot-picture");
  const empty = element("span", "slot-placeholder", placeholder);
  empty.setAttribute("aria-hidden", "true");
  const count = element("span", "slot-count");
  const wear = element("span", "slot-wear");
  const fill = element("span");
  wear.append(fill);
  wear.hidden = true;
  node.append(picture, empty, count, wear);
  let lastId = -1;

  return {
    node,
    update(
      value,
      { unlimited = false, disabled = false, selected = false } = {}
    ) {
      const stack = displayStack(value);
      const id = stack?.id || 0;
      const item = getItem(id);
      const durability = durabilityView(item, stack?.durability);
      if (id !== lastId) {
        picture.replaceChildren();
        if (id) appendItemIcon(picture, id);
        lastId = id;
      }
      node.dataset.item = String(id);
      node.dataset.count = String(stack?.count || 0);
      node.dataset.unlimited = String(Boolean(unlimited && id));
      node.classList.toggle("is-empty", !id);
      node.classList.toggle("selected", selected);
      if (tag === "button") node.disabled = !interactive || disabled;
      node.setAttribute(
        "aria-label",
        `${label}: ${stackDescription(stack, { unlimited })}`
      );
      empty.hidden = Boolean(id);
      setText(
        count,
        !stack || unlimited || stack.count === 1 ? "" : stack.count
      );
      wear.hidden = !durability || durability.fraction >= 1 || unlimited;
      if (durability) {
        fill.style.width = `${durability.fraction * 100}%`;
        fill.style.backgroundColor = `hsl(${Math.round(durability.fraction * 120)} 100% 45%)`;
      }
    },
  };
}

export function createSlotGrid(
  container,
  { area, indices, labels = [], className = "" }
) {
  const slots = indices.map((index, position) => {
    const slot = createStackSlot({
      area,
      index,
      label:
        labels[position] ||
        `${area === "inventory" ? "Inventory" : "Slot"} ${index + 1}`,
      className,
    });
    container.append(slot.node);
    return slot;
  });
  return {
    slots,
    update(stacks, options) {
      slots.forEach((slot, position) =>
        slot.update(stacks[indices[position]], options)
      );
    },
  };
}

let tooltipId = 0;

export function createStackTooltip(container) {
  const node = element("div", "stack-tooltip");
  node.id = `stack-tooltip-${++tooltipId}`;
  node.setAttribute("role", "tooltip");
  node.hidden = true;
  const name = element("div", "stack-tooltip-name");
  const detail = element("div", "stack-tooltip-detail");
  node.append(name, detail);
  container.append(node);
  let anchor;

  function hide() {
    node.hidden = true;
    anchor?.removeAttribute("aria-describedby");
    anchor = null;
  }

  return {
    hide,
    show(value, target, x, y, { unlimited = false, note = "" } = {}) {
      const stack = displayStack(value);
      const item = getItem(stack?.id);
      if (!item) return hide();
      if (anchor !== target) {
        anchor?.removeAttribute("aria-describedby");
        anchor = target;
        anchor?.setAttribute("aria-describedby", node.id);
      }
      // Custom names are literal player text, never markup or innerHTML.
      setText(name, stack.data?.name ?? item.name);
      const durability = durabilityView(item, stack.durability);
      setText(
        detail,
        [
          ...(stack.data?.name ? [item.name] : []),
          ...stackMetadataDetails(stack.data),
          ...(durability
            ? [
                `Durability: ${Math.ceil(durability.remaining)} / ${durability.maximum}`,
              ]
            : []),
          ...(unlimited ? ["Creative catalog — copies items"] : []),
          ...(note ? [note] : []),
        ].join("\n")
      );
      detail.hidden = !detail.textContent;
      node.hidden = false;
      const rect = target?.getBoundingClientRect?.();
      const view = container.ownerDocument.defaultView;
      const left = x ?? rect?.right ?? 0;
      const top = y ?? rect?.top ?? 0;
      node.style.left = `${Math.max(4, Math.min(left + 12, (view?.innerWidth || 1024) - node.offsetWidth - 4))}px`;
      node.style.top = `${Math.max(4, Math.min(top - 12, (view?.innerHeight || 768) - node.offsetHeight - 4))}px`;
    },
    dispose() {
      hide();
      node.remove();
    },
  };
}

export function createCursorStack(container) {
  const slot = createStackSlot({
    tag: "div",
    label: "Carried stack",
    className: "carried-stack",
  });
  slot.node.hidden = true;
  slot.node.setAttribute("role", "status");
  slot.node.setAttribute("aria-live", "polite");
  container.append(slot.node);
  return {
    update(stack) {
      slot.update(stack);
      slot.node.hidden = !displayStack(stack);
    },
    move(x, y) {
      slot.node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -50%)`;
    },
    hide() {
      slot.node.hidden = true;
    },
    dispose() {
      slot.node.remove();
    },
  };
}
