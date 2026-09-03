import { getItem } from "./items.js";

export const contentIngredient = (id, count = 1, alternatives = [], name) => ({
  id,
  count,
  ...(alternatives.length ? { alternatives: [...alternatives] } : {}),
  ...(name ? { name } : {}),
});

export function contentRecipe(
  id,
  output,
  count,
  ingredients,
  station = "hand",
  extra = {}
) {
  const item = getItem(output);
  if (!item) throw new RangeError(`Unregistered recipe result: ${id}`);
  return {
    id,
    name: item.name,
    output: { id: output, count },
    ingredients,
    station,
    duration: 0,
    ...extra,
  };
}

/** Derive accounting costs from real grid cells so patterns cannot undercharge. */
export function shapedContentRecipe(
  id,
  output,
  count,
  pattern,
  key,
  station = "table"
) {
  const inputs = {};
  for (const symbol of pattern.join("")) {
    if (symbol === " ") continue;
    const input = key[symbol];
    if (!input) throw new RangeError(`Missing recipe symbol: ${id}/${symbol}`);
    if (!inputs[symbol]) inputs[symbol] = { ...input, count: 0 };
    inputs[symbol].count++;
  }
  return contentRecipe(id, output, count, Object.values(inputs), station, {
    pattern,
    key: Object.fromEntries(
      Object.keys(inputs).map((symbol) => [
        symbol,
        { ...key[symbol], count: 1 },
      ])
    ),
    mirrored: true,
  });
}

export const smeltingContentRecipe = (id, output, input, experience) =>
  contentRecipe(id, output, 1, [contentIngredient(input)], "furnace", {
    duration: 10,
    experience,
  });
