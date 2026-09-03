import assert from "node:assert/strict";
import { normalizeAnvilRecord, previewAnvil } from "../src/anvil.js";
import {
  createEnchantingPlayer,
  getEnchantingOffers,
  normalizeEnchantingPlayer,
  normalizeEnchantingRecord,
} from "../src/enchanting.js";
import { experienceForLevel } from "../src/experience.js";
import { Gameplay } from "../src/gameplay.js";
import { insertStack, normalizeStack } from "../src/inventory-slots.js";
import { getEnchantment } from "../src/item-stack-data.js";
import { getItem, ITEM } from "../src/items.js";
import { encodedBytes } from "../src/save-budget.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { createWorldContext } from "../src/world-spec.js";

/** No capability substitutes: missing gear/symbol/tag registration must fail. */
export const bindings = Object.freeze({});

export function tool(
  id = ITEM.IRON_PICKAXE,
  durability = getItem(id)?.durability,
  data
) {
  return normalizeStack({
    id,
    count: 1,
    durability,
    ...(data === undefined ? {} : { data: { version: 1, ...data } }),
  });
}

export const materialStack = (id, count = 1, data) =>
  normalizeStack({
    id,
    count,
    ...(data === undefined ? {} : { data: { version: 1, ...data } }),
  });

/**
 * Positive book tests intentionally require the parent's registration checkpoint.
 * Do not replace this with a fake positive ID, mutate the catalog, or skip tests.
 */
export function registeredEnchantedBook() {
  const item = getItem(ITEM.ENCHANTED_BOOK);
  assert.ok(
    item,
    "Parent checkpoint must register ITEM.ENCHANTED_BOOK before tests"
  );
  assert.equal(item.enchantmentCarrier, true);
  assert.equal(item.stackSize, 1);
  assert.equal(item.durability, undefined);
  return item.id;
}

export function enchantedBook(enchantments, data = {}) {
  return materialStack(registeredEnchantedBook(), 1, { ...data, enchantments });
}

export function registeredFishingRod(enchantments = {}) {
  const item = getItem(ITEM.FISHING_ROD);
  assert.ok(
    item,
    "Parent checkpoint must register ITEM.FISHING_ROD before tests"
  );
  assert.equal(item.tool, "fishing_rod");
  assert.equal(item.durability, 64);
  assert.equal(item.stackSize, 1);
  for (const name of ["lure", "luck_of_the_sea"]) {
    assert.equal(
      getEnchantment(name)?.maxLevel,
      3,
      `Parent checkpoint must register canonical ${name} metadata`
    );
  }
  return tool(item.id, item.durability, { enchantments });
}

export function enchantingRecord(
  input = tool(),
  lapis = materialStack(ITEM.LAPIS, 8)
) {
  return { version: 1, input, lapis };
}

export const anvilRecord = (
  left = tool(ITEM.IRON_PICKAXE, 10),
  right = materialStack(ITEM.IRON_INGOT, 3)
) => ({ version: 1, left, right });

/** Test-only prepared owner fixture; production modules contain no such store. */
export function stationFixture(
  kind,
  {
    record = kind === "enchanting" ? enchantingRecord() : anvilRecord(),
    playerState = createEnchantingPlayer(123456789),
    mode = "survival",
    experienceTotal = experienceForLevel(40),
  } = {}
) {
  const coordinator = new TransactionCoordinator();
  const context = createWorldContext({
    seed: "equipment-station-unit",
    generatorVersion: 4,
  });
  const gameplay = new Gameplay({
    coordinator,
    context,
    mode,
    random: () => 0.5,
  });
  const initialization = gameplay.prepareInventory((owned) => {
    owned.slots.fill(null);
    owned.experienceTotal = experienceTotal;
    return true;
  });
  assert.ok(initialization);
  assert.equal(coordinator.commit([initialization]).ok, true);
  const normalize = (state) =>
    kind === "enchanting"
      ? {
          record: normalizeEnchantingRecord(state.record, context),
          playerState: normalizeEnchantingPlayer(state.playerState),
        }
      : { record: normalizeAnvilRecord(state.record, context) };
  const state = normalize({ record, playerState });
  const source = {
    coordinator,
    state,
    bytes: encodedBytes(state),
    revision: 0,
    accept: true,
  };
  assert.equal(coordinator.register(source, source.bytes), true);
  const fixture = {
    gameplay,
    coordinator,
    context,
    source,
    access: true,
    shelvesRevision: 0,
    snapshot: () =>
      JSON.stringify({
        gameplay: gameplay.serialize(),
        station: source.state,
        bytes: coordinator.budget.totalBytes,
        playerRevision: gameplay.revision,
        stationRevision: source.revision,
      }),
    prepareStation: ({ before, after }) => {
      if (
        !source.accept ||
        JSON.stringify(before) !== JSON.stringify(source.state)
      )
        return null;
      const previous = source.state;
      const revision = source.revision;
      const beforeBytes = source.bytes;
      const next = normalize(after);
      const afterBytes = encodedBytes(next);
      let used = false;
      return Object.freeze({
        owner: source,
        beforeBytes,
        afterBytes,
        validate: () =>
          !used &&
          source.accept &&
          source.state === previous &&
          source.revision === revision &&
          source.bytes === beforeBytes,
        publish: () => {
          used = true;
          source.state = next;
          source.bytes = afterBytes;
          source.revision++;
        },
        notify: () => source.onChange?.(),
      });
    },
    editInventory: (edit) => {
      const participant = gameplay.prepareInventory(edit);
      assert.ok(participant);
      assert.equal(coordinator.commit([participant]).ok, true);
    },
    shelfReading: () => {
      const revision = fixture.shelvesRevision;
      return {
        ok: true,
        power: 15,
        validate: () => fixture.shelvesRevision === revision,
      };
    },
  };
  return fixture;
}

export function enchantingOptions(fixture, overrides = {}) {
  const { gameplay, source, context } = fixture;
  const { record, playerState } = source.state;
  const menu = getEnchantingOffers({
    input: record.input,
    playerState,
    bookshelfPower: 15,
    bindings,
    context,
  });
  assert.equal(menu.ok, true);
  return {
    gameplay,
    record,
    playerState,
    shelves: fixture.shelfReading(),
    index: 2,
    offerKey: menu.offers[2].key,
    bindings,
    context,
    prepareStation: fixture.prepareStation,
    validateAccess: () => fixture.access,
    ...overrides,
  };
}

export const receiveCursor = (owned, output) => {
  if (owned.cursor !== null) return false;
  owned.cursor = output;
  return true;
};

export const receiveInventory = (owned, output) =>
  insertStack(owned.slots, output) === null;

export function anvilOptions(fixture, overrides = {}) {
  const record = overrides.record ?? fixture.source.state.record;
  const preview = previewAnvil({
    record,
    rename: overrides.rename,
    mode: fixture.gameplay.mode,
    bindings,
    context: fixture.context,
  });
  assert.equal(preview.ok, true);
  return {
    gameplay: fixture.gameplay,
    record,
    previewKey: preview.key,
    bindings,
    prepareStation: fixture.prepareStation,
    validateAccess: () => fixture.access,
    receiveOutput: receiveCursor,
    context: fixture.context,
    ...overrides,
  };
}
