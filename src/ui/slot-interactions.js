import { stackIdentity } from "../item-stack-data.js";
import { TransactionInvariantError } from "../transactions.js";
import { isTextInput } from "./dom.js";
import {
  displayStack,
  slotAddress,
  slotKeyAction,
  stackAt,
  uniqueSlotTargets,
} from "./slot-model.js";
import { createCursorStack, createStackTooltip } from "./slots.js";

// Shared by the personal inventory, table, chests and furnaces. This controller
// emits transactions only; all ownership, capacity and validation stay in domain.
export function createSlotInteractions(
  container,
  { listen, getState, onAction, onStatus = () => {}, onRefresh = () => {} }
) {
  const document = container.ownerDocument;
  const tooltip = createStackTooltip(container);
  const cursor = createCursorStack(container);
  let hovered = null;
  let pointer = {
    x: (document.defaultView?.innerWidth || 0) / 2,
    y: (document.defaultView?.innerHeight || 0) / 2,
  };
  let gesture = null;
  let lastClick = null;
  let suppressPointerClick = false;
  let busy = false;
  let disposed = false;
  let request = 0;

  const active = () => !disposed && !container.hidden;
  const slotNode = (target) => {
    const node = target?.closest?.("[data-area][data-index]");
    return node &&
      container.contains(node) &&
      !node.disabled &&
      !node.closest("[hidden]")
      ? node
      : null;
  };
  const hitNode = (event) =>
    slotNode(document.elementFromPoint?.(event.clientX, event.clientY)) ||
    slotNode(event.target);
  const stackFor = (node) => {
    const address = slotAddress(node);
    return address?.area === "catalog"
      ? { id: Number(node.dataset.item), count: 1 }
      : address
        ? stackAt(getState(), address)
        : null;
  };

  function updateTooltip() {
    if (!active() || getState().cursor || gesture) return tooltip.hide();
    tooltip.show(stackFor(hovered), hovered, pointer.x, pointer.y, {
      unlimited: hovered?.dataset.area === "catalog",
      note: hovered?.dataset.note || "",
    });
  }

  function resetGesture() {
    if (gesture) {
      try {
        container.releasePointerCapture?.(gesture.pointerId);
      } catch {
        // Browsers release capture themselves when the pointer is cancelled.
      }
    }
    gesture = null;
    container.querySelectorAll(".is-drag-target").forEach((node) => {
      node.classList.remove("is-drag-target");
    });
  }

  async function dispatch(action) {
    if (!onAction || busy || !active()) return false;
    busy = true;
    const currentRequest = ++request;
    container.setAttribute("aria-busy", "true");
    onStatus("", false);
    try {
      const result = await onAction(action);
      if (disposed || currentRequest !== request) return false;
      if (result !== true && result?.ok !== true) {
        onStatus(result?.message || "That item could not be moved.", true);
        return false;
      }
      if (result?.message) onStatus(result.message, false);
      return true;
    } catch (error) {
      // Publication failures are fatal ownership invariants, not a refused click.
      if (error instanceof TransactionInvariantError) throw error;
      if (!disposed && currentRequest === request)
        onStatus(error.message || "That item could not be moved.", true);
      return false;
    } finally {
      if (!disposed && currentRequest === request) {
        busy = false;
        container.setAttribute("aria-busy", "false");
        onRefresh();
        cursor.update(getState().cursor);
        updateTooltip();
      }
    }
  }

  function clickAction(node, button, shiftKey, double = false) {
    const address = slotAddress(node);
    if (!address) return null;
    if (address.area === "catalog")
      return {
        type: "creativePick",
        id: Number(node.dataset.item),
        wholeStack: button !== 2,
        ...(shiftKey ? { hotbarIndex: getState().selected || 0 } : {}),
      };
    if (address.area === "result")
      return { type: "takeCraftResult", shift: Boolean(shiftKey) };
    return double
      ? { type: "collect", ...address }
      : shiftKey
        ? { type: "quickMove", ...address }
        : { type: "click", ...address, button };
  }

  listen(container, "pointerdown", (event) => {
    if (!active()) return;
    suppressPointerClick = false;
    if (busy || ![0, 2].includes(event.button)) return;
    if (gesture && gesture.pointerId !== event.pointerId) return;
    const node = slotNode(event.target);
    if (!node) return;
    event.preventDefault();
    node.focus({ preventScroll: true });
    hovered = node;
    pointer = { x: event.clientX, y: event.clientY };
    gesture = {
      node,
      pointerId: event.pointerId,
      button: event.button,
      address: slotAddress(node),
      shift: event.shiftKey,
      hadCursor: Boolean(getState().cursor),
      targets: [slotAddress(node)],
    };
    tooltip.hide();
    try {
      container.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic/non-primary pointers may not support capture.
    }
  });

  listen(container, "pointermove", (event) => {
    if (!active()) return;
    pointer = { x: event.clientX, y: event.clientY };
    cursor.move(pointer.x, pointer.y);
    hovered = hitNode(event);
    if (
      gesture &&
      gesture.pointerId === event.pointerId &&
      gesture.hadCursor &&
      !gesture.shift &&
      hovered &&
      !["catalog", "result"].includes(gesture.address.area)
    ) {
      gesture.targets = uniqueSlotTargets([
        ...gesture.targets,
        slotAddress(hovered),
      ]);
      if (gesture.targets.length > 1)
        for (const target of gesture.targets)
          [
            ...container.querySelectorAll(
              `[data-area="${target.area}"][data-index="${target.index}"]`
            ),
          ]
            .find((node) => !node.closest("[hidden]"))
            ?.classList.add("is-drag-target");
    }
    updateTooltip();
  });

  listen(container, "pointerup", (event) => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    event.preventDefault();
    suppressPointerClick = true;
    const finished = gesture;
    const target = hitNode(event);
    resetGesture();
    if (!active() || busy) return;
    if (finished.hadCursor && finished.targets.length > 1) {
      lastClick = null;
      void dispatch({
        type: "distribute",
        targets: finished.targets,
        button: finished.button,
      });
      return;
    }
    if (!target || target !== finished.node) return;
    const now = event.timeStamp;
    const key = `${finished.address.area}:${finished.address.index}`;
    const stack =
      displayStack(getState().cursor) || displayStack(stackFor(target));
    const kind = stack ? stackIdentity(stack) : null;
    const double =
      finished.button === 0 &&
      !finished.shift &&
      lastClick?.button === 0 &&
      lastClick?.key === key &&
      kind !== null &&
      lastClick?.kind === kind &&
      now - lastClick.time >= 0 &&
      now - lastClick.time < 300 &&
      Boolean(getState().cursor || stackFor(target));
    lastClick =
      double || finished.shift
        ? null
        : { key, kind, time: now, button: finished.button };
    const action = clickAction(target, finished.button, finished.shift, double);
    if (action) void dispatch(action);
  });

  listen(container, "click", (event) => {
    // Pointer capture can retarget click to the overlay itself. Consume that
    // follow-up event so a slot transaction cannot also dismiss its screen.
    if (suppressPointerClick && event.detail !== 0) {
      suppressPointerClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const node = slotNode(event.target);
    if (!node || !active()) return;
    event.preventDefault();
    // Pointer actions already commit on release. Native keyboard activation
    // has detail=0 and must remain usable without synthesizing mouse gestures.
    if (event.detail === 0 && !gesture) {
      const action = clickAction(node, 0, event.shiftKey);
      if (action) void dispatch(action);
    }
  });
  listen(container, "dblclick", (event) => {
    if (slotNode(event.target)) event.preventDefault();
  });
  listen(container, "contextmenu", (event) => event.preventDefault());
  listen(container, "pointercancel", resetGesture);
  listen(container, "lostpointercapture", resetGesture);
  listen(container, "pointerleave", () => {
    hovered = null;
    tooltip.hide();
  });
  listen(container, "focusin", (event) => {
    if (!active()) return;
    hovered = slotNode(event.target);
    const rect = hovered?.getBoundingClientRect();
    if (rect) pointer = { x: rect.right, y: rect.top };
    updateTooltip();
  });
  listen(container, "keydown", (event) => {
    if (!active() || isTextInput(event.target)) return;
    const node = hovered || slotNode(document.activeElement);
    const address = slotAddress(node);
    if (!address || address.area === "result") return;
    let action = slotKeyAction(event, address);
    if (address.area === "catalog") {
      action =
        action?.type === "swapHotbar"
          ? {
              type: "creativePick",
              id: Number(node.dataset.item),
              wholeStack: true,
              hotbarIndex: action.hotbarIndex,
            }
          : null;
    }
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    lastClick = null;
    void dispatch(action);
  });
  if (document.defaultView)
    listen(document.defaultView, "blur", () => {
      resetGesture();
      tooltip.hide();
    });

  return {
    dispatch,
    get busy() {
      return busy;
    },
    update() {
      if (!active()) {
        resetGesture();
        tooltip.hide();
        cursor.hide();
      } else {
        cursor.update(getState().cursor);
        // Keyboard take/place still displays a cursor near the focused slot.
        cursor.move(pointer.x, pointer.y);
        updateTooltip();
      }
    },
    reset() {
      resetGesture();
      lastClick = null;
      suppressPointerClick = false;
      hovered = null;
      tooltip.hide();
      cursor.hide();
    },
    dispose() {
      disposed = true;
      request++;
      resetGesture();
      tooltip.dispose();
      cursor.dispose();
    },
  };
}
