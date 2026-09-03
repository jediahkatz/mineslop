import {
  cloneSlots,
  cloneStack,
  isValidStack,
  normalizeStack,
} from "./inventory-slots.js";
import {
  normalizePotionData,
  normalizeStackData,
  sameStackKind,
  stackIdentity,
} from "./item-stack-data.js";
import { getItem } from "./items.js";
import { BREWING_INGREDIENTS, brewPotionData } from "./potion-rules.js";
import { encodedBytes } from "./save-budget.js";

export const BREWING_VERSION = 1;
export const BREWING_SLOTS = 5;
export const BREWING_BOTTLE_SLOTS = 3;
export const BREWING_INGREDIENT_SLOT = 3;
export const BREWING_FUEL_SLOT = 4;
export const BREWING_SECONDS = 20;
export const BREWING_TICKS = 400;
export const BREWING_FUEL_OPERATIONS = 20;
export const MAX_BREWING_STEP_SECONDS = 60;
export const BREWING_XP = 0;

// Fixed envelope, bounded progress, fractional tick and three safe-integer
// revisions. Variable slots and batch identities are reserved separately.
export const BREWING_PROGRESS_RESERVED_BYTES = 512;
const EPSILON = 1e-9;
const catalogs = new WeakSet();
const dataRecord = (value, fields) =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return (
      typeof key === "string" &&
      fields.includes(key) &&
      property.enumerable &&
      Object.hasOwn(property, "value")
    );
  });
const boundedInteger = (value, maximum) =>
  Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const arrayOf = (value, length, predicate) =>
  Array.isArray(value) &&
  value.length === length &&
  Array.from(value).every(predicate);
const synchronous = (value) =>
  typeof value === "function" &&
  Object.prototype.toString.call(value) === "[object Function]";

/**
 * Bind lead-registered items once, never guess IDs or reinterpret ordinary
 * materials as bottles. See potion-rules.js for symbolic capabilities/recipes.
 * The real catalog remains the authority for all stack/data validation.
 */
export function createBrewingCatalog(symbols) {
  const item = (symbol) => getItem(symbols?.[symbol]);
  const empty = item("GLASS_BOTTLE");
  if (empty?.emptyBottle !== true || empty.stackSize !== 64 || empty.durability)
    throw new RangeError("GLASS_BOTTLE requires the emptyBottle capability");
  const bottles = {};
  for (const [symbol, form] of [
    ["POTION", "drinkable"],
    ["SPLASH_POTION", "splash"],
  ]) {
    const definition = item(symbol);
    if (
      definition?.potionForm !== form ||
      definition.stackSize !== 1 ||
      definition.durability
    )
      throw new RangeError(
        `${symbol} requires potionForm:${form}, stackSize:1`
      );
    bottles[form] = definition.id;
  }
  const ingredients = {};
  const ingredientById = {};
  for (const [symbol, role] of Object.entries(BREWING_INGREDIENTS)) {
    const definition = item(symbol);
    if (
      definition?.brewingIngredient !== role ||
      definition.durability ||
      !Number.isSafeInteger(definition.stackSize) ||
      definition.stackSize < 1 ||
      definition.stackSize > 64 ||
      Object.hasOwn(ingredientById, definition.id)
    )
      throw new RangeError(`${symbol} requires brewingIngredient:${role}`);
    ingredients[role] = definition.id;
    ingredientById[definition.id] = role;
  }
  if (item("BLAZE_POWDER").brewingFuelOperations !== BREWING_FUEL_OPERATIONS)
    throw new RangeError("Blaze powder must provide 20 brewing operations");
  const ids = [
    empty.id,
    ...Object.values(bottles),
    ...Object.values(ingredients),
  ];
  if (new Set(ids).size !== ids.length)
    throw new RangeError("Brewing capabilities require distinct catalog items");
  const catalog = Object.freeze({
    emptyBottle: empty.id,
    bottles: Object.freeze(bottles),
    ingredients: Object.freeze(ingredients),
    ingredientById: Object.freeze(ingredientById),
    fuelItem: ingredients.blaze_powder,
  });
  catalogs.add(catalog);
  return catalog;
}

function requireCatalog(catalog) {
  if (!catalogs.has(catalog)) throw new RangeError("Unbound brewing catalog");
}

export function brewingIngredient(stack, catalog, context) {
  if (!catalogs.has(catalog) || !isValidStack(stack, context)) return null;
  return catalog.ingredientById[stack.id] ?? null;
}

