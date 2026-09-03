import assert from "node:assert/strict";
import { Gameplay } from "../src/gameplay.js";
import { HorseUI } from "../src/ui/horse-panel.js";
import { preparedDropFixture } from "./prepared-drop-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};

/**
 * DOM/event harness only, not browser/layout or horse-domain evidence.
 * Player transactions and projections use real Gameplay/DropOverflow. Horse
 * commands deliberately REFUSE unless a test supplies an authority callback:
 * this fixture never invents saddle transfer/taming/mounting success.
 */
export function horsePanelFixture(t, {
  entries = [], cursor = null, saddle = null, mode = "survival",
  tamed = true, ridden = false,
  supportedActions = ["click", "quickMove", "swapHotbar", "swapOffhand", "drop", "distribute"],
  onHorseAction, afterAction, onClose, afterClose,
} = {}) {
  const { document, Node } = uiDomFixture(t);
  const documentEvents = new EventTarget();
  const documentListeners = new Set();
  document.addEventListener = (type, handler, options) => {
    const record = { type, handler };
    documentListeners.add(record);
    options?.signal?.addEventListener("abort", () => documentListeners.delete(record), { once: true });
    documentEvents.addEventListener(type, handler, options);
  };
  document.removeEventListener = documentEvents.removeEventListener.bind(documentEvents);
  document.dispatchEvent = documentEvents.dispatchEvent.bind(documentEvents);
  const matches = Node.prototype.matches;
  Node.prototype.matches = function(selector) {
    if (selector.includes(","))
      return selector.split(",").some((part) => this.matches(part.trim()));
    if (selector.startsWith("input:not("))
      return this.tagName === "INPUT" &&
        !["checkbox", "radio", "range", "button", "submit"].includes(this.type);
    if (selector === "[tabindex]") return this.tabIndex !== undefined;
    if (selector === "a[href]") return this.tagName === "A" && this.getAttribute("href") !== null;
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase();
    return matches.call(this, selector);
  };
  Object.defineProperty(Node.prototype, "isConnected", {
    get() { return document.body.contains(this); },
  });
  document.body = new Node("body");
  const root = new Node("div"), opener = new Node("button");
  root.id = "ui";
  document.body.append(opener, root);
  opener.focus();

  const gameplay = new Gameplay({ mode });
  assert.equal(gameplay.inventoryTransaction((owned) => {
    owned.slots = Array(36).fill(null);
    for (const [index, stack] of entries) owned.slots[index] = stack;
    owned.cursor = cursor;
    return true;
  }), true);
  const sink = preparedDropFixture(gameplay);
  const actions = [], results = [], closes = [];
  const parent = { controlsEnabled: true, paused: false };
  let active = false, revision = 0, nextToken = 0, reads = 0, fixture;
  let projected = {
    kind: "horse", sessionToken: 0, horseId: "horse-ui-1", dimension: "overworld",
    tamed, ridden, slots: [saddle], supportedActions,
  };
  const ui = new HorseUI(root, {
    readView() {
      reads++;
      return active ? freeze({ ...structuredClone(projected), gameplay: gameplay.getState() }) : null;
    },
    readRevision: () => `${revision}:${gameplay.revision}:${projected.sessionToken}`,
    onAction(action) {
      actions.push(action);
      let result;
      if (!active || action.sessionToken !== projected.sessionToken)
        result = { ok: false, message: "Stale horse session." };
      else if (action.area === "container" ||
          action.targets?.some((target) => target.area === "container"))
        result = onHorseAction?.(action, fixture) ??
          { ok: false, message: "Horse transfer refused by the test authority." };
      else result = gameplay.inventoryAction(action, { prepareDrops: sink.prepareDrops });
      results.push(result);
      return afterAction ? afterAction(result, action, fixture) : result;
    },
    onClose(command) {
      closes.push(command);
      if (!active || command.sessionToken !== projected.sessionToken)
        return { ok: false, message: "Stale horse session." };
      const result = onClose?.(command, fixture) ?? { ok: true };
      if (result === true || result?.ok === true) {
        active = false;
        parent.controlsEnabled = true;
        afterClose?.(fixture, command);
      }
      return result;
    },
  });
  t.after(() => { ui.dispose(); sink.overflow.dispose(); gameplay.dispose(); });

  const projection = (extra) => {
    projected = { ...projected, ...extra };
    revision++;
  };
  const open = (extra = {}) => {
    projection({ ...extra, sessionToken: ++nextToken });
    active = true;
    parent.controlsEnabled = false;
    return ui.open();
  };
  const invalidate = () => {
    active = false;
    parent.controlsEnabled = true;
    ui.hide();
  };
  let timestamp = 0;
  const fire = (type, target = ui.element, properties = {}, dispatcher = ui.element) => {
    const event = new Event(type, { cancelable: true });
    for (const [key, value] of Object.entries({
      target, pointerId: 1, clientX: 100, clientY: 100,
      button: 0, detail: 1, timeStamp: ++timestamp * 1000, ...properties,
    })) Object.defineProperty(event, key, { value });
    document.elementFromPoint = () => target;
    dispatcher.dispatchEvent(event);
    return event;
  };
  const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
  const click = async (target, properties = {}) => {
    fire("pointerdown", target, properties);
    fire("pointerup", target, properties);
    fire("click", ui.element, { detail: 1 });
    await settle();
  };
  const activate = async (target, dispatcher = ui.element) => {
    assert.equal(Boolean(target.disabled), false);
    fire("click", target, { detail: 0 }, dispatcher);
    await settle();
  };
  const key = async (target, code, properties = {}) => {
    fire("pointermove", target);
    const event = fire("keydown", target, { code, ...properties });
    await settle();
    return event;
  };
  const documentKey = async (code, properties = {}) => {
    const event = fire("keydown", document.activeElement, { code, ...properties }, document);
    await settle();
    return event;
  };
  const slot = (area, index = 0) => {
    const node = ui.element.querySelectorAll(`[data-area="${area}"][data-index="${index}"]`)
      .find((node) => !node.closest("[hidden]"));
    assert.ok(node, `Visible ${area}:${index} slot`);
    return node;
  };
  fixture = {
    ui, root, opener, document, Node, documentListeners, gameplay, parent, sink,
    actions, results, closes, projection, open, invalidate,
    fire, settle, click, activate, key, documentKey, slot,
    token: () => projected.sessionToken,
    reads: () => reads,
  };
  return fixture;
}
