import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createFullscreenSettings } from "../src/ui/fullscreen-settings.js";
import { menuMarkup } from "../src/ui/menu-markup.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(t, onToggle) {
  const { Node } = uiDomFixture(t);
  const root = new Node();
  const buttons = [new Node("button"), new Node("button")];
  const statuses = [new Node("p"), new Node("p")];
  for (const button of buttons) button.dataset.fullscreenToggle = "";
  for (const status of statuses) status.dataset.fullscreenState = "";
  root.append(...buttons, ...statuses);
  const scope = createEventScope();
  const settings = createFullscreenSettings(root, {
    listen: scope.listen,
    onToggle,
  });
  t.after(() => {
    settings.dispose();
    scope.dispose();
  });
  return { root, buttons, statuses, settings };
}

test("fullscreen is opt-in and both settings pages display only confirmed capture state", (t) => {
  let calls = 0;
  const f = fixture(t, () => calls++);
  assert.equal(calls, 0, "constructing settings must not request fullscreen");
  for (const button of f.buttons) {
    assert.equal(button.textContent, "Fullscreen: OFF");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(button.disabled, false);
  }
  assert.equal(f.root.dataset.fullscreen, "false");
  assert.equal(f.root.dataset.keyboardCaptured, "false");
  f.settings.update({ fullscreen: true, keyboardCaptured: true });
  for (const button of f.buttons) {
    assert.equal(button.textContent, "Fullscreen: ON");
    assert.equal(button.getAttribute("aria-pressed"), "true");
  }
  assert.ok(f.statuses.every((status) => status.dataset.state === "captured"));
  assert.equal(f.root.dataset.fullscreen, "true");
  assert.equal(f.root.dataset.keyboardCaptured, "true");
  f.settings.update({ fullscreen: false, keyboardCaptured: false });
  assert.ok(f.statuses.every((status) => status.dataset.state === "windowed"));
  assert.equal(
    calls,
    0,
    "external Escape/fullscreen changes are read-only snapshots"
  );
});

test("fullscreen without keyboard capture never promises protected browser shortcuts", (t) => {
  const f = fixture(t, () => {});
  f.settings.update({ fullscreen: true, keyboardCaptured: false });
  assert.equal(f.root.dataset.fullscreen, "true");
  assert.equal(f.root.dataset.keyboardCaptured, "false");
  for (const status of f.statuses) {
    assert.equal(status.dataset.state, "uncaptured");
    assert.match(status.textContent, /Shortcuts not captured.*double-tap W/);
  }
  f.settings.update({ keyboardCaptured: true });
  assert.equal(f.root.dataset.keyboardCaptured, "true");
  f.settings.update({ fullscreen: false });
  assert.equal(f.root.dataset.keyboardCaptured, "false");
  f.settings.update({ fullscreen: true });
  assert.equal(
    f.root.dataset.keyboardCaptured,
    "false",
    "a new entry cannot reuse stale capture"
  );
  f.settings.update({ keyboardCaptured: "true" });
  assert.equal(f.root.dataset.keyboardCaptured, "false");
  f.settings.update({ fullscreen: false, keyboardCaptured: true });
  assert.equal(
    f.root.dataset.keyboardCaptured,
    "false",
    "windowed mode cannot claim capture"
  );
});

test("the click invokes its callback synchronously and serializes pending toggles", async (t) => {
  let calls = 0;
  let resolve;
  const f = fixture(t, () => {
    calls++;
    return new Promise((done) => {
      resolve = done;
    });
  });
  f.buttons[0].dispatchEvent(new Event("click"));
  assert.equal(
    calls,
    1,
    "do not lose the fullscreen API's user-activation gesture"
  );
  assert.ok(f.buttons.every((button) => button.disabled));
  assert.ok(
    f.buttons.every((button) => button.getAttribute("aria-busy") === "true")
  );
  assert.equal(f.root.dataset.fullscreen, "false");
  f.buttons[1].dispatchEvent(new Event("click"));
  assert.equal(calls, 1);
  resolve({ ok: true, keyboardCaptured: true });
  await Promise.resolve();
  assert.ok(f.buttons.every((button) => !button.disabled));
  assert.ok(
    f.buttons.every((button) => button.getAttribute("aria-busy") === "false")
  );
  assert.equal(
    f.root.dataset.fullscreen,
    "false",
    "a successful request is not a fullscreen snapshot"
  );
  assert.equal(f.root.dataset.keyboardCaptured, "false");
});