/** Bottle slots are also output slots; each holds exactly one physical bottle. */
export function acceptsBrewingStack(index, stack, catalog, context) {
  if (
    !catalogs.has(catalog) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= BREWING_SLOTS
  )
    return false;
  if (stack === null) return true;
  if (!isValidStack(stack, context)) return false;
  if (index < BREWING_BOTTLE_SLOTS) {
    if (stack.count !== 1) return false;
    if (stack.id === catalog.emptyBottle) return true;
    const potion = normalizeStackData(stack.id, stack.data, context)?.potion;
    return Boolean(potion && catalog.bottles[potion.form] === stack.id);
  }
  if (index === BREWING_INGREDIENT_SLOT)
    return brewingIngredient(stack, catalog, context) !== null;
  return stack.id === catalog.fuelItem;
}

/** Metadata-less potion items are not implicitly water bottles. */
export function getBrewingResult(bottle, ingredient, catalog, context) {
  if (
    !acceptsBrewingStack(0, bottle, catalog, context) ||
    bottle === null ||
    bottle.id === catalog.emptyBottle
  )
    return null;
  const role = brewingIngredient(ingredient, catalog, context);
  if (role === null) return null;
  const data = normalizeStackData(bottle.id, bottle.data, context);
  const potion = brewPotionData(data.potion, role);
  if (!potion) return null;
  return normalizeStack(
    { id: catalog.bottles[potion.form], count: 1, data: { ...data, potion } },
    context
  );
}

/** The World owner must separately guard a loaded source-water read. */
export function fillWaterBottle(bottle, catalog, context) {
  requireCatalog(catalog);
  if (
    !isValidStack(bottle, context) ||
    bottle.id !== catalog.emptyBottle ||
    bottle.count !== 1
  )
    return null;
  const data = normalizeStackData(bottle.id, bottle.data, context);
  return normalizeStack(
    {
      id: catalog.bottles.drinkable,
      count: 1,
      data: {
        ...data,
        version: 1,
        potion: normalizePotionData({ id: "water", form: "drinkable" }),
      },
    },
    context
  );
}

/**
 * ProgressionStations owns this record, its slots and reservation. It is NOT
 * carried inventory or a Settlement Map. No wall/day timestamps.
 */
export function createBrewingStand() {
  return {
    version: BREWING_VERSION,
    slots: Array(BREWING_SLOTS).fill(null),
    fuelOperations: 0,
    progressTicks: 0,
    tickRemainder: 0,
    bottleRevisions: [0, 0, 0],
    batch: null,
  };
}

function normalizeSlots(slots, catalog, context) {
  if (
    !arrayOf(slots, BREWING_SLOTS, (stack, index) =>
      acceptsBrewingStack(index, stack, catalog, context)
    )
  )
    throw new RangeError("Invalid brewing slots");
  return cloneSlots(slots, context);
}

/** Strict detached normalization; never repair a forged batch into free output. */
export function normalizeBrewingStand(value, catalog, context) {
  requireCatalog(catalog);
  if (
    !dataRecord(value, [
      "version",
      "slots",
      "fuelOperations",
      "progressTicks",
      "tickRemainder",
      "bottleRevisions",
      "batch",
    ]) ||
    value.version !== BREWING_VERSION ||
    !boundedInteger(value.fuelOperations, BREWING_FUEL_OPERATIONS) ||
    !boundedInteger(value.progressTicks, BREWING_TICKS - 1) ||
    !Number.isFinite(value.tickRemainder) ||
    value.tickRemainder < 0 ||
    value.tickRemainder >= 1 ||
    !arrayOf(value.bottleRevisions, BREWING_BOTTLE_SLOTS, (revision) =>
      boundedInteger(revision, Number.MAX_SAFE_INTEGER)
    )
  )
    throw new RangeError("Invalid brewing state");
  const slots = normalizeSlots(value.slots, catalog, context);
  let batch = null;
  if (value.batch !== null) {
    const ingredient = slots[BREWING_INGREDIENT_SLOT];
    if (
      !dataRecord(value.batch, ["ingredient", "bottles"]) ||
      value.fuelOperations === BREWING_FUEL_OPERATIONS ||
      typeof value.batch.ingredient !== "string" ||
      value.batch.ingredient.length > 4096 ||
      !ingredient ||
      value.batch.ingredient !== stackIdentity(ingredient, context) ||
      !Array.isArray(value.batch.bottles) ||
      value.batch.bottles.length !== BREWING_BOTTLE_SLOTS
    )
      throw new RangeError("Invalid brewing batch");
    const bottles = Array.from(value.batch.bottles, (entry, index) => {
      if (entry === null) return null;
      if (
        !dataRecord(entry, ["revision", "identity"]) ||
        entry.revision !== value.bottleRevisions[index] ||
        typeof entry.identity !== "string" ||
        entry.identity.length > 4096 ||
        !slots[index] ||
        entry.identity !== stackIdentity(slots[index], context) ||
        getBrewingResult(slots[index], ingredient, catalog, context) === null
      )
        throw new RangeError("Stale brewing bottle identity");
      return { revision: entry.revision, identity: entry.identity };
    });
    if (!bottles.some(Boolean)) throw new RangeError("Empty brewing batch");
    batch = { ingredient: value.batch.ingredient, bottles };
  } else if (value.progressTicks !== 0 || value.tickRemainder !== 0)
    throw new RangeError("Progress without a paid brewing batch");
  return {
    version: BREWING_VERSION,
    slots,
    fuelOperations: value.fuelOperations,
    progressTicks: value.progressTicks,
    tickRemainder: value.tickRemainder,
    bottleRevisions: [...value.bottleRevisions],
    batch,
  };
}

