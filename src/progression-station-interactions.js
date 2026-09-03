import { anvilWear, planAnvil, previewAnvil } from "./anvil.js";
import { BLOCKS } from "./blocks.js";
import { cellAfterBreaking, normalizeCell } from "./block-state.js";
import { brewingProgress } from "./brewing.js";
import { immutable, nextEnchantingSeed, refusal, synchronous } from "./enchantment-domain.js";
import {
  getEnchantingOffers, prepareEnchantingTransaction, sampleBookshelfPower,
} from "./enchanting.js";
import { cloneStack, insertStack, isMergeable } from "./inventory-slots.js";
import { getItem, ITEM } from "./items.js";
import { captureStationAccess } from "./progression-access.js";
import { applyProgressionSlotAction } from "./progression-slot-actions.js";
import { progressionStationKind, stationSlots } from "./progression-station-state.js";
import { previewSmithing } from "./smithing.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";

/** An output is paid only when the entire payload fits this owned destination. */
export function receiveProgressionOutput(owned, output, destination, context) {
  if (destination === "inventory") return insertStack(owned.slots, output) === null;
  if (destination !== "cursor") return false;
  if (owned.cursor === null) {
    owned.cursor = cloneStack(output, context);
    return true;
  }
  if (!isMergeable(owned.cursor, output) ||
      owned.cursor.count + output.count > getItem(output.id).stackSize) return false;
  owned.cursor = { ...cloneStack(output, context), count: owned.cursor.count + output.count };
  return true;
}

export function progressionPlan(coordinator, participants, result) {
  const seen = new Set();
  if (!(coordinator instanceof TransactionCoordinator) || !Array.isArray(participants) ||
      !participants.length || participants.length > 128) return refusal("invalid_participants");
  for (const part of participants) {
    if (!part || seen.has(part.owner) ||
        !Number.isSafeInteger(part.beforeBytes) || part.beforeBytes < 0 ||
        !Number.isSafeInteger(part.afterBytes) || part.afterBytes < 0 ||
        coordinator.usage(part.owner) !== part.beforeBytes ||
        !synchronous(part.validate) || !synchronous(part.publish) ||
        (part.notify !== undefined && !synchronous(part.notify)))
      return refusal("invalid_participants");
    seen.add(part.owner);
  }
  return Object.freeze({
    ok: true, prepared: true, participants: Object.freeze(participants),
    result: immutable(result),
  });
}

/**
 * Preparation only. Access/session prerequisites are captured for EVERY action,
 * not trusted from a menu snapshot. Neither this adapter nor a panel holds items.
 */
export class ProgressionStationInteractions {
  constructor({ world, gameplay, stations, readActor, validateSession, prepareDrops }) {
    Object.assign(this, { world, gameplay, stations, readActor, validateSession, prepareDrops });
    this.coordinator = world.coordinator;
    this.context = stations.context;
    this.catalog = stations.catalog;
    this.resources = Object.freeze({ lapis: ITEM.LAPIS, enchantedBook: ITEM.ENCHANTED_BOOK });
  }

  capture(at) {
    if (!synchronous(this.validateSession) || this.validateSession(at) !== true ||
        this.stations.disposed || this.gameplay.coordinator !== this.coordinator ||
        this.stations.coordinator !== this.coordinator)
      return null;
    const access = captureStationAccess(this.world, this.gameplay, this.readActor, at, this.context);
    if (!access) return null;
    const validate = access.validate;
    access.validate = () => this.validateSession(at) === true && validate();
    return access;
  }

  shelves(access) {
    const sample = sampleBookshelfPower(access.reads.read, access.at);
    return sample.ok ? {
      ...sample, validate: () => access.validate(),
    } : sample;
  }

