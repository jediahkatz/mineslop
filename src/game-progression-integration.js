import { captureEntityContext } from "./entity-context.js";
import { refusal, synchronous } from "./enchantment-domain.js";
import { ExperienceFeedback } from "./experience-feedback.js";
import { isValidExperience } from "./experience.js";
import { GameProgressionServices } from "./game-progression-services.js";
import { currentConduitServices, updatePlayerVisualEffects } from "./game-conduit-services.js";
import { normalizeProgressionArchive } from "./game-progression-state.js";
import { GameProjectileServices } from "./game-projectile-services.js";
import { Gameplay } from "./gameplay.js";
import { playerDamageKind } from "./player-damage-kind.js";
import { advancePlayerAir, airTickCount } from "./player-air-clock.js";
import { PLAYER_WIDTH } from "./player.js";
import { progressionPlan } from "./progression-station-interactions.js";
import { progressionStationKind } from "./progression-station-state.js";
import { TransactionInvariantError } from "./transactions.js";
import { ProgressionUI } from "./ui/progression-panel.js";
import { CHUNK_SIZE, World } from "./world.js";

export { normalizeProgressionArchive } from "./game-progression-state.js";

const canBind = (game, key, value) => {
  const property = Object.getOwnPropertyDescriptor(game, key);
  return property
    ? Object.hasOwn(property, "value") && property.configurable &&
      (property.value == null || property.value === value)
    : Object.isExtensible(game);
};

/** Synchronous, renderer/DOM-free candidate construction, suitable for owners[]. */
export function stageProgressionServices(options) {
  return new GameProgressionIntegration(options);
}

/**
 * The Game composition boundary. Stage beside the SAME candidate pearl host,
 * install World/Gameplay/Player, activate pearls, then activate this adapter.
 * `services` owns persisted progression; `feedback` and `ui` own presentation.
 * This never replaces game.effects, binds Gameplay.onChange, advances pearl life,
 * awards from an onCollect receipt, or returns cursor/station items on close.
 */
export class GameProgressionIntegration {
  constructor({
    world, gameplay, projectileServices, context = gameplay?.context,
    saved = null, allowOverBudget = saved != null,
  } = {}) {
    const archive = normalizeProgressionArchive(saved, context);
    const pearls = projectileServices?.projectiles;
    if (
      !(world instanceof World) || !(gameplay instanceof Gameplay) ||
      !(projectileServices instanceof GameProjectileServices) ||
      projectileServices.world !== world || projectileServices.gameplay !== gameplay ||
      projectileServices.coordinator !== world.coordinator || !pearls?.staged ||
      !synchronous(pearls.getOwner) || !archive ||
      archive.progression.potionProjectiles.ownerId !== pearls.ownerId ||
      archive.progression.potionProjectiles.projectiles.some((potion) => potion.life !== pearls.life)
    )
      throw new RangeError("Invalid staged progression integration");
    const services = new GameProgressionServices({
      world, gameplay, context, saved: archive.progression,
      ownerId: pearls.ownerId, allowOverBudget,
    });
    Object.defineProperties(this, Object.fromEntries(Object.entries({
      world, gameplay, projectileServices, pearls, services,
      coordinator: world.coordinator,
    }).map(([key, value]) => [key, { value, enumerable: true }])));
    this.feedback = new ExperienceFeedback();
    this._ownerBridge = pearls.getOwner;
    this._game = this._player = this.ui = null;
    this._disposed = this._actionBusy = this._frameBusy = this._rewardBusy = false;
    this._feedbackVisible = false;
    this.observerErrors = [];
  }

  get active() {
    const game = this._game;
    return !this._disposed && !!game &&
      game.progressionIntegration === this && game.progressionServices === this.services &&
      game.world === this.world && game.gameplay === this.gameplay &&
      game.player === this._player && game.player?.world === this.world &&
      game.projectileServices === this.projectileServices && game.projectiles === this.pearls &&
      this.projectileServices.projectiles === this.pearls &&
      this.pearls.getOwner === this._ownerBridge &&
      this.projectileServices.active && this.services.active;
  }

