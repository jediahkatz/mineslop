import { TRADER_LEVEL_THRESHOLDS } from "../trading-offers.js";
import { element, setText } from "./dom.js";
import { stackDescription, stackMetadataDetails } from "./slot-model.js";
import { createStackSlot } from "./slots.js";

const levels = ["", "Novice", "Apprentice", "Journeyman", "Expert", "Master"];

/** Finite saved offers, not Creative catalog copies or a separate trade escrow. */
export function createProgressionTradingPanel(parent, { listen, dispatch }) {
  const node = element("section", "progression-trading");
  node.hidden = true;
  const rank = element("p", "progression-trade-rank");
  const progress = element("div", "progression-trade-progress");
  progress.setAttribute("role", "progressbar");
  progress.setAttribute("aria-label", "Villager experience");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  const fill = element("span");
  progress.append(fill);
  const offers = element("div", "progression-trade-offers");
  offers.setAttribute("role", "group");
  offers.setAttribute("aria-label", "Available trades");
  const restocks = element("p", "progression-trade-restocks");
  const note = element("p", "progression-note",
    "Trade uses exact, unmodified payment from your backpack. Results and XP arrive there in the same transaction.");
  node.append(rank, progress, offers, restocks, note);
  parent.append(node);
  const rows = new Map();
  // One lifetime listener: reopening traders must not retain detached rows on
  // the overlay's AbortSignal until the whole application is disposed.
  listen(offers, "click", (event) => {
    const button = event.target?.closest?.("[data-offer-id]");
    if (node.hidden || !button || !offers.contains(button) || button.disabled) return;
    dispatch({ type: "trade", offerId: button.dataset.offerId, count: 1 });
  });

  const create = (id) => {
    const button = element("button", "progression-trade-offer");
    button.type = "button";
    button.dataset.offerId = id;
    const exchange = element("span", "progression-trade-exchange");
    const inputs = [0, 1].map(() => createStackSlot({
      tag: "span", label: "Trade payment", interactive: false,
    }));
    const plus = element("span", "progression-plus", "+");
    const arrow = element("span", "progression-arrow", "➜");
    const output = createStackSlot({ tag: "span", label: "Trade result", interactive: false });
    const stock = element("span", "progression-trade-stock");
    const detail = element("span", "progression-trade-detail");
    exchange.append(inputs[0].node, plus, inputs[1].node, arrow, output.node, stock);
    button.append(exchange, detail);
    offers.append(button);
    const row = { button, inputs, plus, output, stock, detail };
    rows.set(id, row);
    return row;
  };

  return {
    reset() {
      rows.clear();
      offers.replaceChildren();
    },
    update(view) {
      node.hidden = view.kind !== "trading";
      if (node.hidden) return;
      const lower = TRADER_LEVEL_THRESHOLDS[view.level - 1];
      const upper = TRADER_LEVEL_THRESHOLDS[view.level];
      const percent = upper === undefined ? 100 :
        Math.max(0, Math.min(100, Math.floor((view.xp - lower) / (upper - lower) * 100)));
      setText(rank, `${levels[view.level]} · ${view.xp} villager XP`);
      progress.setAttribute("aria-valuenow", String(percent));
      fill.style.width = `${percent}%`;
      const ids = new Set(view.offers.map((offer) => offer.id));
      for (const [id, row] of rows)
        if (!ids.has(id)) { row.button.remove(); rows.delete(id); }
      for (const offer of view.offers) {
        const row = rows.get(offer.id) ?? create(offer.id);
        row.inputs.forEach((input, index) => {
          input.node.hidden = !offer.inputs[index];
          input.update(offer.inputs[index] ?? null);
        });
        row.plus.hidden = offer.inputs.length < 2;
        row.output.update(offer.output);
        row.button.disabled = offer.remaining < 1;
        setText(row.stock, `${offer.remaining} / ${offer.maxUses}`);
        setText(row.detail, stackMetadataDetails(offer.output.data).join(" · ") ||
          `+${offer.playerXp} player XP · +${offer.xp} villager XP`);
        const description = `${offer.inputs.map((stack) => stackDescription(stack)).join(" + ")} → ${stackDescription(offer.output)}. ${offer.remaining} trades remaining.`;
        row.button.setAttribute("aria-label", description);
        row.button.title = description;
      }
      setText(restocks, `Restocks today: ${view.restocks} / 2. Requires actual work at an accessible jobsite.`);
    },
  };
}