  view(at, { rename } = {}) {
    const access = this.capture(at);
    const entry = access && this.stations.get(at);
    if (!entry || entry.kind !== access.kind) return null;
    const gameplay = this.gameplay.getState();
    const view = {
      kind: entry.kind, title: BLOCKS[access.cell.id].name,
      position: access.at, slots: stationSlots(entry.kind, entry.record, this.context),
      gameplay, stationRevision: this.stations.revision,
      experience: gameplay.experience,
    };
    if (entry.kind === "enchanting") {
      const shelves = this.shelves(access);
      const menu = shelves.ok ? getEnchantingOffers({
        input: entry.record.input, playerState: this.stations.playerState,
        bookshelfPower: shelves.power, resources: this.resources, context: this.context,
      }) : shelves;
      view.bookshelfPower = shelves.power ?? 0;
      view.reason = menu.reason ?? null;
      view.offers = menu.offers?.map((offer) => ({
        ...offer,
        affordable: gameplay.mode === "creative" || (
          view.experience.level >= offer.requiredLevel &&
          entry.record.lapis?.id === ITEM.LAPIS && entry.record.lapis.count >= offer.lapisCost
        ),
      })) ?? [];
    } else if (entry.kind === "anvil") {
      view.preview = previewAnvil({ record: entry.record, rename,
        mode: gameplay.mode, context: this.context });
    } else if (entry.kind === "smithing") {
      view.preview = previewSmithing(entry.record, this.context);
    } else Object.assign(view, brewingProgress(entry.record, this.catalog, this.context));
    return access.validate() ? view : null;
  }

  prepare(at, action) {
    try {
      if (!action || typeof action !== "object") return refusal("invalid_action");
      const access = this.capture(at);
      const entry = access && this.stations.get(at);
      if (!entry || entry.kind !== access.kind) return refusal("station_unavailable");
      if (action.type === "enchant") return this.#enchant(entry, action, access);
      if (action.type === "takeResult") {
        if (entry.kind === "anvil") return this.#anvil(entry, action, access);
        if (entry.kind === "smithing") return this.#smithing(entry, action, access);
        return refusal("no_station_result");
      }
      return this.#slots(entry, action, access);
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return refusal("invalid_station_action");
    }
  }

