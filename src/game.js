import * as THREE from "three";
import { AudioEngine } from "./audio-engine.js";
import { audioOperation } from "./audio-lifecycle.js";
import { attachAudioUI } from "./audio-ui-events.js";
import { WaterAudioTracker } from "./audio-water-events.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { BrowserCapture } from "./browser-capture.js";
import { CombatFeedback, MELEE_COOLDOWN_SECONDS } from "./combat-feedback.js";
import {
  loadControlPreferences,
  normalizeControlPreferences,
  saveControlPreferences,
} from "./control-preferences.js";
import { DropOverflow } from "./drop-overflow.js";
import { Effects } from "./effects.js";
import { playerKillExperience } from "./experience-rewards.js";
import { Fuses } from "./fuses.js";
import { FrameRate } from "./frame-rate.js";
import { GameArchive } from "./game-archive.js";
import { GameBuildingServices } from "./game-building-services.js";
import { bindGameControls } from "./game-controls.js";
import { GameExplorationServices } from "./game-exploration-services.js";
import { GameFluidServices } from "./game-fluid-services.js";
import { GameGravityServices } from "./game-gravity-services.js";
import { GameWeatherServices, normalizeWeatherArchive } from "./game-weather-services.js";
import { GameMobActions, GameMobHarvestActions } from "./game-mob-actions.js";
import { GameMobIntegration } from "./game-mob-integration.js";
import { GameInventoryActions } from "./game-inventory-actions.js";
import { stageProgressionServices } from "./game-progression-integration.js";
import { GameProjectileServices } from "./game-projectile-services.js";
import { GameTravel } from "./game-travel.js";
import { GameUseActions, physicalEye } from "./game-use-actions.js";
import {
  applyVehiclePose,
  stageVehicleServices,
} from "./game-vehicle-integration.js";
import { bindWorldServiceEvents } from "./game-world-events.js";
import { stageWorld } from "./game-world-stage.js";
import { Gameplay } from "./gameplay.js";
import { hasExpandedTerrain } from "./generator-version.js";
import { requestHeldItemMining } from "./held-item.js";
import { HurtFeedback } from "./hurt-feedback.js";
import { getItem, ITEM } from "./items.js";
import { raycastMelee } from "./melee-targeting.js";
import { normalizeDifficulty } from "./mob-difficulty.js";
import { Pickups } from "./pickups.js";
import { Player } from "./player.js";
import { PlayerVisual } from "./player-visual.js";
import { GameRenderer } from "./renderer.js";
import { normalizeWorldComponents } from "./save-preflight.js";
import { Settlement } from "./settlement.js";
import { ContainerUI } from "./settlement-ui.js";
import { normalizeSave } from "./storage.js";
import { TransactionInvariantError } from "./transactions.js";
import { TransitionGate } from "./transition-gate.js";
import { createUI } from "./ui.js";
import {
  loadViewPreferences,
  normalizeViewPreferences,
  saveViewPreferences,
} from "./view-preferences.js";
import { Wildlife } from "./wildlife.js";
import { raycast } from "./world.js";
import { createWorldContext } from "./world-spec.js";

const LEGACY_KEY = "voxelcraft-world-v1";

export class VoxelGame {
  constructor(container) {
    this.container = container;
    this.transitionGate = new TransitionGate();
    this.travel = new GameTravel(this);
    this.archive = new GameArchive(this);
    this.storage = this.archive.storage;
    this.quality = "medium";
    this.soundEnabled = true;
    this.controlPreferences = loadControlPreferences();
    this.viewPreferences = loadViewPreferences();
    this.paused = true;
    this.building = false;
    this.overlayOpen = false;
    this.started = false;
    this.failed = false;
    this.initializeAudio();
    this.currentTime = 0.36;
    this.elapsed = 0;
    this.lastFrame = performance.now();
    this.frameRate = new FrameRate();
    this.fps = null;
    this.hudTimer = 0;
    this.streamTimer = 0;
    this.autosaveTimer = 0;
    this.saveTimer = null;
    this.storageStatus = "Opening world archive…";
    this.saveErrorReported = false;
    this.heldAction = null;
    this.lastAction = -Infinity;
    this.meleeTarget = null;
    this.combatFeedback = new CombatFeedback();
    this.miningKey = "";
    this.miningProgress = 0;
    this.portalCooldown = 0;
    this.lastOverflowToast = -Infinity;
    this.renderDirection = new THREE.Vector3();
    this.playerEnvironment = {};
    this.useActions = new GameUseActions(this);
    this.mobActions = new GameMobActions(this);
    this.inventoryActions = new GameInventoryActions(this);
    this.harvestActions = new GameMobHarvestActions(this);
    this.browserCapture = new BrowserCapture(document.documentElement, {
      onChange: (state) => this.ui?.update(state),
      onMessage: (message) => this.ui?.toast(message),
    });
    this.gameplay = this.createGameplay();
    this.ui = createUI({
      onPlay: () => this.play(),
      onResume: () => this.play(),
      onPause: () => this.pause(),
      onNewWorld: (seed) => this.newWorld(seed),
      onSave: () => this.save(true),
      onTimeChange: (value) => {
        const result = this.buildingServices?.setTime(Number(value));
        if (result && !result.ok)
          this.ui.toast("The world clock could not change right now.");
      },
      onQualityChange: (value) => {
        this.quality = value;
        this.graphics?.setQuality(value);
      },
      onSoundChange: (enabled) => {
        this.setSoundEnabled(enabled);
        if (enabled) audioOperation(this.audioEngine, "unlock");
      },
      onControlPreferencesChange: (preferences) =>
        this.setControlPreferences(preferences),
      onFullbrightInspectionChange: (enabled) =>
        this.setFullbrightInspection(enabled),
      onGuiScaleChange: (scale) => this.setGuiScale(scale),
      onShowFpsChange: (enabled) => this.setShowFps(enabled),
      onToggleFullscreen: () => this.toggleFullscreen(),
      onQuit: () => this.quitToTitle(),
      onInventoryAction: (action) => this.inventoryAction(action),
      onSelect: (index, id) => {
        if (id !== undefined) this.gameplay.assignSlot(index, id);
        this.select(index);
      },
      onInventoryChange: (open) => this.overlayChanged(open),
      onTeleport: () => {
        if (this.gameplay.mode === "creative")
          return this.teleport(this.world?.getSpawn());
        else
          this.ui.toast(
            "Return-to-spawn is a Creative option. Switch modes in World settings."
          );
      },
      onModeChange: (mode) => this.setMode(mode),
      onCraft: (recipeId) => {
        const result = this.gameplay.craft(recipeId, {
          station: this.station(),
        });
        if (result?.ok) this.scheduleSave();
        this.refreshHud();
        return result;
      },
      onEat: () => this.eat(),
      onRespawn: () => this.respawn(),
      onTravel: (id) => this.travelBiome(id),
      onDimensionChange: (dimension) => this.travelDimension(dimension),
      onExport: () => this.exportWorld(),
      onImport: (file) => this.importWorld(file),
    });
    this.ui.update({
      controlPreferences: this.controlPreferences,
      fullbrightInspection: this.viewPreferences.fullbrightInspection,
      guiScale: this.viewPreferences.guiScale,
      showFps: this.viewPreferences.showFps,
      fullscreen: this.browserCapture.fullscreen,
      keyboardCaptured: this.browserCapture.captured,
    });
    this.containerUI = new ContainerUI(document.querySelector("#ui"), {
      onOpenChange: (open) => this.overlayChanged(open),
      onChange: (result) => {
        if (result?.experience > 0 && !result.experienceCommitted)
          this.awardExperience(result.experience, {
            x: this.player.position.x,
            y: this.player.position.y + 0.8,
            z: this.player.position.z,
          });
        this.scheduleSave();
        this.refreshHud();
      },
      onToast: (text) => this.ui.toast(text),
      prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
      prepareExperience: (amount) => this.prepareExperienceDrop(amount),
    });
    this.unbindControls = bindGameControls(this);
  }

