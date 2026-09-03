import { HOTBAR } from "./blocks.js";
import {
  consumeCraftingInputs,
  matchCraftingRecipe,
  planRecipeFill,
  validCraftingSize,
} from "./crafting.js";
import { experienceState, isValidExperience } from "./experience.js";
import {
  fitsQueuedOutputs,
  freshTimers,
  inventoryProjections,
  MAX_CRAFT_QUEUE,
  normalizeCraftQueue,
  parseGameplaySave,
  TIMER_LIMITS,
} from "./gameplay-save.js";
import { prepareBowShot, prepareHandCost } from "./gameplay-hand-actions.js";
import {
  MINING_TOOLS,
  miningDuration,
  prepareHarvest,
} from "./gameplay-harvest.js";
import {
  applySlotAction,
  armorPoints,
  BAG_INDICES,
  cloneOwnedInventory,
  countPlainSlots,
  countSlots,
  durabilitySlots,
  EQUIPMENT_SLOTS,
  emptyOwnedInventory,
  HOTBAR_INDICES,
  INVENTORY_SLOTS,
  ownedSlot,
  returnInputs,
  takeItem,
  validOwnedInventory,
} from "./inventory-domain.js";
import {
  cloneSlots,
  cloneStack,
  insertStack,
  isMergeable,
  isValidStack,
  splitStackPayload,
  splitStacks,
  takeStack,
} from "./inventory-slots.js";
import { sameStackKind } from "./item-stack-data.js";
import { FUEL_ITEMS, getItem, ITEM } from "./items.js";
import { getRecipe, RECIPES } from "./recipes.js";
import { encodedBytes } from "./save-budget.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";

export { INVENTORY_SLOTS, MAX_CRAFT_QUEUE };
export { TransactionInvariantError } from "./transactions.js";

// Bounded vitals/timers, 16 paid jobs, palette, XP and compatibility projections.
// Variable stack records are reserved separately, including UTF-8 metadata.
export const GAMEPLAY_FIXED_RESERVED_BYTES = 8192;

const MODES = new Set(["survival", "creative"]);
const STATIONS = new Set(["hand", "table", "furnace"]);
const EPSILON = 1e-9;
const noOp = () => {};
const validCount = (count) => Number.isSafeInteger(count) && count > 0;
const validItem = (id) =>
  Number.isInteger(id) && id > 0 && getItem(id) !== null;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const synchronous = (value) =>
  typeof value === "function" &&
  Object.prototype.toString.call(value) === "[object Function]";
const handName = (hand) =>
  hand === "off" ? "offhand" : ["main", "offhand"].includes(hand) ? hand : null;
const VITAL_FIELDS = [
  "health",
  "hunger",
  "air",
  "saturation",
  "exhaustion",
  "dead",
  "deathCause",
];
const stackRecords = (owned) => [
  ...owned.slots,
  owned.cursor,
  owned.offhand,
  ...EQUIPMENT_SLOTS.map((slot) => owned.equipment[slot]),
  ...owned.craftingGrid,
];
const sameStackValue = (a, b) =>
  a === b ||
  Boolean(
    a &&
      b &&
      a.count === b.count &&
      a.durability === b.durability &&
      sameStackKind(a, b)
  );
const reservationBytes = (records) =>
  GAMEPLAY_FIXED_RESERVED_BYTES +
  records.reduce((sum, bytes) => sum + bytes, 0);

function validVitals(state, mode) {
  return (
    ["health", "hunger", "air", "saturation"].every(
      (key) =>
        Number.isFinite(state[key]) && state[key] >= 0 && state[key] <= 20
    ) &&
    Number.isFinite(state.exhaustion) &&
    state.exhaustion >= 0 &&
    state.exhaustion < 4 &&
    typeof state.dead === "boolean" &&
    state.dead === (state.health === 0) &&
    (state.deathCause === null ||
      (state.dead &&
        typeof state.deathCause === "string" &&
        state.deathCause.length <= 80)) &&
    (mode !== "creative" ||
      (!state.dead &&
        state.health === 20 &&
        state.hunger === 20 &&
        state.air === 20)) &&
    Object.entries(TIMER_LIMITS).every(
      ([key, limit]) =>
        Number.isFinite(state.timers?.[key]) &&
        state.timers[key] >= 0 &&
        state.timers[key] < limit
    )
  );
}

function stationAvailable(required, supplied) {
  const stations = Array.isArray(supplied) ? supplied : [supplied];
  return (
    stations.length > 0 &&
    Array.from(stations).every((station) => STATIONS.has(station)) &&
    (required === "hand" || stations.includes(required))
  );
}

function craftFailureMessage(reason, recipe) {
  return (
    {
      unknown_recipe: "Unknown recipe",
      dead: "Respawn before crafting",
      station: `Requires a nearby ${recipe?.station === "table" ? "crafting table" : "furnace"}`,
      ingredients: "Not enough ingredients",
      fuel: "The furnace needs coal, wood, sticks, or bamboo",
      inventory_full: "Backpack full — make room for the result",
      queue_full: "The furnace queue is full",
    }[reason] ?? ""
  );
}

/**
 * World-independent survival state. The caller owns hit cooldowns, proximity,
 * successful world edits, and adding the drops returned by harvest().
 * onHurt({previousHealth,health,damage,dead}) is a visual-only post-commit event,
 * independent of onChange/notify:false. Loading a health snapshot is not a hit.
 */