  get running() {
    const game = this._game;
    return this.active && game.simulating === true && !game.paused &&
      !game.building && !game.failed && !this.gameplay.dead;
  }

  get isOpen() { return this.services.isOpen; }
  get gear() { return this.active ? this.services.gear : null; }

  /**
   * root is the actual #ui. headless:true is an explicit no-DOM test/server use,
   * not a fallback that opens an invisible modal in the browser.
   * onSessionChange owns Game input/pointer-lock transitions, never item payment.
   * Ecology remains optional, but trading is unavailable until its REAL host is
   * active, bound to this Wildlife, and shares this exact trading owner.
   */
  activate(game, {
    root = null, headless = false,
    onSessionChange, getEcologyServices = () => game?.ecologyServices,
    onProjectileEvent,
  } = {}) {
    if (this._game)
      return this._game === game && this.active ? { ok: true } : refusal("already_activated");
    if (this._disposed || !game || game.world !== this.world ||
        game.gameplay !== this.gameplay || game.player?.world !== this.world ||
        game.projectileServices !== this.projectileServices ||
        game.projectiles !== this.pearls || !this.projectileServices.active ||
        this.pearls.getOwner !== this._ownerBridge)
      return refusal("stale_progression_host");
    if (!canBind(game, "progressionIntegration", this))
      return refusal("progression_host_owned");
    if (this.gameplay.damageHost && this.gameplay.damageHost !== this)
      return refusal("damage_host_owned");
    if (this.gameplay.airHost && this.gameplay.airHost !== this)
      return refusal("air_host_owned");
    if (this.services.potions.projectiles.some((potion) => potion.life !== this.pearls.life))
      return refusal("stale_progression_stage");
    if (typeof headless !== "boolean" || (!root && !headless) ||
        (root && (root.ownerDocument !== game.player.element?.ownerDocument ||
          !synchronous(root.append))))
      return refusal("missing_progression_ui");
    const sessionChange = onSessionChange ?? (synchronous(game.overlayChanged)
      ? (open) => game.overlayChanged(open) : null);
    if (![sessionChange, getEcologyServices].every(synchronous) ||
        (onProjectileEvent !== undefined && !synchronous(onProjectileEvent)))
      return refusal("invalid_progression_bridge");

    const ecologyHost = () => {
      if (!this.active) return null;
      const host = getEcologyServices();
      return host?.active === true && host.world === this.world &&
        host.gameplay === this.gameplay && host.coordinator === this.coordinator &&
        host.trading === this.services.trading && host.wildlife === game.wildlife &&
        game.wildlife?.ecologyServices === host && synchronous(host.readRuntimeContext)
        ? host : null;
    };
    let ui = null;
    try {
      if (root) ui = new ProgressionUI(root, {
        readView: (options) => this.view(options),
        readRevision: () => this.active ? this.services.viewRevision : null,
        onAction: (action) => this.action(action),
        onClose: (reason) => this.close(reason),
      });
      const activated = this.services.activate(game, {
        // Intentionally the same function object PlayerProjectiles uses.
        getOwner: this._ownerBridge,
        getEcology: () => ecologyHost()?.ecology ?? null,
        getEcologyContext: () => ecologyHost()?.readRuntimeContext() ?? null,
        onSessionChange: (open, session, reason) => {
          if (!this.active) return;
          if (open && this.ui && !this.ui.open()) {
            this.services.close("unavailable");
            return;
          }
          if (!open) this.ui?.hide();
          sessionChange(open, session, reason);
        },
        onChange: () => this._changed(),
        onProjectileEvent: (event) => {
          this._changed();
          if (this.active) onProjectileEvent?.(event);
        },
      });
      if (!activated.ok) { ui?.dispose(); return activated; }
      Object.defineProperty(game, "progressionIntegration", {
        value: this, configurable: true, writable: true, enumerable: true,
      });
      this._game = game;
      this._player = game.player;
      this.gameplay.damageHost = this;
      this.gameplay.airHost = this;
      this.ui = ui;
      this.feedback.reset();
      return activated;
    } catch (error) {
      ui?.dispose();
      throw error;
    }
  }

