import {
  cloneSlots,
  cloneStack,
  insertStack,
  isValidSlots,
  isValidStack,
  normalizeStack,
  takeStack,
} from "./inventory-slots.js";
import { normalizeStackData, sameStackKind } from "./item-stack-data.js";
import { getItem } from "./items.js";
import { RECIPES } from "./recipes.js";

export const validCraftingSize = (size) => size === 2 || size === 3;

/** Personal grids use compact indices 0..3; the other five cells stay null. */
export function validCraftingGrid(grid, size, context) {
  return (
    validCraftingSize(size) &&
    isValidSlots(grid, 9, context) &&
    grid.slice(size * size).every((stack) => stack === null)
  );
}

/**
 * Generic recipes consume plain stacks only. A specialized ingredient may opt
 * into `metadata:"exact", data:{...}` or explicitly `metadata:"any"` (discarding
 * its decoration). Unknown policies reject; no ID-only accidental enchant loss.
 */
export function matchesIngredient(stack, input) {
  if (
    !isValidStack(stack) ||
    !input ||
    (stack.id !== input.id && !(input.alternatives ?? []).includes(stack.id))
  )
    return false;
  try {
    if (input.metadata === "any") return input.data === undefined;
    if (input.metadata === "exact")
      return (
        input.data !== undefined &&
        sameStackKind(stack, { id: stack.id, data: input.data })
      );
    return (
      (input.metadata === undefined || input.metadata === "plain") &&
      input.data === undefined &&
      normalizeStackData(stack.id, stack.data) === undefined
    );
  } catch {
    return false;
  }
}

export function recipeOutput(recipe) {
  const item = getItem(recipe.output.id);
  if (!item) throw new RangeError("Unknown recipe output");
  return normalizeStack({
    ...recipe.output,
    ...(item.durability
      ? { durability: recipe.output.durability ?? item.durability }
      : {}),
  });
}

function shapedMatch(recipe, grid, size) {
  const height = recipe.pattern.length;
  const width = recipe.pattern[0].length;
  for (let y = 0; y <= size - height; y++) {
    for (let x = 0; x <= size - width; x++) {
      for (const mirror of recipe.mirrored ? [false, true] : [false]) {
        const inputs = [];
        let matches = true;
        for (let row = 0; row < size && matches; row++) {
          for (let column = 0; column < size; column++) {
            const index = row * size + column;
            const inShape =
              row >= y && row < y + height && column >= x && column < x + width;
            const symbol = inShape
              ? recipe.pattern[row - y][
                  mirror ? width - 1 - (column - x) : column - x
                ]
              : " ";
            const expected = symbol === " " ? null : recipe.key[symbol];
            if (
              expected
                ? !matchesIngredient(grid[index], expected)
                : grid[index] !== null
            ) {
              matches = false;
              break;
            }
            if (expected) inputs.push({ index, count: 1 });
          }
        }
        if (matches) return inputs;
      }
    }
  }
  return null;
}

function shapelessMatch(recipe, grid, size) {
  const occupied = grid
    .slice(0, size * size)
    .map((stack, index) => ({ stack, index }))
    .filter(({ stack }) => stack !== null);
  const ingredients = recipe.ingredients.flatMap((input) =>
    Array(input.count).fill(input)
  );
  if (ingredients.length !== occupied.length) return null;
  // Backtracking handles overlapping ingredient alternatives without letting a
  // permissive ingredient steal the only copy of a stricter one.
  ingredients.sort(
    (a, b) => (a.alternatives?.length ?? 0) - (b.alternatives?.length ?? 0)
  );
  const used = new Set();
  const assign = (offset) => {
    if (offset === ingredients.length) return true;
    for (const { stack, index } of occupied) {
      if (used.has(index) || !matchesIngredient(stack, ingredients[offset]))
        continue;
      used.add(index);
      if (assign(offset + 1)) return true;
      used.delete(index);
    }
    return false;
  };
  return assign(0) ? occupied.map(({ index }) => ({ index, count: 1 })) : null;
}