  #guard(participant, access) {
    return participant && Object.freeze({
      ...participant, validate: () => access.validate() && participant.validate(),
    });
  }

  #drops(stacks, at) {
    if (!stacks.length) return [];
    if (!synchronous(this.prepareDrops)) return null;
    const result = this.prepareDrops(stacks, at);
    return result?.participants ?? (result ? [result] : null);
  }

  #slots(entry, action, access) {
    let result;
    const player = this.gameplay.prepareInventory((owned) => {
      result = applyProgressionSlotAction(entry.kind, entry.record, owned, action,
        this.catalog, this.context);
      return result.ok;
    });
    if (!player || !result?.ok) return refusal(result?.reason ?? "inventory_rejected");
    const station = this.stations.prepareChange(entry, {
      before: { record: entry.record }, after: { record: result.record },
    }, { validate: access.validate });
    const drops = this.#drops(result.drops ?? [], entry);
    if (!station || !drops) return refusal("retention_rejected");
    return progressionPlan(this.coordinator, [
      this.#guard(player, access), station, ...drops,
    ], { ok: true, changed: true });
  }

  #enchant(entry, action, access) {
    if (entry.kind !== "enchanting") return refusal("wrong_station");
    return prepareEnchantingTransaction({
      gameplay: this.gameplay, record: entry.record, playerState: this.stations.playerState,
      shelves: this.shelves(access), index: action.index, offerKey: action.offerKey,
      resources: this.resources, context: this.context, validateAccess: access.validate,
      prepareStation: (change) => this.stations.prepareChange(entry, change, {
        validate: access.validate,
      }),
    });
  }

  #anvil(entry, action, access) {
    const result = planAnvil({
      record: entry.record, rename: action.rename, previewKey: action.previewKey,
      experienceTotal: this.gameplay.getState().experience.total, mode: this.gameplay.mode,
      context: this.context,
    });
    if (!result.ok) return result;
    const creative = this.gameplay.mode === "creative";
    const randomState = creative ? this.stations.randomState :
      nextEnchantingSeed(this.stations.randomState);
    const definition = BLOCKS[access.cell.id];
    const wear = creative ? { damaged: false, broken: false } :
      anvilWear(definition.anvilStage, randomState / 0x100000000);
    let mutation = null;
    if (wear.damaged) {
      const after = wear.broken ? cellAfterBreaking(access.cell) :
        normalizeCell({ ...access.cell, id: definition.nextDamagedBlock });
      mutation = this.world.prepareMutation([{
        ...access.at, before: access.cell, after,
      }]);
      if (!mutation) return refusal("anvil_wear_rejected");
    }
    const remainder = [];
    const player = this.gameplay.prepareInventory((owned) => {
      if (owned.experienceTotal !== result.experienceBefore ||
          !receiveProgressionOutput(owned, result.output,
            action.shift === true ? "inventory" : "cursor", this.context)) return false;
      owned.experienceTotal = result.experienceAfter;
      if (wear.broken && result.after.record.right) {
        const rest = insertStack(owned.slots, result.after.record.right);
        if (rest) remainder.push(rest);
      }
      return true;
    });
    if (!player) return refusal("output_capacity");
    const station = this.stations.prepareChange(entry, result, {
      validate: access.validate, randomState, remove: wear.broken,
    });
    const drops = this.#drops(remainder, entry);
    if (!station || !drops) return refusal("retention_rejected");
    return progressionPlan(this.coordinator, [
      this.#guard(player, access), station, ...(mutation ? [mutation] : []), ...drops,
    ], { ok: true, levelCost: result.chargedLevels, anvilBroken: wear.broken,
      output: result.output, experienceCommitted: true });
  }

  #smithing(entry, action, access) {
    const result = previewSmithing(entry.record, this.context);
    if (!result.ok) return result;
    if (action.previewKey !== result.key) return refusal("stale_preview");
    const player = this.gameplay.prepareInventory((owned) =>
      receiveProgressionOutput(owned, result.output,
        action.shift === true ? "inventory" : "cursor", this.context)
    );
    const station = player && this.stations.prepareChange(entry, result, {
      validate: access.validate,
    });
    if (!station) return refusal("output_capacity");
    return progressionPlan(this.coordinator, [
      this.#guard(player, access), station,
    ], { ok: true, output: result.output });
  }

  /**
   * Harvest/explosion path. Pass ALL block/tool loot in extraDrops and any
   * non-World/non-drop participants (e.g. held-tool wear). This prepares the
   * World mutation itself, combines escrow into ONE retained-drop reservation,
   * and returns a single plan. Never also call Settlement.remove at these cells.
   * For Unbreaking, use randomDraws + prepareGameplay(rolls), not a second
   * station-owned RNG plan. prepareGameplay returns one Gameplay participant.
   */
  prepareStationRemoval(changes, {
    extraDrops = [], participants = [], validate, randomDraws = 0, prepareGameplay,
  } = {}) {
    if (!Array.isArray(changes) || !changes.length || changes.length > 128 ||
        !Array.isArray(extraDrops) || !Array.isArray(participants) ||
        !synchronous(validate) ||
        (prepareGameplay !== undefined && !synchronous(prepareGameplay)) ||
        (randomDraws !== 0 && !prepareGameplay)) return refusal("invalid_station_removal");
    if (!changes.some((change) =>
      progressionStationKind(change.before?.id) !== null ||
      this.stations.get({ ...change, dimension: this.world.dimension }) !== null
    )) return null;
    let destination = null;
    const mutation = this.world.prepareMutation(changes);
    if (!mutation) return refusal("world_rejected");
    const removal = this.stations.prepareRemoval(changes, {
      randomDraws,
      validateDestination: () => validate() === true && mutation.validate() === true &&
        destination !== null && destination.every((part) => part.validate() === true),
    });
    if (!removal) return refusal("station_rejected");
    const at = { ...changes[0], dimension: this.world.dimension };
    destination = this.#drops([...extraDrops, ...removal.stacks], at);
    if (!destination) return refusal("retention_rejected");
    const player = prepareGameplay?.(removal.rolls);
    if (prepareGameplay && player?.owner !== this.gameplay)
      return refusal("gameplay_rejected");
    return progressionPlan(this.coordinator, [
      mutation, removal.participant, ...destination, ...(player ? [player] : []), ...participants,
    ], { ok: true, retainedStacks: extraDrops.length + removal.stacks.length });
  }
}