  _observe(callback) {
    try { callback(); } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      this.observerErrors.push(error);
      if (this.observerErrors.length > 16) this.observerErrors.shift();
    }
  }

  _changed() {
    if (!this.active) return;
    this._observe(() => this._game.scheduleSave?.());
    if (this.active) this._observe(() => this._game.refreshHud?.());
  }

  _captureRewardHost() {
    if (!this.running) return null;
    const owner = this._ownerBridge(this.pearls.ownerId);
    if (!owner || owner.ref !== this._player || owner.world !== this.world ||
        owner.dimension !== this.world.dimension || owner.alive !== true ||
        owner.id !== this.pearls.ownerId || owner.life !== this.pearls.life)
      return null;
    const current = captureEntityContext(this.world, this.gameplay.context);
    return () => this.running && current() &&
      this._player === owner.ref && this.pearls.life === owner.life;
  }

  /** One replacement damage transaction; never recurse through Gameplay.damage. */
  prepareDamage(amount, cause = "injury", kind) {
    const current = this._captureRewardHost();
    if (!current || this.gameplay.damageHost !== this ||
        !Number.isFinite(amount) || amount <= 0)
      return null;
    return this.services.gear.prepareDamage(amount, {
      cause,
      kind: playerDamageKind(cause, kind),
      validate: () => this.gameplay.damageHost === this && current(),
    });
  }

  damage(amount, cause, kind) {
    const plan = this.prepareDamage(amount, cause, kind);
    const result = plan && this.commit(plan);
    return result?.ok ? result.damage : 0;
  }

  /** Read PRE-status-tick protection; Gameplay alone consumes the elapsed time. */
  breathingProtection(dt) {
    return this.running
      ? this.services.gear.breathing(this.gameplay.air, dt).protectedSeconds
      : 0;
  }

  /** Re-read live boots and the physical grounded flag every physics substep. */
  waterMovement(onGround) {
    return this.running && !this._player.seated
      ? this.services.gear.waterMovement({ onGround })
      : null;
  }

  prepareAir(dt, options) {
    const current = this._captureRewardHost();
    if (!current || this.gameplay.airHost !== this ||
        !Number.isFinite(dt) || dt <= 0 || dt > 0.25 ||
        !options || typeof options.underwater !== "boolean" ||
        typeof options.restoreAir !== "boolean" ||
        !Number.isFinite(options.protectedSeconds) ||
        options.protectedSeconds < 0 || options.protectedSeconds > dt)
      return null;
    // Conduit is a current resident observation, never a saved StatusEffect.
    // Potion seconds were observed PRE-tick by Game; combine, don't add.
    const conduit = options.underwater && !options.restoreAir && options.protectedSeconds < dt
      ? currentConduitServices(this._game)?.observePlayer() : null;
    if (conduit?.validate())
      options = { ...options, protectedSeconds: Math.max(options.protectedSeconds, dt) };
    // A proven no-change air step needs neither equipment observations nor an
    // inventory draft. Never take this path for ANY exposed underwater time:
    // even a sub-tick step must save its fractional clock (and later its RNG).
    if (this.gameplay.air === 20 && this.gameplay.airPhase === 0 &&
        this.gameplay._timers.drowning === 0 &&
        (!options.underwater || options.restoreAir || options.protectedSeconds === dt))
      return null;
    const playerRef = this._player, poseRevision = playerRef.poseRevision;
    const columns = new Map();
    for (const dx of [-PLAYER_WIDTH / 2, PLAYER_WIDTH / 2])
      for (const dz of [-PLAYER_WIDTH / 2, PLAYER_WIDTH / 2]) {
        const key = `${Math.floor((playerRef.position.x + dx) / CHUNK_SIZE)},${Math.floor((playerRef.position.z + dz) / CHUNK_SIZE)}`;
        const chunk = this.world.chunks.get(key);
        if (!chunk) return null;
        columns.set(key, { chunk, revision: chunk.revision });
      }
    // Capture here, AFTER Game's pre-tick protection observation and status
    // advancement. Later effect or fluid-cell publication invalidates the plan.
    const effects = this.services.effects, effectsRevision = effects.revision;
    const gear = this.services.gear;
    const exposed = options.underwater && !options.restoreAir
      ? Math.max(0, dt - options.protectedSeconds) : 0;
    const respiration = exposed > 0 &&
      gear.enchantmentLevel(this.gameplay.getEquipmentStack("head"), "respiration") > 0;
    const draws = respiration
      ? airTickCount(options.protectedSeconds > 0 ? 0 : this.gameplay.airPhase, exposed)
      : 0;
    const valid = () => this.gameplay.airHost === this && current() &&
      (!conduit || conduit.validate()) &&
      playerRef.poseRevision === poseRevision &&
      this.services.effects === effects && effects.revision === effectsRevision &&
      [...columns].every(([key, { chunk, revision }]) =>
        this.world.chunks.get(key) === chunk && chunk.revision === revision);
    const random = draws ? this.services.stations.prepareRandom(draws, { validate: valid }) : null;
    if (draws && !random) return null;
    let hits = 0;
    const player = this.gameplay._prepareState((draft) => {
      hits = advancePlayerAir(draft, dt, {
        ...options, respiration,
        losesAir: (index) => gear.respirationAirLoss(random.rolls[index]) === 1,
      });
      return true;
    }, { notify: false });
    return player ? progressionPlan(this.coordinator, [
      { ...player, validate: () => valid() && player.validate() },
      ...(random ? [random.participant] : []),
    ], { ok: true, hits }) : null;
  }

  // Called ONLY inside Gameplay.update's sole air clock. A stale host freezes
  // air instead of falling back to unguarded/unenchantable breathing.
  advanceAir(dt, options) {
    const plan = this.prepareAir(dt, options);
    const result = plan && this.commit(plan);
    return result?.ok ? result.hits : 0;
  }

  prepareShieldBlock(hand, amount, validate) {
    const current = this._captureRewardHost();
    if (!current || this.gameplay.damageHost !== this || !synchronous(validate) ||
        !["main", "offhand"].includes(hand) || !Number.isFinite(amount) || amount <= 0)
      return null;
    return this.services.gear.prepareHitWear([{
      area: hand === "offhand" ? "offhand" : "inventory",
      index: hand === "offhand" ? 0 : this.gameplay.selected,
      amount: Math.max(1, Math.ceil(amount) + 1),
    }], {
      selfUseHands: [hand],
      validate: () => this.gameplay.damageHost === this && current() && validate(),
    });
  }

  _showFeedback(view) {
    if (!this.active) return;
    if (!view.visible && !this._feedbackVisible) return;
    this._feedbackVisible = view.visible;
    this._observe(() => this._game.ui?.update?.({ experienceFeedback: view }));
  }

  _feedbackView() {
    return this.feedback.view({
      visible: this.running && this._game.active === true &&
        this._game.ui?.isHudVisible !== false && this.gameplay.mode === "survival",
    });
  }

  _earned(receipt, current) {
    if (!current() || this.gameplay.mode !== "survival") return;
    const event = this.feedback.earned(receipt);
    if (!event) return;
    if (event.soundLevel !== null)
      this._observe(() => this._game.effects?.sound?.("levelup", event.soundLevel));
    else
      this._observe(() => this._game.effects?.sound?.("xp", event.amount));
    this._showFeedback(this._feedbackView());
    this._changed();
  }

  _rewardParticipant(participant, amount, current) {
    if (!participant || participant.owner !== this.gameplay ||
        !Number.isSafeInteger(amount) || amount <= 0)
      return null;
    const previousTotal = this.gameplay.getState().experience.total;
    if (!isValidExperience(previousTotal + amount)) return null;
    const receipt = Object.freeze({ previousTotal, total: previousTotal + amount });
    let published = false, notified = false;
    return Object.freeze({
      ...participant,
      validate: () => current() && participant.validate(),
      publish: () => { participant.publish(); published = true; },
      notify: () => {
        if (!published || notified) return;
        notified = true;
        // Both owners already published. Observer failure cannot turn a paid
        // reward into a retry or skip the original Gameplay notification.
        try { participant.notify?.(); }
        finally { this._earned(receipt, current); }
      },
    });
  }

  /** Ordinary XP (no Mending/RNG), e.g. an explicitly composed station reward. */
  prepareExperience(amount) {
    const current = this._captureRewardHost();
    if (!current || !Number.isSafeInteger(amount) || amount <= 0) return null;
    return this._rewardParticipant(this.gameplay.prepareExperience(amount), amount, current);
  }

  /**
   * Game.awardExperience's failed-orb-spawn fallback: immediately collect the
   * same Mending reward without creating/retiring an orb. Ordinary station/trade
   * XP uses its own Gameplay participant, never this collection fallback.
   */
  earnExperience(amount) {
    if (this._rewardBusy) return refusal("experience_busy");
    this._rewardBusy = true;
    try {
      const plan = this.prepareMending(amount);
      return plan ? this.commit(plan) : refusal("experience_unavailable");
    } finally { this._rewardBusy = false; }
  }

  /**
   * Detached Mending receiver for physical XP. ExperienceOrbs composes these
   * Gameplay + station RNG participants with its own removal in ONE commit.
   * Gameplay already includes leftover XP; never also credit the original amount.
   */
  prepareMending(amount, { participants = [], validate = () => true } = {}) {
    const current = this._captureRewardHost();
    if (!current || !synchronous(validate) || !isValidExperience(amount) || amount === 0)
      return null;
    const valid = () => current() && validate() === true;
    const plan = this.services.gear.prepareMending(amount, { participants, validate: valid });
    return this._guardPlan(plan, valid, plan?.result?.experienceRemaining ?? 0);
  }

  _guardPlan(plan, current, experience = 0) {
    if (!plan?.participants) return plan ?? refusal("invalid_plan");
    const participants = plan.participants.map((participant, index) =>
      experience > 0 && participant.owner === this.gameplay
        ? this._rewardParticipant(participant, experience, current)
        : index === 0
          ? Object.freeze({ ...participant, validate: () => current() && participant.validate() })
          : participant
    );
    return progressionPlan(this.coordinator, participants, plan.result);
  }

  openStation(hit) {
    if (!progressionStationKind(hit?.id)) return { ok: false, handled: false };
    if (!this.running) return { ...refusal("stale_progression_host"), handled: true };
    return { ...this.services.openStation(hit), handled: true };
  }

  openTrader(id) {
    return this.running ? this.services.openTrader(id) : refusal("stale_progression_host");
  }

  onVillagerIntent(id, observation) {
    return this.running ? this.services.onVillagerIntent(id, observation) : null;
  }

  fillBottle(hand = "main") {
    return this.running ? this.services.fillBottle(hand) : refusal("stale_progression_host");
  }

  completeDrink(use) {
    return this.running ? this.services.completeDrink(use) : refusal("stale_progression_host");
  }

  throwPotion(hand = "main") {
    return this.running ? this.services.throwPotion(hand) : refusal("stale_progression_host");
  }

  prepareStationRemoval(changes, { validate = () => true, ...options } = {}) {
    const current = this._captureRewardHost();
    if (!current || !synchronous(validate)) return refusal("stale_progression_host");
    return this.services.prepareStationRemoval(changes, {
      ...options, validate: () => current() && validate() === true,
    });
  }

  view(options) { return this.active ? this.services.view(options) : null; }

  prepareAction(action) {
    const current = this._captureRewardHost();
    if (!current) return refusal("stale_progression_host");
    const plan = this.services.prepareAction(action);
    // Only an actual paid trade receipt can report player XP. Generic inventory
    // snapshots, enchanting/anvil level spending and UI refreshes cannot do so.
    const experience = action?.type === "trade" && plan?.result?.experienceCommitted
      ? plan.result.playerXp : 0;
    return this._guardPlan(plan, current, experience);
  }

  action(action) {
    if (this._actionBusy) return refusal("progression_busy");
    this._actionBusy = true;
    try { return this.commit(this.prepareAction(action)); }
    finally { this._actionBusy = false; }
  }

  commit(plan) {
    if (!this.active) return refusal("stale_progression_host");
    const result = this.services.commit(plan);
    if (result.ok && (result.chargedLevels ?? result.levelCost ?? 0) > 0) {
      this.feedback.spent();
      this._showFeedback(this.feedback.view());
    }
    return result;
  }

  close(reason = "closed") {
    const result = this.services.close(reason);
    if (!this.services.isOpen) this.ui?.hide();
    return result;
  }

  frame(dt, { simulating = this._game?.simulating === true } = {}) {
    if (!this.active || this._frameBusy || !Number.isFinite(dt) || dt < 0 ||
        typeof simulating !== "boolean")
      return refusal("progression_frame_unavailable");
    this._frameBusy = true;
    try {
      const result = this.services.frame(dt, { simulating: simulating && this.running });
      if (!this.active) return result;
      this.ui?.frame(dt);
      this._showFeedback(this.feedback.update(dt, {
        simulating: simulating && this.running,
        visible: this._game.active === true && this._game.ui?.isHudVisible !== false,
        dead: this.gameplay.dead, mode: this.gameplay.mode,
      }));
      return result;
    } finally { this._frameBusy = false; }
  }

  resetFeedback() {
    this.feedback.reset();
    this._showFeedback(this.feedback.view());
  }

  /** Parent renews pearl life once; this hook never increments a separate life. */
  onDeath() {
    if (this._game) currentConduitServices(this._game)?.reset();
    if (this._game) updatePlayerVisualEffects(this._game, { reset: true });
    this.resetFeedback();
    return this.active && this.services.onDeath();
  }

  onRespawn() {
    if (this._game) currentConduitServices(this._game)?.reset();
    this.resetFeedback();
    return this.close("respawn");
  }

  /** Call BEFORE teleport/dimension mutation, and honor a refusal. */
  beforeTravel() {
    if (this._game) currentConduitServices(this._game)?.reset();
    if (this._game) updatePlayerVisualEffects(this._game, { reset: true });
    this.resetFeedback();
    return this.active ? this.services.onDimensionChange() : refusal("stale_progression_host");
  }

  serialize() {
    if (this._disposed || this.projectileServices.projectiles !== this.pearls ||
        this.pearls.getOwner !== this._ownerBridge ||
        this.projectileServices.world !== this.world ||
        this.projectileServices.gameplay !== this.gameplay ||
        this.coordinator.usage(this.pearls) !== this.pearls.reservedBytes ||
        (this._game && !this.active))
      throw new Error("Cannot serialize stale progression integration");
    return { progression: this.services.serialize() };
  }

  dispose() {
    if (this._disposed) return true;
    if (this._actionBusy || this._frameBusy || !this.services.dispose()) return false;
    this.feedback.dispose();
    this.ui?.dispose();
    if (this._game?.progressionIntegration === this) {
      if (this._feedbackVisible)
        this._observe(() => this._game.ui?.update?.({ experienceFeedback: this.feedback.view() }));
      this._game.progressionIntegration = null;
    }
    this._disposed = true;
    this._game = this._player = this.ui = null;
    return true;
  }
}
