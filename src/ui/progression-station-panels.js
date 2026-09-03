import { MAX_STACK_NAME_LENGTH } from "../item-stack-data.js";
import { createStackSlot } from "./slots.js";
import { element, setText } from "./dom.js";

const title = (value) => value.replaceAll("_", " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
const roman = ["", "I", "II", "III", "IV", "V"];

export const progressionMessage = (reason) => ({
  required_level: "You need the displayed experience level.",
  insufficient_levels: "Not enough experience levels.",
  insufficient_lapis: "Not enough lapis lazuli.",
  invalid_lapis: "Place lapis lazuli in the reagent slot.",
  missing_input: "Place an unenchanted item or book in the table.",
  already_enchanted: "Use an anvil to combine enchanted items.",
  not_enchantable: "This item cannot be enchanted at a table.",
  unloaded_bookshelves: "The nearby bookshelves are not loaded.",
  stale_offer: "The enchanting offer changed. Choose again.",
  stale_preview: "The result changed. Review its cost and try again.",
  output_capacity: "Make room in your cursor or backpack for the entire result.",
  inventory_full: "Your backpack is full.",
  no_change: "Add a repair ingredient, combine an item, or change its name.",
  missing_target: "Place the item to repair or rename in the first slot.",
  too_expensive: "Too expensive! Survival anvils require a cost below 40 levels.",
  incompatible_sacrifice: "These items cannot be combined.",
  no_compatible_enchantments: "The supplied enchantments cannot be combined.",
  no_repair_needed: "This item is already fully repaired.",
  invalid_anvil_input: "The anvil input or name is invalid.",
  invalid_smithing_base: "Place diamond equipment in the middle slot.",
  missing_upgrade_template: "A Netherite Upgrade template is required.",
  missing_netherite_ingot: "A netherite ingot is required.",
  station_slots_full: "There is no compatible space in this station.",
  slot_rejected: "That item does not fit this slot.",
  station_rejected: "The station changed or its active-work limit is full.",
  retention_rejected: "The items cannot be retained safely. Nothing was spent.",
  "budget-rejected": "Save capacity is full. Nothing was spent.",
  trade_rejected: "The trade needs its exact payment, available stock and output space.",
  villager_unavailable: "The villager is no longer available.",
  station_unavailable: "The station is no longer in reach.",
  stale_progression_session: "This interaction is no longer open.",
}[reason] ?? "That action could not be completed. Nothing was spent.");

function slot(parent, index, label) {
  const group = element("div", "progression-slot-group");
  const view = createStackSlot({ area: "container", index, label });
  group.append(element("span", "progression-slot-label", label), view.node);
  parent.append(group);
  return view;
}

function resultSlot(parent) {
  parent.append(element("span", "progression-arrow", "➜"));
  const output = createStackSlot({
    area: "result", label: "Paid result", className: "result-slot",
  });
  parent.append(output.node);
  return output;
}

/** Presentation only. All clicks go through the overlay's guarded callback. */
export function createProgressionStationPanels(parent, { listen, dispatch, onRename }) {
  const panels = new Map();
  const make = (kind) => {
    const node = element("section", `progression-workbench progression-${kind}`);
    node.dataset.station = kind;
    node.hidden = true;
    parent.append(node);
    const panel = { node, inputs: [] };
    panels.set(kind, panel);
    return panel;
  };

  const enchanting = make("enchanting");
  const tableSlots = element("div", "progression-inputs");
  enchanting.inputs = [
    slot(tableSlots, 0, "Item"), slot(tableSlots, 1, "Lapis"),
  ];
  enchanting.power = element("p", "progression-cost");
  enchanting.choices = element("div", "progression-enchant-choices");
  enchanting.choices.setAttribute("role", "group");
  enchanting.choices.setAttribute("aria-label", "Enchanting offers");
  enchanting.offers = Array.from({ length: 3 }, (_, index) => {
    const button = element("button", "progression-offer");
    button.type = "button";
    button.dataset.enchantIndex = String(index);
    const clue = element("span", "progression-offer-clue");
    const cost = element("span", "progression-offer-cost");
    button.append(clue, cost);
    listen(button, "click", () => dispatch({ type: "enchant", index }));
    enchanting.choices.append(button);
    return { button, clue, cost };
  });
  enchanting.node.append(tableSlots, enchanting.power, enchanting.choices);

  const anvil = make("anvil");
  const nameLabel = element("label", "progression-name-label", "Item name");
  anvil.name = element("input", "progression-name");
  anvil.name.type = "text";
  // DOM maxlength counts UTF-16 code units; canonical names allow fifty
  // Unicode characters. Preview validation enforces the actual character cap.
  anvil.name.maxLength = MAX_STACK_NAME_LENGTH * 2;
  anvil.name.autocomplete = "off";
  anvil.name.spellcheck = false;
  anvil.name.setAttribute("aria-label", "Item name");
  nameLabel.append(anvil.name);
  const anvilSlots = element("div", "progression-inputs");
  anvil.inputs.push(slot(anvilSlots, 0, "Item"));
  anvilSlots.append(element("span", "progression-plus", "+"));
  anvil.inputs.push(slot(anvilSlots, 1, "Repair / combine"));
  anvil.output = resultSlot(anvilSlots);
  anvil.cost = element("p", "progression-cost");
  anvil.node.append(nameLabel, anvilSlots, anvil.cost);
  listen(anvil.name, "input", () => onRename(anvil.name.value));

  const smithing = make("smithing");
  const smithSlots = element("div", "progression-inputs");
  smithing.inputs = ["Template", "Diamond gear", "Netherite"].map(
    (label, index) => slot(smithSlots, index, label)
  );
  smithing.output = resultSlot(smithSlots);
  smithing.cost = element("p", "progression-cost");
  smithing.node.append(smithSlots, smithing.cost);

  const brewing = make("brewing");
  const brewSlots = element("div", "progression-brewing-slots");
  brewing.inputs = ["Bottle 1", "Bottle 2", "Bottle 3", "Ingredient", "Blaze fuel"]
    .map((label, index) => {
      const view = slot(brewSlots, index, label);
      view.node.parentElement.dataset.brewSlot = String(index);
      return view;
    });
  brewing.progress = element("div", "progression-brew-progress");
  brewing.progress.setAttribute("role", "progressbar");
  brewing.progress.setAttribute("aria-label", "Brewing progress");
  brewing.progress.setAttribute("aria-valuemin", "0");
  brewing.progress.setAttribute("aria-valuemax", "100");
  brewing.fill = element("span");
  brewing.progress.append(brewing.fill);
  brewing.status = element("p", "progression-cost");
  brewing.node.append(brewSlots, brewing.progress, brewing.status);

  return {
    resetName(value) { anvil.name.value = value ?? ""; },
    update(view) {
      for (const [kind, panel] of panels) panel.node.hidden = kind !== view.kind;
      const panel = panels.get(view.kind);
      if (!panel) return;
      panel.inputs.forEach((input, index) => input.update(view.slots[index]));
      if (view.kind === "enchanting") {
        setText(enchanting.power,
          `Bookshelf power: ${view.bookshelfPower} / 15 · Level ${view.experience.level}`);
        enchanting.offers.forEach((row, index) => {
          const offer = view.offers[index];
          row.button.disabled = !offer?.available || !offer.affordable;
          setText(row.clue, offer?.clue
            ? `${title(offer.clue.name)} ${roman[offer.clue.level] ?? offer.clue.level}…`
            : "No enchantment");
          setText(row.cost, offer
            ? `${offer.requiredLevel} required · ${offer.levelCost} level${offer.levelCost === 1 ? "" : "s"} + ${offer.lapisCost} lapis`
            : progressionMessage(view.reason));
          row.button.setAttribute("aria-label", `${row.clue.textContent}. ${row.cost.textContent}`);
        });
      } else if (view.kind === "brewing") {
        const percent = Math.max(0, Math.min(100, Math.floor(view.progress * 100)));
        brewing.progress.setAttribute("aria-valuenow", String(percent));
        brewing.fill.style.width = `${percent}%`;
        setText(brewing.status, `${view.brewing
          ? `Brewing: ${view.elapsedSeconds.toFixed(1)} / ${view.durationSeconds}s`
          : "Ready for bottles and a matching ingredient"} · ${view.fuelOperations} fuel uses`);
      } else {
        const preview = view.preview;
        const affordable = view.gameplay.mode === "creative" ||
          view.experience.level >= (preview?.levelCost ?? 0);
        panel.output.update(preview?.ok ? preview.output : null, {
          disabled: !preview?.ok || !affordable,
        });
        panel.cost.dataset.state = preview?.ok && affordable ? "ready" : "error";
        setText(panel.cost, !preview?.ok ? progressionMessage(preview?.reason) :
          view.kind === "smithing" ? "Consumes one template and one ingot. No XP cost." :
            `Cost: ${preview.levelCost} level${preview.levelCost === 1 ? "" : "s"} · ${preview.rightConsumed} material${preview.rightConsumed === 1 ? "" : "s"}${affordable ? "" : " · Not enough levels"}`);
      }
    },
  };
}
