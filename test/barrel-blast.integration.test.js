import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { BLOCK } from "../src/blocks.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { advanceFurnace, createFurnace, syncFurnaceRecipe } from "../src/furnace.js";
import { ITEM } from "../src/items.js";
import { normalizeWorldComponents } from "../src/save-preflight.js";
import { normalizeSettlementSnapshot, Settlement } from "../src/settlement.js";
import { ContainerUI } from "../src/settlement-ui.js";
import { createSlotGrid, createStackSlot } from "../src/ui/slots.js";
import { exportWorldFile, parseWorldFile, WorldStorage } from "../src/storage.js";
import { containerFixture, editOwnership, moveIntoContainer } from "./container-fixture.js";
import { interactionSnapshot } from "./interaction-fixture.js";
import { parityGame, setOwnedSlots } from "./parity-fixture.js";
import { uiDomFixture } from "./ui-dom-fixture.js";

const stack = (id, count = 1) => ({ id, count });
const named = (id, count = 1) => ({
  ...stack(id, count), data: { version: 1, name: "Keep <exact> & safe" },
});
const click = (index, button = 0) => ({ type: "click", area: "container", index, button });

// Native Game/Settlement/UI-controller transactions; no renderer or visual claims.
function native(kind) {
  const f = parityGame("survival", { generatorVersion: 4 });
  const id = kind === "barrel" ? BLOCK.BARREL : BLOCK.BLAST_FURNACE;
  const hit = { x: 2, y: 9, z: 0, id };
  f.game.world.setCell(hit.x, hit.y, hit.z, { id });
  f.game.target = hit;
  const ui = Object.assign(Object.create(ContainerUI.prototype), {
    document: { activeElement: null },
    element: { hidden: true, dataset: {}, contains: () => false },
    closeButton: { focus() {} },
    _session: null,
    _interactions: { busy: false, reset() {} },
    _setStatus() {},
    refresh() { return true; },
    onOpenChange() {},
    onToast() {},
    onChange() {},
    prepareDrops: (stacks) => f.game.prepareDropItems(stacks, { x: 2, y: 9, z: 0 }),
    prepareExperience: (amount) => f.game.harvestActions.prepareExperience(amount, { x: 2, y: 9, z: 0 }),
  });
  f.game.containerUI = ui;
  assert.equal(f.game.useActions.tap(), true);
  assert.equal(ui.kind, kind);
  return { ...f, hit, ui, action: (a) => ui._action(a) };
}
function insertNative(f, index, value) {
  editOwnership(f.game.gameplay, (owned) => { owned.cursor = value; });
  assert.equal(f.action(click(index)).ok, true);
}
function barrelFixture() {
  const f = containerFixture("furnace", { generatorVersion: 4 });
  f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.BARREL);
  f.hit.id = BLOCK.BARREL;
  return f;
}

test("actual container refresh labels and enables barrel cells and blast furnace cells distinctly", (t) => {
  const dom = uiDomFixture(t);
  for (const kind of ["barrel", "blast_furnace"]) {
    const { ui } = native(kind);
    ui.element.querySelector = dom.get;
    ui.closeButton = new dom.Node("button");
    ui._chest = createSlotGrid(new dom.Node(), {
      area: "container", indices: Array.from({ length: 27 }, (_, i) => i),
      labels: Array.from({ length: 27 }, (_, i) => `Chest ${i + 1}`),
    });
    ui._furnace = ["input", "fuel", "output"].map((label, index) =>
      createStackSlot({ area: "container", index, label: `Furnace ${label}` }));
    ui._backpack = ui._hotbar = ui._offhand = { update() {} };
    ui._interactions.update = () => {};
    assert.equal(ContainerUI.prototype.refresh.call(ui), true);
    const title = kind === "barrel" ? "Barrel" : "Blast Furnace";
    assert.equal(dom.get("#container-title").textContent, title);
    assert.equal(dom.get(".settlement-chest").hidden, kind !== "barrel");
    assert.equal(dom.get(".furnace-workbench").hidden, kind !== "blast_furnace");
    for (const slot of kind === "barrel" ? ui._chest.slots : ui._furnace) {
      assert.equal(slot.node.disabled, false);
      assert.ok(slot.node.getAttribute("aria-label").startsWith(title));
    }
  }
});

