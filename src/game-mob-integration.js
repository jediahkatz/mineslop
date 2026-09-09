import * as THREE from "three";
import { ExperienceOrbs } from "./experience-orbs.js";
import { GameEcologyMarkers } from "./game-ecology-markers.js";
import { GameEcologyServices } from "./game-ecology-services.js";
import { GameIngredientMobActions } from "./game-ingredient-mob-actions.js";
import { GameMobPotionImpact } from "./game-mob-potion-impact.js";
import { GameplayLightScratch, readGameplayHabitat } from "./gameplay-light.js";
import { normalizeGameMobArchive, snapshotGameMobs } from "./game-mob-state.js";
import { normalizeVehicleServicesSnapshot } from "./game-vehicle-state.js";
import { normalizeDifficulty } from "./mob-difficulty.js";
import { MobStatusEffects } from "./mob-status-effects.js";
import { isDaylight } from "./mob-species.js";
import { Wildlife } from "./wildlife.js";

const point = ({ x, y, z }) => ({ x, y, z });

/**
 * Game composition only. Ecology is the sole ecology owner, Horses the sole
 * horse sidecar, and Wildlife the sole base/renderer. The temporary Scene has
 * no renderer/WebGL context or live callbacks; the same owners move into Game.
 */
export class GameMobIntegration {
  constructor({
    world, gameplay, overflow, context, progressionIntegration,
    explorationServices = null, saved = null,
  }) {
    const vehicles = normalizeVehicleServicesSnapshot(saved, context);
    if (!vehicles) throw new Error("Invalid candidate horse state");
    const archive = normalizeGameMobArchive(saved, context, world.dimension, {
      horses: vehicles.horses, exploration: explorationServices?.exploration.serialize(),
    });
    Object.assign(this, {
      world, gameplay, overflow, context, progressionIntegration, explorationServices,
      vehicleServices: null, _game: null, _disposed: false,
      _stageEpoch: world.epoch, _stageDimension: world.dimension,
      habitatLightWork: { queries: 0, cellReads: 0, queuedCells: 0 },
      habitatLightScratch: new GameplayLightScratch(),
    });
    this._initialHorses = vehicles.horses;
    this._savedActive = archive.mobs;
    this.wildlife = null;
    this.scene = new THREE.Scene();
    this.markers = new GameEcologyMarkers(explorationServices?.index);
    try {
      this.mobStatusEffects = new MobStatusEffects({
        coordinator: world.coordinator,
        context,
        state: archive.mobStatusEffects,
        mobsByDimension: archive.mobStates,
        allowOverBudget: saved != null,
      });
      this.experienceOrbs = new ExperienceOrbs(this.scene, world, {
        context, coordinator: world.coordinator,
        prepareCollect: (amount) => this._current()
          ? this.progressionIntegration.prepareMending(amount, {
              validate: () => this._current(),
            }) : null,
        onCollect: () => { if (this._current()) this._game.scheduleSave?.(); },
      });
      if (!this.experienceOrbs.load(saved?.experienceOrbs, { context, allowOverBudget: saved != null }))
        throw new Error("Invalid candidate experience orbs");
      this.ecologyServices = new GameEcologyServices({
        world, gameplay, overflow, context, experienceOrbs: this.experienceOrbs,
        exploration: explorationServices?.exploration,
        trading: progressionIntegration.services.trading,
        markers: this.markers, saved: archive.ecology, allowOverBudget: saved != null,
        readHabitat: (...args) => this.readHabitat(...args),
        observeLootAvailability: (descriptors) => {
          const current = () => this._current() &&
            this.explorationServices === explorationServices &&
            (this._game.explorationServices ?? null) === explorationServices &&
            this.markers.index === explorationServices?.index;
          if (!current()) return null;
          const observed = explorationServices
            ? explorationServices.observeLootAvailability(descriptors)
            : { structures: Object.freeze([]), validate: () => true };
          return observed && Object.freeze({
            structures: observed.structures,
            validate: () => current() && observed.validate(),
          });
        },
        // Owner API: normalization/activate/serialize must consult this current
        // sidecar, not the initial load (tracking and tombstones change in play).
        readHorses: () => this.horseSnapshot(),
        readPlayer: () => this.readPlayer(),
        isTrading: (id) => {
          const session = this._current() && this.progressionIntegration.services.session;
          return session?.kind === "trading" && session.npcId === id;
        },
        prepareVillagerDeath: ({ entityId, dimension }) => {
          const game = this._game, wildlife = this.wildlife;
          const mob = wildlife?.byId.get(entityId);
          const plan = this._current() &&
            this.progressionIntegration.services.prepareVillagerJobsiteRelease(entityId, {
              validate: () => this._current() && this._game === game &&
                this.world.dimension === dimension && this.wildlife === wildlife &&
                wildlife.byId.get(entityId) === mob && !mob.dead,
            });
          return plan?.participants?.length === 1 &&
            plan.participants[0].owner === this.progressionIntegration.services.trading
            ? plan.participants[0] : null;
        },
        onVillagerIntent: (id, intent) => {
          if (this._current()) this.progressionIntegration.onVillagerIntent(id, intent);
        },
        onEffectsChanged: (modifiers) => {
          if (this._current()) this._game.ecologyModifiers = Object.freeze({ ...modifiers });
        },
        onChange: () => { if (this._current()) this._game.scheduleSave?.(); },
      });
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  horseSnapshot() {
    return this.vehicleServices ? this.vehicleServices.horses.serialize() : this._initialHorses;
  }

  readHabitat(position, candidateWorld, kind, spawn) {
    if (candidateWorld !== this.world || !this._current()) return null;
    if (kind !== "drowned") return readGameplayHabitat(candidateWorld, position);
    const stats = {};
    const habitat = readGameplayHabitat(candidateWorld, position, {
      light: true,
      skipBlockAboveSky: isDaylight(spawn?.timeOfDay) ? 7 : undefined,
      stats,
      scratch: this.habitatLightScratch,
    });
    for (const key of ["queries", "cellReads", "queuedCells"]) {
      const amount = key === "queries" ? 1 : stats[key] ?? 0;
      this.habitatLightWork[key] = Math.min(
        Number.MAX_SAFE_INTEGER, this.habitatLightWork[key] + amount
      );
    }
    return habitat;
  }

  /** Load the real detached Horses leaf BEFORE restoring its paired base. */
  stageWildlife(vehicles) {
    if (this._disposed || this._game || this.wildlife || this.vehicleServices ||
        vehicles.world !== this.world || vehicles.gameplay !== this.gameplay ||
        vehicles.experienceOrbs !== this.experienceOrbs ||
        JSON.stringify(vehicles.horses.serialize()) !== JSON.stringify(this._initialHorses))
      throw new Error("Invalid staged horse owner");
    this.vehicleServices = vehicles;
    try {
      this.wildlife = this._restoreBase(this._savedActive, this.scene);
      if (!vehicles.stageWildlife(this.wildlife))
        throw new Error("Cannot pair staged horses and Wildlife");
      this._savedActive = null;
      return this.wildlife;
    } catch (error) {
      this.wildlife?.dispose();
      this.wildlife = null;
      this.vehicleServices = null;
      throw error;
    }
  }

  _current() {
    const game = this._game;
    return !this._disposed && !!game && game.mobIntegration === this &&
      game.world === this.world && game.gameplay === this.gameplay &&
      game.overflow === this.overflow && game.experienceOrbs === this.experienceOrbs &&
      game.ecologyServices === this.ecologyServices && game.wildlife === this.wildlife &&
      this.ecologyServices?.active === true && !this.wildlife?.disposed;
  }

  readPlayer() {
    const game = this._game, player = game?.player;
    // Activation reads before ecology.active becomes visible, so check the
    // installed identities independently of _current().
    if (!game || game.mobIntegration !== this || game.world !== this.world ||
        game.gameplay !== this.gameplay || player?.world !== this.world ||
        game.wildlife !== this.wildlife) return null;
    const pose = game.vehicleServices?.poseForArchive();
    const position = pose?.position ?? player.position;
    const eye = pose ? { ...point(position), y: position.y + player.eyeHeight } : player.eyePosition;
    return {
      position: point(position), eye: point(eye), dimension: this.world.dimension,
      targetKey: `${this.progressionIntegration.pearls.ownerId}:${this.progressionIntegration.pearls.life}`,
      health: this.gameplay.health, mode: this.gameplay.mode,
      swimming: player.fluidState?.waterImmersion >= 0.35,
      invulnerable: this.gameplay.mode === "creative",
    };
  }

  _restoreBase(saved, scene) {
    const wildlife = new Wildlife(scene, this.world, {
      context: this.context, allowOverBudget: true,
      onDamage: (amount, cause, source, attack) => this._current()
        ? this._game.useActions.damage(amount, cause, attack?.position ?? source,
            attack?.kind ?? (source?.spec?.ranged ? "projectile" : "melee"))
        : null,
      onDrop: (id, count, at) => {
        if (this._current()) this._game.dropItems([{ id, count }], at ?? this._game.player.position);
      },
      onIngredientDamage: (mob, amount, direction, retaliate) => this._current()
        ? (this._game.ingredientMobActions ??= new GameIngredientMobActions(this._game))
          .environment(mob, amount, direction, retaliate)
        : { hit: false, killed: false, damage: 0, reason: "inactive-ingredient-owner" },
      prepareStatusRetirement: (removed, validate) => this._current()
        ? this.mobStatusEffects.prepareRetire(removed.map((mob) => ({
            dimension: this.world.dimension,
            entityId: mob.id,
            life: mob.life,
          })), { validate: () => this._current() && validate() })
        : null,
      onExplode: (at, radius) => { if (this._current()) this._game.explode(at, radius, false); },
      onToast: (text) => { if (this._current()) this._game.ui.toast(text); },
    });
    try {
      const horses = this.horseSnapshot();
      wildlife.context.difficulty = normalizeDifficulty(this._game?.worldDifficulty?.value);
      wildlife.context.difficultyRevision = this._game?.worldDifficulty?.revision ?? 0;
      if (!wildlife.load(saved ?? wildlife.serialize(), {
        context: this.context, horses, ecology: this.ecologyServices.ecology,
      }))
        throw new Error("Cannot restore canonical Wildlife");
      // Explicit public adoption API: a legacy restoreWildlife implementation
      // ignores extra arguments and would replace the base for a second time.
      if (typeof this.ecologyServices.bindRestoredWildlife !== "function" ||
          !this.ecologyServices.bindRestoredWildlife(wildlife, { horses }))
        throw new Error("Ecology cannot adopt the already-restored Wildlife");
      return wildlife;
    } catch (error) {
      wildlife.dispose();
      throw error;
    }
  }

  install(game, vehicleServices) {
    if (this._disposed || this._game || !this.wildlife || this.wildlife.disposed ||
        this.vehicleServices !== vehicleServices || this.world.epoch !== this._stageEpoch ||
        this.world.dimension !== this._stageDimension ||
        game.world !== this.world || game.gameplay !== this.gameplay ||
        game.overflow !== this.overflow || vehicleServices.world !== this.world ||
        vehicleServices._stagedWildlife !== this.wildlife || !game.graphics?.scene?.isScene)
      return false;
    const scene = game.graphics.scene;
    scene.add(this.wildlife.group, this.experienceOrbs.mesh);
    this.wildlife.scene = this.experienceOrbs.scene = scene;
    Object.assign(game, {
      mobIntegration: this, ecologyServices: this.ecologyServices,
      wildlife: this.wildlife, experienceOrbs: this.experienceOrbs,
      mobStatusEffects: this.mobStatusEffects,
    });
    game.mobPotionImpact = new GameMobPotionImpact(game);
    this.wildlife.context.mobStatusModifiers = (mob) =>
      game.mobStatusEffects?.modifiers({
        dimension: this.world.dimension,
        entityId: mob.id,
        life: mob.life,
      });
    this._game = game;
    return true;
  }

  activate({ safeSpawn = false } = {}) {
    if (!this._game || !this.ecologyServices.activate(this.wildlife)) return false;
    if (safeSpawn && this.gameplay.mode === "survival" && !this.gameplay.dead)
      this.wildlife.protectSpawn(this._game.player.position);
    this.capture();
    return true;
  }

  capture() {
    if (!this._current()) throw new Error("Cannot capture stale mob owners");
    let snapshot = snapshotGameMobs(this._game);
    const reconcile = this.mobStatusEffects.prepareReconcile(snapshot.mobStates, {
      validate: () => this._current(),
    });
    if (reconcile) {
      if (!this.world.coordinator.commit([reconcile]).ok)
        throw new Error("Cannot retire stale mob status effects");
      snapshot = snapshotGameMobs(this._game);
    }
    this._game.mobStates = snapshot.mobStates;
    return snapshot;
  }

  suspend() {
    if (!this._current()) return false;
    this.capture();
    if (!this.vehicleServices.suspendWildlife()) return false;
    if (this.ecologyServices.suspend()) return true;
    this.vehicleServices.bindWildlife(this.wildlife);
    return false;
  }

  /** World has switched only AFTER source capture and both borrower suspends. */
  restore(saved, { safeSpawn = false } = {}) {
    if (!this._game || this.ecologyServices.wildlife || this.vehicleServices.horses.wildlife)
      throw new Error("Suspend mob borrowers before restoring a dimension");
    if (this.wildlife && this.wildlife.dispose() === false)
      throw new Error("Could not release the previous Wildlife");
    const wildlife = this._restoreBase(
      saved ?? this.ecologyServices.snapshotForDimension(this.world.dimension),
      this._game.graphics.scene
    );
    this.wildlife = this._game.wildlife = wildlife;
    if (!this.vehicleServices.bindWildlife(wildlife) || !this.activate({ safeSpawn })) {
      this.vehicleServices.suspendWildlife();
      this.ecologyServices.suspend();
      wildlife.dispose();
      throw new Error("Cannot bind destination mob owners");
    }
    return wildlife;
  }

  dispose() {
    if (this._disposed) return true;
    // Vehicle teardown owns rider release. Refuse before disposing Ecology if
    // the sibling borrower has not relinquished this base owner yet.
    if (this.wildlife && this.vehicleServices?.horses.wildlife === this.wildlife)
      return false;
    if (this.ecologyServices?.dispose() === false || this.wildlife?.dispose() === false)
      return false;
    this.experienceOrbs?.dispose();
    this.mobStatusEffects?.dispose();
    if (this._game?.mobIntegration === this) {
      this._game.mobIntegration = this._game.ecologyServices =
        this._game.mobStatusEffects = this._game.mobPotionImpact = null;
    }
    this._disposed = true;
    this._game = null;
    return true;
  }
}