export const cloneBrewingStand = normalizeBrewingStand;

export function isValidBrewingStand(value, catalog, context) {
  try {
    normalizeBrewingStand(value, catalog, context);
    return true;
  } catch {
    return false;
  }
}

function clearBatch(state) {
  state.batch = null;
  state.progressTicks = 0;
  state.tickRemainder = 0;
}

const sameValue = (a, b, context) =>
  a === b ||
  Boolean(a && b && a.count === b.count && sameStackKind(a, b, context));

/**
 * Reconcile a detached UI/automation edit before ProgressionStations prepares ownership.
 * Include touchedBottleSlots for replacements with identical ID/data: count
 * equality is not physical identity. New/replaced bottles never inherit a paid
 * batch's progress. Untouched members of a partial batch finish normally.
 */
export function changeBrewingSlots(
  value,
  slots,
  catalog,
  { context, touchedBottleSlots = [] } = {}
) {
  const next = normalizeBrewingStand(value, catalog, context);
  const incoming = normalizeSlots(slots, catalog, context);
  if (
    !Array.isArray(touchedBottleSlots) ||
    touchedBottleSlots.length > BREWING_BOTTLE_SLOTS ||
    !Array.from(touchedBottleSlots).every((index) =>
      boundedInteger(index, BREWING_BOTTLE_SLOTS - 1)
    ) ||
    new Set(touchedBottleSlots).size !== touchedBottleSlots.length
  )
    throw new RangeError("Invalid touched brewing slots");
  for (let index = 0; index < BREWING_BOTTLE_SLOTS; index++) {
    if (
      !touchedBottleSlots.includes(index) &&
      sameValue(next.slots[index], incoming[index], context)
    )
      continue;
    if (next.bottleRevisions[index] === Number.MAX_SAFE_INTEGER)
      throw new RangeError("Brewing bottle revision exhausted");
    next.bottleRevisions[index]++;
    if (next.batch) next.batch.bottles[index] = null;
  }
  next.slots = incoming;
  if (
    next.batch &&
    (!incoming[BREWING_INGREDIENT_SLOT] ||
      stackIdentity(incoming[BREWING_INGREDIENT_SLOT], context) !==
        next.batch.ingredient ||
      !next.batch.bottles.some(Boolean))
  )
    clearBatch(next);
  return normalizeBrewingStand(next, catalog, context);
}

/** Cancellation does not refund the operation already charged at batch start. */
export function cancelBrewing(value, catalog, context) {
  const next = normalizeBrewingStand(value, catalog, context);
  clearBatch(next);
  return next;
}

function captureBatch(state, catalog, context) {
  const ingredient = state.slots[BREWING_INGREDIENT_SLOT];
  if (!ingredient) return null;
  const bottles = state.slots
    .slice(0, BREWING_BOTTLE_SLOTS)
    .map((stack, index) =>
      getBrewingResult(stack, ingredient, catalog, context)
        ? {
            revision: state.bottleRevisions[index],
            identity: stackIdentity(stack, context),
          }
        : null
    );
  return bottles.some(Boolean)
    ? { ingredient: stackIdentity(ingredient, context), bottles }
    : null;
}

function debitSlot(slots, index) {
  const stack = slots[index];
  slots[index] =
    stack.count === 1 ? null : { ...stack, count: stack.count - 1 };
}

function completionSlots(state, batch, catalog, context) {
  const slots = cloneSlots(state.slots, context);
  const ingredient = slots[BREWING_INGREDIENT_SLOT];
  for (let index = 0; index < BREWING_BOTTLE_SLOTS; index++) {
    if (!batch.bottles[index]) continue;
    const output = getBrewingResult(slots[index], ingredient, catalog, context);
    if (!output) throw new RangeError("Brewing batch no longer has a result");
    slots[index] = output;
  }
  debitSlot(slots, BREWING_INGREDIENT_SLOT);
  return slots;
}

