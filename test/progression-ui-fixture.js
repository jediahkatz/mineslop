import assert from "node:assert/strict";
import { ProgressionUI } from "../src/ui/progression-panel.js";
import { progressionLiveFixture } from "./progression-live-fixture.js";
import { progressionTradingFixture } from "./progression-trading-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

/**
 * Lightweight DOM/event harness, not browser/layout evidence. Extend only the
 * existing test DOM's missing selectors/document events. Production panels,
 * slot controller, registries, World and every ownership callback run unchanged.
 */
export function progressionUiFixture(t, {
  profession, afterAction, afterSessionChange, ...options
} = {}) {
  const { document, Node } = uiDomFixture(t);
  const documentEvents = new EventTarget();
  for (const name of ["addEventListener", "removeEventListener", "dispatchEvent"])
    document[name] = documentEvents[name].bind(documentEvents);
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
    get() { return document.body?.contains(this) === true; },
  });
  document.body = new Node("body");
  const root = new Node("div"), opener = new Node("button");
  root.id = "ui";
  document.body.append(opener, root);
  opener.focus();
  let ui, f;
  const fixture = profession ? progressionTradingFixture : progressionLiveFixture;
  f = fixture(t, {
    ...options, profession, document,
    onSessionChange(open, session, reason) {
      // This is the parent control bridge. The panel itself never enables the
      // Player, resets held use, changes pause state or takes pointer lock.
      f.player.enabled = !open;
      if (open) ui.open(); else ui.hide();
      afterSessionChange?.(open, f, session, reason);
    },
  });
  const actions = [], results = [];
  ui = new ProgressionUI(root, {
    readView: (request) => f.services.view(request),
    readRevision: () => f.services.viewRevision,
    onAction: (action) => {
      actions.push(action);
      const result = f.services.action(action);
      results.push(result);
      return afterAction ? afterAction(result, action) : result;
    },
    onClose: (reason) => f.services.close(reason),
  });
  t.after(() => ui.dispose());
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
  const activateButton = async (target, dispatcher = target) => {
    assert.equal(Boolean(target.disabled), false, "Only enabled UI controls can activate");
    fire("click", target, { detail: 0 }, dispatcher);
    await settle();
  };
  const key = async (target, code, properties = {}) => {
    fire("pointermove", target);
    const event = fire("keydown", target, { code, ...properties });
    await settle();
    return event;
  };
  const documentKey = async (code, target = document.activeElement, properties = {}) => {
    const event = fire("keydown", target, { code, ...properties }, document);
    await settle();
    return event;
  };
  const slot = (area, index = 0) => {
    const node = ui.element.querySelectorAll(`[data-area="${area}"][data-index="${index}"]`)
      .find((node) => !node.closest("[hidden]"));
    assert.ok(node, `Visible ${area}:${index} slot`);
    return node;
  };
  return Object.assign(f, {
    ui, root, opener, document, actions, results,
    fire, settle, click, activateButton, key, documentKey, slot,
  });
}
