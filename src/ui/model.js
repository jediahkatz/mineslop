import { matchesIngredient } from "../crafting.js";
import { FUEL_ITEMS, getItem } from "../items.js";

export const DIMENSIONS = ["overworld", "nether", "end"];

export const dimensionName = (dimension) =>
  ({ overworld: "Overworld", nether: "Nether", end: "The End" })[dimension] ||
  String(dimension || "Overworld");

export const heldItemLabel = (item) => item?.name || "";

export const stationName = (station) =>
  Array.isArray(station)
    ? station.map(stationName).join(" + ")
    : { hand: "Hand crafting", table: "Crafting table", furnace: "Furnace" }[
        station
      ] || String(station || "Hand crafting");

export function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

export function normalizeHotbar(ids = []) {
  return Array.from({ length: 9 }, (_, index) => {
    const id = Number(ids?.[index]);
    return Number.isInteger(id) && id > 0 ? id : 0;
  });
}

export function itemCount(state, id) {
  if (!id) return 0;
  if (Array.isArray(state.slots))
    return state.slots.reduce(
      (total, stack) =>
        total +
        (stack?.id === id
          ? Math.max(0, Math.floor(Number(stack.count) || 0))
          : 0),
      0
    );
  if (state.counts)
    return Math.max(0, Math.floor(Number(state.counts[id]) || 0));
  if (state.inventory instanceof Map)
    return Math.max(0, Math.floor(Number(state.inventory.get(id)) || 0));
  const entry = Array.isArray(state.inventory)
    ? state.inventory.find((item) => Number(item.id) === Number(id))
    : undefined;
  return Math.max(0, Math.floor(Number(entry?.count) || 0));
}

export function catalogItems(catalog) {
  const entries =
    catalog instanceof Map
      ? [...catalog.values()]
      : Object.values(catalog ?? {});
  return entries.filter(
    (item) => item && Number.isInteger(item.id) && item.id > 0
  );
}

export function itemCategory(item) {
  if (
    item.tool ||
    item.weapon ||
    item.kind === "equipment" ||
    /pickaxe|shovel|sword|axe|bow/i.test(item.name)
  )
    return "tools";
  if (foodValue(item) > 0) return "food";
  if (
    item.kind === "block" ||
    (item.kind === undefined && getItem(item.id)?.kind === "block")
  )
    return "blocks";
  return "materials";
}

export function foodValue(item) {
  if (!item) return 0;
  return (
    Number(item.food?.hunger ?? item.food ?? item.hunger ?? item.nutrition) || 0
  );
}

export function filterItems(
  items,
  { state = {}, creative = false, query = "", category = "all" } = {}
) {
  const search = query.trim().toLowerCase();
  return items.filter((item) => {
    if (item.hidden || (!creative && itemCount(state, item.id) < 1))
      return false;
    const group = itemCategory(item);
    return (
      (category === "all" || group === category) &&
      (!search ||
        `${item.name} ${group} ${item.category || ""}`
          .toLowerCase()
          .includes(search))
    );
  });
}

export function durabilityView(item, value) {
  if (!item || value === undefined || value === null) return null;
  const maximum = Number(
    value?.max ??
      value?.maximum ??
      item.maxDurability ??
      item.durability ??
      item.tool?.durability
  );
  const remaining = Number(
    value?.remaining ?? value?.current ?? value?.value ?? value
  );
  if (!Number.isFinite(maximum) || maximum <= 0 || !Number.isFinite(remaining))
    return null;
  return {
    remaining: clamp(remaining, 0, maximum),
    maximum,
    fraction: clamp(remaining / maximum),
  };
}

