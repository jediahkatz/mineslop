import { createBrewingCatalog, fillWaterBottle } from "./brewing.js";
import { cellsEqual } from "./block-state.js";
import { dataRecord, refusal, synchronous } from "./enchantment-domain.js";
import { captureEntityContext } from "./entity-context.js";
import { draftHand } from "./gameplay-hand-actions.js";
import { cloneStack, insertStack } from "./inventory-slots.js";
import { sameStackKind } from "./item-stack-data.js";
import { ItemUse } from "./item-use.js";
import { ITEM } from "./items.js";
import { PotionProjectiles } from "./potion-projectiles.js";
import { createPotionProjectilesSnapshot, normalizePotionProjectilesSnapshot } from "./potion-projectile-state.js";
import { POTION_DRINK_SECONDS } from "./potion-rules.js";
import { captureProgressionActor, captureStationAccess, progressionReadSet } from "./progression-access.js";
import { normalizeProgressionContext } from "./progression-context.js";
import { ProgressionGearEffects } from "./progression-gear-effects.js";
import { applyProgressionInventoryAction } from "./progression-slot-actions.js";
import { ProgressionStations } from "./progression-stations.js";
import {
  createProgressionStationsSnapshot, normalizeProgressionStationsSnapshot,
  progressionStationKey,
} from "./progression-station-state.js";
import { ProgressionStationInteractions, progressionPlan } from "./progression-station-interactions.js";
import { ProgressionTradingHost } from "./progression-trading-host.js";
import { preparePotionConsumption, prepareStatusAdvance } from "./status-effect-actions.js";
import { createStatusEffects, normalizeStatusEffects, StatusEffects } from "./status-effects.js";
import { CHUNK_SIZE } from "./terrain.js";
import { Trading } from "./trading.js";
import { normalizeTradingSnapshot, TRADING_VERSION } from "./trading-state.js";
import { TransactionCoordinator, TransactionInvariantError } from "./transactions.js";
import { findWaterSource } from "./world-interactions.js";

export const PROGRESSION_SERVICES_VERSION = 1;
const noOp = () => {};
const bindable = (game, key, value) => {
  const descriptor = Object.getOwnPropertyDescriptor(game, key);
  return descriptor ? Object.hasOwn(descriptor, "value") && descriptor.configurable &&
    (descriptor.value == null || descriptor.value === value) : Object.isExtensible(game);
};

/**
 * Archive field: `progression`. Absence alone performs the deterministic legacy
 * migration. Explicit null/bad versions fail; no corrupt input becomes a fresh
 * seed, empty stand or rerolled trader. No renderer, DOM or live callbacks here.
 */
export function normalizeProgressionServicesSnapshot(value, context, {
  ownerId = "local-player", catalog = createBrewingCatalog(ITEM),
} = {}) {
  try {
    context = normalizeProgressionContext(context);
    const emptyTrading = {
      version: TRADING_VERSION, seed: context.seed,
      generatorVersion: context.generatorVersion, npcs: [],
    };
    if (value === undefined) value = {
      version: PROGRESSION_SERVICES_VERSION,
      stations: createProgressionStationsSnapshot(context),
      statusEffects: createStatusEffects(), trading: emptyTrading,
      potionProjectiles: createPotionProjectilesSnapshot(context, ownerId),
    };
    const fields = ["version", "stations", "statusEffects", "trading", "potionProjectiles"];
    dataRecord(value, fields, "progression sidecar");
    if (value.version !== PROGRESSION_SERVICES_VERSION ||
        fields.some((field) => !Object.hasOwn(value, field) || value[field] === undefined)) return null;
    const trading = normalizeTradingSnapshot(value.trading, context);
    if (!trading) return null;
    return {
      version: PROGRESSION_SERVICES_VERSION,
      stations: normalizeProgressionStationsSnapshot(value.stations, catalog, context),
      statusEffects: normalizeStatusEffects(value.statusEffects),
      trading,
      potionProjectiles: normalizePotionProjectilesSnapshot(value.potionProjectiles, context, ownerId),
    };
  } catch {
    return null;
  }
}

