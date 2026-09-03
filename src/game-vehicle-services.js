import { boatInput, boatWoodForItem } from "./boat-definitions.js";
import { boatBox } from "./boat-physics.js";
import { Boats } from "./boats.js";
import { bodyBox, boxCollides, sweepCameraDistance } from "./collision.js";
import { Fishing } from "./fishing.js";
import { fishingRodStats } from "./fishing-loot.js";
import { createFluidSample, sampleFluidAtPoint } from "./fluid-sampling.js";
import {
  prepareVehicleDrops,
  prepareVehicleExperience,
  prepareVehicleHandCost,
  readVehicleOwner,
} from "./game-vehicle-owners.js";
import {
  normalizeVehicleServiceContext,
  normalizeVehicleServicesSnapshot,
  vehicleContextMatches,
  vehicleHandSlot,
  vehicleHostBindable,
  vehicleRecord,
  vehicleSynchronous,
} from "./game-vehicle-state.js";
import { getItem } from "./items.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import { commitVehicleSnapshots } from "./vehicle-load.js";
import { finitePoint, loadedAquaticArea } from "./vehicle-water.js";
import { createWorldContext } from "./world-spec.js";

export { normalizeVehicleServicesSnapshot };

const refused = (reason) => ({ ok: false, reason });
const IDLE = Object.freeze({ ok: true, advanced: false });
const HELD = Object.freeze({ ok: true, action: "held-vehicle-use" });
const NO_FRAME_OPTIONS = Object.freeze({});
const position = ({ x, y, z }) => ({ x, y, z });
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const distanceSquared = (a, b) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const bindingNames = ["vehicleServices", "boats", "fishing"];

/**
 * Detached stage/load -> activate(game) -> frame/render/serialize -> dispose.
 * Owns only Boats/Fishing and their bounded render adapters, not its input
 * World/Gameplay/DropOverflow/ExperienceOrbs/Player. XP may be supplied at stage
 * time or bound to the REAL game.experienceOrbs at activation.
 *
 * Parent supplies the actual Player's keys to frame, then passes riderPose()
 * and takeExitPose() into Player's mounted branch instead of walking. Look,
 * camera and Gameplay.environment/update continue normally. Call render AFTER
 * that Player update. No input listeners, chunk admission, eager rewards,
 * whole-save frame projections, observer replacement or camera-yaw steering.
 */
