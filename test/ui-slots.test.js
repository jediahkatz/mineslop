import assert from "node:assert/strict";
import test from "node:test";
import { getItem, ITEM } from "../src/items.js";
import {
  createCursorStack,
  createSlotGrid,
  createStackSlot,
  createStackTooltip,
} from "../src/ui/slots.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

test("slot rendering updates counts and damage without replacing the icon or inventing a count of one", (t) => {
  uiDomFixture(t);
  const slot = createStackSlot({
    area: "inventory",
    index: 4,
    label: "Hotbar 5",
  });
  slot.update({ id: ITEM.APPLE, count: 4 });
  const picture = slot.node.querySelector(".slot-picture");
  const image = picture.children[0];
  assert.equal(slot.node.dataset.index, "4");
  assert.equal(slot.node.querySelector(".slot-count").textContent, "4");
  slot.update({ id: ITEM.APPLE, count: 1 });
  assert.equal(picture.children[0], image, "unchanged item art is retained");
  assert.equal(slot.node.querySelector(".slot-count").textContent, "");
  slot.update({ id: ITEM.WOOD_PICKAXE, count: 1, durability: 12 });
  assert.ok(
    slot.node
      .getAttribute("aria-label")
      .includes(`Durability 12 / ${getItem(ITEM.WOOD_PICKAXE).durability}`)
  );
  assert.equal(slot.node.querySelector(".slot-wear").hidden, false);
  slot.update(null);
  assert.equal(slot.node.dataset.item, "0");
  assert.equal(picture.children.length, 0);
  assert.equal(slot.node.querySelector(".slot-wear").hidden, true);
});

test("unlimited palette slots declare their policy without showing a fabricated finite stack", (t) => {
  uiDomFixture(t);
  const slot = createStackSlot({ label: "Palette" });
  slot.update({ id: ITEM.APPLE, count: 1 }, { unlimited: true });
  assert.equal(slot.node.querySelector(".slot-count").textContent, "");
  assert.equal(slot.node.dataset.unlimited, "true");
  assert.match(slot.node.getAttribute("aria-label"), /Unlimited palette item/);
});

test("slot grids retain stable backend indices across bag and hotbar layouts", (t) => {
  const { Node } = uiDomFixture(t);
  const container = new Node();
  const grid = createSlotGrid(container, {
    area: "inventory",
    indices: [9, 10, 11],
  });
  const slots = Array(36).fill(null);
  slots[10] = { id: ITEM.APPLE, count: 8 };
  grid.update(slots);
  assert.deepEqual(
    container.children.map((node) => node.dataset.index),
    ["9", "10", "11"]
  );
  assert.deepEqual(
    container.children.map((node) => node.dataset.count),
    ["0", "8", "0"]
  );
});

test("tooltip associations and carried stacks clear when a screen closes", (t) => {
  const { Node } = uiDomFixture(t);
  const container = new Node();
  const target = new Node();
  const tooltip = createStackTooltip(container);
  tooltip.show({ id: ITEM.APPLE, count: 3 }, target, 20, 20);
  assert.ok(target.getAttribute("aria-describedby"));
  assert.equal(
    container.querySelector(".stack-tooltip-name").textContent,
    "Apple"
  );
  tooltip.hide();
  assert.equal(target.getAttribute("aria-describedby"), null);
  const cursor = createCursorStack(container);
  cursor.update({ id: ITEM.APPLE, count: 3 });
  assert.equal(container.querySelector(".carried-stack").hidden, false);
  cursor.move(320, 180);
  assert.match(
    container.querySelector(".carried-stack").style.transform,
    /320px, 180px/
  );
  cursor.update(null);
  assert.equal(container.querySelector(".carried-stack").hidden, true);
  cursor.dispose();
  tooltip.dispose();
  assert.equal(container.children.length, 0);
});

test("custom names and metadata tooltips use literal text, including markup-shaped names", (t) => {
  const { Node } = uiDomFixture(t);
  const container = new Node();
  const target = new Node();
  const tooltip = createStackTooltip(container);
  const name = container.querySelector(".stack-tooltip-name");
  const detail = container.querySelector(".stack-tooltip-detail");
  for (const node of [name, detail]) {
    Object.defineProperty(node, "innerHTML", {
      set: () => assert.fail("metadata must never be passed to innerHTML"),
    });
  }
  const stack = {
    id: ITEM.WOOD_PICKAXE,
    count: 1,
    durability: 12,
    data: {
      version: 1,
      name: "<img src=x onerror=alert(1)>",
      enchantments: { efficiency: 2 },
      repairCost: 3,
    },
  };
  const slot = createStackSlot({ area: "inventory" });
  slot.update(stack);
  tooltip.show(stack, target, 20, 20);
  assert.equal(name.textContent, stack.data.name);
  assert.equal(name.children.length, 0);
  assert.match(detail.textContent, /Stored enchantments: Efficiency II/);
  assert.match(detail.textContent, /Prior repair cost: 3/);
  assert.ok(slot.node.getAttribute("aria-label").includes(stack.data.name));
  const icon = slot.node.querySelector(".slot-picture").children[0];
  slot.update({ ...stack, data: { ...stack.data, name: "Another name" } });
  assert.equal(slot.node.querySelector(".slot-picture").children[0], icon);
  assert.match(slot.node.getAttribute("aria-label"), /Another name/);
  tooltip.show({ ...stack, data: { version: 99 } }, target, 20, 20);
  assert.equal(container.querySelector(".stack-tooltip").hidden, true);
  assert.equal(target.getAttribute("aria-describedby"), null);
});