/**
 * Detached candidate construction -> install candidate World/Gameplay ->
 * activate(game, bridges). Never replaces an old host, takes pointer lock,
 * changes pause/input state, or imports CSS. Parent owns those transitions.
 *
 * Session close is ownership-neutral: station and Gameplay cursor remain saved.
 * There is no "return on close" fallback that can erase a full inventory.
 */
export class GameProgressionServices {
  constructor({ world, gameplay, context = gameplay?.context, saved,
    ownerId = "local-player", allowOverBudget = false } = {}) {
    const normalizedContext = normalizeProgressionContext(context);
    const catalog = createBrewingCatalog(ITEM);
    const normalized = normalizeProgressionServicesSnapshot(saved, normalizedContext, { ownerId, catalog });
    if (
      !(world?.coordinator instanceof TransactionCoordinator) ||
      world._disposed || gameplay?._disposed ||
      gameplay?.coordinator !== world.coordinator ||
      world.coordinator.usage(world) === undefined ||
      world.coordinator.usage(gameplay) === undefined ||
      world.seed !== normalizedContext.seed ||
      world.generatorVersion !== normalizedContext.generatorVersion ||
      gameplay.context?.seed !== world.seed ||
      gameplay.context?.generatorVersion !== world.generatorVersion ||
      !normalized || typeof allowOverBudget !== "boolean"
    )
      throw new RangeError("Invalid staged progression services");
    Object.assign(this, {
      world, gameplay, context: normalizedContext, catalog, ownerId,
      coordinator: world.coordinator,
      _game: null, _disposed: false, _session: null, _sessionRevision: 0,
      _stageEpoch: world.epoch, _stageDimension: world.dimension,
      _gameplayContext: gameplay.context,
      _frameBusy: false, _actionBusy: false,
      _bridges: null, observerErrors: [],
    });
    if (!this.coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register progression lifecycle");
    try {
      this.stations = new ProgressionStations({
        world, context: normalizedContext, catalog, snapshot: normalized.stations, allowOverBudget,
      });
      this.effects = new StatusEffects({
        coordinator: this.coordinator, state: normalized.statusEffects, allowOverBudget,
      });
      this.trading = new Trading({ context: normalizedContext,
        coordinator: this.coordinator, allowOverBudget });
      if (!this.trading.load(normalized.trading, { allowOverBudget }))
        throw new RangeError("Cannot restore traders");
      this.potions = new PotionProjectiles({
        world, context: normalizedContext, catalog, ownerId,
        snapshot: normalized.potionProjectiles, allowOverBudget,
      });
      this.gear = new ProgressionGearEffects(gameplay, this.effects, this.stations);
      this.interactions = new ProgressionStationInteractions({
        world, gameplay, stations: this.stations,
        readActor: () => this.readActor(),
        validateSession: (at) => this._stationSessionValid(at),
        prepareDrops: (stacks, at) => this._prepareDrops(stacks, at),
      });
      this._owners = Object.freeze({
        world, gameplay, context: normalizedContext, coordinator: this.coordinator,
        stations: this.stations, effects: this.effects, trading: this.trading,
        potions: this.potions, gear: this.gear, interactions: this.interactions,
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _available() {
    return !this._disposed && !!this._owners && Object.entries(this._owners).every(
      ([key, owner]) => this[key] === owner
    ) && !this.world._disposed && !this.gameplay._disposed &&
      this.world.coordinator === this.coordinator &&
      this.gameplay.coordinator === this.coordinator &&
      this.gameplay.context === this._gameplayContext &&
      this.world.seed === this.context.seed &&
      this.world.generatorVersion === this.context.generatorVersion &&
      this.coordinator.usage(this) === 0 &&
      this.coordinator.usage(this.world) !== undefined &&
      this.coordinator.usage(this.gameplay) !== undefined &&
      [this.stations, this.effects, this.trading, this.potions].every(
        (owner) => owner.coordinator === this.coordinator &&
          this.coordinator.usage(owner) === owner.reservedBytes
      );
  }

  get active() {
    const game = this._game;
    return this._available() && !!game && game.world === this.world &&
      game.gameplay === this.gameplay && game.progressionServices === this;
  }
  get isOpen() { return this._session !== null; }
  get session() {
    if (!this._session) return null;
    const { kind, dimension, token, npcId, x, y, z } = this._session;
    return { kind, dimension, token,
      ...(kind === "trading" ? { npcId } : { x, y, z }) };
  }

  /** Cheap UI invalidation key; no offers, stack snapshots or saved JSON. */
  get viewRevision() {
    const session = this._session;
    if (!this.active || !session) return null;
    return [
      session.token, this.world.epoch, this.world._editRevision, this.gameplay.revision,
      session.kind === "trading" ? this.trading.revision : this.stations.revision,
      session.kind === "trading" ? this._game.buildingServices?.clockProjection()?.tradingClock?.day : "",
    ].join(":");
  }

  /**
   * Required for trading: getEcology(), getEcologyContext().
   * Required for thrown potions: getOwner(id), SAME persisted owner/life bridge
   * as PlayerProjectiles (no separate life counter). Optional readPotionTargets
   * adds real Gameplay/StatusEffects-backed targets; default is the local player.
   * onSessionChange(open,session,reason) is where parent owns overlay/input.
   */
  activate(game, {
    getOwner, getEcology, getEcologyContext, readPotionTargets,
    onSessionChange = noOp, onChange = noOp, onProjectileEvent = noOp,
  } = {}) {
    if (!game || !this._available() || game.world !== this.world ||
        game.gameplay !== this.gameplay || game.player?.world !== this.world)
      return refusal("stale_progression_host");
    if (this._game)
      return this._game === game && this.active ? { ok: true } : refusal("already_activated");
    if (this.world.epoch !== this._stageEpoch || this.world.dimension !== this._stageDimension)
      return refusal("stale_progression_stage");
    if ([getOwner, getEcology, getEcologyContext, readPotionTargets].some(
      (callback) => callback !== undefined && !synchronous(callback)
    ) || ![onSessionChange, onChange, onProjectileEvent].every(synchronous))
      return refusal("invalid_progression_bridge");
    if (!getOwner && this.potions.size)
      return refusal("saved_potions_require_owner_bridge");
    if (!bindable(game, "progressionServices", this) ||
        !this.coordinator.register(this, 0, { allowOverBudget: true }))
      return refusal("progression_host_owned");
    if (this.potions.activated || !this.stations.seal() ||
        !this.trading.seal() || !this.effects.seal())
      return refusal("progression_activation_rejected");
    // Binding validates callbacks/ownership without reading a live owner,
    // simulating flight or notifying. Publish the Game binding only afterwards.
    if (getOwner && !this.potions.activate({
      getOwner,
      readTargets: readPotionTargets ?? (() => {
        const owner = getOwner(this.ownerId);
        return owner ? [{
          id: this.ownerId, ref: owner.ref, dimension: owner.dimension,
          position: owner.position, radius: owner.radius, height: owner.height,
          gameplay: this.gameplay, effects: this.effects,
          available: owner.alive && owner.world === this.world && !this.gameplay.dead,
        }] : [];
      }),
      validateLive: () => this.active,
      onEvent: (event) => { if (this.active) onProjectileEvent(event); },
    })) return refusal("potion_activation_rejected");
    Object.defineProperty(game, "progressionServices", {
      value: this, configurable: true, writable: true, enumerable: true,
    });
    this._game = game;
    this._bridges = { getOwner, getEcology, getEcologyContext, onSessionChange,
      onChange, onProjectileEvent };
    const changed = () => { if (this.active) onChange(); };
    this.stations.onChange = changed;
    this.effects.onChange = changed;
    this.trading.onChange = changed;
    this.traders = new ProgressionTradingHost({
      world: this.world, gameplay: this.gameplay, trading: this.trading,
      getEcology, getEcologyContext,
      readActor: () => this.readActor(),
      getBuildingServices: () => game.buildingServices,
      validateLive: () => this.active && !game.building && !game.paused && !game.failed,
    });
    return { ok: true };
  }

  readActor() {
    if (!this.active) return null;
    const game = this._game, player = game.player;
    if (!player || player.world !== this.world) return null;
    const owner = this._bridges.getOwner?.(this.ownerId);
    return {
      ref: player, world: this.world, dimension: this.world.dimension,
      alive: !this.gameplay.dead, life: owner?.life,
      position: player.position, eye: player.eyePosition,
      forward: player.forward, poseRevision: player.poseRevision,
    };
  }

  _prepareDrops(stacks, at) {
    if (!this.active || !synchronous(this._game.prepareDropItems)) return null;
    return this._game.prepareDropItems(stacks, {
      x: at.x + 0.5, y: at.y + 0.5, z: at.z + 0.5,
    });
  }

  _stationSessionValid(at) {
    const session = this._session;
    if (!this.active || !session || session.kind === "trading" ||
        this.gameplay.dead || this._game.building || this._game.paused || this._game.failed ||
        session.epoch !== this.world.epoch || session.dimension !== this.world.dimension ||
        progressionStationKey(session) !== progressionStationKey(at) ||
        (at.token !== undefined && session.token !== at.token))
      return false;
    const chunk = this.world.chunks.get(session.column);
    return chunk === session.chunk && chunk?.incarnation === session.incarnation;
  }

  _observe(callback) {
    try { callback(); } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      this.observerErrors.push(error);
      if (this.observerErrors.length > 16) this.observerErrors.shift();
    }
  }

  openStation(hit) {
    if (!this.active || this._game.active !== true || this.gameplay.dead ||
        this._game.building || this._game.paused || this._game.failed ||
        this.isOpen) return refusal("interaction_unavailable");
    const at = { x: hit?.x, y: hit?.y, z: hit?.z, dimension: this.world.dimension };
    const access = captureStationAccess(this.world, this.gameplay, () => this.readActor(), at, this.context);
    if (!access || hit.id !== access.cell.id ||
        (hit.state !== undefined && hit.state !== access.cell.state) ||
        (hit.fluid !== undefined && hit.fluid !== access.cell.fluid))
      return refusal("station_unavailable");
    const player = this._game.player;
    const participant = this.stations.prepareOpen(at, {
      validate: () => this.active && this._game.player === player &&
        !this.isOpen && access.validate(),
    });
    if (!participant) return refusal("station_rejected");
    const committed = this.coordinator.commit([participant]);
    if (!committed.ok) return committed;
    this.observerErrors = committed.observerErrors;
    for (const error of this.observerErrors)
      if (error instanceof TransactionInvariantError) throw error;
    // Notifications can replace the host or evict/mutate the station's column.
    // The committed escrow stays saved even when its menu can no longer open.
    if (!this.active || this._game.player !== player || this._game.active !== true ||
        this._game.paused || this._game.building || this._game.failed || !access.validate())
      return { ...committed, opened: false };
    const column = `${Math.floor(at.x / CHUNK_SIZE)},${Math.floor(at.z / CHUNK_SIZE)}`;
    const chunk = this.world.chunks.get(column);
    this._session = Object.freeze({
      ...at, kind: access.kind, epoch: this.world.epoch,
      column, chunk, incarnation: chunk.incarnation, token: ++this._sessionRevision,
    });
    this._observe(() => this._bridges.onSessionChange(true, this.session));
    return { ...committed, opened: true, view: this.view() };
  }

  openTrader(id) {
    if (!this.active || this._game.active !== true || this.isOpen || this.gameplay.dead ||
        this._game.paused || this._game.building || this._game.failed)
      return refusal("interaction_unavailable");
    if (!this.trading.readRuntime(id)) {
      const admission = this.traders.prepareAdmission(id);
      if (!admission)
        return refusal("villager_jobsite_unavailable");
      const committed = this.commit(admission);
      if (!committed.ok) return committed;
      if (!this.active || this._game.active !== true || this.isOpen)
        return { ...committed, opened: false };
    }
    if (!this.traders.captureInteraction(id)) return refusal("villager_unavailable");
    this._session = Object.freeze({
      kind: "trading", npcId: id, dimension: this.world.dimension,
      epoch: this.world.epoch, token: ++this._sessionRevision,
    });
    this._observe(() => this._bridges.onSessionChange(true, this.session));
    return { ok: true, opened: true, view: this.view() };
  }

  close(reason = "closed") {
    if (!this._session) return { ok: true, changed: false };
    this._session = null;
    this._sessionRevision++;
    if (this.active) this._observe(() => this._bridges.onSessionChange(false, null, reason));
    return { ok: true, changed: true, escrowRetained: true };
  }

  view(options) {
    const session = this._session;
    if (!this.active || !session || this.gameplay.dead ||
        session.epoch !== this.world.epoch || session.dimension !== this.world.dimension) return null;
    const view = session.kind === "trading" ? this.traders.view(session.npcId) :
      this.interactions.view(session, options);
    return view ? { ...view, sessionToken: session.token } : null;
  }

  prepareAction(action) {
    const session = this._session;
    if (!this.active || !session || action?.sessionToken !== session.token)
      return refusal("stale_progression_session");
    if (session.kind !== "trading") return this.interactions.prepare(session, action);
    const access = this.traders.captureInteraction(session.npcId);
    if (!access) return refusal("villager_unavailable");
    const valid = () => this.active && this._session === session &&
      session.epoch === this.world.epoch && access.validate();
    if (action.type === "trade")
      return this.traders.prepareTrade(session.npcId, action.offerId, {
        count: action.count ?? 1, validateSession: valid,
      }) ?? refusal("trade_rejected");
    if (!["click", "quickMove", "swapHotbar", "swapOffhand", "collect", "distribute", "drop"].includes(action.type))
      return refusal("invalid_trade_action");
    const addressAllowed = ({ area } = {}) =>
      ["inventory", "equipment", "offhand"].includes(area) ||
      (action.type === "drop" && area === "cursor");
    if (action.type === "distribute"
      ? !Array.isArray(action.targets) || !action.targets.every(addressAllowed)
      : !addressAllowed(action))
      return refusal("invalid_trade_slot");
    let result;
    const player = this.gameplay.prepareInventory((owned) => {
      result = applyProgressionInventoryAction(owned, action, this.context);
      return result.ok;
    });
    if (!player) return refusal("inventory_rejected");
    const drop = result.drops?.length ? this._game.preparePlayerDrops?.(result.drops) : undefined;
    if (result.drops?.length && !drop) return refusal("retention_rejected");
    return progressionPlan(this.coordinator, [
      { ...player, validate: () => valid() && player.validate() }, ...(drop ? [drop] : []),
    ], { ok: true });
  }

  action(action) {
    if (this._actionBusy) return refusal("progression_busy");
    this._actionBusy = true;
    try {
      return this.commit(this.prepareAction(action));
    } finally { this._actionBusy = false; }
  }

  commit(plan) {
    if (!this.active || !plan?.participants) return plan?.ok === false ? plan : refusal("invalid_plan");
    const committed = this.coordinator.commit(plan.participants);
    this.observerErrors = committed.observerErrors ?? [];
    for (const error of this.observerErrors) if (error instanceof TransactionInvariantError) throw error;
    if (committed.ok) this._observe(() => this._bridges.onChange());
    return committed.ok ? { ...plan.result, ...committed } : committed;
  }

  prepareStationRemoval(changes, options = {}) {
    if (!this.active) return refusal("progression_not_live");
    const current = captureEntityContext(this.world, this.context);
    return this.interactions.prepareStationRemoval(changes, {
      ...options, validate: () => this.active && current() &&
        (options.validate === undefined || options.validate() === true),
    });
  }

  /**
   * Forward ecology's actual work observation, never a simulated day skip.
   * GameEcologyServices emits a stable id; a raw ecology bridge may supply the
   * actual mob. Resolve ids through the current runtime, never a saved copy.
   */
  onVillagerIntent(entity, observation) {
    if (!this.active || this._game.building || this._game.paused ||
        this._game.simulating !== true) return null;
    const mob = typeof entity === "string"
      ? this._bridges.getEcologyContext?.()?.getMob?.(entity) : entity;
    if (!mob?.id || (typeof entity === "string" && mob.id !== entity)) return null;
    const plan = this.traders.prepareWork(mob.id, observation, mob);
    return plan ? this.commit(plan) : null;
  }

  prepareVillagerJobsiteRelease(id, options) {
    return this.active ? this.traders.prepareJobsiteRelease(id, options) : null;
  }

  prepareVillagerJobsitesRelease(ids, options) {
    return this.active ? this.traders.prepareJobsitesRelease(ids, options) : null;
  }

  prepareVillagerJobsiteAssignment(id, options) {
    return this.active ? this.traders.prepareJobsiteAssignment(id, options) : null;
  }

  fillBottle(hand = "main") {
    if (!this.active || this._game.active !== true ||
        !["main", "offhand"].includes(hand)) return refusal("interaction_unavailable");
    const actor = captureProgressionActor(this.world, this.gameplay, () => this.readActor());
    const held = this.gameplay.getHandStack(hand), revision = this.gameplay.getHandRevision(hand);
    if (!actor || held?.id !== this.catalog.emptyBottle) return refusal("not_a_bottle");
    const source = findWaterSource(this.world, actor.eye, this._game.player.forward);
    const reads = progressionReadSet(this.world, this.context);
    if (!source || !reads) return refusal("no_source_water");
    for (const read of source.reads)
      if (!cellsEqual(reads.read(read.x, read.y, read.z), read.before))
        return refusal("water_changed");
    const filled = fillWaterBottle({ ...held, count: 1 }, this.catalog, this.context);
    if (!filled || !reads.validate()) return refusal("water_unavailable");
    const player = this.gameplay.prepareInventory((owned) => {
      if (this.gameplay.mode === "creative") return insertStack(owned.slots, filled) === null;
      const slot = draftHand(owned, hand, this.gameplay.selected), stack = slot?.get();
      if (!sameStackKind(stack, held, this.context)) return false;
      if (stack.count === 1) slot.set(filled);
      else {
        slot.set({ ...stack, count: stack.count - 1 });
        if (insertStack(owned.slots, filled)) return false;
      }
      return true;
    });
    if (!player) return refusal("inventory_full");
    return this.commit(progressionPlan(this.coordinator, [{
      ...player, validate: () => this.active && this._game.active === true &&
        actor.validate() && reads.validate() &&
        this.gameplay.getHandRevision(hand) === revision && player.validate(),
    }], { ok: true, filled: true }));
  }

  /** Feed the actual parent ItemUse after its held 32-tick drink cycle. */
  completeDrink(use) {
    if (!this.active || this._game.active !== true || !(use instanceof ItemUse) ||
        use.kind !== "drink" || use.identity === null ||
        !Number.isSafeInteger(use.handRevision) ||
        use.elapsed < POTION_DRINK_SECONDS - 1e-9)
      return refusal("drink_not_complete");
    const stack = this.gameplay.getHandStack(use.hand);
    const handRevision = this.gameplay.getHandRevision(use.hand);
    if (!use.matches(stack, handRevision)) return refusal("stale_drink");
    const actor = captureProgressionActor(this.world, this.gameplay, () => this.readActor());
    const plan = actor && preparePotionConsumption(this.gameplay, this.effects, {
      hand: use.hand, handRevision, stack: cloneStack(stack, this.context),
    }, { catalog: this.catalog });
    if (!plan) return refusal("drink_rejected");
    const result = this.commit({
      ...plan, participants: plan.participants.map((participant, index) => index ? participant : {
        ...participant, validate: () => this.active && this._game.active === true &&
          actor.validate() && use.kind === "drink" &&
          use.elapsed >= POTION_DRINK_SECONDS - 1e-9 && participant.validate(),
      }),
    });
    if (result.ok) use.completeDrinkCycle();
    return result;
  }

  throwPotion(hand = "main") {
    if (!this.active || this._game.active !== true ||
        !["main", "offhand"].includes(hand)) return refusal("interaction_unavailable");
    const stack = this.gameplay.getHandStack(hand);
    return this.commit(this.potions.prepareThrow(this.gameplay, {
      hand, stack, handRevision: this.gameplay.getHandRevision(hand),
    }, { validate: () => this.active && this._game.active === true }));
  }

  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (!this.active || this._frameBusy || !Number.isFinite(dt) || dt < 0 ||
        typeof simulating !== "boolean") return refusal("progression_frame_unavailable");
    // Lifecycle checks don't rebuild offers, inventory projections or UI trees.
    if (this._session && !(this._session.kind === "trading"
      ? this._session.epoch === this.world.epoch &&
        this.traders.captureInteraction(this._session.npcId)
      : this.interactions.capture(this._session)))
      this.close("unavailable");
    if (!simulating || this._game.paused || this._game.building || this._game.failed ||
        this.gameplay.dead || dt === 0) return { ok: true, advanced: false };
    this._frameBusy = true;
    try {
      const elapsed = Math.min(dt, 0.25);
      const current = captureEntityContext(this.world, this.context);
      let effects = null, brewing = null;
      if (this.effects.hasActiveEffects) {
        const plan = prepareStatusAdvance(this.gameplay, this.effects, elapsed);
        if (plan?.participants.length)
          effects = this.coordinator.commit(plan.participants.map((participant, index) =>
            index ? participant : { ...participant,
              validate: () => this.active && current() && participant.validate() }));
      }
      if (this.active && !this.gameplay.dead && this.stations.brewingCount) {
        const advance = this.stations.prepareBrewingAdvance(elapsed, {
          validate: () => this.active && current() && !this.gameplay.dead,
        });
        if (advance?.participant) brewing = this.coordinator.commit([advance.participant]);
      }
      const potions = this.active ? this.potions.frame(elapsed) : null;
      this.observerErrors = [
        ...(effects?.observerErrors ?? []), ...(brewing?.observerErrors ?? []),
        ...(potions?.observerErrors ?? []),
      ];
      for (const error of this.observerErrors)
        if (error instanceof TransactionInvariantError) throw error;
      return { ok: true, advanced: true, effects, brewing, potions };
    } finally { this._frameBusy = false; }
  }

  /** Death/respawn never changes physical escrow or the player's table seed. */
  onDeath() {
    this.close("death");
    if (!this.active) return false;
    const participants = [];
    if (this.effects.hasActiveEffects) {
      const clear = this.effects.prepareClear(undefined, { notify: false });
      if (!clear) return false;
      participants.push(clear);
    }
    if (this.potions.size) {
      const cancel = this.potions.prepareCancel("death");
      if (!cancel?.participants) return false;
      participants.push(...cancel.participants);
    }
    return !participants.length || this.commit(progressionPlan(
      this.coordinator, participants, { ok: true, escrowRetained: true }
    )).ok;
  }

  onDimensionChange() {
    const closed = this.close("dimension");
    if (!this.active) return refusal("progression_not_live");
    if (!this.potions.size) return closed;
    const cancelled = this.commit(this.potions.prepareCancel("dimension"));
    return cancelled.ok ? { ...closed, ...cancelled, changed: true, escrowRetained: true } : cancelled;
  }

  serialize() {
    if (!this._available() || (this._game && !this.active) ||
        (!this._game && (this.world.epoch !== this._stageEpoch ||
          this.world.dimension !== this._stageDimension)))
      throw new Error("Cannot serialize stale progression services");
    return {
      version: PROGRESSION_SERVICES_VERSION,
      stations: this.stations.serialize(), statusEffects: this.effects.serialize(),
      trading: this.trading.serialize(), potionProjectiles: this.potions.serialize(),
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (this._frameBusy || this._actionBusy || !this.coordinator.release(this)) return false;
    this.stations?.dispose(); this.effects?.dispose();
    this.trading?.dispose(); this.potions?.dispose();
    this._session = null;
    this._disposed = true;
    if (this._game?.progressionServices === this) this._game.progressionServices = null;
    this._game = null;
    return true;
  }
}