test("confirmed state can arrive during the click and entering/exiting works from either button", async (t) => {
  let fullscreen = false;
  const f = fixture(t, () => {
    fullscreen = !fullscreen;
    f.settings.update({ fullscreen, keyboardCaptured: fullscreen });
    return { ok: true };
  });
  f.buttons[0].dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.equal(f.root.dataset.fullscreen, "true");
  assert.ok(
    f.buttons.every((button) => button.textContent === "Fullscreen: ON")
  );
  f.buttons[1].dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.equal(f.root.dataset.fullscreen, "false");
  assert.ok(
    f.buttons.every((button) => button.textContent === "Fullscreen: OFF")
  );
});

test("refused or rejected toggles retain actual state and re-enable both controls", async (t) => {
  let reject = false;
  const f = fixture(t, () =>
    reject
      ? Promise.reject(new Error("Fullscreen denied"))
      : { ok: false, message: "Hold Escape to leave fullscreen." }
  );
  f.settings.update({ fullscreen: true, keyboardCaptured: true });
  f.buttons[0].dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.equal(f.root.dataset.fullscreen, "true");
  assert.equal(f.root.dataset.keyboardCaptured, "true");
  assert.ok(f.buttons.every((button) => !button.disabled));
  reject = true;
  f.buttons[1].dispatchEvent(new Event("click"));
  await Promise.resolve();
  assert.equal(f.root.dataset.fullscreen, "true");
  assert.ok(f.buttons.every((button) => !button.disabled));
});

test("unbound fullscreen controls are disabled", (t) => {
  const f = fixture(t);
  assert.ok(f.buttons.every((button) => button.disabled));
  f.buttons[0].dispatchEvent(new Event("click"));
  assert.equal(f.root.dataset.fullscreen, "false");
});

test("disposal prevents late pending updates", async (t) => {
  let resolve;
  const f = fixture(
    t,
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  f.buttons[0].dispatchEvent(new Event("click"));
  f.settings.dispose();
  f.buttons[0].textContent = "Detached";
  resolve({ ok: true });
  await Promise.resolve();
  f.settings.update({ fullscreen: true, keyboardCaptured: true });
  assert.equal(f.buttons[0].textContent, "Detached");
  assert.equal(f.root.dataset.fullscreen, "false");
});

test("both pages explain windowed Ctrl+W, safe sprinting, game fullscreen, and the browser Escape hatch", () => {
  const markup = menuMarkup();
  assert.equal([...markup.matchAll(/data-fullscreen-toggle/g)].length, 2);
  assert.match(markup, /id="fullscreen-setting"/);
  assert.match(markup, /id="controls-fullscreen-setting"/);
  for (const page of ["controls", "video"]) {
    assert.match(
      markup,
      new RegExp(
        `aria-describedby="${page}-fullscreen-status ${page}-shortcut-warning ${page}-fullscreen-help"`
      )
    );
    const warning = markup.match(
      new RegExp(`<p id="${page}-shortcut-warning"[^>]*>(.*?)</p>`)
    )[1];
    const help = markup.match(
      new RegExp(`<p id="${page}-fullscreen-help"[^>]*>(.*?)</p>`)
    )[1];
    const text = (html) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    assert.match(
      text(warning),
      /Windowed browser shortcuts such as Ctrl\+W can close this tab/
    );
    assert.match(text(warning), /Double-tap W to sprint safely/);
    assert.match(
      text(help),
      /API fullscreen.*when supported.*browser F11 alone does not capture/
    );
    assert.match(text(help), /tap Esc to pause.*HOLD Esc.*exit fullscreen/);
  }
  assert.match(markup, /Ctrl \/ W ×2/);
  assert.match(
    markup,
    /Hold use \/ eat \/ bow \/ shield \(Remote\).*<kbd>V<\/kbd>/
  );
});
