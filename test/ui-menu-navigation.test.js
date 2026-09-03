import assert from "node:assert/strict";
import test from "node:test";
import { createEventScope } from "../src/ui/dom.js";
import { createMenuNavigation } from "../src/ui/menu-navigation.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

function fixture(t) {
  const { Node } = uiDomFixture(t);
  const menu = new Node();
  const pages = [
    "main",
    "options",
    "controls",
    "video",
    "world",
    "new-world",
  ].map((page) => {
    const node = new Node();
    node.dataset.menuPage = page;
    return node;
  });
  const nodes = new Map();
  const get = (selector) => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector);
  };
  menu.querySelector = get;
  menu.querySelectorAll = (selector) =>
    selector === "[data-menu-page]" ? pages : [];
  let allowed = true;
  const scope = createEventScope();
  t.after(() => scope.dispose());
  const navigation = createMenuNavigation(menu, {
    listen: scope.listen,
    canNavigate: () => allowed,
  });
  return {
    menu,
    get,
    pages,
    navigation,
    block: () => {
      allowed = false;
    },
  };
}

test("title and pause are distinct screens with one explicit settings page at a time", (t) => {
  const f = fixture(t);
  f.navigation.show("title", { focus: false });
  assert.equal(f.get(".title-copy").hidden, false);
  assert.equal(f.get(".menu-title").hidden, true);
  assert.equal(f.get(".single-world-note").hidden, false);
  assert.deepEqual(
    f.pages.filter((page) => !page.hidden).map((page) => page.dataset.menuPage),
    ["main"]
  );
  f.navigation.show("pause", { focus: false });
  assert.equal(f.get(".title-copy").hidden, true);
  assert.equal(f.get(".menu-title").textContent, "Game Menu");
  assert.equal(f.get(".single-world-note").hidden, true);
  assert.equal(f.menu.classList.contains("is-paused"), true);
});

test("Done and Escape's shared back operation restore the actual navigation path", (t) => {
  const f = fixture(t);
  f.navigation.show("pause", { focus: false });
  f.navigation.navigate("options");
  f.navigation.navigate("controls");
  assert.equal(f.navigation.page, "controls");
  f.get(".menu-back-button").dispatchEvent(new Event("click"));
  assert.equal(f.navigation.page, "options");
  assert.equal(f.navigation.back(), true);
  assert.equal(f.navigation.page, "main");
  assert.equal(
    f.navigation.back(),
    false,
    "only the main pause page may resume the game"
  );
  f.navigation.navigate("world");
  f.navigation.navigate("new-world");
  f.navigation.back();
  assert.equal(f.navigation.page, "world");
});

test("pending destructive work blocks dismissal and unsupported menu routes are rejected", (t) => {
  const f = fixture(t);
  f.navigation.show("title", { focus: false });
  assert.equal(f.navigation.navigate("multiplayer"), false);
  f.navigation.navigate("world");
  f.block();
  assert.equal(f.navigation.navigate("new-world"), false);
  assert.equal(f.navigation.back(), false);
  assert.equal(f.navigation.page, "world");
});