test("prepared slot and escrow-close actions veto owner/session replacement before publication", () => {
  for (const closing of [false, true]) {
    for (const replace of ["world", "gameplay", "player", "settlement", "session"]) {
      const f = native("barrel");
      insertNative(f, 0, named(ITEM.APPLE, 3));
      if (closing)
        editOwnership(f.game.gameplay, (owned) => { owned.cursor = named(ITEM.APPLE, 2); });
      const gameplay = f.game.gameplay, settlement = f.game.settlement;
      const before = [gameplay.serialize(), settlement.serialize()];
      const prepare = gameplay.prepareInventory.bind(gameplay);
      if (!closing) {
        gameplay.prepareInventory = (...args) => {
          const result = prepare(...args);
          if (replace === "session") f.ui._session = { ...f.ui._session };
          else f.game[replace] = Object.create(f.game[replace]);
          return result;
        };
      } else {
        const prepareState = gameplay._prepareState.bind(gameplay);
        gameplay._prepareState = (...args) => {
          const result = prepareState(...args);
          if (replace === "session") f.ui._session = { ...f.ui._session };
          else f.game[replace] = Object.create(f.game[replace]);
          return result;
        };
      }
      assert.equal(f.action(closing ? { type: "close" } : click(0)).ok, false, `${closing}:${replace}`);
      assert.deepEqual([gameplay.serialize(), settlement.serialize()], before);
    }
  }
});

test("paid native recipes craft and place real barrel/blast blocks before opening finite state", () => {
  for (const [recipeId, id, ingredients] of [
    ["barrel", BLOCK.BARREL, [[BLOCK.PLANKS, 6], [BLOCK.OAK_SLAB, 2]]],
    ["blast_furnace", BLOCK.BLAST_FURNACE, [[ITEM.IRON_INGOT, 5], [BLOCK.FURNACE, 1], [BLOCK.SMOOTH_STONE, 3]]],
  ]) {
    const { game } = parityGame("survival", { generatorVersion: 4 });
    setOwnedSlots(game, ingredients.map(([item, count], index) => [index + 9, stack(item, count)]));
    game.world.setCell(1, 9, 1, { id: BLOCK.CRAFTING_TABLE });
    assert.equal(game.openStation({ x: 1, y: 9, z: 1, id: BLOCK.CRAFTING_TABLE }), true);
    assert.equal(game.inventoryActions.action({ type: "fillRecipe", recipeId }).ok, true);
    assert.equal(game.inventoryActions.action({ type: "takeCraftResult" }).ok, true);
    assert.deepEqual(game.gameplay.cursor, stack(id));
    assert.equal(game.inventoryActions.action({ type: "takeCraftResult" }).ok, false);
    assert.equal(game.inventoryActions.action({
      type: "click", area: "inventory", index: 0, button: 0,
    }).ok, true);
    game.target = { x: 2, y: 8, z: 0, id: game.world.get(2, 8, 0), normal: { x: 0, y: 1, z: 0 } };
    assert.equal(game.useActions.place("main", id), true);
    assert.equal(game.gameplay.count(id), 0);
    assert.equal(game.world.get(2, 9, 0), id);
    const state = game.settlement.getContainerState(game.world, { x: 2, y: 9, z: 0, id }, game.gameplay);
    assert.equal(state.kind, recipeId);
    assert.equal(state.slots.length, recipeId === "barrel" ? 27 : 3);
  }
});