/** The result is a preview, not an owned output. No inputs are consumed here. */
export function matchCraftingRecipe(grid, size, recipes = RECIPES) {
  if (!validCraftingGrid(grid, size)) return null;
  for (const recipe of recipes) {
    if (recipe.duration || recipe.station === "furnace") continue;
    const inputs = recipe.pattern
      ? shapedMatch(recipe, grid, size)
      : recipe.shapeless
        ? shapelessMatch(recipe, grid, size)
        : null;
    if (inputs)
      return {
        recipe,
        inputs: inputs.map((input) => ({
          ...input,
          expected: cloneStack(grid[input.index]),
        })),
        output: recipeOutput(recipe),
      };
  }
  return null;
}

/** Top-left recipe-book layout; matching also permits every legal offset/mirror. */
export function recipeLayout(recipe, size) {
  if (!recipe || recipe.duration || !validCraftingSize(size)) return null;
  if (recipe.pattern) {
    if (recipe.pattern.length > size || recipe.pattern[0].length > size)
      return null;
    return recipe.pattern.flatMap((row, y) =>
      [...row].flatMap((symbol, x) =>
        symbol === " "
          ? []
          : [{ index: y * size + x, ingredient: recipe.key[symbol] }]
      )
    );
  }
  if (!recipe.shapeless) return null;
  const ingredients = recipe.ingredients.flatMap((input) =>
    Array(input.count).fill(input)
  );
  return ingredients.length <= size * size
    ? ingredients.map((ingredient, index) => ({ index, ingredient }))
    : null;
}

/**
 * Fills from finite inventory + existing inputs, never from a Creative palette.
 * Existing inputs are reused before leftovers are returned; this also works with
 * a full bag when the recipe itself frees the space needed for those leftovers.
 */
export function planRecipeFill(slots, grid, size, recipe) {
  const layout = recipeLayout(recipe, size);
  if (!layout) return { ok: false, reason: "station" };
  if (!isValidSlots(slots, 36) || !validCraftingGrid(grid, size))
    return { ok: false, reason: "invalid" };
  const pool = [...cloneSlots(slots), ...cloneSlots(grid)];
  const order = [
    ...Array.from({ length: 9 }, (_, index) => 36 + index),
    ...Array.from({ length: 36 }, (_, index) => index),
  ];
  const nextGrid = Array(9).fill(null);
  for (const { index, ingredient } of layout) {
    let source = -1;
    for (const id of [ingredient.id, ...(ingredient.alternatives ?? [])]) {
      source =
        order.find(
          (slot) =>
            pool[slot]?.id === id && matchesIngredient(pool[slot], ingredient)
        ) ?? -1;
      if (source >= 0) break;
    }
    if (source < 0) return { ok: false, reason: "ingredients" };
    nextGrid[index] = takeStack(pool, source, 1);
  }
  const nextSlots = pool.slice(0, 36);
  for (const stack of pool.slice(36)) {
    if (stack && insertStack(nextSlots, stack))
      return { ok: false, reason: "inventory_full" };
  }
  return { ok: true, slots: nextSlots, craftingGrid: nextGrid };
}

/**
 * Consume one matched recipe from a working grid, after output fits. All
 * prerequisites are checked before debiting; stale previews cannot consume a
 * different named/enchanted/worn item that has since occupied the same cell.
 */
export function consumeCraftingInputs(grid, match) {
  if (
    !isValidSlots(grid, 9) ||
    !Array.isArray(match?.inputs) ||
    !match.inputs.length
  )
    throw new RangeError("Invalid crafting input plan");
  const seen = new Set();
  for (const input of match.inputs) {
    if (
      !input ||
      !Number.isInteger(input.index) ||
      input.index < 0 ||
      input.index >= grid.length ||
      seen.has(input.index) ||
      !Number.isSafeInteger(input.count) ||
      input.count <= 0 ||
      !isValidStack(input.expected) ||
      !sameStackKind(grid[input.index], input.expected) ||
      grid[input.index].durability !== input.expected.durability ||
      grid[input.index].count < input.count
    )
      throw new RangeError("Stale crafting input plan");
    seen.add(input.index);
  }
  for (const { index, count } of match.inputs) takeStack(grid, index, count);
  return true;
}