  initializeAudio({ createContext, document: doc = globalThis.document } = {}) {
    if (this.audioEngine || this._audioDisposed) return;
    this.audioEngine = new AudioEngine({ createContext });
    audioOperation(this.audioEngine, "setEnabled", this.soundEnabled !== false);
    audioOperation(this.audioEngine, "setPaused", true);
    this.detachAudioUI = attachAudioUI(() => this.audioEngine, doc);
    const view = doc?.defaultView;
    const pagehide = (event) => {
      if (event.persisted) audioOperation(this.audioEngine, "setHidden", true);
      else this.disposeAudio();
    };
    view?.addEventListener("pagehide", pagehide);
    this.detachAudioPage = () => view?.removeEventListener("pagehide", pagehide);
  }

  setSoundEnabled(enabled) {
    this.soundEnabled = Boolean(enabled);
    audioOperation(this.audioEngine, "setEnabled", this.soundEnabled);
    try {
      if (this.effects) this.effects.soundEnabled = this.soundEnabled;
    } catch {
      // An optional audio observer cannot reject a settings/save transition.
    }
  }

  bindPlayerAudio() {
    const effects = this.effects;
    const player = this.player;
    const play = (kind, id) => {
      if (this.player !== player || this.effects !== effects) return false;
      return audioOperation(effects, "sound", kind, id);
    };
    const water = new WaterAudioTracker((kind) => play(kind));
    player.onStep = (id) => play("step", id);
    player.onWaterSample = (sample, state) => water.observe(sample, state);
  }

  updateAudio(dt) {
    audioOperation(this.audioEngine, "setHidden", Boolean(globalThis.document?.hidden));
    audioOperation(this.audioEngine, "setPaused",
      !this.started || !this.simulating || this.failed);
    audioOperation(this.audioEngine, "update", dt);
  }

  renderWeather() {
    const weather = this.weatherServices;
    if (this.renderedWeather && this.renderedWeather !== weather)
      this.renderedWeather.frame(0, { simulating: false });
    this.renderedWeather = weather ?? null;
    const projection = weather?.render();
    audioOperation(this.audioEngine, "setRain",
      weather?.active && weather.running ? projection?.level ?? 0 : 0);
  }

  disposeAudio() {
    if (this._audioDisposed) return;
    this._audioDisposed = true;
    audioOperation(this, "detachAudioUI");
    audioOperation(this, "detachAudioPage");
    this.detachAudioUI = this.detachAudioPage = null;
    audioOperation(this.audioEngine, "dispose");
  }

  createGameplay(mode = "survival", options = {}) {
    return this.bindGameplay(new Gameplay({ mode, ...options }));
  }

  bindGameplay(gameplay) {
    (this.hurtFeedback ??= new HurtFeedback()).reset();
    this.ui?.updateHurt?.({});
    Object.assign(gameplay, {
      onToast: (text) => this.ui?.toast(text),
      onHurt: (event) => {
        if (this.gameplay === gameplay) this.hurtFeedback.noteHealthLoss(event);
      },
      onDeath: () => {
        if (this.gameplay !== gameplay) return;
        audioOperation(this.audioEngine, "setPaused", true);
        const departure = this.vehicleServices?.onDeath();
        if (departure?.ok && this.player?.seated) {
          this.player.setPosition(this.player.position);
          this.player.flying = false;
        }
        this.projectileServices?.cancel("death", { advanceLife: true });
        this.progressionIntegration?.onDeath();
        this.resetActions();
        if (this.player) {
          this.player.enabled = false;
          this.player.unlock();
        }
        this.refreshHud();
        // Death hides screens but keeps their escrow in the saved Gameplay state.
        this.containerUI?.close({ force: true });
        void this.ui?.closeInventory();
        this.ui?.closeAtlas?.();
        this.scheduleSave();
      },
      onChange: (state) => {
        this.gameplayState = state;
        this.scheduleSave();
      },
    });
    this.gameplayState = gameplay.getState();
    return gameplay;
  }

  bindPlayerDamage(player = this.player, gameplay = this.gameplay) {
    const world = this.world;
    player.onFall = (distance) => {
      if (this.player !== player || this.gameplay !== gameplay || this.world !== world)
        return 0;
      return gameplay.damage(Math.ceil(distance - 3), "fall", "fall");
    };
  }

