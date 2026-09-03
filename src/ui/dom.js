import { getItem } from "../items.js";
import * as textures from "../textures.js";

const ICONS = {
  cube: '<path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z"/><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  settings:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="16" cy="17" r="3"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  save: '<path d="M5 3h12l4 4v14H3V3h2Zm2 0v7h10V3M7 21v-7h10v7"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="m16 8-2 6-6 2 2-6 6-2Z"/>',
  leaf: '<path d="M20 4C8 2 2 8 5 15s15 3 15-11ZM5 20l9-10"/>',
  heart:
    '<path d="M12 20 3.5 12A5.4 5.4 0 0 1 12 5.5 5.4 5.4 0 0 1 20.5 12Z"/>',
  hunger: '<path d="M8 14c-6-8 5-13 9-7 6 4 1 15-7 9l-4 4-3-3 5-3Z"/>',
  air: '<circle cx="12" cy="12" r="8"/><path d="M7 10a5 5 0 0 1 4-3"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  pack: '<path d="M8 6V4h8v2M5 7h14v14H5zM5 13h14M9 13v3h6v-3"/>',
  craft: '<path d="m14 3 7 7-4 4-3-3-9 10-3-3L12 9 9 6l5-3Z"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
};

export const svg = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.cube}</svg>`;

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

export function appendItemIcon(container, id) {
  if (!id) return;
  const icon = textures.itemIcon?.(id);
  if (typeof icon === "string") {
    const image = element("img", "item-icon");
    image.src = icon;
    image.alt = "";
    image.draggable = false;
    container.append(image);
  } else if (icon?.nodeType) {
    container.append(icon.cloneNode(true));
  } else {
    const fallback = element("span", "item-icon item-icon-fallback");
    fallback.style.color = getItem(id)?.color || "#d1eb93";
    fallback.innerHTML = svg("cube");
    container.append(fallback);
  }
}

export function setText(node, text) {
  const value = String(text ?? "");
  if (node.textContent !== value) node.textContent = value;
}

export function focusFirst(panel) {
  const first = focusableElements(panel)[0];
  (first || panel).focus({ preventScroll: true });
}

function focusableElements(panel) {
  return [
    ...panel.querySelectorAll(
      "a[href],button,input,select,textarea,[tabindex]"
    ),
  ].filter(
    (node) =>
      !node.disabled && node.tabIndex !== -1 && !node.closest("[hidden]")
  );
}

export function trapFocus(event, panel) {
  if (event.key !== "Tab") return;
  const nodes = focusableElements(panel);
  const first = nodes[0];
  const last = nodes.at(-1);
  const active = panel.ownerDocument?.activeElement ?? document.activeElement;
  if (!first) {
    event.preventDefault();
    panel.focus();
  } else if (!nodes.includes(active)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  }
}

export function isTextInput(target) {
  return (
    target?.matches?.(
      'input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="button"]):not([type="submit"]), select, textarea'
    ) || target?.isContentEditable
  );
}

export function createEventScope() {
  const abort = new AbortController();
  return {
    listen(node, event, handler, options = {}) {
      node.addEventListener(event, handler, {
        ...options,
        signal: abort.signal,
      });
    },
    dispose() {
      abort.abort();
    },
  };
}