function materialEntries(materials) {
  if (!materials) return [];
  const entries = Array.isArray(materials)
    ? materials
    : Object.entries(materials).map(([id, count]) => ({
        id: Number(id),
        count,
      }));
  return entries.map((entry) => {
    if (Array.isArray(entry))
      return { id: Number(entry[0]), count: Number(entry[1]) };
    return {
      id: Number(entry.id ?? entry.itemId ?? entry.item),
      count: Number(entry.count ?? entry.amount ?? 1),
      name: entry.name,
      alternatives: entry.alternatives || [],
      ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    };
  });
}

/** Canonical slots use the same eligibility policy as crafting, including fuel. */
function recipeResources(state) {
  const slots = Array.isArray(state.slots) ? state.slots : null;
  const reserved = new Map();
  const matches = (stack, id, input) =>
    matchesIngredient(stack, { ...input, id, alternatives: [] });
  const available = (id, input = {}) => {
    if (slots)
      return slots.reduce(
        (sum, stack, index) =>
          sum +
          (matches(stack, id, input)
            ? Math.max(0, stack.count - (reserved.get(index) ?? 0))
            : 0),
        0
      );
    // Old aggregate snapshots contain plain items, not evidence of exact data.
    if (
      input.data !== undefined ||
      ![undefined, "plain", "any"].includes(input.metadata)
    )
      return 0;
    return Math.max(0, itemCount(state, id) - (reserved.get(id) ?? 0));
  };
  const reserve = (id, amount, input = {}) => {
    if (!slots) {
      reserved.set(id, (reserved.get(id) ?? 0) + amount);
      return;
    }
    for (let index = 0; index < slots.length && amount > 0; index++) {
      const stack = slots[index];
      if (!matches(stack, id, input)) continue;
      const used = reserved.get(index) ?? 0;
      const take = Math.min(amount, stack.count - used);
      reserved.set(index, used + take);
      amount -= take;
    }
  };
  return { available, reserve };
}

export function recipeView(
  recipe,
  state = {},
  station = state.station || "hand"
) {
  const output = recipe.output ?? recipe.result;
  const outputId = Number(
    typeof output === "number" ? output : (output?.id ?? output?.itemId)
  );
  const outputCount = Number(
    output?.count ?? output?.amount ?? recipe.count ?? 1
  );
  const ingredients = materialEntries(recipe.ingredients ?? recipe.inputs);
  const { available, reserve } = recipeResources(state);
  let affordable = true;
  const costs = ingredients.map((cost) => {
    const choices = [...new Set([cost.id, ...(cost.alternatives || [])])];
    const have = choices.reduce((total, id) => total + available(id, cost), 0);
    let needed = cost.count;
    for (const id of choices) {
      const amount = Math.min(needed, available(id, cost));
      reserve(id, amount, cost);
      needed -= amount;
    }
    if (needed > 0) affordable = false;
    return { ...cost, have, fuel: false };
  });
  const duration = Number(recipe.duration ?? recipe.time) || 0;
  const storedFuel = Math.max(0, Number(state.fuelTime) || 0);
  let neededFuel = Math.max(0, duration - storedFuel);
  if (Array.isArray(recipe.fuel)) {
    for (const { id, count } of recipe.fuel) {
      const have = available(id);
      costs.push({ id, count, have, fuel: true });
      reserve(id, Math.min(count, have));
      neededFuel = Math.max(
        0,
        neededFuel - Math.min(count, have) * (getItem(id)?.fuel || 0)
      );
    }
  } else {
    for (const id of duration > 0 ? FUEL_ITEMS : []) {
      const burnTime = getItem(id).fuel;
      const have = available(id);
      const count = Math.min(Math.ceil(neededFuel / burnTime), have);
      if (count > 0) costs.push({ id, count, have, fuel: true });
      reserve(id, count);
      neededFuel = Math.max(0, neededFuel - count * burnTime);
    }
  }
  const required = recipe.station || "hand";
  const valid =
    Number.isInteger(outputId) &&
    outputId > 0 &&
    outputCount > 0 &&
    ingredients.length > 0 &&
    costs.every((cost) => cost.id > 0 && cost.count > 0);
  const atStation =
    required === "hand" ||
    (Array.isArray(station)
      ? station.includes(required)
      : required === station);
  const creative = state.mode === "creative";
  const canCraft =
    !state.dead &&
    valid &&
    (typeof recipe.canCraft === "boolean"
      ? recipe.canCraft && (creative || (affordable && neededFuel === 0))
      : creative || (affordable && atStation && neededFuel === 0));
  let reason = "";
  if (!valid) reason = "Recipe unavailable";
  else if (state.dead) reason = "Respawn to craft";
  else if (!canCraft && recipe.reason)
    reason =
      {
        station: `Open a ${stationName(required).toLowerCase()}`,
        ingredients: "More materials needed",
        fuel: "Add coal, wood, sticks or bamboo for fuel",
        inventory_full: "Make room in your backpack",
        queue_full: "Furnace queue is full",
        dead: "Respawn to craft",
      }[recipe.reason] || recipe.reason;
  else if (!creative && !atStation && recipe.canCraft !== true)
    reason = `Open a ${stationName(required).toLowerCase()}`;
  else if (!canCraft)
    reason = !affordable
      ? "More materials needed"
      : neededFuel > 0
        ? "Add coal, wood, sticks or bamboo for fuel"
        : "Not available here";
  return {
    outputId,
    outputCount,
    costs,
    required,
    canCraft,
    reason,
    duration,
    fuel:
      duration > 0
        ? { stored: storedFuel, needed: duration, missing: neededFuel }
        : null,
  };
}

