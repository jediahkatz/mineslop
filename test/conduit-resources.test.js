import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { rollFishingCatch } from "../src/fishing-loot.js";
import { ITEM } from "../src/items.js";
import { RECIPES } from "../src/recipes.js";
import { conduitFixture } from "./conduit-fixture.js";

test("the live vehicle fishing tables supply shells only through open-water treasure; recipe retains eight shells and one heart", async (t) => {
  const f = await conduitFixture(t);
  const tables = f.vehicles.fishing._tables;
  assert.equal(tables.treasure.find((entry) => entry.item === "NAUTILUS_SHELL").stack.id,
    ITEM.NAUTILUS_SHELL);
  let selected;
  for (let seed = 0; seed < 4096; seed++) {
    const result = rollFishingCatch(seed, { tables, context: f.context, openWater: true });
    if (result.stack.id === ITEM.NAUTILUS_SHELL) { selected = { seed, result }; break; }
  }
  assert.ok(selected, "a bounded seeded roll reaches the actual shell table entry");
  assert.equal(selected.result.category, "treasure");
  const closed = rollFishingCatch(selected.seed, { tables, context: f.context, openWater: false });
  assert.notEqual(closed.category, "treasure");
  assert.notEqual(closed.stack.id, ITEM.NAUTILUS_SHELL);
  const recipe = RECIPES.find((recipe) => recipe.id === "conduit");
  assert.equal(recipe.output.id, BLOCK.CONDUIT);
  assert.deepEqual(new Map(recipe.ingredients.map(({ id, count }) => [id, count])),
    new Map([[ITEM.NAUTILUS_SHELL, 8], [ITEM.HEART_OF_THE_SEA, 1]]));
});
