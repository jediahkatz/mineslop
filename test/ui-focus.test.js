import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventScope,
  focusFirst,
  isTextInput,
  setText,
  trapFocus,
} from "../src/ui/dom.js";

function focusFixture(t) {
  const original = globalThis.document;
  const document = { activeElement: null };
  globalThis.document = document;
  t.after(() => {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  });
  const nodes = [];
  const node = (options = {}) => {
    const control = {
      disabled: false,
      tabIndex: 0,
      closest: () => (options.hidden ? {} : null),
      focus() {
        document.activeElement = control;
      },
      ...options,
    };
    nodes.push(control);
    return control;
  };
  const panel = {
    querySelectorAll: () => nodes,
    contains: (control) => nodes.includes(control),
    focus() {
      document.activeElement = panel;
    },
  };
  const key = (shiftKey = false) => ({
    key: "Tab",
    shiftKey,
    prevented: false,
    preventDefault() {
      this.prevented = true;
    },
  });
  return { document, node, panel, key };
}

test("modal entry focuses the first visible enabled control", (t) => {
  const { document, node, panel } = focusFixture(t);
  node({ hidden: true });
  node({ disabled: true });
  node({ tabIndex: -1 });
  const first = node();
  node();
  focusFirst(panel);
  assert.equal(document.activeElement, first);
});

test("Tab wraps at the last modal control and Shift-Tab wraps at the first", (t) => {
  const { document, node, panel, key } = focusFixture(t);
  const first = node();
  node({ hidden: true });
  const last = node();
  last.focus();
  const forward = key();
  trapFocus(forward, panel);
  assert.equal(forward.prevented, true);
  assert.equal(document.activeElement, first);
  const backward = key(true);
  trapFocus(backward, panel);
  assert.equal(backward.prevented, true);
  assert.equal(document.activeElement, last);
});

test("ordinary Tab navigation stays native within a modal", (t) => {
  const { node, panel, key } = focusFixture(t);
  const first = node();
  node();
  first.focus();
  const event = key();
  trapFocus(event, panel);
  assert.equal(event.prevented, false);
});

test("focus is recovered when an updated inventory no longer contains the active control", (t) => {
  const { document, node, panel, key } = focusFixture(t);
  const first = node();
  document.activeElement = {};
  const event = key();
  trapFocus(event, panel);
  assert.equal(event.prevented, true);
  assert.equal(document.activeElement, first);
});

test("Shift-Tab recovers stale external focus at the last visible modal control", (t) => {
  const { document, node, panel, key } = focusFixture(t);
  node();
  const last = node();
  node({ hidden: true });
  document.activeElement = {};
  const event = key(true);
  trapFocus(event, panel);
  assert.equal(event.prevented, true);
  assert.equal(document.activeElement, last);
});

test("a focused control hidden by a screen change cannot trap keyboard navigation", (t) => {
  const { document, node, panel, key } = focusFixture(t);
  const first = node();
  const hidden = node({ hidden: true });
  hidden.focus();
  trapFocus(key(), panel);
  assert.equal(document.activeElement, first);
});

test("empty or entirely disabled dialogs keep focus inside the panel", (t) => {
  const { document, node, panel, key } = focusFixture(t);
  node({ disabled: true });
  trapFocus(key(), panel);
  assert.equal(document.activeElement, panel);
});

test("editable targets and contenteditable descendants are recognized for key isolation", () => {
  assert.equal(isTextInput({ matches: () => true }), true);
  assert.equal(
    isTextInput({ matches: () => false, isContentEditable: true }),
    true
  );
  assert.equal(
    Boolean(isTextInput({ matches: () => false, isContentEditable: false })),
    false
  );
  assert.equal(Boolean(isTextInput(null)), false);
});

test("disposing the shared event scope removes UI listeners together", () => {
  const scope = createEventScope();
  const controls = [new EventTarget(), new EventTarget()];
  let calls = 0;
  for (const control of controls) scope.listen(control, "click", () => calls++);
  controls[0].dispatchEvent(new Event("click"));
  controls[1].dispatchEvent(new Event("click"));
  assert.equal(calls, 2);
  scope.dispose();
  for (const control of controls) control.dispatchEvent(new Event("click"));
  assert.equal(calls, 2);
});

test("unchanged snapshot text does not rewrite the DOM", () => {
  let text = "";
  let writes = 0;
  const node = {
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value;
      writes++;
    },
  };
  setText(node, "Birch Forest");
  setText(node, "Birch Forest");
  assert.equal(writes, 1);
  setText(node, "Cherry Grove");
  assert.equal(writes, 2);
});
