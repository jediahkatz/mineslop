import { BLOCK } from "../src/blocks.js";
import {
  advanceBrewing,
  brewingRecordBytes,
  changeBrewingSlots,
  createBrewingCatalog,
  createBrewingStand,
  normalizeBrewingStand,
} from "../src/brewing.js";
import { normalizeStack } from "../src/inventory-slots.js";
import { normalizePotionData } from "../src/item-stack-data.js";
import { ITEM } from "../src/items.js";

/**
 * Checkpoint dependency: these tests use ONLY lead-registered real items.
 * Missing brewing capabilities are a deliberate failure, never a fake registry,
 * an invented ID, or a skipped claim of station integration.
 */
export const brewingCatalog = () => createBrewingCatalog({ ...BLOCK, ...ITEM });

export function potionStack(catalog, id, options = {}) {
  const { name, form = "drinkable", ...flags } = options;
  return normalizeStack({
    id: catalog.bottles[form],
    count: 1,
    data: {
      version: 1,
      ...(name === undefined ? {} : { name }),
      potion: normalizePotionData({ id, form, ...flags }),
    },
  });
}

export const ingredientStack = (catalog, role, count = 1) =>
  normalizeStack({ id: catalog.ingredients[role], count });

export function brewingStand(
  catalog,
  {
    bottles = [potionStack(catalog, "water"), null, null],
    ingredient = "nether_wart",
    ingredientCount = 1,
    fuelCount = 1,
  } = {}
) {
  return changeBrewingSlots(createBrewingStand(), [
    ...bottles,
    ingredientCount ? ingredientStack(catalog, ingredient, ingredientCount) : null,
    fuelCount ? normalizeStack({ id: catalog.fuelItem, count: fuelCount }) : null,
  ], catalog);
}

/**
 * Test-only one-record stand participant for the leaf reducer's byte boundary.
 * progression-brewing.integration.test.js uses the production ProgressionStations
 * owner with real World/Gameplay callbacks. Neither fixture modifies Settlement.
 */
export class PreparedBrewingRecordFixture {
  constructor(coordinator, catalog, state = createBrewingStand()) {
    this.coordinator = coordinator;
    this.catalog = catalog;
    this.state = normalizeBrewingStand(state, catalog);
    this.revision = 0;
    this.notifications = 0;
    this.bytes = brewingRecordBytes(this.state, catalog);
    if (!coordinator.register(this, this.bytes))
      throw new Error("Cannot register brewing record fixture");
  }

  snapshot() {
    return normalizeBrewingStand(this.state, this.catalog);
  }

  prepare(value, { reuseBytes = false, valid = () => true } = {}) {
    const next = normalizeBrewingStand(value, this.catalog);
    const previous = this.state;
    const revision = this.revision;
    const beforeBytes = this.bytes;
    const afterBytes = reuseBytes ? beforeBytes : brewingRecordBytes(next, this.catalog);
    let used = false;
    return {
      owner: this, beforeBytes, afterBytes,
      validate: () =>
        !used && this.revision === revision && this.state === previous &&
        this.bytes === beforeBytes && valid() === true,
      publish: () => {
        used = true;
        this.state = next;
        this.bytes = afterBytes;
        this.revision++;
      },
      notify: () => { this.notifications++; },
    };
  }

  prepareAdvance(dt, options) {
    const transition = advanceBrewing(this.state, dt, this.catalog, options);
    return {
      transition,
      participant: transition.changed
        ? this.prepare(transition.state, { reuseBytes: !transition.reservationChanged })
        : null,
    };
  }

  dispose() {
    return this.coordinator.release(this);
  }
}