export class Gameplay {
  constructor({
    mode = "survival",
    onToast = noOp,
    onDeath = noOp,
    onChange = noOp,
    onHurt = noOp,
    random = Math.random,
    coordinator = new TransactionCoordinator(),
    context,
    allowOverBudget = false,
  } = {}) {
    if (!MODES.has(mode)) throw new RangeError("Unknown game mode");
    if (typeof allowOverBudget !== "boolean")
      throw new RangeError("Invalid inventory admission policy");
    this.coordinator = coordinator;
    this.context = context;
    this.mode = mode;
    this.onToast = onToast;
    this.onDeath = onDeath;
    this.onChange = onChange;
    this.onHurt = onHurt;
    this.random = random;
    this.health = 20;
    this.hunger = 20;
    this.air = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.dead = false;
    this.deathCause = null;
    this._owned = emptyOwnedInventory();
    this._owned.slots[0] = { id: ITEM.APPLE, count: 4 };
    this._creativeHotbar = [...HOTBAR];
    this._creativeSelected = 0;
    this._survivalSelected = 0;
    this._inventoryBusy = false;
    this._queue = [];
    this._timers = freshTimers();
    this._changeClock = 0;
    this._revision = 0;
    this._handRevisions = { main: 0, offhand: 0 };
    this._disposed = false;
    this._recordBytes = stackRecords(this._owned).map(encodedBytes);
    this._bytes = reservationBytes(this._recordBytes);
    // Only a preflight-validated staged import may opt into oversized admission.
    if (!coordinator.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Cannot register inventory reservation");
  }

  get revision() {
    return this._revision;
  }

  get reservedBytes() {
    return this._bytes;
  }

  // Compatibility facades are detached projections, never mutable authorities.
  get inventory() {
    return countSlots(this._owned.slots);
  }
  get _durability() {
    return durabilitySlots(this._owned.slots);
  }
  get _fuelTime() {
    return this._owned.fuelTime;
  }
  get _survivalHotbar() {
    return this._owned.slots.slice(0, 9).map((stack) => stack?.id ?? 0);
  }
  get hotbar() {
    return this.mode === "creative"
      ? [...this._creativeHotbar]
      : this._survivalHotbar;
  }
  get selected() {
    return this.mode === "creative"
      ? this._creativeSelected
      : this._survivalSelected;
  }
  get slots() {
    return cloneSlots(this._owned.slots, this.context);
  }
  get cursor() {
    return cloneStack(this._owned.cursor, this.context);
  }
  get offhand() {
    return cloneStack(this._owned.offhand, this.context);
  }
  get equipment() {
    return cloneOwnedInventory(this._owned, this.context).equipment;
  }

  get selectedItem() {
    return getItem(this.getHandStack()?.id);
  }

  setMode(mode) {
    if (this._disposed || this._inventoryBusy || !MODES.has(mode)) return false;
    if (mode === this.mode) return true;
    this.mode = mode;
    this.health = this.hunger = this.air = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.dead = false;
    this.deathCause = null;
    this._timers = freshTimers();
    this._revision++;
    this._handRevisions.main++;
    this._handRevisions.offhand++;
    this._emit();
    return true;
  }

  select(index) {
    if (
      this._disposed ||
      this._inventoryBusy ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 8
    )
      return false;
    if (this.selected !== index) {
      this._revision++;
      this._handRevisions.main++;
    }
    if (this.mode === "creative") this._creativeSelected = index;
    else this._survivalSelected = index;
    this._emit();
    return true;
  }

  assignSlot(index, id) {
    const participant = this.prepareAssignSlot(index, id);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  /** Prepared palette selection/owned-slot swap, for joint world item use. */
  prepareAssignSlot(index, id, options = {}) {
    if (
      !object(options) ||
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 8 ||
      (id !== 0 && !validItem(id))
    )
      return null;
    const { notify = true } = options;
    return this._prepareState(
      (state) => {
        if (this.mode === "creative") {
          state.creativeHotbar[index] = id;
          return true;
        }
        const draft = state.owned;
        if (draft.slots[index]?.id === id) return true;
        if (id === 0) {
          const stack = takeStack(draft.slots, index);
          return (
            !stack ||
            !insertStack(
              draft.slots,
              stack,
              [...BAG_INDICES, ...HOTBAR_INDICES].filter((i) => i !== index)
            )
          );
        }
        const source = draft.slots.findIndex((stack) => stack?.id === id);
        if (source < 0) return false;
        [draft.slots[source], draft.slots[index]] = [
          draft.slots[index],
          draft.slots[source],
        ];
        return true;
      },
      { notify }
    );
  }

  // These counts cover the 36 finite slots, even in Creative. Cursor, offhand,
  // equipment and crafting escrow are exposed separately and cannot be spent by
  // an ID-based craft/consume while another screen is holding them.
  count(id) {
    return this.inventory.get(id) ?? 0;
  }

  countPlain(id) {
    return countPlainSlots(this._owned.slots).get(id) ?? 0;
  }

  // All-or-nothing: callers can retain a world pickup when this returns false.
  add(id, count = 1, options = {}) {
    // This is deliberately a plain-data adapter, not a metadata-stripping API.
    if (!object(options) || options.data !== undefined) return false;
    const stacks = splitStacks(id, count, options.durability);
    if (!stacks) return false;
    return this.inventoryTransaction((draft) =>
      stacks.every((stack) => !insertStack(draft.slots, stack))
    );
  }

  prepareAddStack(stack, options = {}) {
    if (!isValidStack(stack, this.context)) return null;
    const incoming = cloneStack(stack, this.context);
    return this.prepareInventory(
      (draft) => insertStack(draft.slots, incoming) === null,
      options
    );
  }

  addStack(stack, options = {}) {
    const participant = this.prepareAddStack(stack, options);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  consume(id, count = 1) {
    if (
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !validItem(id) ||
      !validCount(count)
    )
      return false;
    if (this.mode === "creative") return true;
    return this.inventoryTransaction((draft) =>
      takeItem(draft.slots, id, count, this.selected)
    );
  }

  // Legacy internal wear call targets the held instance, never an ID FIFO.
  _wear(id, amount = 1) {
    if (this.mode === "creative" || this._owned.slots[this.selected]?.id !== id)
      return false;
    return this.wearHand("main", amount);
  }

  /**
   * Prepare detached {slots[36],cursor,offhand,equipment,craftingGrid[9],
   * craftingSize,experienceTotal,fuelTime}. edit MUST synchronously return true.
   * No ownership, reservations or observers change until coordinator.commit.
   * fuelTime is unused legacy prepaid credit, not a second fuel-item payment.
   */
  prepareInventory(edit, options = {}) {
    if (!object(options) || !synchronous(edit)) return null;
    const { notify = true } = options;
    return this._prepareState((state) => edit(state.owned), { notify });
  }

  /** Internal single-owner state edit; all publication is prevalidated installs. */
  _prepareState(edit, options = {}) {
    if (!object(options)) return null;
    const {
      notify = true,
      allowDead = false,
      selfUseHands = [],
      completeUseHands = [],
    } = options;
    if (
      this._disposed ||
      this._inventoryBusy ||
      (this.dead && !allowDead) ||
      !synchronous(edit) ||
      typeof notify !== "boolean"
    )
      return null;
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const coordinator = this.coordinator;
    const context = this.context;
    const seed = context?.seed;
    const generatorVersion = context?.generatorVersion;
    const specForDimension = context?.specForDimension;
    const mode = this.mode;
    const creativeSelected = this._creativeSelected;
    const survivalSelected = this._survivalSelected;
    const selected = this.selected;
    const previous = {
      owned: this._owned,
      queue: this._queue,
      creativeHotbar: this._creativeHotbar,
      timers: this._timers,
      ...Object.fromEntries(VITAL_FIELDS.map((key) => [key, this[key]])),
    };
    this._inventoryBusy = true;
    try {
      const draft = {
        ...previous,
        owned: cloneOwnedInventory(previous.owned, context),
        queue: previous.queue.map((job) => ({ ...job })),
        creativeHotbar: [...previous.creativeHotbar],
        timers: { ...previous.timers },
      };
      const handReferences = {
        main: draft.owned.slots[selected],
        offhand: draft.owned.offhand,
      };
      if (edit(draft) !== true) return null;
      const queue = normalizeCraftQueue(draft.queue);
      if (
        !validOwnedInventory(draft.owned, context) ||
        !queue ||
        !fitsQueuedOutputs(draft.owned.slots, queue, context) ||
        !Array.isArray(draft.creativeHotbar) ||
        draft.creativeHotbar.length !== 9 ||
        !Array.from(draft.creativeHotbar).every(
          (id) => id === 0 || validItem(id)
        ) ||
        !validVitals(draft, mode)
      )
        return null;

      const changedHands = ["main", "offhand"].filter((hand) => {
        // Retire accepted releases before observers, even with no Creative debit.
        if (completeUseHands.includes(hand)) return true;
        const before =
          hand === "main"
            ? previous.owned.slots[selected]
            : previous.owned.offhand;
        const after =
          hand === "main" ? draft.owned.slots[selected] : draft.owned.offhand;
        const continuing =
          selfUseHands.includes(hand) &&
          before &&
          after &&
          sameStackKind(before, after, context) &&
          after.count <= before.count &&
          (before.durability === undefined ||
            after.durability <= before.durability);
        return (
          ((handReferences[hand] !== after || !sameStackValue(before, after)) &&
            !continuing) ||
          (hand === "main" &&
            mode === "creative" &&
            previous.creativeHotbar[selected] !==
              draft.creativeHotbar[selected])
        );
      });
      // Clone again: neither edit's references nor participant users own next.
      const next = {
        owned: cloneOwnedInventory(draft.owned, context),
        queue,
        creativeHotbar: [...draft.creativeHotbar],
        timers: Object.fromEntries(
          Object.keys(TIMER_LIMITS).map((key) => [key, draft.timers[key]])
        ),
        ...Object.fromEntries(VITAL_FIELDS.map((key) => [key, draft[key]])),
      };
      const oldRecords = stackRecords(previous.owned);
      const recordBytes = stackRecords(next.owned).map((stack, index) =>
        sameStackValue(stack, oldRecords[index])
          ? this._recordBytes[index]
          : encodedBytes(stack)
      );
      const afterBytes = reservationBytes(recordBytes);
      // Every live health edit (including quiet status/pearl transactions)
      // reports only its committed loss. Loading/respawning never enters here.
      const hurt =
        mode !== "creative" && next.health < previous.health
          ? Object.freeze({
              previousHealth: previous.health,
              health: next.health,
              damage: previous.health - next.health,
              dead: next.dead,
            })
          : null;
      let used = false;
      let notified = false;
      return Object.freeze({
        owner: this,
        beforeBytes,
        afterBytes,
        validate: () =>
          !used &&
          !this._disposed &&
          !this._inventoryBusy &&
          this._revision === revision &&
          this._owned === previous.owned &&
          this._queue === previous.queue &&
          this._creativeHotbar === previous.creativeHotbar &&
          this._timers === previous.timers &&
          VITAL_FIELDS.every((key) => this[key] === previous[key]) &&
          this.mode === mode &&
          this._creativeSelected === creativeSelected &&
          this._survivalSelected === survivalSelected &&
          this.coordinator === coordinator &&
          this._bytes === beforeBytes &&
          coordinator.usage(this) === beforeBytes &&
          this.context === context &&
          context?.seed === seed &&
          context?.generatorVersion === generatorVersion &&
          context?.specForDimension === specForDimension,
        publish: () => {
          used = true;
          this._owned = next.owned;
          this._queue = next.queue;
          this._creativeHotbar = next.creativeHotbar;
          this._timers = next.timers;
          for (const key of VITAL_FIELDS) this[key] = next[key];
          this._recordBytes = recordBytes;
          this._bytes = afterBytes;
          this._revision++;
          for (const hand of changedHands) this._handRevisions[hand]++;
        },
        ...(notify || hurt
          ? {
              notify: () => {
                if (!used || notified) return;
                notified = true;
                // notify:false suppresses inventory/HUD snapshots, not hurt.
                // The coordinator observes errors after ALL state/reservations
                // publish; failed visuals cannot reject damage or skip onChange.
                try {
                  if (hurt) this.onHurt(hurt);
                } finally {
                  if (notify) this._emit();
                }
              },
            }
          : {}),
      });
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this._inventoryBusy = false;
    }
  }

  /**
   * Compose prepared ownership participants on this coordinator. New callers
   * must use participants, not commit. Fatal publication invariants propagate.
   */
  inventoryTransaction(edit, options = {}) {
    if (!object(options)) return false;
    const { participants = [], notify = true, commit } = options;
    if (
      !Array.isArray(participants) ||
      (commit !== undefined && (!synchronous(commit) || participants.length))
    )
      return false;
    const participant = this.prepareInventory(edit, { notify });
    if (!participant) return false;
    if (commit !== undefined)
      return this._legacyInventoryCommit(participant, commit);
    return this.coordinator.commit([participant, ...participants]).ok;
  }

  /**
   * @deprecated Isolated old callers only; never mix with prepared participants.
   * commit must veto/throw BEFORE writing and must not notify or alter this
   * coordinator. Capacity is checked first. After acceptance a failed install
   * is fatal, never an ordinary refusal that could orphan the external write.
   */
  _legacyInventoryCommit(participant, commit) {
    if (
      !participant.validate() ||
      !this.coordinator.budget.canCommit([participant])
    )
      return false;
    this._inventoryBusy = true;
    try {
      const accepted = commit();
      if (accepted === false) return false;
      if (accepted && typeof accepted.then === "function")
        throw new TransactionInvariantError(
          "legacy commit returned asynchronous work"
        );
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return false;
    } finally {
      this._inventoryBusy = false;
    }
    if (!this.coordinator.commit([participant]).ok)
      throw new TransactionInvariantError(
        "legacy external write invalidated its inventory source"
      );
    return true;
  }

  _commitWithDrops(participant, drops, prepareDrops, participants = []) {
    if (!participant || !Array.isArray(participants)) return false;
    const combined = [participant, ...participants];
    if (drops.length) {
      if (!synchronous(prepareDrops)) return false;
      this._inventoryBusy = true;
      let drop;
      try {
        drop = prepareDrops(cloneSlots(drops, this.context));
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        return false;
      } finally {
        this._inventoryBusy = false;
      }
      if (!drop) return false;
      combined.push(drop);
    }
    return this.coordinator.commit(combined).ok;
  }

  notifyInventoryChange() {
    if (this._disposed || this._inventoryBusy) return false;
    this._emit();
    return true;
  }

  /**
   * Creative main-hand stacks are a read-only unlimited palette projection, not
   * owned copies. All cursors, offhands, grids and equipment are always finite.
   * No cursor-origin flag is needed: only explicit creativePick may copy catalog
   * items into ownership; assignSlot/pickBlock/legacy craft only change a palette.
   */
  getHandStack(hand = "main") {
    hand = handName(hand);
    if (hand === "offhand")
      return cloneStack(this._owned.offhand, this.context);
    if (hand !== "main") return null;
    if (this.mode !== "creative")
      return cloneStack(this._owned.slots[this.selected], this.context);
    const id = this._creativeHotbar[this.selected];
    const item = id ? getItem(id) : null;
    return item ? splitStacks(id, item.stackSize)[0] : null;
  }

  /** Slot/selection/completed-use identity, separate from ongoing count/wear. */
  getHandRevision(hand = "main") {
    return this._handRevisions[handName(hand)] ?? null;
  }

  /** Prepared costs for a joint World/held-item transaction. */
  prepareHandCost(hand, options) {
    return prepareHandCost(this, handName(hand), options);
  }

  prepareBowShot(shot, options) {
    return prepareBowShot(this, shot, options);
  }

  consumeHand(hand = "main", count = 1) {
    hand = handName(hand);
    if (
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !hand ||
      !validCount(count)
    )
      return false;
    const stack = this.getHandStack(hand);
    if (!stack || stack.count < count) return false;
    if (this.mode === "creative") return true;
    const participant = this._prepareState(
      ({ owned: draft }) => {
        const slot = ownedSlot(
          draft,
          hand === "main" ? "inventory" : "offhand",
          hand === "main" ? this.selected : 0
        );
        const cell = [slot.get()];
        takeStack(cell, 0, count);
        slot.set(cell[0]);
        return true;
      },
      { selfUseHands: [hand] }
    );
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  _wearSlot(slot, amount) {
    const stack = slot.get();
    if (stack?.durability === undefined) return false;
    const remaining = stack.durability - amount;
    slot.set(remaining > 0 ? { ...stack, durability: remaining } : null);
    return remaining <= 0;
  }

  wearHand(hand = "main", amount = 1) {
    hand = handName(hand);
    const stack = this.getHandStack(hand);
    if (
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !validCount(amount) ||
      !stack?.durability
    )
      return false;
    if (this.mode === "creative") return true;
    let broken = false;
    const participant = this._prepareState(
      ({ owned: draft }) => {
        broken = this._wearSlot(
          ownedSlot(
            draft,
            hand === "main" ? "inventory" : "offhand",
            hand === "main" ? this.selected : 0
          ),
          amount
        );
        return true;
      },
      { selfUseHands: [hand] }
    );
    const ok =
      participant !== null && this.coordinator.commit([participant]).ok;
    if (ok && broken) this.onToast(`${getItem(stack.id).name} broke`);
    return ok;
  }

  eatFromHand(hand = "main") {
    hand = handName(hand);
    const stack = this.getHandStack(hand);
    const food = getItem(stack?.id);
    if (
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !food?.food ||
      this.hunger >= 20
    )
      return false;
    const participant = this._prepareState(
      (state) => {
        const draft = state.owned;
        if (this.mode !== "creative") {
          const slot = ownedSlot(
            draft,
            hand === "main" ? "inventory" : "offhand",
            hand === "main" ? this.selected : 0
          );
          const cell = [slot.get()];
          takeStack(cell, 0, 1);
          slot.set(cell[0]);
        }
        state.hunger = Math.min(20, state.hunger + food.food);
        state.saturation = Math.min(
          state.hunger,
          state.saturation + (food.saturation ?? 0)
        );
        return true;
      },
      { selfUseHands: [hand] }
    );
    const ok =
      participant !== null && this.coordinator.commit([participant]).ok;
    if (ok) this.onToast(`Ate ${food.name.toLowerCase()}`);
    return ok;
  }

  // F/Q cannot turn a virtual Creative palette entry into a finite item. They
  // operate in Creative only when a real copy occupies the selected owned slot.
  _ownedMainMatchesPalette() {
    return (
      this.mode !== "creative" ||
      (this._owned.slots[this.selected]?.id ?? 0) ===
        this._creativeHotbar[this.selected]
    );
  }

  swapHands(options = {}) {
    if (!object(options)) return false;
    const { creativeCopy = false, prepareDrops } = options;
    if (typeof creativeCopy !== "boolean") return false;
    const virtual = !this._ownedMainMatchesPalette();
    if (virtual && !creativeCopy) return false;
    const display = virtual ? this.getHandStack() : null;
    const drops = [];
    const participant = this._prepareState((state) => {
      const draft = state.owned;
      const previous = draft.slots[this.selected];
      draft.slots[this.selected] = draft.offhand;
      draft.offhand = virtual ? cloneStack(display, this.context) : previous;
      if (virtual && previous) {
        const remainder = insertStack(
          draft.slots,
          previous,
          draft.slots
            .map((_, index) => index)
            .filter((index) => index !== this.selected)
        );
        if (remainder) drops.push(remainder);
      }
      if (this.mode === "creative")
        state.creativeHotbar[this.selected] =
          draft.slots[this.selected]?.id ?? 0;
      return true;
    });
    return this._commitWithDrops(participant, drops, prepareDrops);
  }

  pickBlock(id) {
    if (this._disposed || this._inventoryBusy || this.dead || !validItem(id))
      return false;
    if (this.mode === "creative") return this.assignSlot(this.selected, id);
    const index = this._owned.slots.findIndex((stack) => stack?.id === id);
    if (index < 0) return false;
    return index < 9 ? this.select(index) : this.assignSlot(this.selected, id);
  }

  dropSelected(options = {}) {
    if (!object(options) || !this._ownedMainMatchesPalette()) return false;
    const { wholeStack = false, prepareDrops } = options;
    return this.inventoryAction(
      {
        type: "drop",
        area: "inventory",
        index: this.selected,
        wholeStack,
      },
      { prepareDrops }
    ).ok;
  }

  prepareExperience(amount, options = {}) {
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    return this.prepareInventory((draft) => {
      const total = draft.experienceTotal + amount;
      if (!isValidExperience(total)) return false;
      draft.experienceTotal = total;
      return true;
    }, options);
  }

  addExperience(amount, options = {}) {
    const participant = this.prepareExperience(amount, options);
    return participant !== null && this.coordinator.commit([participant]).ok;
  }

  /** Only the parent opening a real table may select 3; proximity never does. */
  setCraftingSize(size, options = {}) {
    if (
      !object(options) ||
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      !validCraftingSize(size)
    )
      return false;
    const { prepareDrops, participants = [], notify = true } = options;
    if (size === this._owned.craftingSize) return true;
    let drops = [];
    const participant = this.prepareInventory(
      (draft) => {
        drops = returnInputs(draft, {
          cursor: false,
          canFit: (slots) =>
            fitsQueuedOutputs(slots, this._queue, this.context),
        });
        draft.craftingSize = size;
        return true;
      },
      { notify }
    );
    return this._commitWithDrops(
      participant,
      drops,
      prepareDrops,
      participants
    );
  }

  _takeCraftResult(draft, shift) {
    let crafted = 0;
    const recipeId = matchCraftingRecipe(draft.craftingGrid, draft.craftingSize)
      ?.recipe.id;
    while (recipeId) {
      const match = matchCraftingRecipe(draft.craftingGrid, draft.craftingSize);
      if (match?.recipe.id !== recipeId) break;
      const next = cloneOwnedInventory(draft, this.context);
      if (shift) {
        if (insertStack(next.slots, match.output)) break;
      } else if (!next.cursor)
        next.cursor = cloneStack(match.output, this.context);
      else if (
        isMergeable(next.cursor, match.output) &&
        next.cursor.count + match.output.count <=
          getItem(match.output.id).stackSize
      )
        next.cursor.count += match.output.count;
      else break;
      consumeCraftingInputs(next.craftingGrid, match);
      if (!fitsQueuedOutputs(next.slots, this._queue, this.context)) break;
      Object.assign(draft, next);
      crafted++;
      if (!shift) break;
    }
    return crafted
      ? { ok: true }
      : { ok: false, message: "No recipe result or no room for it" };
  }

  inventoryAction(action, options = {}) {
    if (!object(action) || !object(options))
      return { ok: false, message: "Invalid inventory action" };
    const { prepareDrops, participants = [], notify = true } = options;
    let result = { ok: false, message: "Inventory is unavailable" };
    let drops = [];
    const paletteChanges = new Map();
    const participant = this._prepareState(
      (state) => {
        const draft = state.owned;
        if (action.type === "takeCraftResult") {
          if (action.shift !== undefined && typeof action.shift !== "boolean")
            return false;
          result = this._takeCraftResult(draft, action.shift === true);
        } else if (action.type === "fillRecipe") {
          const recipe = getRecipe(action.recipeId);
          if (!recipe) return false;
          const plan = planRecipeFill(
            draft.slots,
            draft.craftingGrid,
            draft.craftingSize,
            recipe
          );
          result = {
            ok: plan.ok,
            ...(plan.ok
              ? {}
              : { message: craftFailureMessage(plan.reason, recipe) }),
          };
          if (plan.ok) {
            draft.slots = plan.slots;
            draft.craftingGrid = plan.craftingGrid;
          }
        } else if (action.type === "creativePick") {
          if (
            this.mode !== "creative" ||
            !validItem(action.id) ||
            (action.wholeStack !== undefined &&
              typeof action.wholeStack !== "boolean") ||
            (action.hotbarIndex !== undefined &&
              (!Number.isInteger(action.hotbarIndex) ||
                action.hotbarIndex < 0 ||
                action.hotbarIndex > 8))
          )
            return false;
          const stack = splitStacks(
            action.id,
            action.wholeStack ? getItem(action.id).stackSize : 1
          )[0];
          if (action.hotbarIndex !== undefined) {
            if (insertStack(draft.slots, stack, [action.hotbarIndex]))
              return false;
            paletteChanges.set(action.hotbarIndex, action.id);
          } else {
            const cursor = [draft.cursor];
            if (insertStack(cursor, stack)) return false;
            draft.cursor = cursor[0];
          }
          result = { ok: true };
        } else {
          result = applySlotAction(draft, action, {
            canFit: (slots) =>
              fitsQueuedOutputs(slots, this._queue, this.context),
          });
          drops = result.drops ?? [];
          if (
            result.ok &&
            this.mode === "creative" &&
            action.type !== "close"
          ) {
            // Explicit edits to a finite hotbar slot also select its displayed
            // palette entry. Passive pickups, mode changes, book fill and closing
            // escrow do not rewrite a saved custom Creative palette.
            const targets =
              action.type === "distribute" ? action.targets : [action];
            const indices = targets
              .filter(
                (target) => target.area === "inventory" && target.index < 9
              )
              .map((target) => target.index);
            if (action.type === "swapHotbar") indices.push(action.hotbarIndex);
            for (const index of indices) {
              const before = this._owned.slots[index];
              const after = draft.slots[index];
              if (!sameStackValue(before, after))
                paletteChanges.set(index, after?.id ?? 0);
            }
          }
        }
        for (const [index, id] of paletteChanges)
          state.creativeHotbar[index] = id;
        return result.ok;
      },
      { notify }
    );
    const ok = this._commitWithDrops(
      participant,
      drops,
      prepareDrops,
      participants
    );
    return ok
      ? { ok: true }
      : {
          ok: false,
          message: result.ok
            ? drops.length && participant
              ? "The drop could not be retained; your items are unchanged"
              : "Backpack full — leave room for paid smelting outputs"
            : result.message,
        };
  }

  miningDuration(blockId) {
    return miningDuration(this, blockId);
  }

  /** {participant,drops}; combine with World, retained loot and XP before commit. */
  prepareHarvest(blockId, options) {
    return prepareHarvest(this, blockId, options);
  }

  /** Legacy single-owner adapter. Actual Game mining uses prepareHarvest. */
  harvest(blockId, options) {
    const plan = this.prepareHarvest(blockId, options);
    return plan && this.coordinator.commit([plan.participant]).ok
      ? plan.drops.map((drop) => ({ ...drop }))
      : [];
  }

  canPlace(id, hand) {
    const held = hand === undefined ? null : this.getHandStack(hand);
    return (
      !this._disposed &&
      !this._inventoryBusy &&
      !this.dead &&
      validItem(id) &&
      getItem(id).placeable &&
      (hand === undefined
        ? this.mode === "creative" ||
          this.getHandStack()?.id === id ||
          this.countPlain(id) > 0 ||
          this._owned.offhand?.id === id
        : held?.id === id)
    );
  }

  // Call once after checking the target cell. False never consumes anything.
  placed(id, hand) {
    if (!this.canPlace(id, hand)) return false;
    if (hand !== undefined) return this.consumeHand(hand);
    if (this.getHandStack()?.id === id) return this.consumeHand("main");
    if (this._owned.offhand?.id === id) return this.consumeHand("offhand");
    return this.consume(id, 1);
  }

  attackDamage() {
    if (this.dead) return 0;
    const held = this.selectedItem;
    if (
      held?.tool === "bow" &&
      this.mode !== "creative" &&
      !this.countPlain(ITEM.ARROW) &&
      this._owned.offhand?.id !== ITEM.ARROW
    )
      return 0;
    return held?.damage ?? 1;
  }

  attack() {
    if (this._disposed || this._inventoryBusy || this.dead) return 0;
    const damage = this.attackDamage();
    const held = this.selectedItem;
    if (!damage) {
      this.onToast("You need arrows for the bow");
      return 0;
    }
    if (this.mode === "survival") {
      let broken = false;
      const participant = this._prepareState(
        ({ owned: draft }) => {
          if (held?.tool === "bow") {
            if (draft.offhand?.id === ITEM.ARROW) {
              const cell = [draft.offhand];
              takeStack(cell, 0, 1);
              draft.offhand = cell[0];
            } else if (!takeItem(draft.slots, ITEM.ARROW, 1, this.selected))
              return false;
          }
          if (MINING_TOOLS.has(held?.tool) || held?.tool === "bow")
            broken = this._wearSlot(
              ownedSlot(draft, "inventory", this.selected),
              held.tool === "sword" || held.tool === "bow" ? 1 : 2
            );
          return true;
        },
        { notify: false, selfUseHands: ["main", "offhand"] }
      );
      if (!participant || !this.coordinator.commit([participant]).ok) return 0;
      if (broken) this.onToast(`${held.name} broke`);
      this._exhaust(0.1);
    }
    this._emit();
    return damage;
  }

  eat() {
    return this.eatFromHand("main");
  }

  damage(amount, cause = "injury") {
    if (
      this._disposed ||
      this._inventoryBusy ||
      this.dead ||
      this.mode === "creative" ||
      !Number.isFinite(amount) ||
      amount <= 0
    )
      return 0;
    cause = typeof cause === "string" ? cause.slice(0, 80) : "injury";
    const points = armorPoints(this._owned.equipment);
    let wear = 0;
    if (points && !["drowning", "starvation", "fall"].includes(cause)) {
      wear = Math.max(1, Math.floor(amount / 4));
      // Java's damage-dependent armor reduction (iron has no toughness).
      const protection = Math.min(
        20,
        Math.max(points / 5, points - amount / 2)
      );
      amount *= 1 - protection / 25;
    }
    const taken = Math.min(this.health, amount);
    const broken = [];
    const participant = this._prepareState(
      (state) => {
        if (wear) {
          for (let index = 0; index < EQUIPMENT_SLOTS.length; index++) {
            const slot = ownedSlot(state.owned, "equipment", index);
            const id = slot.get()?.id;
            if (this._wearSlot(slot, wear)) broken.push(id);
          }
        }
        state.health = Math.max(0, state.health - taken);
        state.timers.regen = 0;
        if (state.health === 0) {
          state.dead = true;
          state.deathCause = cause;
        }
        return true;
      },
      { notify: false }
    );
    if (!participant || !this.coordinator.commit([participant]).ok) return 0;
    for (const id of broken) this.onToast(`${getItem(id).name} broke`);
    if (this.dead) this.onDeath(cause);
    this._emit();
    return taken;
  }

  respawn() {
    if (this._disposed || this._inventoryBusy) return false;
    this.health = this.hunger = this.air = 20;
    this.saturation = 5;
    this.exhaustion = 0;
    this.dead = false;
    this.deathCause = null;
    this._timers = freshTimers();
    this._revision++;
    this._handRevisions.main++;
    this._handRevisions.offhand++;
    this._emit();
    return true;
  }

  _plan(recipe, station) {
    // This legacy ID-only craft API cannot opt into decorated ingredients.
    const inventory = countPlainSlots(this._owned.slots);
    const costs = new Map();
    const missing = [];
    const ingredients = [];
    const fuel = [];
    const reserve = (id, amount) => {
      inventory.set(id, (inventory.get(id) ?? 0) - amount);
      if (!inventory.get(id)) inventory.delete(id);
      costs.set(id, (costs.get(id) ?? 0) + amount);
    };
    if (this.mode !== "creative") {
      for (const input of recipe.ingredients) {
        let needed = input.count;
        const display = new Map();
        for (const id of [input.id, ...(input.alternatives ?? [])]) {
          const amount = Math.min(needed, inventory.get(id) ?? 0);
          if (amount) {
            reserve(id, amount);
            display.set(id, amount);
          }
          needed -= amount;
        }
        if (needed) {
          missing.push({ ...input, needed, owned: input.count - needed });
          display.set(input.id, (display.get(input.id) ?? 0) + needed);
        }
        for (const [id, count] of display) ingredients.push({ id, count });
      }
    } else
      ingredients.push(...recipe.ingredients.map((input) => ({ ...input })));
    const plainRecipe = recipe.ingredients.every(
      (input) =>
        input.data === undefined &&
        (input.metadata === undefined || input.metadata === "plain")
    );
    let reason = this.dead
      ? "dead"
      : this._disposed || this._inventoryBusy
        ? "busy"
        : !stationAvailable("hand", station) ||
            (!stationAvailable(recipe.station, station) &&
              this.mode !== "creative")
          ? "station"
          : missing.length || !plainRecipe
            ? "ingredients"
            : null;
    let fuelTime = this._fuelTime;
    if (!reason && this.mode !== "creative" && recipe.duration) {
      if (this._queue.length >= MAX_CRAFT_QUEUE) reason = "queue_full";
      let needed = Math.max(0, recipe.duration - fuelTime);
      for (const id of FUEL_ITEMS) {
        const burnTime = getItem(id).fuel;
        const amount = Math.min(
          Math.ceil(needed / burnTime),
          inventory.get(id) ?? 0
        );
        if (amount) {
          reserve(id, amount);
          fuel.push({ id, count: amount });
          fuelTime += burnTime * amount;
          needed = Math.max(0, recipe.duration - fuelTime);
        }
      }
      if (needed > EPSILON) {
        reason ??= "fuel";
        fuel.push({
          id: ITEM.COAL,
          count: Math.ceil(needed / getItem(ITEM.COAL).fuel),
        });
      } else fuelTime = Math.max(0, fuelTime - recipe.duration);
    }
    let slots;
    if (!reason && this.mode !== "creative") {
      slots = cloneSlots(this._owned.slots, this.context);
      for (const [id, count] of costs) {
        if (!takeItem(slots, id, count, this.selected)) {
          reason = "ingredients";
          break;
        }
      }
      if (!reason) {
        const withOutput = cloneSlots(slots, this.context);
        const output = splitStackPayload(
          recipe.output,
          INVENTORY_SLOTS,
          this.context
        );
        if (
          !output ||
          output.some((stack) => insertStack(withOutput, stack)) ||
          !fitsQueuedOutputs(withOutput, this._queue, this.context)
        )
          reason = "inventory_full";
        if (!recipe.duration) slots = withOutput;
      }
    }
    return {
      ok: !reason,
      reason,
      missing,
      costs,
      fuelTime,
      ingredients,
      fuel,
      slots,
    };
  }

  /**
   * Always returns {ok, reason, queued, output, missing}. Check .ok, not truthiness.
   * Furnace jobs reserve inputs, fuel AND output space atomically at enqueue time.
   * A station can be a string, or an array when both stations are nearby.
   * This legacy compatibility entrypoint intentionally retains instant recipes;
   * new UI code must use fillRecipe + takeCraftResult, never this bypass.
   */
  craft(recipeId, options = {}) {
    if (this._disposed || this._inventoryBusy)
      return {
        ok: false,
        reason: "busy",
        queued: false,
        output: null,
        missing: [],
      };
    const { station = "hand" } = object(options) ? options : { station: null };
    const recipe = getRecipe(recipeId);
    const plan = recipe
      ? this._plan(recipe, station)
      : { ok: false, reason: "unknown_recipe", missing: [] };
    const result = {
      ok: plan.ok,
      reason: plan.reason,
      queued: plan.ok && this.mode === "survival" && recipe.duration > 0,
      output: recipe ? structuredClone(recipe.output) : null,
      missing: plan.missing,
    };
    if (!plan.ok) {
      this.onToast(craftFailureMessage(plan.reason, recipe));
      return result;
    }
    const participant = this._prepareState(
      (state) => {
        if (this.mode === "creative") {
          // A free palette selection cannot mint finite Survival inventory.
          state.creativeHotbar[this.selected] = recipe.output.id;
        } else {
          state.owned.slots = plan.slots;
          if (recipe.duration) {
            state.owned.fuelTime = plan.fuelTime;
            state.queue.push({ recipeId, remaining: recipe.duration });
          }
        }
        return true;
      },
      { notify: false }
    );
    if (!participant || !this.coordinator.commit([participant]).ok) {
      result.ok = result.queued = false;
      result.reason = "inventory_full";
      this.onToast(craftFailureMessage(result.reason, recipe));
      return result;
    }
    this.onToast(
      `${result.queued ? "Smelting" : "Crafted"} ${recipe.name.toLowerCase()}`
    );
    this._emit();
    return result;
  }

  getCraftableRecipes(station = "hand") {
    return RECIPES.map((recipe) => {
      const { ok, reason, missing, ingredients, fuel } = this._plan(
        recipe,
        station
      );
      return {
        ...structuredClone(recipe),
        ingredients,
        fuel,
        canCraft: ok,
        missing,
        reason: craftFailureMessage(reason, recipe),
        reasonCode: reason,
      };
    });
  }

  _advanceCrafting(dt) {
    while (this._queue.length && dt > 0) {
      const job = this._queue[0];
      const elapsed = Math.min(dt, job.remaining);
      job.remaining -= elapsed;
      dt -= elapsed;
      this._revision++;
      if (job.remaining > EPSILON) break;
      job.remaining = 0;
      const output = getRecipe(job.recipeId).output;
      const participant = this._prepareState(
        (state) => {
          const stacks = splitStackPayload(
            output,
            INVENTORY_SLOTS,
            this.context
          );
          if (
            !stacks ||
            stacks.some((stack) => insertStack(state.owned.slots, stack))
          )
            return false;
          state.queue.shift();
          return true;
        },
        { allowDead: true, notify: false }
      );
      if (!participant || !this.coordinator.commit([participant]).ok) break;
      const { id } = output;
      this.onToast(`${getItem(id).name} ready`);
      this._emit();
    }
  }

  _exhaust(amount) {
    this._revision++;
    this.exhaustion += amount;
    while (this.exhaustion >= 4) {
      this.exhaustion -= 4;
      if (this.saturation > 0)
        this.saturation = Math.max(0, this.saturation - 1);
      else this.hunger = Math.max(0, this.hunger - 1);
    }
  }

  _hazard(name, dt, amount) {
    const interval = TIMER_LIMITS[name];
    const elapsed = this._timers[name] + dt;
    const hits = Math.floor((elapsed + EPSILON) / interval);
    this._timers[name] = Math.max(0, elapsed - hits * interval);
    for (let i = 0; i < hits && !this.dead; i++) this.damage(amount, name);
  }

  update(
    dt,
    {
      moving = false,
      sprinting = false,
      inWater = false,
      underwater = false,
      inLava = false,
      airKnown = true,
      restoreAir = false,
      fallDistance = 0,
    } = {}
  ) {
    if (
      this._disposed ||
      this._inventoryBusy ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      typeof airKnown !== "boolean" ||
      typeof restoreAir !== "boolean"
    )
      return;
    this._revision++;
    // Bound suspended-tab catch-up, while accepting useful simulation steps.
    dt = Math.min(dt, 60);
    this._advanceCrafting(dt);
    if (this.mode === "creative" || this.dead) return;
    if (!inWater && Number.isFinite(fallDistance) && fallDistance > 3) {
      this.damage(Math.floor(fallDistance - 3), "fall");
    }
    this._changeClock += dt;
    for (let remaining = dt; remaining > EPSILON && !this.dead; ) {
      const step = Math.min(0.25, remaining);
      remaining -= step;
      this._exhaust(
        step *
          (0.002 +
            (moving ? (sprinting ? 0.24 : 0.06) : 0) +
            (inWater && moving ? 0.08 : 0))
      );
      if (airKnown) {
        if (restoreAir) {
          this.air = 20;
          this._timers.drowning = 0;
        } else if (underwater) {
          const breathing = Math.min(step, this.air / (20 / 15));
          this.air = Math.max(0, this.air - step * (20 / 15));
          this._hazard("drowning", Math.max(0, step - breathing), 2);
        } else {
          this.air = Math.min(20, this.air + step * 4);
          this._timers.drowning = 0;
        }
      }
      if (inLava) this._hazard("lava", step, 4);
      else this._timers.lava = 0;
      if (this.hunger === 0) this._hazard("starvation", step, 1);
      else this._timers.starvation = 0;
      if (
        !this.dead &&
        !inLava &&
        !underwater &&
        this.hunger >= 18 &&
        this.health < 20
      ) {
        this._timers.regen += step;
        if (this._timers.regen + EPSILON >= TIMER_LIMITS.regen) {
          this._timers.regen = 0;
          this.health = Math.min(20, this.health + 1);
          this._exhaust(6);
        }
      } else this._timers.regen = 0;
    }
    if (this._changeClock >= 0.25) {
      this._changeClock %= 0.25;
      this._emit();
    }
  }

  getState() {
    const { experienceTotal, ...owned } = cloneOwnedInventory(
      this._owned,
      this.context
    );
    return {
      ...owned,
      mode: this.mode,
      health: this.health,
      hunger: this.hunger,
      air: this.air,
      saturation: this.saturation,
      dead: this.dead,
      deathCause: this.deathCause,
      hotbar: [...this.hotbar],
      selected: this.selected,
      creativeHotbar: [...this._creativeHotbar],
      creativeSelected: this._creativeSelected,
      survivalSelected: this._survivalSelected,
      mainHandSource:
        this.mode === "creative" ? "creativePalette" : "inventory",
      counts: Object.fromEntries(this.inventory),
      durability: Object.fromEntries(
        [...this._durability].map(([id, wear]) => [id, wear[0]])
      ),
      inventory: [...this.inventory].map(([id, count]) => ({ id, count })),
      inventorySlotsUsed: this._owned.slots.filter(Boolean).length,
      inventorySlotsTotal: INVENTORY_SLOTS,
      armorPoints: armorPoints(this._owned.equipment),
      experience: experienceState(experienceTotal),
      craftingResult:
        matchCraftingRecipe(this._owned.craftingGrid, this._owned.craftingSize)
          ?.output ?? null,
      crafting: this._queue.map((job) => {
        const recipe = getRecipe(job.recipeId);
        return {
          recipeId: job.recipeId,
          name: recipe.name,
          remaining: job.remaining,
          duration: recipe.duration,
          progress: 1 - job.remaining / recipe.duration,
          output: structuredClone(recipe.output),
        };
      }),
    };
  }

  serialize() {
    const { experienceTotal, ...owned } = cloneOwnedInventory(
      this._owned,
      this.context
    );
    return {
      version: 3,
      ...owned,
      mode: this.mode,
      health: this.health,
      hunger: this.hunger,
      air: this.air,
      saturation: this.saturation,
      exhaustion: this.exhaustion,
      dead: this.dead,
      deathCause: this.deathCause,
      // Optional compatibility projections are validated against canonical
      // slots on v2/v3 load. Editing a count snapshot is not a transfer API.
      ...inventoryProjections(this._owned, this.mode, this._creativeHotbar),
      selected: this.selected,
      creativeHotbar: [...this._creativeHotbar],
      creativeSelected: this._creativeSelected,
      survivalSelected: this._survivalSelected,
      experience: experienceState(experienceTotal),
      crafting: this._queue.map((job) => ({ ...job })),
      timers: { ...this._timers },
    };
  }

  /** Invalid saves return false without changing any live state or callbacks. */
  load(data, options = {}) {
    if (!object(options) || this._disposed || this._inventoryBusy) return false;
    const {
      context = this.context,
      allowOverBudget = false,
      notify = true,
    } = options;
    if (typeof allowOverBudget !== "boolean" || typeof notify !== "boolean")
      return false;
    const next = parseGameplaySave(data, context);
    if (!next) return false;
    const recordBytes = stackRecords(next.owned).map(encodedBytes);
    const bytes = reservationBytes(recordBytes);
    if (!this.coordinator.register(this, bytes, { allowOverBudget }))
      return false;
    this._owned = next.owned;
    this._creativeHotbar = next.creativeHotbar;
    this._creativeSelected = next.creativeSelected;
    this._survivalSelected = next.survivalSelected;
    this.mode = next.mode;
    this.health = next.health;
    this.hunger = next.hunger;
    this.air = next.air;
    this.saturation = next.saturation;
    this.exhaustion = next.exhaustion;
    this.dead = next.dead;
    this.deathCause = next.deathCause;
    this._queue = next.queue;
    this._timers = next.timers;
    this.context = context;
    this._recordBytes = recordBytes;
    this._bytes = bytes;
    this._revision++;
    this._handRevisions.main++;
    this._handRevisions.offhand++;
    this._changeClock = 0;
    if (notify) this._emit();
    return true;
  }

  dispose() {
    if (this._disposed || this._inventoryBusy) return false;
    if (!this.coordinator.release(this)) return false;
    this._disposed = true;
    this._revision++;
    this._handRevisions.main++;
    this._handRevisions.offhand++;
    this._bytes = 0;
    this.onToast = this.onDeath = this.onChange = this.onHurt = noOp;
    return true;
  }

  _emit() {
    this.onChange(this.getState());
  }
}
