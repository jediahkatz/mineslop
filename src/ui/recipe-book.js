import { planRecipeFill, recipeLayout } from "../crafting.js";
import { getItem } from "../items.js";
import { RECIPES } from "../recipes.js";
import { appendItemIcon, element } from "./dom.js";
import { recipeView } from "./model.js";
import { createStackTooltip } from "./slots.js";

export function createRecipeBook(container, { listen, onFill }) {
  const catalog = Array.isArray(RECIPES) ? RECIPES : Object.values(RECIPES);
  let state = {};
  let size = 2;
  let signature = "";
  container.innerHTML = `
    <h3>Recipe Book</h3>
    <label class="recipe-search-label"><span class="sr-only">Search recipes</span><input class="recipe-search" type="search" placeholder="Search..." autocomplete="off"></label>
    <label class="craftable-filter"><input type="checkbox"> Craftable</label>
    <div class="recipe-grid"></div>
    <p class="recipe-empty" hidden>No matching recipes</p>
    <p class="recipe-book-help">Select a recipe to fill the grid using your items.</p>`;
  const $ = (selector) => container.querySelector(selector);
  const tooltip = createStackTooltip(container);
  const entries = new Map();

  function render() {
    if (container.hidden) return;
    const query = $(".recipe-search").value.trim().toLowerCase();
    const craftableOnly = $(".craftable-filter input").checked;
    const key = JSON.stringify([
      state.slots,
      state.counts,
      state.craftingGrid,
      state.mode,
      size,
      query,
      craftableOnly,
    ]);
    if (signature === key) return;
    signature = key;
    const focused = container.ownerDocument.activeElement?.dataset.recipe;
    const grid = $(".recipe-grid");
    grid.replaceChildren();
    entries.clear();
    for (const recipe of catalog) {
      if (recipe.station === "furnace") continue;
      // Grid crafting uses finite owned ingredients even in Creative. The
      // legacy unlimited palette/craft shortcut is a separate domain policy.
      const view = recipeView(
        recipe,
        { ...state, mode: "survival" },
        size === 3 ? "table" : "hand"
      );
      const fits = Boolean(recipeLayout(recipe, size));
      view.canCraft =
        !state.dead &&
        Array.isArray(state.slots) &&
        planRecipeFill(
          state.slots,
          state.craftingGrid || Array(9).fill(null),
          size,
          recipe
        ).ok;
      const name = recipe.name || getItem(view.outputId)?.name || "Recipe";
      if (query && !name.toLowerCase().includes(query)) continue;
      if (craftableOnly && (!fits || !view.canCraft)) continue;
      const button = element("button", "recipe-slot");
      button.type = "button";
      button.dataset.recipe = String(recipe.id);
      button.disabled = !onFill || !fits;
      button.classList.toggle("is-unavailable", !fits || !view.canCraft);
      appendItemIcon(button, view.outputId);
      button.setAttribute(
        "aria-label",
        `Fill recipe: ${name}${fits ? "" : " (requires a crafting table)"}`
      );
      if (view.outputCount > 1)
        button.append(element("span", "slot-count", view.outputCount));
      entries.set(String(recipe.id), { view, name, fits });
      grid.append(button);
      if (focused === String(recipe.id)) button.focus({ preventScroll: true });
    }
    $(".recipe-empty").hidden = entries.size > 0;
  }

  listen($(".recipe-search"), "input", render);
  listen($(".craftable-filter input"), "change", render);
  listen($(".recipe-grid"), "click", (event) => {
    const button = event.target.closest("[data-recipe]");
    if (!button || button.disabled) return;
    onFill?.(button.dataset.recipe);
  });
  listen($(".recipe-grid"), "pointermove", (event) => {
    const button = event.target.closest("[data-recipe]");
    const entry = entries.get(button?.dataset.recipe);
    if (!entry) return tooltip.hide();
    tooltip.show(
      { id: entry.view.outputId, count: entry.view.outputCount },
      button,
      event.clientX,
      event.clientY,
      {
        note: !entry.fits
          ? "Open a Crafting Table for a 3×3 grid"
          : !entry.view.canCraft
            ? "More materials may be needed"
            : "Click to fill crafting grid",
      }
    );
  });
  listen(container, "pointerleave", tooltip.hide);
  return {
    update(next, nextSize) {
      state = next;
      size = nextSize;
      render();
    },
    refresh() {
      signature = "";
      render();
      tooltip.hide();
    },
    dispose() {
      tooltip.dispose();
    },
  };
}