for (const kind of ["barrel", "blast_furnace"]) {
  test(`native ${kind} use/slots/harvest/explosion retains block+contents+XP once`, () => {
    for (const explosion of [false, true]) {
      const f = native(kind);
      setOwnedSlots(f.game, [[0, { ...stack(ITEM.IRON_PICKAXE), durability: 30 }]]);
      if (kind === "barrel") insertNative(f, 26, named(ITEM.APPLE, 4));
      else {
        insertNative(f, 0, stack(ITEM.RAW_IRON, 4));
        insertNative(f, 1, stack(ITEM.COAL, 2));
        f.game.settlement.update(10, f.game.world);
        assert.equal(f.action(click(2, 2)).experience, 1);
        assert.equal(f.game.gameplay.cursor.count, 1);
      }
      const expected = f.game.settlement.inspectContainer(f.game.world, f.hit);
      const before = interactionSnapshot(f.game);
      const prepareDrops = f.game.prepareDropItems;
      f.game.prepareDropItems = () => null;
      assert.equal(f.game.harvestActions.break(f.hit, { explosion }).ok, false);
      assert.deepEqual(interactionSnapshot(f.game), before);
      f.game.prepareDropItems = prepareDrops;
      const plan = f.game.harvestActions.prepareBreak(f.hit, { explosion });
      assert.ok(plan);
      assert.equal(f.game.harvestActions.commit(plan).ok, true);
      assert.equal(f.game.harvestActions.commit(plan).ok, false);
      assert.equal(f.game.world.get(f.hit.x, f.hit.y, f.hit.z), BLOCK.AIR);
      assert.deepEqual(f.drops.map(({ position, options, ...value }) => value),
        [stack(f.hit.id), ...expected.slots.filter(Boolean)]);
      assert.equal(f.experience.reduce((total, v) => total + v.amount, 0), kind === "barrel" ? 0 : 2);
    }
  });

  test(`native ${kind} reach, stale target/owner and busy gates preserve ownership`, () => {
    const f = native(kind);
    insertNative(f, 0, kind === "barrel" ? named(ITEM.APPLE, 2) : stack(ITEM.RAW_IRON, 2));
    const before = interactionSnapshot(f.game);
    f.game.settlement._busy = true;
    assert.equal(f.action(click(0)).ok, false);
    f.game.settlement._busy = false;
    assert.deepEqual(interactionSnapshot(f.game), before);
    f.ui._interactions.busy = true;
    assert.equal(f.ui.close(), false);
    f.ui._interactions.busy = false;
    f.game.player.eyePosition.x = 100;
    assert.equal(f.action(click(0)).ok, false);
    assert.equal(f.ui.isOpen, false);
    assert.deepEqual(interactionSnapshot(f.game), before);
    assert.equal(f.game.inventoryActions.openStation(f.hit), false);
    f.game.player.eyePosition.x = 0.5;
    assert.equal(f.game.inventoryActions.openStation({ ...f.hit, dimension: "nether" }), false);
    assert.equal(f.game.inventoryActions.openStation(f.hit), true);
    const original = f.game.settlement;
    f.game.settlement = new Settlement({ coordinator: f.game.coordinator, context: f.game.worldContext });
    assert.equal(f.action(click(0)).ok, false);
    f.game.settlement = original;
    assert.deepEqual(interactionSnapshot(f.game), before);
  });
}