export class GameVehicleServices {
  constructor({
    world,
    gameplay,
    overflow,
    experienceOrbs = null,
    coordinator = world?.coordinator,
    context = gameplay?.context ?? (world && createWorldContext(world)),
    saved = null,
    allowOverBudget = false,
    scene = null,
    lootTables,
  } = {}) {
    const cleanContext = normalizeVehicleServiceContext(context);
    const snapshot = normalizeVehicleServicesSnapshot(saved, context);
    if (
      !world ||
      world._disposed ||
      !(world.chunks instanceof Map) ||
      !(coordinator instanceof TransactionCoordinator) ||
      coordinator !== world.coordinator ||
      !cleanContext ||
      !snapshot ||
      !vehicleContextMatches(context, world) ||
      typeof allowOverBudget !== "boolean" ||
      scene !== null ||
      [gameplay, overflow].some(
        (owner) =>
          !owner ||
          owner._disposed ||
          owner.coordinator !== coordinator ||
          coordinator.usage(owner) === undefined ||
          !vehicleContextMatches(owner.context, world)
      ) ||
      coordinator.usage(world) === undefined ||
      !vehicleSynchronous(world.getCell) ||
      !vehicleSynchronous(gameplay.getHandStack) ||
      !vehicleSynchronous(gameplay.getHandRevision) ||
      !vehicleSynchronous(gameplay.prepareHandCost) ||
      !vehicleSynchronous(gameplay.prepareInventory) ||
      !vehicleSynchronous(overflow.prepareEnqueue)
    )
      throw new RangeError("Invalid staged vehicle services");
    this.world = world;
    this.gameplay = gameplay;
    this.overflow = overflow;
    this.experienceOrbs = experienceOrbs;
    this.context = context;
    this.coordinator = coordinator;
    this._owners = Object.freeze({
      world,
      gameplay,
      overflow,
      context,
      coordinator,
    });
    this._gameplayContext = gameplay.context;
    this._overflowContext = overflow.context;
    this._specForDimension = context.specForDimension;
    this._seed = world.seed;
    this._generatorVersion = world.generatorVersion;
    this._preparedEpoch = world.epoch;
    this._preparedDimension = world.dimension;
    this._revision = 0;
    this._game = this._candidateGame = this._player = this._scene = null;
    this._experienceContext = experienceOrbs?.context;
    this._experienceOwner = experienceOrbs;
    this._disposed = this._frameBusy = this._actionBusy = this._loading = false;
    this._useLatched = this._frameChanged = false;
    this._saveIn = 0;
    this._exitPose = null;
    this._plans = new WeakSet();
    this._observerErrors = [];
    this._controls = { player: { forward: 0, turn: 0, dismount: false } };
    const sample = createFluidSample();
    this._hooks = Object.freeze({
      coordinator,
      context,
      allowOverBudget,
      available: () => this._leafAvailable(),
      readOwner: (ownerId, hand) => readVehicleOwner(this, ownerId, hand),
      prepareHandCost: (request) => prepareVehicleHandCost(this, request),
      prepareDrops: (request) => prepareVehicleDrops(this, request),
      prepareExperience: (request) => prepareVehicleExperience(this, request),
      sampleFluid: (source, point) => sampleFluidAtPoint(source, point, sample),
      onChange: () => this._changed(),
    });
    if (experienceOrbs !== null && !this._validExperience(experienceOrbs))
      throw new RangeError("Invalid staged vehicle experience owner");
    if (!coordinator.register(this, 0, { allowOverBudget }))
      throw new RangeError("Cannot register vehicle lifecycle");
    try {
      this.boats = new Boats(null, world, {
        ...this._hooks,
        onEvent: (event) => this._boatEvent(event),
      });
      this.fishing = new Fishing(null, world, {
        ...this._hooks,
        lootTables,
        onEvent: (event) => this._fishingEvent(event),
      });
      this._boatOwner = this.boats;
      this._fishingOwner = this.fishing;
      if (!this.load(snapshot, { allowOverBudget }))
        throw new RangeError("Cannot restore staged vehicles");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  _validExperience(owner) {
    return (
      !!owner &&
      !owner._disposed &&
      owner.world === this.world &&
      owner.coordinator === this.coordinator &&
      this.coordinator.usage(owner) !== undefined &&
      vehicleContextMatches(owner.context, this.world) &&
      vehicleSynchronous(owner.prepareSpawn)
    );
  }

  _worldAvailable() {
    const owners = this._owners;
    return (
      !this._disposed &&
      this.world === owners.world &&
      this.gameplay === owners.gameplay &&
      this.overflow === owners.overflow &&
      this.context === owners.context &&
      this.coordinator === owners.coordinator &&
      !this.world._disposed &&
      !this.gameplay._disposed &&
      !this.overflow._disposed &&
      this.world.coordinator === this.coordinator &&
      this.gameplay.coordinator === this.coordinator &&
      this.overflow.coordinator === this.coordinator &&
      this.coordinator.usage(this.world) !== undefined &&
      this.coordinator.usage(this.gameplay) !== undefined &&
      this.coordinator.usage(this.overflow) !== undefined &&
      this.coordinator.usage(this) === 0 &&
      this.gameplay.context === this._gameplayContext &&
      this.overflow.context === this._overflowContext &&
      vehicleContextMatches(this.gameplay.context, this.world) &&
      vehicleContextMatches(this.overflow.context, this.world) &&
      this.context.specForDimension === this._specForDimension &&
      this.context.seed === this._seed &&
      this.context.generatorVersion === this._generatorVersion &&
      this.world.seed === this._seed &&
      this.world.generatorVersion === this._generatorVersion &&
      this.boats === this._boatOwner &&
      this.fishing === this._fishingOwner &&
      !!this.boats &&
      !!this.fishing &&
      !this.boats._disposed &&
      !this.fishing._disposed &&
      this.boats.world === this.world &&
      this.fishing.world === this.world &&
      this.boats.context === this.context &&
      this.fishing.context === this.context &&
      this.boats.coordinator === this.coordinator &&
      this.fishing.coordinator === this.coordinator &&
      this.boats.available === this._hooks.available &&
      this.fishing.available === this._hooks.available &&
      this.boats.readOwner === this._hooks.readOwner &&
      this.fishing.readOwner === this._hooks.readOwner &&
      this.boats.prepareHandCost === this._hooks.prepareHandCost &&
      this.fishing.prepareHandCost === this._hooks.prepareHandCost &&
      this.boats.prepareDrops === this._hooks.prepareDrops &&
      this.fishing.prepareDrops === this._hooks.prepareDrops &&
      this.fishing.prepareExperience === this._hooks.prepareExperience &&
      this.boats.sampleFluid === this._hooks.sampleFluid &&
      this.fishing.sampleFluid === this._hooks.sampleFluid &&
      this.coordinator.usage(this.boats) === this.boats.reservedBytes &&
      this.coordinator.usage(this.fishing) === this.fishing.reservedBytes
    );
  }

  _staged() {
    return (
      this._worldAvailable() &&
      !this._game &&
      this.world.epoch === this._preparedEpoch &&
      this.world.dimension === this._preparedDimension
    );
  }

  get active() {
    const game = this._game;
    return (
      this._worldAvailable() &&
      !!game &&
      game.world === this.world &&
      game.gameplay === this.gameplay &&
      game.overflow === this.overflow &&
      game.vehicleServices === this &&
      game.boats === this.boats &&
      game.fishing === this.fishing &&
      game.player === this._player &&
      game.player.world === this.world &&
      game.experienceOrbs === this.experienceOrbs &&
      this.experienceOrbs === this._experienceOwner &&
      this._validExperience(this.experienceOrbs) &&
      this.experienceOrbs.context === this._experienceContext &&
      game.graphics?.scene === this._scene &&
      game.worldContext === this._gameContext &&
      (game.coordinator === undefined || game.coordinator === this.coordinator)
    );
  }

  _leafAvailable() {
    return this._candidateGame
      ? this._staged()
      : this.active && (!this._frameBusy || this._running());
  }

  _running() {
    const game = this._game;
    return (
      !!game &&
      !game.paused &&
      !game.building &&
      !game.failed &&
      !this.gameplay.dead
    );
  }

  _actionAvailable() {
    const game = this._game;
    return (
      this.active &&
      this._running() &&
      game.active !== false &&
      !game.overlayOpen &&
      !game.closingScreens &&
      !this._loading
    );
  }

  _captureGuard(action = true, pose = true) {
    const game = this._game,
      player = this._player;
    const epoch = this.world.epoch,
      dimension = this.world.dimension,
      revision = this._revision;
    const at = pose ? position(player.position) : null;
    const eye = pose ? position(player.eyePosition) : null;
    const poseRevision = player?.poseRevision,
      yaw = player?.yaw,
      pitch = player?.pitch;
    return () =>
      (action ? this._actionAvailable() : this.active) &&
      this._game === game &&
      this._player === player &&
      this._revision === revision &&
      this.world.epoch === epoch &&
      this.world.dimension === dimension &&
      (!pose ||
        (samePoint(player.position, at) &&
          samePoint(player.eyePosition, eye) &&
          player.poseRevision === poseRevision &&
          player.yaw === yaw &&
          player.pitch === pitch));
  }

  /** Call while detached; both normalized leaves install together or not at all. */
  load(saved, { allowOverBudget = false } = {}) {
    if (
      !this._staged() ||
      this._candidateGame ||
      this._loading ||
      typeof allowOverBudget !== "boolean"
    )
      return false;
    const snapshot = normalizeVehicleServicesSnapshot(saved, this.context);
    if (!snapshot) return false;
    const boats = this.boats.prepareLoad(snapshot.boats);
    const fishing = this.fishing.prepareLoad(snapshot.fishing);
    if (!boats || !fishing) return false;
    this._loading = true;
    try {
      if (
        !commitVehicleSnapshots(
          this.coordinator,
          [boats, fishing],
          allowOverBudget
        )
      )
        return false;
      this._revision++;
      return true;
    } finally {
      this._loading = false;
    }
  }

  /**
   * Optional staging hints, at most two radius-one neighborhoods. Parent owns
   * any admission BEFORE activation, never calls ensureArea in the frame loop.
   */
  requiredFootprints() {
    if (!this._staged()) return [];
    const result = [];
    const rider = this.boats.riderPose();
    if (rider)
      result.push({
        ...position(rider.position),
        dimension: rider.dimension,
        radius: 1,
        reason: "rider",
      });
    const cast = this.fishing.getCast();
    if (cast?.dimension === this.world.dimension)
      result.push({
        ...position(cast),
        dimension: cast.dimension,
        radius: 1,
        reason: "cast",
      });
    return result;
  }

  /** Validate the restored rider before tearing down the previous live Game. */
  stageRiderPose(savedPosition) {
    if (!this._staged()) return refused("stale-vehicle-stage");
    return this._checkRiderPose(savedPosition);
  }

  /** Check real staged Gameplay's rod/slot as well, before live Game teardown. */
  stagePlayerPose(savedPosition) {
    if (!finitePoint(savedPosition))
      return refused("invalid-staged-player-pose");
    const rider = this.stageRiderPose(savedPosition);
    if (!rider.ok || this.gameplay.dead) return rider;
    const cast = this.fishing.getCast();
    if (
      !cast ||
      !this.fishing.needsBinding() ||
      cast.dimension !== this.world.dimension
    )
      return rider;
    const checked = this.fishing.checkLoadedOwner("player", {
      position: rider.riderPose?.position ?? savedPosition,
      dimension: this.world.dimension,
      stack: this.gameplay.getHandStack(cast.hand),
      handRevision: this.gameplay.getHandRevision(cast.hand),
      slotKey: vehicleHandSlot(this.gameplay, cast.hand),
    });
    return checked.ok ? rider : checked;
  }

  _checkRiderPose(savedPosition) {
    const rider = this.boats.riderPose();
    if (!rider || this.gameplay.dead) return { ok: true, riderPose: null };
    if (
      !finitePoint(savedPosition) ||
      distanceSquared(savedPosition, rider.position) > 0.125 ** 2
    )
      return refused("saved-rider-pose-mismatch");
    const boat = this.boats.getBoat(rider.id);
    if (!loadedAquaticArea(this.world, boatBox(boat, true)))
      return refused("rider-frontier");
    if (
      boxCollides(this.world, boatBox(boat, true)) ||
      boxCollides(this.world, bodyBox(rider.position))
    )
      return refused("rider-obstructed");
    return { ok: true, riderPose: rider };
  }

  activate(game) {
    if (this._game)
      return this._game === game && this.active
        ? { ok: true }
        : refused("vehicle-services-already-bound");
    if (
      !vehicleRecord(game) ||
      !this._staged() ||
      this._loading ||
      this._candidateGame ||
      game.world !== this.world ||
      game.gameplay !== this.gameplay ||
      game.overflow !== this.overflow ||
      (game.coordinator !== undefined &&
        game.coordinator !== this.coordinator) ||
      (game.worldContext !== undefined &&
        !vehicleContextMatches(game.worldContext, this.world)) ||
      game.player?.world !== this.world ||
      !finitePoint(game.player.position) ||
      !finitePoint(game.player.eyePosition) ||
      !finitePoint(game.player.forward) ||
      !this._validExperience(game.experienceOrbs) ||
      (this.experienceOrbs !== null &&
        game.experienceOrbs !== this.experienceOrbs)
    )
      return refused("stale-vehicle-host");
    const scene = game.graphics?.scene;
    if (scene != null && scene.isScene !== true)
      return refused("invalid-vehicle-scene");
    const bindings = [this, this.boats, this.fishing];
    if (
      !bindingNames.every((name, index) =>
        vehicleHostBindable(game, name, bindings[index])
      ) ||
      !this.coordinator.register(this, 0, { allowOverBudget: true })
    )
      return refused("vehicle-host-already-owned");
    const rider = this.stagePlayerPose(game.player.position);
    if (!rider.ok) return rider;
    const player = game.player,
      experience = game.experienceOrbs,
      gameContext = game.worldContext;
    const at = position(player.position),
      eye = position(player.eyePosition);
    const poseRevision = player.poseRevision,
      yaw = player.yaw,
      pitch = player.pitch;
    const gameplayRevision = this.gameplay.revision;
    const boatRevision = this.boats.revision,
      fishingRevision = this.fishing.revision;
    // Scene.add dispatches public Three.js events. Revalidate the staged
    // owners/pose after renderer construction, before ANY binding publication.
    const current = () =>
      this._staged() &&
      this._candidateGame === game &&
      game.world === this.world &&
      game.gameplay === this.gameplay &&
      game.overflow === this.overflow &&
      game.player === player &&
      player.world === this.world &&
      game.experienceOrbs === experience &&
      this._validExperience(experience) &&
      game.worldContext === gameContext &&
      game.graphics?.scene === scene &&
      (game.coordinator === undefined ||
        game.coordinator === this.coordinator) &&
      this.gameplay.revision === gameplayRevision &&
      this.boats.revision === boatRevision &&
      this.fishing.revision === fishingRevision &&
      samePoint(player.position, at) &&
      samePoint(player.eyePosition, eye) &&
      player.poseRevision === poseRevision &&
      player.yaw === yaw &&
      player.pitch === pitch &&
      bindingNames.every((name, index) =>
        vehicleHostBindable(game, name, bindings[index])
      );
    this._candidateGame = game;
    let installed = false;
    try {
      const participants = [];
      if (this.gameplay.dead) {
        if (this.boats.mountFor()) {
          const release = this.boats.preparePassengerRelease();
          if (!release.ok) return release;
          participants.push(...release.participants);
        }
        if (this.fishing.hasCast()) {
          const cancel = this.fishing.prepareCancel("player", "owner-dead");
          if (!cancel.ok) return cancel;
          participants.push(...cancel.participants);
        }
      } else if (
        this.fishing.needsBinding() &&
        this.fishing.getCast().dimension === this.world.dimension
      ) {
        const bind = this.fishing.prepareBindLoadedOwner();
        if (!bind.ok) return bind;
        participants.push(...bind.participants);
      }
      if (
        !this.boats.bindRenderer(scene ?? null) ||
        !this.fishing.bindRenderer(scene ?? null)
      )
        return refused("vehicle-render-binding-rejected");
      if (!current()) return refused("stale-vehicle-activation");
      const result = participants.length
        ? this.coordinator.commit(
            participants.map((participant) => ({
              ...participant,
              validate: () => current() && participant.validate(),
            }))
          )
        : { ok: true, observerErrors: [] };
      if (!result.ok) return result;
      for (let index = 0; index < bindingNames.length; index++)
        Object.defineProperty(game, bindingNames[index], {
          value: bindings[index],
          configurable: true,
          writable: true,
          enumerable: true,
        });
      this._game = game;
      this._player = game.player;
      this._scene = scene;
      this._gameContext = game.worldContext;
      this.experienceOrbs = this._experienceOwner = game.experienceOrbs;
      this._experienceContext = this.experienceOrbs.context;
      this._revision++;
      installed = true;
      return { ...result, riderPose: rider.riderPose };
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return refused("vehicle-activation-rejected");
    } finally {
      this._candidateGame = null;
      if (!installed)
        for (const leaf of [this.boats, this.fishing]) {
          leaf.renderer?.dispose();
          leaf.renderer = null;
        }
    }
  }

  _guardPlan(plan, action = true, pose = true) {
    if (!plan?.ok || !Array.isArray(plan.participants))
      return plan ?? refused("invalid-vehicle-plan");
    const guard = this._captureGuard(action, pose);
    const result = Object.freeze({
      ...plan,
      participants: Object.freeze(
        plan.participants.map((participant) =>
          Object.freeze({
            ...participant,
            validate: () => guard() && participant.validate(),
          })
        )
      ),
    });
    this._plans.add(result);
    return result;
  }

  _prepareAction(prepare) {
    if (this._actionBusy || this._frameBusy || !this._actionAvailable())
      return refused("vehicle-action-unavailable");
    this._actionBusy = true;
    try {
      return this._guardPlan(prepare());
    } finally {
      this._actionBusy = false;
    }
  }

  commit(plan) {
    if (!plan?.ok) return plan ?? refused("invalid-vehicle-plan");
    if (!this._plans.has(plan)) return refused("foreign-vehicle-plan");
    const result = this.coordinator.commit(plan.participants);
    if (!result.ok) return result;
    const { participants, ...detail } = plan;
    return { ...detail, ...result };
  }

  /** null means this hand is not a boat/rod; failures are handled, not fallthrough. */
  prepareUseHand(hand = "main") {
    if (!["main", "offhand"].includes(hand)) return refused("invalid-hand");
    const stack = this.gameplay.getHandStack(hand);
    const wood = boatWoodForItem(stack?.id);
    const rod = fishingRodStats(stack, this.context);
    if (wood === null && !rod) return null;
    return this._prepareAction(() => {
      const actor = this._hooks.readOwner("player", hand);
      if (!actor) return refused("physical-eye-unavailable");
      if (wood !== null) {
        const target = this.boats.raycastWater(actor.eye, actor.direction);
        return target
          ? this.boats.preparePlace({
              hand,
              point: target.point,
              yaw: this._player.yaw,
            })
          : refused("water-or-clearance");
      }
      if (!this.fishing.hasCast()) return this.fishing.prepareCast({ hand });
      const reel = this.fishing.prepareReel();
      return reel.reason === "rod-changed"
        ? this.fishing.prepareCancel("player", "rod-changed")
        : reel;
    });
  }

  useHand(hand = "main", { held = false } = {}) {
    if (typeof held !== "boolean") return refused("invalid-use-gesture");
    if (held && this._useLatched) return HELD;
    const plan = this.prepareUseHand(hand);
    if (plan === null) return null;
    if (held) this._useLatched = true;
    return this.commit(plan);
  }

  resetInput() {
    this._useLatched = false;
  }

  /** Pass the nearer solid-block/mob distance; physical geometry also clips it. */
  raycast(maxDistance = 6) {
    if (
      !this._actionAvailable() ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0 ||
      (!this.boats.activeSize && !this.fishing.activeSize)
    )
      return null;
    const actor = this._hooks.readOwner("player", "main");
    if (!actor) return null;
    const reach = sweepCameraDistance(
      this.world,
      actor.eye,
      actor.direction,
      Math.min(6, maxDistance),
      0
    );
    const boat = this.boats.raycast(actor.eye, actor.direction, reach);
    const bobber = this.fishing.raycast(actor.eye, actor.direction, reach);
    return boat && (!bobber || boat.distance <= bobber.distance)
      ? boat
      : bobber;
  }

  prepareInteract(hit) {
    if (!["boat", "fishing-bobber"].includes(hit?.type)) return null;
    return this._prepareAction(() => {
      // Re-pick, never trust a stale Game target or a fabricated entity ID.
      const current = this.raycast();
      if (!current || current.type !== hit.type || current.id !== hit.id)
        return refused("stale-vehicle-target");
      if (hit.type === "fishing-bobber")
        return current.ownerId === "player"
          ? this.fishing.prepareReel()
          : refused("not-owned-bobber");
      return this.boats.mountFor()?.id === hit.id
        ? this.boats.prepareDismount()
        : this.boats.prepareMount(hit.id);
    });
  }

  interact(hit, { held = false } = {}) {
    if (typeof held !== "boolean") return refused("invalid-use-gesture");
    if (held && this._useLatched) return HELD;
    const plan = this.prepareInteract(hit);
    if (plan === null) return null;
    if (held) this._useLatched = true;
    return this.commit(plan);
  }

  prepareBreak(hit) {
    if (hit?.type !== "boat") return null;
    return this._prepareAction(() => {
      const current = this.raycast();
      return current?.type === "boat" && current.id === hit.id
        ? this.boats.prepareBreak(hit.id)
        : refused("stale-vehicle-target");
    });
  }

  attack(hit) {
    const plan = this.prepareBreak(hit);
    return plan === null ? null : this.commit(plan);
  }

  dismount() {
    return this.commit(this._prepareAction(() => this.boats.prepareDismount()));
  }

  riderPose() {
    return this.active && !this.gameplay.dead ? this.boats.riderPose() : null;
  }

  /** Save can run before Player consumes this frame's committed seat/exit. */
  poseForArchive() {
    const rider = this.riderPose();
    if (rider) return rider;
    if (!this.active || this.gameplay.dead || !this._exitPose) return null;
    return {
      ...this._exitPose,
      position: position(this._exitPose.position),
      velocity: position(this._exitPose.velocity),
    };
  }

  takeExitPose() {
    if (!this.active) return null;
    const exit = this._exitPose;
    this._exitPose = null;
    return exit;
  }

  /** On return to an inactive saved dimension, after admitting Player's pose. */
  rebindPlayer() {
    if (
      !this.active ||
      this._frameBusy ||
      this._actionBusy ||
      this.gameplay.dead
    )
      return refused("vehicle-binding-unavailable");
    const rider = this._checkRiderPose(this._player.position);
    if (!rider.ok) return rider;
    if (
      !this.fishing.needsBinding() ||
      this.fishing.getCast().dimension !== this.world.dimension
    )
      return rider;
    const bind = this._guardPlan(this.fishing.prepareBindLoadedOwner(), false);
    const result = this.commit(bind);
    return result.ok ? { ...result, riderPose: rider.riderPose } : result;
  }

  /**
   * Parent calls only for an accepted travel/teleport, or while Gameplay.dead,
   * before changing/reviving Player. Cancels the cast and detaches the passenger
   * together; never calls dismount or invents a destination in the old world.
   */
  prepareDeparture(reason = "travel") {
    if (
      !this.active ||
      this._actionBusy ||
      this._frameBusy ||
      !["travel", "death"].includes(reason) ||
      (reason === "death" && !this.gameplay.dead)
    )
      return refused("vehicle-departure-unavailable");
    const participants = [];
    if (this.boats.mountFor()) {
      const release = this.boats.preparePassengerRelease("player", {
        travelling: reason === "travel",
      });
      if (!release.ok) return release;
      participants.push(...release.participants);
    }
    if (this.fishing.hasCast()) {
      const cancel = this.fishing.prepareCancel(
        "player",
        reason === "death" ? "owner-dead" : "owner-travel"
      );
      if (!cancel.ok) return cancel;
      participants.push(...cancel.participants);
    }
    const revision = this._revision;
    const boatRevision = this.boats.revision,
      fishingRevision = this.fishing.revision;
    let used = false,
      notified = false;
    participants.push({
      owner: this,
      beforeBytes: 0,
      afterBytes: 0,
      validate: () =>
        !used &&
        this._revision === revision &&
        this.boats.revision === boatRevision &&
        this.fishing.revision === fishingRevision &&
        (reason !== "death" || this.gameplay.dead === true),
      publish: () => {
        used = true;
        this._revision++;
        this._exitPose = null;
        this._useLatched = false;
      },
      notify: () => {
        if (!used || notified) return;
        notified = true;
        const errors = [];
        for (const clear of [
          () => this.boats.renderer?.render([], null),
          () => this.fishing.renderer?.clearFeedback(),
          () => this.fishing.renderer?.render([], null, null),
        ])
          try {
            clear();
          } catch (error) {
            errors.push(error);
          }
        if (errors.length)
          throw new AggregateError(
            errors,
            "Vehicle departure observers failed"
          );
      },
    });
    return this._guardPlan(
      { ok: true, action: "departure", reason, participants },
      false,
      false
    );
  }

  _depart(reason) {
    return this.commit(this.prepareDeparture(reason));
  }

  detachForTravel() {
    return this._depart("travel");
  }
  onDeath() {
    return this._depart("death");
  }

  onMutation(sourceWorld, event) {
    if (
      sourceWorld !== this.world ||
      !this.active ||
      event?.epoch !== this.world.epoch ||
      event?.dimension !== this.world.dimension
    )
      return false;
    return this.fishing.onMutation(event);
  }

  /** Admission does not simulate or generate. Existing casts resume next frame. */
  onChunkLoaded(sourceWorld, event) {
    return (
      sourceWorld === this.world &&
      this.active &&
      event?.epoch === this.world.epoch &&
      event?.dimension === this.world.dimension
    );
  }

  frame(
    dt,
    {
      simulating = this._game?.simulating === true,
      keys = null,
    } = NO_FRAME_OPTIONS
  ) {
    if (
      !this.active ||
      this._frameBusy ||
      this._actionBusy ||
      this._loading ||
      !Number.isFinite(dt) ||
      dt < 0 ||
      typeof simulating !== "boolean"
    )
      return refused("vehicle-frame-unavailable");
    if (this.gameplay.dead) {
      if (this.boats.mountFor() || this.fishing.hasCast())
        return this.onDeath();
      return IDLE;
    }
    if (
      !simulating ||
      !this._running() ||
      dt === 0 ||
      (!this.boats.activeSize && !this.fishing.activeSize)
    )
      return IDLE;
    this._frameBusy = true;
    this._frameChanged = false;
    try {
      boatInput(this._actionAvailable() ? keys : null, this._controls.player);
      const boats = this.boats.activeSize
        ? this.boats.update(dt, {
            viewer: this._player.position,
            controls: this._controls,
          })
        : null;
      const fishing =
        this.active && this._running() && this.fishing.activeSize
          ? this.fishing.update(dt)
          : null;
      this._saveIn = Math.max(0, this._saveIn - Math.min(dt, 0.2));
      if (this._frameChanged && this._saveIn === 0 && this.active) {
        this._saveIn = 1;
        this._observe(() => this._game.scheduleSave?.());
      }
      return {
        ok: true,
        advanced: !!(boats?.moved || fishing?.ticks),
        boats,
        fishing,
      };
    } finally {
      this._frameBusy = false;
    }
  }

  /** Call after Player consumes its vehicle pose, just before graphics.render. */
  render(dt = 0) {
    if (!this.active || !Number.isFinite(dt) || dt < 0) return false;
    this.boats.render(this._player.position);
    this.fishing.render(this._player.position, this._running() ? dt : 0);
    return true;
  }

  _observe(callback) {
    if (!this.active) return;
    try {
      callback();
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      if (this._observerErrors.length < 16) this._observerErrors.push(error);
    }
  }

  _changed() {
    if (!this.active) return;
    if (this._frameBusy) {
      this._frameChanged = true;
      return;
    }
    this._observe(() => this._game.refreshHud?.());
    this._observe(() => this._game.scheduleSave?.());
  }

  _boatEvent(event) {
    if (!this.active) return;
    if (event.ownerId === "player") {
      if (event.type === "dismount")
        this._exitPose = {
          ...event.exit,
          position: position(event.exit.position),
          velocity: position(event.exit.velocity),
        };
      if (event.type === "mount" || event.type === "release")
        this._exitPose = null;
    }
    if (event.type === "mount")
      this._observe(() =>
        this._game.ui?.toast?.("A/D steer · W/S paddle · Shift to dismount")
      );
    if (event.type === "place" || event.type === "break")
      this._observe(() => this._game.effects?.sound?.(event.type, event.id));
  }

  _fishingEvent(event) {
    if (!this.active) return;
    const text =
      event.type === "cast"
        ? "Line cast — wait for a bite"
        : event.type === "approach"
          ? "A fish is approaching…"
          : event.type === "bite"
            ? "Bite! Use the rod to reel in"
            : event.type === "miss"
              ? "The fish got away"
              : event.type === "catch"
                ? `Caught ${getItem(event.stack.id).name} · ${event.experience} XP in orbs`
                : null;
    if (text) this._observe(() => this._game.ui?.toast?.(text));
    if (["splash", "bite", "catch"].includes(event.type))
      this._observe(() => this._game.effects?.sound?.(`fishing-${event.type}`));
  }

  serialize() {
    if (!(this._game ? this.active : this._staged()))
      throw new Error("Cannot serialize stale vehicle services");
    return { boats: this.boats.serialize(), fishing: this.fishing.serialize() };
  }

  diagnostics() {
    return {
      active: this.active,
      disposed: this._disposed,
      boats: this.boats?.diagnostics() ?? null,
      fishing: this.fishing?.diagnostics() ?? null,
      mounted: this.active ? this.boats.mountFor() : null,
      observerErrors: this._observerErrors.slice(),
    };
  }

  dispose() {
    if (this._disposed) return true;
    if (
      this._frameBusy ||
      this._actionBusy ||
      this._loading ||
      this._candidateGame ||
      this.boats?._preparing ||
      this.fishing?._preparing ||
      this.boats?._updating ||
      this.fishing?._updating ||
      !this.coordinator.release(this)
    )
      return false;
    this._disposed = true;
    this._revision++;
    this.boats?.dispose();
    this.fishing?.dispose();
    const bindings = [this, this.boats, this.fishing];
    for (let index = 0; index < bindingNames.length; index++) {
      const slot =
        this._game &&
        Object.getOwnPropertyDescriptor(this._game, bindingNames[index]);
      if (
        slot &&
        Object.hasOwn(slot, "value") &&
        slot.writable &&
        slot.value === bindings[index]
      )
        Object.defineProperty(this._game, bindingNames[index], { value: null });
    }
    this._game = this._player = this._exitPose = null;
    this._observerErrors.length = 0;
    return true;
  }
}