export function craftingJobs(crafting) {
  const jobs = Array.isArray(crafting)
    ? crafting
    : (crafting?.queue ?? (crafting?.recipeId ? [crafting] : []));
  return jobs.map((job) => {
    const duration = Number(job.duration ?? job.totalTime ?? job.total) || 0;
    const remaining = Number(job.remaining ?? job.timeRemaining);
    const elapsed = Number(job.elapsed) || 0;
    const progress = Number.isFinite(Number(job.progress))
      ? clamp(job.progress)
      : duration > 0
        ? clamp(
            (Number.isFinite(remaining) ? duration - remaining : elapsed) /
              duration
          )
        : 0;
    return {
      ...job,
      progress,
      remaining: Number.isFinite(remaining)
        ? Math.max(0, remaining)
        : Math.max(0, duration - elapsed),
    };
  });
}

export function filterBiomes(
  biomes,
  { query = "", dimension = "all", category = "all" } = {}
) {
  const search = query.trim().toLowerCase().replaceAll("_", " ");
  return DIMENSIONS.map((id) => ({
    id,
    name: dimensionName(id),
    biomes: biomes.filter(
      (biome) =>
        biome.dimension === id &&
        (dimension === "all" || dimension === id) &&
        (category === "all" || category === biome.category) &&
        (!search ||
          `${biome.id} ${biome.name} ${biome.category} ${biome.description}`
            .toLowerCase()
            .replaceAll("_", " ")
            .includes(search))
    ),
  })).filter((group) => group.biomes.length > 0);
}

export function storageView(status) {
  if (typeof status === "string") {
    return {
      message: status,
      state:
        /error|failed|could not|unavailable|full|export to keep your progress/i.test(
          status
        )
          ? "error"
          : "idle",
    };
  }
  if (!status)
    return {
      message: "Saves stay on this device. Export a backup to keep.",
      state: "idle",
    };
  return {
    message: String(
      status.message ??
        status.error?.message ??
        status.error ??
        status.label ??
        ""
    ),
    state:
      status.error || status.ok === false
        ? "error"
        : (status.state ?? status.status ?? "idle"),
  };
}

export function createOverlayNotifier(onChange) {
  let open = false;
  return (activeOverlay, dead) => {
    const next = Boolean(activeOverlay || dead);
    if (open === next) return;
    open = next;
    onChange?.(open);
  };
}
