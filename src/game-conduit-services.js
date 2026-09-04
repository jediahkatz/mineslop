import { ecologyBodySample } from "./aquatic-ai.js";
import { isWaterFluid } from "./block-state.js";
import { ConduitIndex, CONDUIT_LIMITS } from "./conduit-index.js";
import { inConduitRange } from "./conduit-rules.js";
import { sampleFluid } from "./fluid-sampling.js";
import { MAX_MOBS } from "./mob-species.js";

const aquaticHostiles = new Set(["drowned", "guardian", "elder_guardian"]);
const samePoint = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const hidden = (game) => game.player?.element?.ownerDocument?.hidden === true;

export function currentConduitServices(game) {
  const host = game.conduitServices;
  return host?.game === game && host.world === game.world &&
    host.gameplay === game.gameplay && host.player === game.player && host.active
    ? host : null;
}

/** A derived, zero-save owner. Rebuilt from world cells; never creates potions. */
export class GameConduitServices {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.gameplay = game.gameplay;
    this.player = game.player;
    this.progression = game.progressionIntegration;
    this.index = new ConduitIndex(this.world);
    this.cooldowns = new Map();
    this.disposed = false;
    this.attackOrder = [];
    this._syncLife();
  }

  get attackCursor() { return this.attackOrder[0] ?? null; }

  get active() {
    const game = this.game;
    return !this.disposed && game.conduitServices === this &&
      game.world === this.world && !this.world._disposed &&
      game.gameplay === this.gameplay && game.player === this.player &&
      this.player?.world === this.world &&
      game.progressionIntegration === this.progression &&
      this.progression?.active === true;
  }

  get available() {
    return this.active && !this.game.building && !this.game.failed && !this.gameplay.dead;
  }

  get running() {
    return this.available && this.game.simulating === true && !this.game.paused && !hidden(this.game);
  }

  _syncLife() {
    const epoch = this.world.epoch, life = this.progression?.pearls?.life;
    if (this.epoch !== epoch || this.life !== life || this.dimension !== this.world.dimension) {
      this.index.reset();
      this.cooldowns.clear();
      this.attackOrder.length = 0;
      this.epoch = epoch;
      this.life = life;
      this.dimension = this.world.dimension;
    }
  }

  reset() {
    this.index.reset();
    this.cooldowns.clear();
    this.attackOrder.length = 0;
  }

  _guard() {
    this._syncLife();
    const { epoch, life, dimension } = this;
    return () => this.available && this.world.epoch === epoch &&
      this.world.dimension === dimension && this.progression.pearls.life === life;
  }

  _playerWater() {
    // Fresh physical body/eye sampling, not Player's previous render snapshot.
    return sampleFluid(this.world, this.player.position, {
      height: this.player.height ?? 1.8, radius: 0.3,
      eyeHeight: this.player.eyeHeight ?? 1.62,
    });
  }

  observePlayer() {
    if (!this.available) return null;
    const current = this._guard();
    if (!this.index.sources.size || this.index.overflow) return null;
    const sample = this._playerWater();
    if (!sample.valid || !sample.loaded || !sample.eyeLoaded || sample.waterImmersion <= 0)
      return null;
    const point = { ...this.player.position }, pose = this.player.poseRevision;
    const revision = this.world._editRevision;
    for (const position of this.index.sources.values()) {
      const observation = this.index.observe(position);
      if (!observation || !inConduitRange(observation.value.center, point, observation.value.radius))
        continue;
      const validate = () => current() && observation.validate() &&
        this.world._editRevision === revision && this.player.poseRevision === pose &&
        samePoint(this.player.position, point) &&
        // Unload is not a cell revision. Recheck wet/known coverage at use.
        (() => {
          const wet = this._playerWater();
          return wet.valid && wet.loaded && wet.eyeLoaded && wet.waterImmersion > 0;
        })();
      return Object.freeze({ ...observation.value, validate });
    }
    return null;
  }

  onChunkLoaded(world, event) { return this.index.onChunkLoaded(world, event); }

  onMutation(world, event) {
    const accepted = this.index.onMutation(world, event);
    if (accepted) {
      // Invalidate interrupted attack clocks even if a frame is removed and
      // rebuilt before the next simulation frame.
      for (const [key, cooldown] of this.cooldowns)
        if (!this.index.observe(cooldown.position)?.value.attacks) this.cooldowns.delete(key);
      this.attackOrder = this.attackOrder.filter((key) => this.cooldowns.has(key));
    }
    return accepted;
  }

  _ecology() {
    const host = this.game.ecologyServices;
    return host?.active === true && host.world === this.world &&
      host.gameplay === this.gameplay && host.wildlife === this.game.wildlife &&
      this.game.wildlife?.ecologyServices === host ? host : null;
  }

  _targetWet(host, mob, source) {
    if (!mob || mob.dead || mob.dormant || !aquaticHostiles.has(mob.kind) ||
        host.wildlife.byId.get(mob.id) !== mob ||
        !inConduitRange(source.center, mob.position, 8)) return false;
    const wet = ecologyBodySample(this.world, mob.position, mob.spec);
    return !!wet && wet.waterImmersion > 0;
  }

  /** Environmental transaction only: no direct health, player XP or retaliation. */
  prepareAttack(position) {
    if (!this.running) return null;
    const current = this._guard(), source = this.index.observe(position), host = this._ecology();
    if (!source?.value.attacks || !host || host.wildlife.entities.length > MAX_MOBS) return null;
    const mob = host.wildlife.entities.find((entity) => this._targetWet(host, entity, source.value));
    if (!mob) return null;
    const point = { ...mob.position }, revision = this.world._editRevision;
    return host.prepareHit(mob.id, 4, { x: 0, y: 0, z: 0 }, {
      playerKill: false, retaliate: false,
      validate: () => current() && this.running && this._ecology() === host &&
        source.validate() && this.world._editRevision === revision &&
        samePoint(mob.position, point) && this._targetWet(host, mob, source.value),
    });
  }

  frame(dt) {
    if (!this.active) return;
    this._syncLife();
    this.index.step();
    if (!this.available) {
      this.cooldowns.clear();
      this.attackOrder.length = 0;
      return;
    }
    if (!this.running || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, 0.25);
    const retained = new Set();
    for (const [key, position] of this.index.sources) {
      const source = this.index.observe(position);
      if (!source?.value.attacks) { this.cooldowns.delete(key); continue; }
      retained.add(key);
      const cooldown = this.cooldowns.get(key) ?? { position, elapsed: 0 };
      cooldown.elapsed = Math.min(2, cooldown.elapsed + dt);
      this.cooldowns.set(key, cooldown);
    }
    for (const key of this.cooldowns.keys()) if (!retained.has(key)) this.cooldowns.delete(key);
    // A bounded circular queue of SOURCE identities, independent of readiness
    // and of the discovery Map's order. Admissions join behind waiting peers;
    // removing the cursor retains its next surviving peer. Rotate only past
    // the last attempted source, including no-target and vetoed attempts.
    this.attackOrder = this.attackOrder.filter((key) => this.cooldowns.has(key));
    const queued = new Set(this.attackOrder);
    for (const key of this.cooldowns.keys())
      if (!queued.has(key)) this.attackOrder.push(key);
    const order = this.attackOrder;
    let attempts = 0, lastAttempted = -1;
    for (let i = 0; i < order.length && attempts < CONDUIT_LIMITS.attacksPerStep; i++) {
      const cooldown = this.cooldowns.get(order[i]);
      if (!cooldown || cooldown.elapsed < 2 - 1e-9) continue;
      cooldown.elapsed = 0;
      attempts++;
      lastAttempted = i;
      const plan = this.prepareAttack(cooldown.position);
      if (plan) this._ecology()?.commit(plan);
    }
    if (lastAttempted >= 0) order.push(...order.splice(0, lastAttempted + 1));
    this.attackOrder = order.filter((key) => this.cooldowns.has(key));
  }

  dispose() {
    this.disposed = true;
    this.reset();
    return true;
  }
}

