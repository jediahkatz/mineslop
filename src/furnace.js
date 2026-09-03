import { matchesIngredient, recipeOutput } from "./crafting.js";
import {
  cloneSlots,
  cloneStack,
  isMergeable,
  isValidStack,
  takeStack,
} from "./inventory-slots.js";
import { normalizeStackData } from "./item-stack-data.js";
import { FUEL_ITEMS, getItem } from "./items.js";
import { getRecipe, RECIPES } from "./recipes.js";

export const FURNACE_SLOTS = 3;
// Integer awards keep partially extracted stacks and saved XP exactly accountable.
export const FURNACE_XP_PER_OUTPUT = 1;
const EPSILON = 1e-8;
const MAX_BURN_TIME = Math.max(...FUEL_ITEMS.map((id) => getItem(id).fuel));
const smelting = RECIPES.filter(
  (recipe) =>
    recipe.station === "furnace" &&
    recipe.duration > 0 &&
    recipe.ingredients.length === 1
);
const outputs = new Set(smelting.map((recipe) => recipe.output.id));
const inRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;

export function getSmeltingRecipe(stack, context) {
  if (!isValidStack(stack, context)) return null;
  return (
    smelting.find(({ ingredients: [input] }) =>
      matchesIngredient(stack, input)
    ) ?? null
  );
}

/** Output is extraction-only. This predicate describes player insertion. */
export function acceptsFurnaceStack(index, stack, context) {
  if (!Number.isInteger(index) || index < 0 || index >= FURNACE_SLOTS)
    return false;
  if (stack === null) return true;
  if (!isValidStack(stack, context)) return false;
  if (index === 0) return getSmeltingRecipe(stack, context) !== null;
  if (index === 1)
    return (
      normalizeStackData(stack.id, stack.data, context) === undefined &&
      getItem(stack.id).fuel > 0
    );
  return false;
}

export function createFurnace() {
  return {
    slots: Array(FURNACE_SLOTS).fill(null),
    burnTime: 0,
    burnDuration: 0,
    cookTime: 0,
    recipeId: null,
    experience: 0,
  };
}

export function cloneFurnace(furnace, context) {
  return {
    slots: cloneSlots(furnace.slots, context),
    burnTime: furnace.burnTime,
    burnDuration: furnace.burnDuration,
    cookTime: furnace.cookTime,
    recipeId: furnace.recipeId,
    experience: furnace.experience,
  };
}

/** Changing the input recipe cannot carry partially paid cooking into another. */
export function syncFurnaceRecipe(furnace) {
  const recipe = getSmeltingRecipe(furnace.slots[0]);
  const id = recipe?.id ?? null;
  if (furnace.recipeId !== id) {
    furnace.recipeId = id;
    furnace.cookTime = 0;
  }
  return recipe;
}

export function isValidFurnace(furnace, context) {
  if (
    !furnace ||
    typeof furnace !== "object" ||
    Array.isArray(furnace) ||
    !Array.isArray(furnace.slots) ||
    furnace.slots.length !== FURNACE_SLOTS ||
    !Array.from(furnace.slots).every(
      (stack) => stack === null || isValidStack(stack, context)
    )
  )
    return false;
  const [input, fuel, output] = furnace.slots;
  if (
    !acceptsFurnaceStack(0, input, context) ||
    !acceptsFurnaceStack(1, fuel, context) ||
    (output !== null && !outputs.has(output.id)) ||
    !inRange(furnace.burnDuration, 0, MAX_BURN_TIME) ||
    !inRange(furnace.burnTime, 0, furnace.burnDuration) ||
    !Number.isSafeInteger(furnace.experience) ||
    furnace.experience < 0 ||
    furnace.experience > (output?.count ?? 0) * FURNACE_XP_PER_OUTPUT
  )
    return false;
  const recipe = getSmeltingRecipe(input, context);
  return (
    furnace.recipeId === (recipe?.id ?? null) &&
    inRange(furnace.cookTime, 0, recipe?.duration ?? 0) &&
    (!recipe || furnace.cookTime < recipe.duration)
  );
}

function canCook(furnace, recipe) {
  if (!recipe || furnace.slots[0].count < recipe.ingredients[0].count)
    return false;
  const output = furnace.slots[2];
  const produced = recipeOutput(recipe);
  return (
    output === null ||
    (isMergeable(output, produced) &&
      output.count + produced.count <= getItem(output.id).stackSize)
  );
}

/**
 * Active simulation seconds, independent of whether a screen is open.
 * Blocked output/no input stops cooking and never ignites fresh fuel. Already
 * burning fuel still expires; an unfueled, unchanged recipe keeps its progress.
 * Only the caller decides which loaded dimension's furnaces receive time.
 */
export function advanceFurnace(furnace, dt) {
  if (!Number.isFinite(dt) || dt <= 0) return false;
  let changed = false;
  while (dt > EPSILON) {
    const previousRecipe = furnace.recipeId;
    const recipe = syncFurnaceRecipe(furnace);
    if (previousRecipe !== furnace.recipeId) changed = true;
    if (!canCook(furnace, recipe)) {
      if (furnace.burnTime > 0) {
        furnace.burnTime = Math.max(0, furnace.burnTime - dt);
        changed = true;
      }
      break;
    }
    if (furnace.burnTime <= EPSILON) {
      const fuel = furnace.slots[1];
      if (!fuel || !acceptsFurnaceStack(1, fuel)) {
        if (furnace.burnTime !== 0) {
          furnace.burnTime = 0;
          changed = true;
        }
        break;
      }
      furnace.burnTime = furnace.burnDuration = getItem(fuel.id).fuel;
      takeStack(furnace.slots, 1, 1);
      changed = true;
    }
    const elapsed = Math.min(
      dt,
      furnace.burnTime,
      recipe.duration - furnace.cookTime
    );
    furnace.burnTime = Math.max(0, furnace.burnTime - elapsed);
    furnace.cookTime += elapsed;
    dt -= elapsed;
    changed = true;
    if (furnace.cookTime >= recipe.duration - EPSILON) {
      takeStack(furnace.slots, 0, recipe.ingredients[0].count);
      const output = furnace.slots[2];
      furnace.slots[2] = {
        ...cloneStack(output ?? recipeOutput(recipe)),
        count: (output?.count ?? 0) + recipe.output.count,
      };
      furnace.experience += recipe.output.count * FURNACE_XP_PER_OUTPUT;
      furnace.cookTime = 0;
      syncFurnaceRecipe(furnace);
    }
  }
  return changed;
}

/** Debit only XP belonging to the outputs actually extracted by a transaction. */
export function takeFurnaceExperience(furnace, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return 0;
  const earned = Math.min(furnace.experience, count * FURNACE_XP_PER_OUTPUT);
  furnace.experience -= earned;
  return earned;
}

export function furnaceProgress(furnace) {
  const recipe = getRecipe(furnace.recipeId);
  return {
    burning: furnace.burnTime > 0,
    burnTime: furnace.burnTime,
    burnDuration: furnace.burnDuration,
    burnProgress: furnace.burnDuration
      ? furnace.burnTime / furnace.burnDuration
      : 0,
    cookTime: furnace.cookTime,
    cookDuration: recipe?.duration ?? 0,
    cookProgress: recipe ? furnace.cookTime / recipe.duration : 0,
    recipeId: furnace.recipeId,
    experience: furnace.experience,
  };
}