/**
 * Pure active-simulation transition, capped like Gameplay.update. A batch spends
 * ONE operation at start and ONE ingredient on completion, for up to three
 * eligible bottles. An unsupported/blocked batch never starts or ignites fuel.
 *
 * canAcceptResults is a synchronous, read-only destination preflight, not a
 * publication callback. The coordinator must still admit the final reservation.
 * Paused/unloaded/inactive dimensions must receive paused:true or no call at all.
 * Sleep/day jumps must NEVER be passed here as elapsed simulation seconds.
 */
export function advanceBrewing(
  value,
  dt,
  catalog,
  { context, paused = false, canAcceptResults = () => true } = {}
) {
  const state = normalizeBrewingStand(value, catalog, context);
  if (typeof paused !== "boolean" || !synchronous(canAcceptResults))
    throw new RangeError("Invalid brewing update options");
  const result = {
    state,
    changed: false,
    reservationChanged: false,
    operationsStarted: 0,
    operationsCompleted: 0,
    fuelItemsConsumed: 0,
    ingredientsConsumed: 0,
    completedSlots: [],
    experience: BREWING_XP,
    reason: null,
  };
  if (paused || !Number.isFinite(dt) || dt <= 0) {
    result.reason = paused ? "paused" : "inactive-time";
    return result;
  }
  let available =
    state.tickRemainder + Math.min(dt, MAX_BREWING_STEP_SECONDS) * 20;
  while (available > EPSILON) {
    const batch = state.batch ?? captureBatch(state, catalog, context);
    if (!batch) {
      result.reason = "no-recipe";
      break;
    }
    // The output is in-place, not another stack to merge. A destination can
    // still block admission (e.g. shared save capacity or an automation escrow).
    const completed = completionSlots(state, batch, catalog, context);
    if (canAcceptResults(cloneSlots(completed, context)) !== true) {
      result.reason = "output-blocked";
      break;
    }
    if (!state.batch) {
      if (state.fuelOperations === 0) {
        if (!state.slots[BREWING_FUEL_SLOT]) {
          result.reason = "no-fuel";
          break;
        }
        debitSlot(state.slots, BREWING_FUEL_SLOT);
        state.fuelOperations = BREWING_FUEL_OPERATIONS;
        result.fuelItemsConsumed++;
        // Completion was projected before the new fuel debit.
        completed[BREWING_FUEL_SLOT] = cloneStack(
          state.slots[BREWING_FUEL_SLOT],
          context
        );
      }
      state.fuelOperations--;
      state.batch = batch;
      result.operationsStarted++;
      result.reservationChanged = result.changed = true;
    }
    const ticks = Math.min(
      Math.floor(available + EPSILON),
      BREWING_TICKS - state.progressTicks
    );
    state.progressTicks += ticks;
    available = Math.max(0, available - ticks);
    result.changed = true;
    if (state.progressTicks < BREWING_TICKS) {
      state.tickRemainder = available;
      break;
    }
    state.slots = completed;
    result.completedSlots.push(
      batch.bottles.flatMap((entry, index) => (entry ? [index] : []))
    );
    result.operationsCompleted++;
    result.ingredientsConsumed++;
    result.reservationChanged = true;
    clearBatch(state);
  }
  return result;
}

/**
 * Per-record reservation only. Reserve the pending result at START so capacity
 * refusal happens before fuel is paid. Completion cannot introduce an unreserved
 * metadata increase. Progress-only ticks reuse this reservation without JSON.
 * ProgressionStations adds the exact position/array-separator envelope.
 */
export function brewingRecordBytes(value, catalog, context) {
  const state = normalizeBrewingStand(value, catalog, context);
  const present = encodedBytes({ slots: state.slots, batch: state.batch });
  const completed = state.batch
    ? encodedBytes({
        slots: completionSlots(state, state.batch, catalog, context),
        batch: null,
      })
    : present;
  return BREWING_PROGRESS_RESERVED_BYTES + Math.max(present, completed);
}

export function brewingProgress(value, catalog, context) {
  const state = normalizeBrewingStand(value, catalog, context);
  return {
    brewing: state.batch !== null,
    fuelOperations: state.fuelOperations,
    progress: state.progressTicks / BREWING_TICKS,
    elapsedSeconds: state.progressTicks / 20,
    durationSeconds: BREWING_SECONDS,
    activeBottleSlots: state.batch
      ? state.batch.bottles.flatMap((entry, index) => (entry ? [index] : []))
      : [],
  };
}