test("barrel escrow close and real full overflow veto preserve every source and world cell", () => {
  const f = native("barrel");
  insertNative(f, 0, named(ITEM.APPLE, 2));
  editOwnership(f.game.gameplay, (owned) => {
    owned.slots = Array.from({ length: 36 }, () => stack(BLOCK.DIRT, 64));
    owned.slots[0] = { ...stack(ITEM.IRON_PICKAXE), durability: 10 };
    owned.cursor = named(ITEM.APPLE, 3);
  });
  f.game.overflow.dispose();
  f.game.overflow = new DropOverflow({ coordinator: f.game.coordinator, context: f.game.worldContext, maxEntries: 1 });
  assert.equal(f.game.overflow.enqueue([stack(BLOCK.DIRT)], { x: 2, y: 9, z: 0 }, "overworld"), true);
  f.game.pickups.accept = false;
  const before = interactionSnapshot(f.game);
  assert.equal(f.ui.close(), false);
  assert.equal(f.ui.isOpen, true);
  assert.deepEqual(interactionSnapshot(f.game), before);
  assert.equal(f.game.harvestActions.break(f.hit).ok, false);
  assert.deepEqual(interactionSnapshot(f.game), before);
  assert.deepEqual(f.game.harvestActions.explode({ x: 2.5, y: 9.5, z: 0.5 }, 0.6), []);
  assert.deepEqual(interactionSnapshot(f.game), before);
});

test("cross-dimension barrels are finite independent stores preserving exact decorated stacks", () => {
  const f = barrelFixture();
  const payload = { ...named(ITEM.IRON_PICKAXE), durability: 19,
    data: { version: 1, name: "Kept tool", enchantments: { efficiency: 2 } } };
  for (const dimension of ["overworld", "nether", "end"]) {
    f.world.dimension = dimension;
    f.hit.dimension = dimension;
    f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.BARREL);
    moveIntoContainer(f, 26, payload);
    assert.equal(f.state().slots.length, 27);
    assert.equal(f.state().title, "Barrel");
    assert.deepEqual(f.state().slots[26], payload);
  }
  assert.equal(f.settlement.serialize().barrels.length, 3);
  assert.equal(f.settlement.serialize().chests.length, 0);
  assert.equal(f.action(click(27)).ok, false);
  const saved = f.settlement.serialize();
  assert.deepEqual(normalizeSettlementSnapshot(saved, f.context), saved);
  f.state().slots[26].data.name = "detached";
  assert.deepEqual(f.settlement.serialize(), saved);
  const overlapping = structuredClone(saved);
  overlapping.chests.push(structuredClone(overlapping.barrels[0]));
  assert.equal(normalizeSettlementSnapshot(overlapping, f.context), null);
});

test("a fully occupied barrel refuses a 28th kind and stale block replacements cannot adopt it", () => {
  const f = barrelFixture();
  const saved = f.settlement.serialize();
  saved.barrels.push({
    dimension: f.world.dimension, x: f.hit.x, y: f.hit.y, z: f.hit.z,
    slots: Array.from({ length: 27 }, () => stack(BLOCK.DIRT, 64)),
  });
  assert.equal(f.settlement.load(saved, { world: f.world }), true);
  editOwnership(f.game, (owned) => { owned.slots[9] = named(ITEM.APPLE); });
  const before = f.snapshot();
  assert.equal(f.action({ type: "quickMove", area: "inventory", index: 9 }).ok, false);
  assert.deepEqual(f.snapshot(), before);
  f.world.set(f.hit.x, f.hit.y, f.hit.z, BLOCK.CHEST);
  assert.equal(f.settlement.getContainerState(f.world, { ...f.hit, id: BLOCK.CHEST }, f.game), null);
  assert.deepEqual(f.snapshot(), before);
});

test("saved decorated blast output extracts and breaks without erasing metadata or duplicating XP", () => {
  const f = native("blast_furnace");
  const saved = f.game.settlement.serialize();
  const output = named(ITEM.GOLD_INGOT, 3);
  Object.assign(saved.furnaces[0], { slots: [null, null, output], experience: 3 });
  assert.equal(f.game.settlement.load(saved, { world: f.game.world }), true);
  assert.equal(f.action(click(2, 2)).experience, 2);
  assert.deepEqual(f.game.gameplay.cursor, { ...output, count: 2 });
  setOwnedSlots(f.game, [[0, { ...stack(ITEM.IRON_PICKAXE), durability: 20 }]]);
  assert.equal(f.game.harvestActions.break(f.hit).ok, true);
  assert.deepEqual(f.drops.map(({ position, options, ...value }) => value),
    [stack(BLOCK.BLAST_FURNACE), { ...output, count: 1 }]);
  assert.equal(f.experience.reduce((total, entry) => total + entry.amount, 0), 3);
  assert.equal(f.game.harvestActions.break(f.hit).ok, false);
  assert.equal(f.experience.reduce((total, entry) => total + entry.amount, 0), 3);
});