/** Called immediately before graphics.update, including paused appearance. */
export function updatePlayerVisualEffects(game, { reset = false } = {}) {
  const host = game.progressionIntegration;
  const current = !reset && !game.building && !game.failed && !game.gameplay?.dead &&
    game.player?.world === game.world && host?.active === true &&
    host.world === game.world && host.gameplay === game.gameplay;
  const strength = current ? host.gear?.lighting?.strength : 0;
  const observation = current ? currentConduitServices(game)?.observePlayer() : null;
  const effects = {
    nightVision: Number.isFinite(strength) ? Math.max(0, Math.min(1, strength)) : 0,
    conduitPower: !!observation && observation.validate(),
  };
  game.graphics?.setPlayerVisualEffects?.(effects);
  return effects;
}

/** Actual Game.primary duration, with raw tool stats passed to gear exactly once. */
export function gameMiningDuration(game, blockId) {
  const host = game.progressionIntegration;
  if (host?.active !== true || host.world !== game.world || host.gameplay !== game.gameplay)
    return game.gameplay.miningDuration(blockId);
  const sample = sampleFluid(game.world, game.player.position, {
    height: game.player.height ?? 1.8, radius: 0.3, eyeHeight: game.player.eyeHeight ?? 1.62,
  });
  if (!sample.valid || !sample.loaded || !sample.eyeLoaded) return Infinity;
  const observation = currentConduitServices(game)?.observePlayer();
  const conduitPower = !!observation && observation.validate();
  const ecology = game.ecologyServices;
  const fatigue = ecology?.active === true && ecology.world === game.world &&
    ecology.gameplay === game.gameplay && ecology.wildlife === game.wildlife
    ? ecology.modifiers().miningSpeedMultiplier : 1;
  return game.gameplay.miningDuration(blockId, {
    modifySpeed: (base, effectiveTool, tool) => host.gear.miningSpeed(base, tool, {
      effectiveTool, submerged: isWaterFluid(sample.eyeFluid),
      onGround: game.player.grounded === true, conduitPower,
    }) * fatigue,
  });
}