  async start() {
    let saved;
    try {
      saved = await this.storage.load();
      this.storageStatus = "Saved on this device";
    } catch (error) {
      this.storageStatus = "Export to keep your progress";
      this.storageUnavailable = error.message;
    }
    if (!saved) {
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
        if (legacy) saved = normalizeSave(legacy);
      } catch {
        /* Keep any unreadable old save untouched. */
      }
    }
    await this.initialize(saved?.world.seed ?? "cedar-valley", saved);
    this.animation = requestAnimationFrame((now) => this.frame(now));
    if (saved?.legacy)
      this.ui.toast(
        "World restored. B opens the biome atlas; generate a new seed for the new terrain."
      );
    else if (this.storageUnavailable) this.ui.toast(this.storageUnavailable);
  }

  async prepareWorld(seed, saved, options = {}) {
    // Direct staging callers also pass original archives, not necessarily the
    // already-normalized initialize() input.
    if (!normalizeWeatherArchive(saved)) throw new Error("Invalid saved weather");
    const staged = await stageWorld({
      seed,
      saved,
      mode:
        saved?.gameplay?.mode ??
        (saved?.legacy
          ? "creative"
          : (options.mode ?? this.gameplay?.mode ?? "survival")),
      quality: saved?.quality ?? this.quality,
      dimension: options.dimension ?? "overworld",
      generatorVersion: options.generatorVersion,
      onProgress: (progress, label) => this.ui.setLoading(progress, label),
    });
    const owners = [];
    try {
      const context = options.context ?? createWorldContext(staged.world);
      const ownership = { context, coordinator: staged.world.coordinator };
      // Detached owners have no live Game callbacks while they are being loaded.
      const gameplay = new Gameplay({
        mode: staged.mode,
        ...ownership,
        allowOverBudget: saved !== null,
      });
      owners.push(gameplay);
      const settlement = new Settlement(ownership);
      owners.push(settlement);
      const overflow = new DropOverflow(ownership);
      owners.push(overflow);
      const fuses = new Fuses(ownership);
      owners.push(fuses);
      for (const [name, component] of [
        ["gameplay", gameplay],
        ["settlement", settlement],
        ["overflow", overflow],
        ["fuses", fuses],
      ]) {
        if (
          saved?.[name] !== undefined &&
          component.load(saved[name], { context, allowOverBudget: true }) ===
            false
        )
          throw new Error(`Invalid candidate ${name} state`);
      }
      if (!settlement.bindWorld(staged.world))
        throw new Error("Cannot bind the staged settlement to its world");
      // Restore the complete calendar/bed ownership before touching live state.
      const buildingServices = new GameBuildingServices({
        world: staged.world,
        gameplay,
        context,
        saved,
        allowOverBudget: saved != null,
      });
      owners.push(buildingServices);
      const fluidServices = new GameFluidServices({
        world: staged.world,
        overflow,
        settlement,
        ...ownership,
        saved,
        allowOverBudget: saved != null,
      });
      owners.push(fluidServices);
      const gravityServices = new GameGravityServices({ world: staged.world });
      owners.push(gravityServices);
      const weatherServices = new GameWeatherServices({ world: staged.world, saved });
      owners.push(weatherServices);
      const projectileServices = new GameProjectileServices({
        world: staged.world,
        gameplay,
        context,
        saved,
        allowOverBudget: saved != null,
      });
      owners.push(projectileServices);
      const progressionIntegration = stageProgressionServices({
        world: staged.world,
        gameplay,
        context,
        projectileServices,
        saved,
        allowOverBudget: saved != null,
      });
      owners.push(progressionIntegration);
      const explorationServices =
        hasExpandedTerrain(staged.world.generatorVersion) ||
        (saved != null && Object.hasOwn(saved, "exploration"))
          ? new GameExplorationServices({
              world: staged.world,
              gameplay,
              settlement,
              overflow,
              context,
              saved,
              allowOverBudget: saved != null,
            })
          : null;
      if (explorationServices) owners.push(explorationServices);
      const mobIntegration = new GameMobIntegration({
        world: staged.world, gameplay, overflow, context, saved,
        progressionIntegration, explorationServices,
      });
      owners.push(mobIntegration);
      const vehicleServices = await stageVehicleServices({
        world: staged.world, gameplay, overflow, context, saved,
        experienceOrbs: mobIntegration.experienceOrbs,
        mobIntegration, position: staged.pose.position,
      });
      owners.push(vehicleServices);
      return {
        ...staged,
        context,
        gameplay,
        settlement,
        overflow,
        fuses,
        buildingServices,
        fluidServices,
        gravityServices,
        weatherServices,
        projectileServices,
        progressionIntegration,
        vehicleServices,
        explorationServices,
        mobIntegration,
      };
    } catch (error) {
      for (const owner of owners.reverse()) {
        try {
          owner.dispose?.();
        } catch {
          // Continue releasing every detached owner after a failed preparation.
        }
        staged.world.coordinator?.release(owner);
      }
      try {
        staged.world.dispose();
      } catch {
        // Preserve the component failure that prevented activation.
      }
      throw error;
    }
  }

  async initialize(seed, saved = null, options = {}) {
    const normalized = normalizeWorldComponents(saved);
    const { context, ...components } = normalized ?? {};
    if (normalized) saved = { ...structuredClone(saved), ...components };
    if (!(await this.closeScreens()))
      throw new Error("Close the inventory safely before replacing this world");
    this.building = true;
    audioOperation(this.audioEngine, "setPaused", true);
    this.resetSwimmingPresentation();
    this.resetFrameRate();
    this.paused = true;
    this.overlayOpen = false;
    this.resetActions();
    this.stationOverride = null;
    this.player?.unlock();
    this.ui.setLoading(0.05, "Reading the world seed");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    let staged;
    try {
      staged = await this.prepareWorld(seed, saved, { ...options, context });
    } catch (error) {
      this.building = false;
      if (this.world) {
        this.ui.ready();
        this.ui.showMenu(this.started ? "pause" : "title");
        this.refreshHud();
      }
      throw error;
    }
    try {
      await this.installPreparedWorld(staged, saved);
    } catch (error) {
      staged.weatherServices.dispose();
      audioOperation(this.audioEngine, "setRain", 0);
      throw error;
    }
  }

  async installPreparedWorld(staged, saved) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // Required terrain and a collision-checked pose exist before live teardown.
    this.unbindWorldEvents?.();
    this.unbindWorldEvents = null;
    this.weatherServices?.dispose();
    this.weatherServices = null;
    this.renderedWeather = null;
    this.gravityServices?.dispose();
    this.gravityServices = null;
    this.vehicleServices?.dispose();
    this.vehicleServices = this.boats = this.fishing = this.horses = null;
    this.mobIntegration?.dispose();
    this.mobIntegration = this.ecologyServices = null;
    this.progressionIntegration?.dispose();
    this.progressionIntegration = this.progressionServices = null;
    this.explorationServices?.dispose();
    this.explorationServices = null;
    this.exploration = null;
    this.player?.dispose();
    this.wildlife?.dispose();
    this.pickups?.dispose();
    this.experienceOrbs?.dispose();
    this.playerVisual?.dispose();
    this.effects?.dispose();
    this.projectileServices?.dispose();
    this.projectileServices = null;
    this.projectiles = null;
    this.graphics?.dispose();
    this.fluidServices?.dispose();
    this.fluidServices = null;
    this.fluids = null;
    if (this.buildingServices) this.buildingServices.dispose();
    else this.buildingActions?.dispose();
    this.buildingServices = null;
    this.buildingActions = null;
    this.beds = null;
    this.worldClock = null;
    this.gameplay?.dispose?.();
    this.settlement?.dispose?.();
    this.overflow?.dispose?.();
    this.fuses?.dispose?.();
    this.world?.dispose();
    this.worldContext = staged.context;
    this.coordinator = staged.world.coordinator;
    this.gameplay = this.bindGameplay(staged.gameplay);
    this.settlement = staged.settlement;
    this.overflow = staged.overflow;
    this.fuses = staged.fuses;
    this.quality = staged.quality;
    this.setSoundEnabled(saved?.soundEnabled ?? this.soundEnabled);
    this.world = staged.world;
    this.graphics = new GameRenderer(this.container, this.world);
    this.graphics.setQuality(this.quality);
    this.graphics.setFullbrightInspection(
      this.viewPreferences.fullbrightInspection
    );
    this.player = new Player(
      this.graphics.camera,
      this.world,
      this.graphics.renderer.domElement,
      this.controlPreferences
    );
    this.player.onInputReset = () => {
      this.resetActions();
    };
    this.player.sneaking = staged.pose.sneaking;
    this.player.setPosition(staged.pose.position);
    this.player.yaw = staged.pose.yaw;
    this.player.pitch = staged.pose.pitch;
    this.player.flying = staged.pose.flying;
    this.player.allowFlight = this.gameplay.mode === "creative";
    this.player.canSprint = this.gameplay.hunger > 6;
    if (!this.player.allowFlight) this.player.flying = false;
    this.bindPlayerDamage();
    this.currentTime = staged.buildingServices.worldClock.time;
    this.graphics.setTime(this.currentTime);
    this.effects = new Effects(this.graphics.scene, this.graphics.camera, {
      registerContextOwner: (owner) => this.graphics.registerContextResourceOwner(owner),
      audioEngine: this.audioEngine,
    });
    this.heldItemId = undefined;
    this.offhandItemId = undefined;
    this.playerVisual = new PlayerVisual(this.graphics.scene);
    this.effects.soundEnabled = this.soundEnabled;
    this.bindPlayerAudio();
    this.player.onFlightChange = (flying) =>
      this.ui.toast(
        flying
          ? "Flying · Space up · Shift down · Double-Space to land"
          : "Flight off"
      );
    this.pickups = new Pickups(this.graphics.scene, this.world, {
      context: this.worldContext,
      coordinator: this.coordinator,
      onCollect: (id, count) => {
        this.ui.toast(`+${count} ${getItem(id)?.name ?? "item"}`);
        this.scheduleSave();
      },
      onFull: () =>
        this.ui.toast("Backpack full. Store items in a chest to make room."),
    });
    if (
      !this.pickups.load(saved?.pickups, {
        context: this.worldContext,
        allowOverBudget: true,
      })
    )
      throw new Error("The saved item pickups are invalid");
    if (!staged.mobIntegration.install(this, staged.vehicleServices))
      throw new Error("The staged mob owners could not be installed");
    const vehicles = staged.vehicleServices.activate(this, { root: document.querySelector("#ui") });
    if (!vehicles.ok) {
      staged.vehicleServices.dispose();
      throw new Error(
        `The staged vehicle services could not be activated: ${vehicles.reason}`
      );
    }
    this.applyVehiclePose();
    this.mobStates = saved?.mobStates ?? {};
    if (!staged.buildingServices.activate(this).ok) {
      staged.buildingServices.dispose();
      throw new Error("The staged building services could not be activated");
    }
    if (!staged.fluidServices.activate(this).ok) {
      staged.fluidServices.dispose();
      throw new Error("The staged fluid services could not be activated");
    }
    if (!staged.gravityServices.activate(this).ok) {
      staged.gravityServices.dispose();
      throw new Error("The staged gravity services could not be activated");
    }
    if (!staged.projectileServices.activate(this).ok) {
      staged.projectileServices.dispose();
      throw new Error("The staged projectile services could not be activated");
    }
    const progression = staged.progressionIntegration.activate(this, {
      root: document.querySelector("#ui"),
      onSessionChange: (open) => this.overlayChanged(open),
      getEcologyServices: () => this.ecologyServices,
    });
    if (!progression.ok)
      throw new Error(`Progression activation failed: ${progression.reason}`);
    if (
      staged.explorationServices &&
      !staged.explorationServices.activate(this).ok
    ) {
      staged.explorationServices.dispose();
      throw new Error("The staged exploration services could not be activated");
    }
    if (!staged.mobIntegration.activate({ safeSpawn: true }))
      throw new Error("The staged ecology services could not be activated");
    if (!staged.weatherServices.activate(this).ok)
      throw new Error("The staged weather services could not be activated");
    this.bindWorldServiceEvents();
    if (!this.applyVehiclePose()) this.player.update(0);
    const closed = this.gameplay.inventoryAction(
      { type: "close" },
      {
        prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
      }
    );
    if (closed.ok)
      this.gameplay.setCraftingSize(2, {
        prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
      });
    this.portalCooldown = 3;
    this.select(this.gameplay.selected);
    if (!this.applyVehiclePose())
      this.player.update(0.001, {
        recoverFromVoid: this.gameplay.mode === "creative",
      });
    this.graphics.rebuildDirty(Infinity);
    this.graphics.setBiome?.(
      this.world.getBiome(
        this.player.position.x,
        this.player.position.z,
        this.player.position.y
      )
    );
    this.graphics.update(0, this.elapsed, this.player.position);
    this.renderWeather();
    this.graphics.render();
    this.building = false;
    this.ui.ready();
    this.ui.showMenu("title");
    this.refreshHud();
  }

  createWildlife(saved, { safeSpawn = false } = {}) {
    if (this.mobIntegration)
      return this.mobIntegration.restore(saved, { safeSpawn });
    this.wildlife = new Wildlife(this.graphics.scene, this.world, {
      context: this.worldContext,
      onDamage: (amount, cause, source, attack) =>
        this.useActions.damage(
          amount,
          cause,
          attack?.position ?? source,
          attack?.kind ?? (source?.spec?.ranged ? "projectile" : "melee")
        ),
      onDrop: (id, count, position) =>
        this.dropItems([{ id, count }], position ?? this.player.position),
      onExplode: (position, radius) => this.explode(position, radius, false),
      onToast: (text) => this.ui.toast(text),
    });
    if (
      saved &&
      this.wildlife.load(saved, { context: this.worldContext }) === false
    )
      throw new Error("The saved creatures are invalid for this world");
    if (safeSpawn && this.gameplay.mode === "survival" && !this.gameplay.dead) {
      this.wildlife.protectSpawn(this.player.position);
      this.mobStates[this.world.dimension] = this.wildlife.serialize();
    }
  }

  bindWorldServiceEvents() {
    this.unbindWorldEvents?.();
    this.unbindWorldEvents = bindWorldServiceEvents(this);
  }

  resetActions() {
    this.heldAction = null;
    this.meleeTarget = null;
    this.vehicleTarget = null;
    this.combatFeedback?.reset();
    this.ui?.updateCombat?.({});
    this.hurtFeedback?.reset();
    this.ui?.updateHurt?.({});
    this.miningKey = "";
    this.miningProgress = 0;
    this.useActions?.reset();
    this.resetHeldButtons?.();
  }

  beginUse(source = "mouse") {
    this.useActions ??= new GameUseActions(this);
    return this.useActions.begin(source);
  }

  endUse(source = "mouse", cancel = false) {
    return this.useActions?.end(source, cancel) ?? false;
  }

  cyclePerspective() {
    if (!this.active || !this.player) return false;
    const perspective = this.player.cyclePerspective();
    this.player.update(0);
    this.refreshHud();
    return perspective;
  }

  toggleFullscreen() {
    this.resetActions();
    return this.browserCapture.toggle();
  }

  swapHands() {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.swapHands();
  }

  pickBlock() {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.pickBlock();
  }

  dropSelected(wholeStack = false) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.dropSelected(wholeStack);
  }

  inventoryAction(action) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.action(action);
  }

  retainPlayerDrops(stacks) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.retainPlayerDrops(stacks);
  }

  preparePlayerDrops(stacks) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.preparePlayerDrops(stacks);
  }

  prepareExperienceDrop(amount, position = this.player?.position) {
    if (!position || !this.experienceOrbs) return null;
    return this.experienceOrbs.prepareSpawn(
      amount,
      {
        x: position.x,
        y: position.y + 0.8,
        z: position.z,
      },
      { dimension: this.world.dimension, pickupDelay: 0.2 }
    );
  }

  openStation(hit) {
    const progression = this.progressionIntegration?.openStation(hit);
    if (progression?.handled) {
      if (!progression.ok)
        this.ui.toast(progression.message ?? "This station is not available right now");
      return progression.ok;
    }
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.openStation(hit);
  }

  plantFromHand(hand, hit) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.plant(hand, hit);
  }

  async quitToTitle() {
    if (this.building || !this.player) return false;
    if (!(await this.pause()))
      return { ok: false, message: "Your inventory is still open." };
    const saved = await this.save(true);
    if (!saved.ok) return saved;
    this.started = false;
    this.ui.showMenu("title");
    return { ok: true };
  }

  get active() {
    return (
      !this.paused &&
      !this.overlayOpen &&
      !this.building &&
      !this.closingScreens &&
      !this.gameplay.dead
    );
  }

  get simulating() {
    return !this.paused && !this.building && !this.gameplay.dead;
  }

  async play() {
    if (!this.player || this.building || this.gameplay.dead || this.playing)
      return;
    this.playing = true;
    if (!(await this.closeScreens())) {
      this.playing = false;
      return false;
    }
    this.paused = false;
    this.started = true;
    audioOperation(this.audioEngine, "setPaused", false);
    this.overlayOpen = false;
    this.ui.hideMenu();
    audioOperation(this.effects, "unlockAudio");
    this.player.enabled = true;
    if ((await this.player.lock()) === false)
      this.ui.toast(
        "Click the world to capture the mouse. Arrow keys also look around."
      );
    if (this.player.inputMode === "remote" && !this.remoteHintShown) {
      this.remoteHintShown = true;
      this.ui.toast(
        "Right-drag to look · Hold V to use items · Controls help is in Options"
      );
    }
    this.playing = false;
    this.scheduleSave();
    return true;
  }

  async closeScreens() {
    if (this.screenClose) return this.screenClose;
    this.closingScreens = true;
    this.screenClose = (async () => {
      try {
        if (this.vehicleServices?.horseInventory?.closeCurrent("screen-change")?.ok === false)
          return false;
        if (this.progressionIntegration?.close("screen-change")?.ok === false)
          return false;
        if (this.containerUI?.isOpen && this.containerUI.close() === false)
          return false;
        if ((await this.ui?.closeInventory()) === false) return false;
        this.ui?.closeAtlas?.();
        this.overlayOpen = false;
        return true;
      } catch (error) {
        if (error instanceof TransactionInvariantError) throw error;
        this.ui?.toast(
          error.message || "Could not close this inventory safely"
        );
        return false;
      } finally {
        this.closingScreens = false;
      }
    })();
    try {
      return await this.screenClose;
    } finally {
      this.screenClose = null;
    }
  }

  async pause() {
    if (!this.player || this.building) return false;
    this.paused = true;
    audioOperation(this.audioEngine, "setPaused", true);
    // Visibility/blur can suspend RAF before another hidden frame arrives.
    this.resetSwimmingPresentation();
    this.resetActions();
    this.player.enabled = false;
    this.player.unlock();
    if (!(await this.closeScreens())) {
      void this.save();
      return false;
    }
    if (!this.gameplay.dead) this.ui.showMenu("pause");
    void this.save();
    return true;
  }

  overlayChanged(open) {
    this.overlayOpen = open;
    if (open) this.resetSwimmingPresentation();
    this.resetActions();
    if (!open) {
      this.stationOverride = null;
      this.gameplay.setCraftingSize(2, {
        prepareDrops: (stacks) => this.preparePlayerDrops(stacks),
      });
      this.refreshHud();
    }
    if (!this.player) return;
    if (open) {
      this.player.enabled = false;
      this.player.unlock();
    } else if (
      !this.paused &&
      !this.building &&
      !this.closingScreens &&
      !this.gameplay.dead
    ) {
      void this.play();
    }
  }

  async setMode(mode) {
    if (this.transitionGate.busy) return false;
    if (!["creative", "survival"].includes(mode)) return false;
    return this.transitionGate.run(async () => {
      if (!(await this.closeScreens())) return false;
      this.resetActions();
      this.gameplay.setMode(mode);
      if (mode === "creative") this.wildlife?.endSpawnProtection();
      if (this.player) {
        this.player.allowFlight = mode === "creative";
        if (!this.player.allowFlight) {
          this.player.flying = false;
          this.player.fallDistance = 0;
        }
      }
      this.select(this.gameplay.selected);
      this.refreshHud();
      this.scheduleSave();
      return true;
    });
  }

  setControlPreferences(preferences) {
    const next = normalizeControlPreferences({
      ...this.controlPreferences,
      ...preferences,
    });
    const modeChanged = next.inputMode !== this.controlPreferences.inputMode;
    this.controlPreferences = next;
    this.resetActions();
    this.player?.setControlPreferences(next);
    // Switching back to capture needs a fresh Play gesture, not a background
    // permission request. Native -> Remote can continue without capturing.
    if (modeChanged && next.inputMode === "native" && this.active) this.pause();
    this.ui.update({ controlPreferences: next });
    if (!saveControlPreferences(next))
      this.ui.toast(
        "Controls changed for this session. Browser preferences could not be saved."
      );
    return { ...next };
  }

  setFullbrightInspection(enabled) {
    const next = normalizeViewPreferences({
      ...this.viewPreferences,
      fullbrightInspection: enabled,
    });
    this.graphics?.setFullbrightInspection(next.fullbrightInspection);
    this.viewPreferences = next;
    this.ui.update({
      fullbrightInspection:
        this.graphics?.fullbrightInspection ?? next.fullbrightInspection,
    });
    if (!saveViewPreferences(next))
      this.ui.toast(
        "Inspection changed for this session. Browser preferences could not be saved."
      );
    return { ...next };
  }

  setGuiScale(guiScale) {
    const next = normalizeViewPreferences({
      ...this.viewPreferences,
      guiScale,
    });
    this.viewPreferences = next;
    this.ui.update({ guiScale: next.guiScale });
    if (!saveViewPreferences(next))
      this.ui.toast(
        "GUI scale changed for this session. Browser preferences could not be saved."
      );
    return { ...next };
  }

  setShowFps(enabled) {
    const next = normalizeViewPreferences({
      ...this.viewPreferences,
      showFps: enabled,
    });
    this.viewPreferences = next;
    this.ui.update({ showFps: next.showFps, fps: this.fps });
    if (!saveViewPreferences(next))
      this.ui.toast(
        "FPS display changed for this session. Browser preferences could not be saved."
      );
    return { ...next };
  }

  resetFrameRate() {
    this.frameRate?.reset();
    this.fps = null;
  }

  select(index) {
    this.useActions?.reset();
    this.gameplay.select(index);
    this.ui?.setSelected(this.gameplay.selected);
    this.effects?.select(this.gameplay.hotbar[this.gameplay.selected] ?? 0);
    this.miningKey = "";
    this.miningProgress = 0;
  }

  station() {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.stationValid() ? ["hand", "table"] : ["hand"];
  }

  applyVehiclePose() {
    return applyVehiclePose(this);
  }

  /** Parent settings/combat adapters consume this normalized value + revision.
   * No difficulty switch UI or alternate persisted occupancy/state is invented.
   */
  readWorldDifficulty() {
    const revision = this.worldDifficulty?.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new RangeError("Invalid world difficulty revision");
    return Object.freeze({ value: normalizeDifficulty(this.worldDifficulty?.value), revision });
  }

  updateTarget() {
    const creative = this.gameplay.mode === "creative";
    const eye = physicalEye(this);
    this.target = raycast(
      this.world,
      eye,
      this.player.forward,
      creative ? 5 : 4.5
    );
    const mob = this.wildlife.raycast?.(
      eye,
      this.player.forward,
      creative ? 5 : 3
    );
    this.mobTarget =
      mob && (!this.target || mob.distance < this.target.distance) ? mob : null;
    this.meleeTarget = raycastMelee(
      this.wildlife,
      this.world,
      eye,
      this.player.forward,
      creative ? 5 : 3,
      { preciseHit: mob ?? null, blockHit: this.target }
    );
    this.vehicleTarget =
      this.vehicleServices?.raycast(
        Math.min(6, this.target?.distance ?? 6, this.mobTarget?.distance ?? 6)
      ) ?? null;
    if (this.vehicleTarget) {
      this.target = this.mobTarget = null;
      // A farther boat seen through a precise limb gap must not steal a nearer
      // continuous-body melee hit. Precise use and melee remain separate.
      if (
        this.meleeTarget &&
        this.vehicleTarget.distance < this.meleeTarget.distance
      )
        this.meleeTarget = null;
    }
  }

  primary(dt, pressed = true) {
    this.combatFeedback?.noteAttempt({
      now: this.elapsed,
      lastAction: this.lastAction,
      active: this.active,
      hasTarget: !!this.meleeTarget,
      usingItem: !!this.useActions?.use?.active,
      pressed,
    });
    if (!this.active || this.useActions?.use.active) return;
    if (this.vehicleTarget && !this.meleeTarget) {
      this.miningProgress = 0;
      if (
        this.vehicleTarget.type !== "boat" ||
        !pressed ||
        this.elapsed - this.lastAction < MELEE_COOLDOWN_SECONDS
      )
        return;
      const result = this.vehicleServices.attack(this.vehicleTarget);
      if (result?.ok) {
        this.lastAction = this.elapsed;
        this.applyVehiclePose();
        this.effects.swing = 1;
        this.updateTarget();
      }
      return;
    }
    if (this.meleeTarget) {
      this.miningProgress = 0;
      if (!pressed || this.elapsed - this.lastAction < MELEE_COOLDOWN_SECONDS)
        return;
      this.lastAction = this.elapsed;
      // A bow is charged/released with use; hitting with it is an ordinary melee hit.
      this.mobActions ??= new GameMobActions(this);
      const entity = this.meleeTarget.entity;
      if (this.mobActions.owns(entity)) {
        this.mobActions.melee(entity);
      } else {
        const amount = this.gameplay.selectedItem?.tool === "bow" ? 1 : this.gameplay.attack();
        if (amount) this.hitMob(entity, amount);
      }
      this.effects.sound("mine", 2);
      this.effects.swing = 1;
      this.scheduleSave();
      return;
    }
    if (!this.target || this.target.id === BLOCK.BEDROCK) {
      this.miningProgress = 0;
      return;
    }
    const key = [
      this.world.dimension,
      this.world.epoch,
      this.target.x,
      this.target.y,
      this.target.z,
      this.target.id,
      this.target.state,
      this.target.fluid,
      this.gameplay.getHandRevision("main"),
    ].join(",");
    if (key !== this.miningKey) {
      this.miningKey = key;
      this.miningProgress = 0;
    }
    if (
      this.gameplay.mode === "creative" &&
      this.elapsed - this.lastAction < 0.2
    )
      return;
    const duration = this.gameplay.miningDuration(this.target.id) /
      (this.ecologyServices?.modifiers().miningSpeedMultiplier ?? 1);
    this.miningProgress += dt / Math.max(0.05, duration);
    requestHeldItemMining(this.effects);
    if (this.miningProgress < 1) return;
    const hit = this.target;
    this.harvestActions ??= new GameMobHarvestActions(this);
    if (this.harvestActions.break(hit).ok) {
      this.effects.burst(hit);
      this.effects.sound("mine", hit.id);
      this.graphics.rebuildDirty(4);
      this.scheduleSave();
      this.refreshHud();
    }
    this.lastAction = this.elapsed;
    this.miningProgress = 0;
    this.miningKey = "";
    this.updateTarget();
  }

  hitMob(entity, amount) {
    this.mobActions ??= new GameMobActions(this);
    if (this.mobActions.owns(entity)) return this.mobActions.hit(entity, amount);
    this.wildlife.endSpawnProtection?.();
    const result = this.wildlife.damage(entity, amount, this.player.forward);
    this.awardExperience(
      playerKillExperience(
        entity,
        result,
        this.gameplay.mode,
        this.gameplay.random
      ),
      entity.position ?? this.player.position
    );
    return result;
  }

  awardExperience(amount, position = this.player?.position) {
    if (!Number.isSafeInteger(amount) || amount <= 0) return false;
    const retained = this.experienceOrbs?.spawn(amount, position, {
      pickupDelay: 0.2,
    });
    if (retained !== true) {
      const accepted = this.progressionIntegration
        ? this.progressionIntegration.earnExperience(amount).ok
        : this.gameplay.addExperience(amount);
      if (!accepted) return false;
    }
    this.scheduleSave();
    return true;
  }

  releaseContainer(hit, position) {
    if (![BLOCK.CHEST, BLOCK.FURNACE].includes(hit?.id)) return false;
    this.harvestActions ??= new GameMobHarvestActions(this);
    return this.harvestActions.break(hit, { position }).ok;
  }

  secondary() {
    this.useActions ??= new GameUseActions(this);
    return this.useActions.tap();
  }

  eat(hand = "main") {
    if (this.gameplay.eatFromHand(hand)) {
      this.effects?.sound("place", 1);
      const view = hand === "offhand" ? this.effects.offhand : this.effects;
      if (view) view.swing = 0.8;
      this.scheduleSave();
      this.refreshHud();
      return true;
    }
    return false;
  }

  swapItem(from, to, worldParticipant) {
    if (this.gameplay.getHandStack("main")?.id !== from) return false;
    return this.swapHandItem("main", to, worldParticipant);
  }

  swapHandItem(hand, to, worldParticipant, options) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.swapHandItem(
      hand,
      to,
      worldParticipant,
      options
    );
  }

  prepareDropItems(drops, position, options) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.prepareDropItems(drops, position, options);
  }

  dropItems(drops, position, options) {
    this.inventoryActions ??= new GameInventoryActions(this);
    return this.inventoryActions.dropItems(drops, position, options);
  }

  explode(position, radius = 3, damagePlayer = true) {
    this.harvestActions ??= new GameMobHarvestActions(this);
    const changed = this.harvestActions.explode(position, radius);
    for (const hit of changed.slice(0, 8)) this.effects.burst(hit);
    const distance = this.player.position.distanceTo(
      new THREE.Vector3(position.x, position.y, position.z)
    );
    if (damagePlayer && distance < radius * 2)
      (this.useActions ??= new GameUseActions(this)).damage(
        Math.ceil((1 - distance / (radius * 2)) * 14),
        "an explosion",
        position,
        "explosion"
      );
    this.effects.sound("mine", 3);
    this.graphics.rebuildDirty(8);
    this.scheduleSave();
    return changed;
  }

  teleport(destination) {
    return this.travel.teleport(destination);
  }

  travelBiome(id, options) {
    return this.travel.biome(id, options);
  }

  travelDimension(dimension, portal = false) {
    return this.travel.dimension(dimension, portal);
  }

  respawn() {
    return this.travel.respawn();
  }

  newWorld(seed) {
    return this.travel.generate(seed);
  }

  snapshot() {
    return this.archive.snapshot();
  }

  scheduleSave() {
    // An unopened title-screen tab must not acquire save ownership over a played tab.
    if (this.started) this.archive.scheduleSave();
  }

  save(announce = false) {
    return this.archive.save(announce);
  }

  exportWorld() {
    return this.archive.exportWorld();
  }

  importWorld(file) {
    return this.archive.importWorld(file);
  }

  refreshHud() {
    if (!this.ui || !this.player || !this.world) return;
    const biome = this.world.getBiome(
      this.player.position.x,
      this.player.position.z,
      this.player.position.y
    );
    const station = this.station();
    const gameplayState = this.gameplay.getState();
    this.gameplayState = gameplayState;
    this.ui.update({
      fps: this.fps,
      position: this.player.position,
      blockName: this.target ? BLOCKS[this.target.id]?.name : "",
      targetName: this.meleeTarget?.name ?? "",
      flying: this.player.flying,
      time: this.currentTime,
      seed: this.world.seed,
      generatorVersion: this.world.generatorVersion,
      biome,
      dimension: this.world.dimension,
      chunkCount: this.world.chunks.size,
      gameplay: gameplayState,
      spawnGrace:
        this.gameplay.mode === "survival" && !this.gameplay.dead
          ? (this.wildlife?.spawnGrace ?? 0)
          : 0,
      recipes: this.gameplay.getCraftableRecipes(station),
      station,
      storageStatus: this.storageStatus,
      miningProgress: this.miningProgress,
      quality: this.quality,
      soundEnabled: this.soundEnabled,
      controlPreferences: this.controlPreferences,
      fullbrightInspection: this.graphics.fullbrightInspection,
      guiScale: this.viewPreferences.guiScale,
      showFps: this.viewPreferences.showFps,
      perspective: this.player.perspective ?? "first",
    });
    this.ui.setHotbar?.(this.gameplay.hotbar);
    const heldId = this.gameplay.getHandStack("main")?.id ?? 0;
    if (heldId !== this.heldItemId) {
      this.heldItemId = heldId;
      this.effects.select(heldId);
    }
    const offhandId = this.gameplay.getHandStack("offhand")?.id ?? 0;
    if (offhandId !== this.offhandItemId) {
      this.offhandItemId = offhandId;
      this.effects.selectOffhand(offhandId);
    }
    this.graphics.setBiome?.(biome);
    this.containerUI?.refresh();
  }

  // One borrowed presentation payload per Game. Rebuild its booleans from the
  // current owners after physics/environment/late vehicle exits, never queries.
  swimmingObservation(active) {
    const state = (this.swimPresentation ??= {});
    const player = this.player;
    const fluid = player?.fluidState;
    state.fluidKnown = Boolean(
      active && player?.world === this.world && !player?.fluidMovementBlocked &&
      fluid?.valid && fluid.loaded && fluid.eyeLoaded
    );
    state.swimming = state.fluidKnown && player.swimming === true;
    state.moving = Boolean(active && player?.moving);
    state.grounded = player?.grounded === true;
    state.seated = player?.seated === true;
    state.flying = player?.flying === true;
    state.climbing = player?.climbing === true;
    state.dead = this.gameplay?.dead === true;
    // There is no persisted bob toggle. Use the actual live device motion
    // preference owned by the held view; do not invent a world-save setting.
    state.bob = this.effects?.motionPreference?.matches !== true;
    return state;
  }

  resetSwimmingPresentation() {
    const state = this.swimmingObservation(false);
    this.playerVisual?.update?.(0, { perspective: "first" });
    this.effects?.update?.(0, this.elapsed, false, false, null, state);
  }

  frame(now) {
    this.animation = requestAnimationFrame((time) => this.frame(time));
    const frameTime = (now - this.lastFrame) / 1000;
    const dt = Math.min(frameTime, 0.1);
    this.lastFrame = now;
    this.updateAudio?.(dt);
    this.weatherServices?.frame(dt, {
      simulating: this.simulating && !!this.graphics,
      hidden: document.hidden,
    });
    if (!this.weatherServices?.running)
      audioOperation(this.audioEngine, "setRain", 0);
    this.graphics?.observeFrame?.(frameTime * 1000, {
      paused: this.paused || this.building || this.failed || this.gameplay.dead,
      hidden: document.hidden,
    });
    if (!this.graphics || this.building || this.failed || document.hidden) {
      this.resetSwimmingPresentation();
      this.resetFrameRate();
      return;
    }
    this.elapsed += dt;
    const vehicleFrame = (this.vehicleFrame = (this.vehicleFrame ?? 0) + 1);
    this.vehicleServices?.beginFrame(vehicleFrame);
    this.portalCooldown -= dt;
    if (this.stationOverride && !this.inventoryActions.stationValid()) {
      this.ui.closeInventory();
      this.stationOverride = null;
    }
    this.fluidServices?.frame(dt, { simulating: this.simulating });
    this.vehicleServices?.frame(dt, {
      simulating: this.simulating,
      keys: this.active ? this.player.vehicleKeys : null,
      frameId: vehicleFrame,
    });
    const riderPose = this.vehicleServices?.riderPose();
    const exitPose = this.vehicleServices?.takeExitPose();
    if (this.active) {
      this.player.canSprint =
        this.gameplay.hunger > 6 || this.gameplay.mode === "creative";
    }
    // Read the bound owner now: render observations can outlive their source,
    // life or dimension. Never feed cached ecologyModifiers back into physics.
    const ecology = this.ecologyServices;
    const swimSpeedMultiplier =
      this.active &&
      !riderPose && !exitPose && !this.player.seated &&
      ecology?.active === true &&
      this.mobIntegration?.ecologyServices === ecology &&
      ecology.world === this.world &&
      ecology.gameplay === this.gameplay &&
      ecology.wildlife === this.wildlife
        ? ecology.modifiers().swimSpeedMultiplier
        : 1;
    if (this.active || riderPose || exitPose)
      this.player.update(dt, {
        recoverFromVoid: this.gameplay.mode === "creative",
        ...(swimSpeedMultiplier !== 1 ? { swimSpeedMultiplier } : null),
        ...(riderPose || exitPose ? { riderPose, exitPose } : null),
      });
    if (this.active) {
      this.updateTarget();
      if (this.heldAction === "mine") this.primary(dt, false);
      else this.miningProgress = 0;
    }
    this.useActions.update(this.active ? dt : 0);
    this.projectileServices?.frame(dt, { simulating: this.simulating });
    this.progressionIntegration?.frame(dt, { simulating: this.simulating });
    this.ui.updateCombat?.(
      this.combatFeedback.view({
        now: this.elapsed,
        lastAction: this.lastAction,
        active: this.active,
        hasTarget: !!this.meleeTarget,
        usingItem: !!this.useActions.use?.active,
        hudVisible: this.ui.isHudVisible !== false,
      })
    );
    this.buildingServices?.frame(dt, { simulating: this.simulating });
    this.explorationServices?.frame(dt);
    if (this.simulating) {
      const p = this.player.position;
      const feet = this.world.get(
        Math.floor(p.x),
        Math.floor(p.y),
        Math.floor(p.z)
      );
      const environment = this.player.gameplayEnvironment(
        (this.playerEnvironment ??= {})
      );
      this.gameplay.update(dt, environment);
      if (this.settlement.update(dt, this.world)) this.scheduleSave();
      if (environment.inVoid) this.gameplay.damage(20, "the void", "void");
      if (
        [BLOCK.NETHER_PORTAL, BLOCK.END_PORTAL].includes(feet) &&
        this.portalCooldown <= 0
      ) {
        this.portalCooldown = 10;
        void this.travelDimension(
          this.world.dimension === "overworld"
            ? feet === BLOCK.NETHER_PORTAL
              ? "nether"
              : "end"
            : "overworld",
          true
        );
      }
      this.fuses.update(dt, this.world, (position, radius) =>
        this.explode(position, radius)
      );
      if (this.overflow.flush(this.world, this.pickups)) this.scheduleSave();
    }
    this.streamTimer += dt;
    if (this.streamTimer > 0.15) {
      this.streamTimer = 0;
      this.world.updateStreaming(
        this.player.position,
        this.graphics.renderRadius
      );
    }
    this.graphics.setTarget(
      this.active && this.ui.isHudVisible !== false && !this.meleeTarget
        ? this.target
        : null,
      this.miningProgress
    );
    // Wildlife's view sorting needs the current camera direction, not the
    // renderer's later lighting/LOD snapshot. Keep this sample before AI.
    this.graphics.camera.getWorldDirection(this.renderDirection);
    const difficulty = this.readWorldDifficulty();
    this.wildlife.context && Object.assign(this.wildlife.context, {
      difficulty: difficulty.value, difficultyRevision: difficulty.revision,
    });
    const wildlifeFrame = () => this.wildlife.update(
      this.simulating ? dt : 0,
      this.elapsed,
      this.player.position,
      {
        timeOfDay: this.currentTime,
        mode: this.gameplay.mode,
        playerForward: this.player.forward,
        playerEye: physicalEye(this),
        playerHeight: this.player.height ?? this.player.bodyHeight ?? 1.8,
        renderEye: this.graphics.camera.position,
        renderForward: this.renderDirection,
        health: this.gameplay.health,
      }
    );
    if (this.vehicleServices) this.vehicleServices.runWildlifeFrame(wildlifeFrame);
    else wildlifeFrame();
    // Late Wildlife damage/bucking may publish an exit after the first Player
    // consumer. Consume only that pending handoff, never a second walking tick.
    const lateExit = this.vehicleServices?.takeExitPose();
    if (lateExit && !this.gameplay.dead)
      this.player.update(0, { recoverFromVoid: false, exitPose: lateExit });
    // Resolve every physical owner and late dismount before testing swept
    // falling-cell occupancy. Keep one mesh budget, after these World edits.
    this.gravityServices?.frame(dt, { simulating: this.simulating });
    this.graphics.rebuildDirty(this.quality === "high" ? 2 : 1);
    // Snapshot daylight and cut LOD only after final poses, mutations and mesh
    // admission: an earlier snapshot can overlap new detail or hide fallback
    // for a row culled by a late dismount.
    this.graphics.update(0, this.elapsed, this.player.position);
    this.pickups.update(
      this.simulating ? dt : 0,
      this.elapsed,
      this.player.position,
      this.gameplay
    );
    this.experienceOrbs.update(
      this.simulating ? dt : 0,
      this.elapsed,
      this.player.position,
      this.gameplay
    );
    const hurt = this.hurtFeedback.update(dt, {
      simulating: this.simulating,
      visible: this.active,
      dead: this.gameplay.dead,
    });
    this.ui.updateHurt?.(hurt);
    const perspective = this.player.perspective ?? "first";
    const locomotion = this.swimmingObservation(this.active);
    if (perspective !== "first") {
      this.playerVisual.update(this.active ? dt : 0, {
        ...locomotion,
        position: this.player.position,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        moving: this.active && this.player.moving,
        sprinting: this.player.sprinting,
        crouching: this.player.sneaking,
        seated: this.player.seated === true,
        vehicleType: this.player.vehicleType,
        hullYaw: this.player.hullHeading,
        horseView: this.player.vehicleType === "horse"
          ? this.wildlife.byId.get(this.horses?.mountFor()?.id)?.horseView ?? null : null,
        bodyHeight: this.player.height,
        eyeHeight: this.player.eyeHeight,
        velocityY: this.player.velocity.y,
        perspective,
        mainHand: this.gameplay.getHandStack("main"),
        offhand: this.gameplay.getHandStack("offhand"),
        equipment: this.gameplayState?.equipment,
        hurtTint: hurt.tint,
      });
    } else if (this.playerVisual.visible) {
      this.playerVisual.update(0, { perspective: "first" });
    }
    this.effects.update(
      dt,
      this.elapsed,
      this.player.moving,
      this.active &&
        this.ui.isHudVisible !== false &&
        (this.player.perspective ?? "first") === "first",
      this.useActions.use,
      locomotion
    );
    this.vehicleServices?.render(this.simulating ? dt : 0);
    this.projectileServices?.render();
    // Atmosphere has already updated. Apply world-anchored clouds and the final
    // admitted rain/audio projection immediately before the scene draw.
    this.renderWeather();
    this.hurtFeedback.render(this.graphics.camera, hurt, () =>
      this.graphics.render()
    );
    (this.frameRate ??= new FrameRate()).observe(frameTime * 1000);
    this.fps = this.frameRate.fps;
    this.hudTimer += dt;
    if (this.hudTimer > 0.2) {
      this.hudTimer = 0;
      this.refreshHud();
    }
    if (this.started && this.simulating) this.autosaveTimer += dt;
    if (this.autosaveTimer > 15) {
      this.autosaveTimer = 0;
      void this.save();
    }
  }

  showError(error) {
    this.disposeAudio();
    this.weatherServices?.dispose();
    this.renderedWeather = null;
    console.error(error);
    this.browserCapture?.dispose();
    this.hurtFeedback?.dispose();
    this.ui?.updateHurt?.({});
    this.failed = true;
    this.building = false;
    const panel = document.createElement("div");
    panel.className = "fatal-error";
    const heading = document.createElement("h1");
    heading.textContent = "This world couldn't open";
    const message = document.createElement("p");
    message.textContent = `${error.message}. Use a current desktop browser with WebGL 2 enabled. Your saved world has not been deleted.`;
    const retry = document.createElement("button");
    retry.textContent = "Try again";
    retry.onclick = () => location.reload();
    panel.append(heading, message, retry);
    document.querySelector("#ui").replaceChildren(panel);
  }
}