test("legacy settlement 1–4 retain ordinary furnace kind, metadata, crop species and fractions", () => {
  for (const version of [1, 2, 3, 4]) {
    const slots = Array(27).fill(null);
    slots[0] = named(ITEM.APPLE, 3);
    const at = { dimension: "overworld", x: 2, y: 20, z: 3 };
    const ordinary = createFurnace();
    delete ordinary.kind;
    Object.assign(ordinary, {
      burnTime: 73.125, burnDuration: 80, cookTime: 3.875, recipeId: "iron_ingot",
      slots: [stack(ITEM.RAW_IRON), stack(ITEM.COAL), named(ITEM.IRON_INGOT)], experience: 1,
    });
    const saved = {
      version,
      chests: [{ ...at, ...(version === 1 ? { items: [stack(ITEM.APPLE, 3)] } : { slots }) }],
      crops: [{ ...at, x: 4, age: 2.125, ...(version === 4 ? { version: 1, species: "carrot" } : {}) }],
      ...(version === 1 ? {} : { furnaces: [{ ...at, x: 6, ...ordinary }] }),
    };
    const normalized = normalizeSettlementSnapshot(saved);
    assert.ok(normalized);
    assert.equal(normalized.version, 5);
    assert.equal(normalized.crops[0].age, 2.125);
    assert.equal(normalized.crops[0].species, version === 4 ? "carrot" : "wheat");
    if (version > 1) {
      assert.deepEqual(normalized.chests[0].slots, slots);
      assert.deepEqual(normalized.furnaces[0], { ...at, x: 6, ...ordinary, kind: "furnace" });
    }
  }
});

test("barrel/blast saves survive file export/import, IndexedDB reopen and component preflight", async () => {
  const f = barrelFixture();
  moveIntoContainer(f, 26, named(ITEM.APPLE, 3));
  const savedSettlement = f.settlement.serialize();
  const furnace = createFurnace("blast_furnace");
  furnace.slots = [stack(ITEM.RAW_GOLD, 3), stack(ITEM.COAL, 2), null];
  syncFurnaceRecipe(furnace);
  advanceFurnace(furnace, 7.375);
  savedSettlement.furnaces.push({ dimension: "nether", x: 2, y: 20, z: 3, ...furnace });
  savedSettlement.crops.push({ dimension: "overworld", x: 4, y: 20, z: 3, age: 2.125, version: 1, species: "carrot" });
  const saved = {
    version: 3,
    world: {
      version: 3, generatorVersion: 4, seed: f.world.seed, dimension: "overworld",
      edits: [
        ["overworld", 2, 20, 3, BLOCK.BARREL, 0, 0],
        ["nether", 2, 20, 3, BLOCK.BLAST_FURNACE, 0, 0],
      ],
    },
    settlement: savedSettlement, gameplay: f.game.serialize(), time: 0.375,
  };
  assert.deepEqual(parseWorldFile(exportWorldFile(saved)), saved);
  const indexedDB = new IDBFactory();
  const storage = new WorldStorage({ indexedDB });
  await storage.save(saved);
  await storage.close();
  const reader = new WorldStorage({ indexedDB });
  const loaded = await reader.load();
  await reader.close();
  assert.deepEqual(loaded.settlement, savedSettlement);
  assert.deepEqual(normalizeWorldComponents(loaded).settlement, savedSettlement);
});
