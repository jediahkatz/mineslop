import {
  captureEntityContext,
  entityContextFor,
  matchesEntityContext,
} from "./entity-context.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { ITEM } from "./items.js";
import {
  finitePearlVector,
  pearlImpactPose,
  pearlLaunchVelocity,
  PEARL_STEP_SECONDS,
  probePearlOrigin,
  stepPearlFlight,
  validPearlPosition,
} from "./pearl-physics.js";
import {
  clonePearlRecord,
  freezePearlRecord,
  MAX_PEARL_ID,
  MAX_PLAYER_PEARLS,
  nextPearlRandom,
  normalizePlayerProjectilesSnapshot,
  pearlDataRecord,
  PEARL_COOLDOWN_SECONDS,
  PEARL_FRONTIER_SECONDS,
  PEARL_LIFETIME_SECONDS,
  pearlReservedBytes,
  PLAYER_PROJECTILES_VERSION,
  validPearlLife,
  validPearlOwnerId,
} from "./pearl-save.js";
import {
  TransactionCoordinator,
  TransactionInvariantError,
} from "./transactions.js";
import { isDimension, isWorldPose } from "./world-spec.js";

export const PEARL_TELEPORT_DAMAGE = 5;
export const MAX_PEARL_STEPS_PER_UPDATE = 4;
export const MAX_PEARL_FRAME_SECONDS =
  PEARL_STEP_SECONDS * MAX_PEARL_STEPS_PER_UPDATE;
export const MAX_PEARL_FRONTIER_REQUESTS = 2;
export const PEARL_FRONTIER_REQUEST_INTERVAL = 0.25;
export const PEARL_FRONTIER_TICKET_SECONDS = 0.5;
export const MAX_PEARL_IMPACT_PEERS = 4;

const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const vector = (value) => ({ x: value.x, y: value.y, z: value.z });
const equalVector = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const freezeData = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
};
const freezeState = (state) =>
  Object.freeze({
    ...state,
    projectiles: Object.freeze(
      state.projectiles.map((projectile) =>
        Object.isFrozen(projectile) &&
        Object.isFrozen(projectile.position) &&
        Object.isFrozen(projectile.velocity)
          ? projectile
          : freezePearlRecord(projectile)
      )
    ),
  });

/**
 * One local player's pearl ownership, on World's shared coordinator.
 *
 * Parent bridges (all synchronous; preparation is detached and may veto):
 * getOwner(id) -> {id,life,ref,world,dimension,alive,mode,position,eye,forward,
 *                  radius,height}
 *   `ref` is the actual Player object; `life` is persisted and changes at every
 *   death/respawn. `eye` is the physical eye, NOT the third-person/bobbing camera.
 * prepareHeldCost({hand,stack,handRevision,count,creative,...identity})
 *   -> Gameplay.prepareHandCost(hand,{count:1,stack,handRevision}).
 * prepareImpact(request) -> {pose, damage, extraParticipants?: participant[]}.
 *   Both owners must be registered here, including Creative's no-damage guard.
 *   Up to four distinct additional owners may detach a vehicle/cast in the
 *   SAME impact commit; invalid or duplicate participants veto the entire hit.
 *   Pose installs position, zero velocity/fall distance and movement resets.
 *   Preserve heading, flight and the checked stance/body; reset grounded/jump
 *   state, not crouch height. Validate the parent's physical-state revision.
 *   Damage requests normally 5 HP, bypassing armor AND shields; Creative is
 *   immune. Do not call Player.setPosition/Game.damage/Gameplay.damage during
 *   publication: parent bridges install prevalidated fields, then notify.
 *
 * prepareThrow/prepareImpactTransaction return {participants,...}; commit ALL
 * participants once. throwPearl is the single-operation convenience. Successful
 * throw ownership is spent even if flight later misses/cancels; no item refund.
 * onEvent is postcommit sound/HUD/save/VFX notification only.
 *
 * Bounded policy, NOT Java cross-dimensional/stasis ticket parity: owner/world/
 * dimension changes cancel; unloaded geometry freezes for at most two seconds
 * and lifetime keeps advancing. requestChunks receives a bounded 0.5s TTL
 * request after publication, never an awaited continuation or teleport callback.
 * One controller serves BOTH hands. Feed active simulation dt (up to 0.2s per
 * update); do not feed sleep/day-counter jumps. Maximum 16 pearls, 30s life.
 * Normalization/serialization stores owner identity, RNG, cooldown and all
 * dimensional records. Only absence of the archive field means an empty pool;
 * a present packet that fails normalization/load must reject candidate activation.
 * For detached candidate-world staging, construct with staged:true, load and
 * reserve the packet before old-world disposal, then activateOwner() once the
 * real candidate Player exists. Staged instances cannot throw, tick or impact.
 */
export class PlayerProjectiles {
  constructor(
    world,
    {
      coordinator = world?.coordinator,
      context = world,
      ownerId,
      life = 0,
      randomState = 0x6d2b79f5,
      allowOverBudget = false,
      staged = false,
      getOwner,
      prepareHeldCost,
      prepareImpact,
      onEvent,
      requestChunks,
    } = {}
  ) {
    context = entityContextFor(world, context);
    if (
      !(coordinator instanceof TransactionCoordinator) ||
      world?.coordinator !== coordinator ||
      !matchesEntityContext(world, context) ||
      typeof world?.getCell !== "function" ||
      typeof world?.isLoaded !== "function" ||
      !isDimension(world.dimension) ||
      !validPearlOwnerId(ownerId) ||
      !validPearlLife(life) ||
      !Number.isSafeInteger(randomState) ||
      randomState < 1 ||
      randomState > 0xffffffff ||
      typeof allowOverBudget !== "boolean" ||
      typeof staged !== "boolean" ||
      !synchronous(getOwner) ||
      [prepareHeldCost, prepareImpact, onEvent, requestChunks].some(
        (callback) => callback !== undefined && !synchronous(callback)
      )
    )
      throw new TypeError(
        "PlayerProjectiles requires a World, shared coordinator and owner bridges"
      );
    Object.defineProperties(this, {
      world: { value: world, enumerable: true },
      context: { value: context, enumerable: true },
      coordinator: { value: coordinator, enumerable: true },
      ownerId: { value: ownerId, enumerable: true },
    });
    this.getOwner = getOwner;
    this.prepareHeldCost = prepareHeldCost;
    this.prepareImpact = prepareImpact;
    this.onEvent = onEvent;
    this.requestChunks = requestChunks;
    this._seed = world.seed;
    this._generatorVersion = world.generatorVersion;
    this._contextSeed = context.seed;
    this._specForDimension = context.specForDimension;
    this._state = freezeState({
      life,
      randomState,
      cooldown: 0,
      nextId: 1,
      accumulator: 0,
      projectiles: [],
    });
    // Runtime references/epochs are rebound only by a validated load or throw.
    this._binding = null;
    this._revision = 0;
    this._bytes = pearlReservedBytes(0);
    this._disposed = false;
    this._staged = staged;
    this._preparing = false;
    this._reading = false;
    this._updating = false;
    this._requestsRemaining = 0;
    if (
      !normalizePlayerProjectilesSnapshot(this.serialize(), context, {
        id: ownerId,
      })
    )
      throw new TypeError("Invalid pearl world context");
    if (!coordinator.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Unable to reserve pearl state");
  }

  get size() {
    return this._state.projectiles.length;
  }
  get projectiles() {
    return this._state.projectiles;
  }
  get cooldown() {
    return this._state.cooldown;
  }
  get life() {
    return this._state.life;
  }
  get revision() {
    return this._revision;
  }
  get reservedBytes() {
    return this._bytes;
  }
  get staged() {
    return this._staged;
  }

  _worldCurrent() {
    return (
      !this._disposed &&
      matchesEntityContext(this.world, this.context) &&
      this.world.coordinator === this.coordinator &&
      this.world.seed === this._seed &&
      this.world.generatorVersion === this._generatorVersion &&
      this.context.seed === this._contextSeed &&
      this.context.generatorVersion === this._generatorVersion &&
      this.context.specForDimension === this._specForDimension &&
      isDimension(this.world.dimension)
    );
  }

  _readOwner() {
    if (this._reading || !synchronous(this.getOwner)) return null;
    this._reading = true;
    try {
      const value = this.getOwner(this.ownerId);
      if (
        !value ||
        value.id !== this.ownerId ||
        !validPearlLife(value.life) ||
        !value.ref ||
        typeof value.ref !== "object" ||
        !value.world ||
        !isDimension(value.dimension) ||
        typeof value.alive !== "boolean" ||
        !["survival", "creative"].includes(value.mode) ||
        !finitePearlVector(value.position) ||
        !finitePearlVector(value.eye) ||
        !finitePearlVector(value.forward) ||
        !Number.isFinite(value.radius) ||
        value.radius <= 0 ||
        value.radius > 0.5 ||
        !Number.isFinite(value.height) ||
        value.height <= 0 ||
        value.height > 2.5
      )
        return null;
      return {
        id: value.id,
        life: value.life,
        ref: value.ref,
        world: value.world,
        dimension: value.dimension,
        alive: value.alive,
        mode: value.mode,
        position: vector(value.position),
        eye: vector(value.eye),
        forward: vector(value.forward),
        radius: value.radius,
        height: value.height,
      };
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this._reading = false;
    }
  }

  _ownerActive(owner) {
    return (
      !!owner &&
      owner.alive &&
      this._worldCurrent() &&
      owner.world === this.world &&
      owner.dimension === this.world.dimension &&
      isWorldPose(owner.position, this.context, owner.dimension)
    );
  }

  _ownerGuard(owner, pose = false) {
    const current = captureEntityContext(this.world, this.context);
    return () => {
      const now = this._readOwner();
      return (
        current() &&
        this._ownerActive(now) &&
        now.ref === owner.ref &&
        now.life === owner.life &&
        now.mode === owner.mode &&
        (!pose ||
          (equalVector(now.position, owner.position) &&
            equalVector(now.eye, owner.eye) &&
            equalVector(now.forward, owner.forward) &&
            now.radius === owner.radius &&
            now.height === owner.height))
      );
    };
  }

  _bind(owner) {
    return Object.freeze({
      ref: owner.ref,
      life: owner.life,
      dimension: owner.dimension,
      epoch: this.world.epoch ?? this.world._epoch,
    });
  }

  _bindingMatches(owner) {
    return (
      !!owner &&
      !!this._binding &&
      owner.ref === this._binding.ref &&
      owner.life === this._binding.life &&
      owner.dimension === this._binding.dimension &&
      (this.world.epoch ?? this.world._epoch) === this._binding.epoch
    );
  }

  _prepareState(
    nextState,
    binding,
    guard = () => true,
    notify,
    staged = this._staged
  ) {
    const state = freezeState(nextState);
    const revision = this._revision;
    const beforeBytes = this._bytes;
    const afterBytes = pearlReservedBytes(state.projectiles.length);
    let used = false;
    return Object.freeze({
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        !this._disposed &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        guard() === true,
      publish: () => {
        used = true;
        this._state = state;
        this._binding = binding;
        this._staged = staged;
        this._bytes = afterBytes;
        this._revision = revision + 1;
      },
      ...(notify ? { notify } : {}),
    });
  }

  _notify(event) {
    const data = freezeData(event);
    return () => this.onEvent?.(data);
  }

  _external(participant) {
    return (
      !!participant &&
      participant.owner !== this &&
      this.coordinator.usage(participant.owner) !== undefined &&
      synchronous(participant.validate) &&
      synchronous(participant.publish) &&
      (participant.notify === undefined || synchronous(participant.notify))
    );
  }

  _callPrepare(callback, request) {
    if (!synchronous(callback)) return null;
    try {
      return callback(request);
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    }
  }

  prepareThrow(shot) {
    if (
      this._disposed ||
      this._staged ||
      this._preparing ||
      this._reading ||
      !pearlDataRecord(shot, ["hand", "stack", "handRevision"]) ||
      !["main", "offhand"].includes(shot.hand) ||
      !Number.isSafeInteger(shot.handRevision) ||
      shot.handRevision < 0 ||
      !isValidStack(shot.stack, this.context) ||
      shot.stack.id !== ITEM.ENDER_PEARL ||
      !synchronous(this.prepareHeldCost) ||
      !synchronous(this.prepareImpact) ||
      this.cooldown > 1e-9 ||
      this.life >= MAX_PEARL_ID ||
      this._state.nextId >= MAX_PEARL_ID
    )
      return null;
    this._preparing = true;
    try {
      const before = this._state;
      const owner = this._readOwner();
      if (
        !this._ownerActive(owner) ||
        !validPearlPosition(owner.eye, this.context, owner.dimension) ||
        Math.hypot(
          owner.eye.x - owner.position.x,
          owner.eye.z - owner.position.z
        ) >
          owner.radius + 0.1 ||
        owner.eye.y < owner.position.y ||
        owner.eye.y > owner.position.y + owner.height + 0.1
      )
        return null;
      const retained = this._bindingMatches(owner) ? this.projectiles : [];
      if (retained.length >= MAX_PLAYER_PEARLS) return null;
      const velocity = pearlLaunchVelocity(owner.forward);
      const origin =
        velocity && probePearlOrigin(this.world, this.context, owner.eye);
      if (!velocity || origin?.kind !== "ready") return null;
      const guard = this._ownerGuard(owner, true);
      const spin = nextPearlRandom(before.randomState);
      const projectile = freezePearlRecord({
        id: before.nextId,
        kind: "ender_pearl",
        ownerId: this.ownerId,
        life: owner.life,
        dimension: owner.dimension,
        position: owner.eye,
        velocity,
        age: 0,
        wait: 0,
        spin,
      });
      const cost = this._callPrepare(
        this.prepareHeldCost,
        Object.freeze({
          ownerId: this.ownerId,
          life: owner.life,
          ownerRef: owner.ref,
          world: this.world,
          hand: shot.hand,
          stack: freezeData(cloneStack(shot.stack, this.context)),
          handRevision: shot.handRevision,
          count: 1,
          creative: owner.mode === "creative",
        })
      );
      if (!this._external(cost)) return null;
      const owned = this._prepareState(
        {
          ...before,
          life: owner.life,
          randomState: spin,
          nextId: projectile.id + 1,
          cooldown: PEARL_COOLDOWN_SECONDS,
          projectiles: [...retained, projectile],
        },
        this._bind(owner),
        () => this._state === before && guard() && origin.validate(),
        this._notify({
          type: "throw",
          projectileId: projectile.id,
          ownerId: this.ownerId,
          life: owner.life,
          dimension: owner.dimension,
          hand: shot.hand,
          position: vector(projectile.position),
        })
      );
      return Object.freeze({
        projectileId: projectile.id,
        participants: Object.freeze([cost, owned]),
      });
    } finally {
      this._preparing = false;
    }
  }

  throwPearl(shot) {
    const plan = this.prepareThrow(shot);
    return !!plan && this.coordinator.commit(plan.participants).ok;
  }

  _impactPlan(projectile, owner, flight) {
    const before = this._state;
    const pose = pearlImpactPose(this.world, this.context, flight.hit, owner);
    if (pose.kind !== "ready") return pose;
    const guard = this._ownerGuard(owner, true);
    const request = Object.freeze({
      projectileId: projectile.id,
      ownerId: this.ownerId,
      life: projectile.life,
      ownerRef: owner.ref,
      world: this.world,
      dimension: projectile.dimension,
      body: Object.freeze({ radius: owner.radius, height: owner.height }),
      position: Object.freeze(vector(pose.position)),
      velocity: Object.freeze({ x: 0, y: 0, z: 0 }),
      fallDistance: 0,
      resetMovement: true,
      damage: Object.freeze({
        amount: PEARL_TELEPORT_DAMAGE,
        cause: "ender-pearl",
        bypassArmor: true,
        bypassShield: true,
        creativeImmune: true,
      }),
    });
    const effects = this._callPrepare(this.prepareImpact, request);
    const extra = effects?.extraParticipants;
    const peers =
      extra === undefined
        ? []
        : Array.isArray(extra) && extra.length <= MAX_PEARL_IMPACT_PEERS
          ? Array.from(extra)
          : null;
    if (
      !effects ||
      !this._external(effects.pose) ||
      !this._external(effects.damage) ||
      !peers ||
      !peers.every((participant) => this._external(participant)) ||
      new Set([
        effects.pose.owner,
        effects.damage.owner,
        ...peers.map((p) => p.owner),
      ]).size !==
        2 + peers.length
    )
      return { kind: "veto" };
    const removal = this._prepareState(
      {
        ...before,
        projectiles: before.projectiles.filter(
          (entry) => entry.id !== projectile.id
        ),
      },
      this._binding,
      () =>
        this._state === before &&
        guard() &&
        flight.validate() &&
        pose.validate(),
      this._notify({
        type: "impact",
        projectileId: projectile.id,
        ownerId: this.ownerId,
        life: projectile.life,
        dimension: projectile.dimension,
        position: vector(pose.position),
      })
    );
    return {
      kind: "ready",
      plan: Object.freeze({
        projectileId: projectile.id,
        request,
        participants: Object.freeze([
          effects.pose,
          effects.damage,
          removal,
          ...peers,
        ]),
      }),
    };
  }

  /** Prepare only an actual next-tick swept impact, never an arbitrary target. */
  prepareImpactTransaction(projectileId) {
    if (this._disposed || this._staged || this._preparing || this._reading)
      return null;
    this._preparing = true;
    try {
      const owner = this._readOwner();
      const projectile = this.projectiles.find(
        (entry) => entry.id === projectileId
      );
      if (
        !projectile ||
        !this._ownerActive(owner) ||
        !this._bindingMatches(owner) ||
        projectile.dimension !== owner.dimension ||
        projectile.age + PEARL_STEP_SECONDS >= PEARL_LIFETIME_SECONDS
      )
        return null;
      const flight = stepPearlFlight(this.world, this.context, projectile);
      return flight.kind === "impact"
        ? (this._impactPlan(projectile, owner, flight).plan ?? null)
        : null;
    } finally {
      this._preparing = false;
    }
  }

  _replaceRecord(projectile, next, guard, notify) {
    return this._prepareState(
      {
        ...this._state,
        projectiles: next
          ? this.projectiles.map((entry) =>
              entry.id === projectile.id ? next : entry
            )
          : this.projectiles.filter((entry) => entry.id !== projectile.id),
      },
      this._binding,
      () =>
        this.projectiles.find((entry) => entry.id === projectile.id) ===
          projectile && guard(),
      notify
    );
  }

  _remove(projectile, reason, guard = () => true) {
    const plan = this._replaceRecord(
      projectile,
      null,
      guard,
      this._notify({
        type: "cancel",
        reason,
        projectileId: projectile.id,
        ownerId: this.ownerId,
        life: projectile.life,
        dimension: projectile.dimension,
      })
    );
    return this.coordinator.commit([plan]).ok;
  }

  _ageOnly(projectile, owner) {
    const age = projectile.age + PEARL_STEP_SECONDS;
    if (age >= PEARL_LIFETIME_SECONDS - 1e-9)
      return this._remove(projectile, "expired");
    const plan = this._replaceRecord(
      projectile,
      { ...projectile, age, wait: 0 },
      this._ownerGuard(owner)
    );
    return this.coordinator.commit([plan]).ok;
  }

  _waitAtFrontier(projectile, owner, frontier) {
    const age = projectile.age + PEARL_STEP_SECONDS;
    const wait = projectile.wait + PEARL_STEP_SECONDS;
    if (age >= PEARL_LIFETIME_SECONDS - 1e-9)
      return this._remove(projectile, "expired");
    if (wait >= PEARL_FRONTIER_SECONDS - 1e-9)
      return this._remove(projectile, "frontier-timeout");
    const requestDue =
      projectile.wait === 0 ||
      Math.floor(wait / PEARL_FRONTIER_REQUEST_INTERVAL) >
        Math.floor(projectile.wait / PEARL_FRONTIER_REQUEST_INTERVAL);
    const columns = freezeData(
      frontier.columns.map(({ cx, cz }) => ({ cx, cz }))
    );
    const guard = this._ownerGuard(owner);
    const plan = this._replaceRecord(
      projectile,
      { ...projectile, age, wait },
      () => guard() && frontier.validate(),
      requestDue
        ? () => {
            if (!this._requestsRemaining || !this.requestChunks) return;
            this._requestsRemaining--;
            return this.requestChunks(
              Object.freeze({
                world: this.world,
                ownerId: this.ownerId,
                life: projectile.life,
                projectileId: projectile.id,
                dimension: projectile.dimension,
                columns,
                ttl: PEARL_FRONTIER_TICKET_SECONDS,
              })
            );
          }
        : undefined
    );
    return this.coordinator.commit([plan]).ok;
  }

  _step(projectile, owner, vetoed) {
    if (projectile.dimension !== owner.dimension)
      return this._remove(projectile, "dimension-changed");
    if (projectile.age + PEARL_STEP_SECONDS >= PEARL_LIFETIME_SECONDS - 1e-9)
      return this._remove(projectile, "expired");
    if (vetoed.has(projectile.id)) return this._ageOnly(projectile, owner);
    const flight = stepPearlFlight(this.world, this.context, projectile);
    const guard = this._ownerGuard(owner);
    if (flight.kind === "frontier")
      return this._waitAtFrontier(projectile, owner, flight);
    if (flight.kind === "invalid")
      return this._remove(projectile, "invalid-flight");
    if (flight.kind === "miss")
      return this._remove(
        projectile,
        flight.reason,
        () => guard() && flight.validate()
      );
    if (flight.kind === "flight") {
      const plan = this._replaceRecord(
        projectile,
        {
          ...projectile,
          position: flight.position,
          velocity: flight.velocity,
          age: projectile.age + PEARL_STEP_SECONDS,
          wait: 0,
        },
        () => guard() && flight.validate()
      );
      return this.coordinator.commit([plan]).ok;
    }
    this._preparing = true;
    let impact;
    try {
      impact = this._impactPlan(projectile, owner, flight);
    } finally {
      this._preparing = false;
    }
    if (impact.kind === "frontier")
      return this._waitAtFrontier(projectile, owner, {
        ...impact,
        validate: () => flight.validate() && impact.validate(),
      });
    if (impact.kind === "blocked" || impact.kind === "invalid")
      return this._remove(
        projectile,
        "blocked-impact",
        () =>
          guard() &&
          flight.validate() &&
          (!impact.validate || impact.validate())
      );
    if (impact.plan && this.coordinator.commit(impact.plan.participants).ok)
      return true;
    // A veto retains ownership and position; it cannot retain life indefinitely.
    // Retry at most once per render update, and keep aging toward cancellation.
    vetoed.add(projectile.id);
    return this._ageOnly(projectile, owner);
  }

  /** Call with active simulation dt, not day/time-of-day or hidden-tab catchup. */
  update(dt) {
    if (
      this._disposed ||
      this._staged ||
      this._updating ||
      this._preparing ||
      this._reading ||
      !Number.isFinite(dt) ||
      dt < 0
    )
      return false;
    this._updating = true;
    this._requestsRemaining = MAX_PEARL_FRONTIER_REQUESTS;
    try {
      let owner = this._readOwner();
      if (!this._ownerActive(owner)) {
        this.cancelPending(
          owner && !owner.alive ? "owner-dead" : "owner-unavailable"
        );
        return false;
      }
      if (this.size && !this._bindingMatches(owner))
        this.cancelPending(
          owner.dimension !== this._binding?.dimension
            ? "dimension-changed"
            : "owner-or-world-stale"
        );
      if (!dt || this._disposed) return true;
      const ids = this.projectiles.map((entry) => entry.id);
      const elapsed = Math.min(dt, MAX_PEARL_FRAME_SECONDS);
      const available = this._state.accumulator + elapsed;
      const steps = Math.min(
        MAX_PEARL_STEPS_PER_UPDATE,
        Math.floor((available + 1e-9) / PEARL_STEP_SECONDS)
      );
      const accumulator = Math.max(0, available - steps * PEARL_STEP_SECONDS);
      const clock = this._prepareState(
        {
          ...this._state,
          life: this.size ? this._state.life : owner.life,
          cooldown: Math.max(0, this.cooldown - elapsed),
          accumulator,
        },
        this._binding,
        this._ownerGuard(owner)
      );
      if (!this.coordinator.commit([clock]).ok) return false;
      const vetoed = new Set();
      for (let step = 0; step < steps; step++) {
        for (const id of ids) {
          if (this._disposed) return false;
          owner = this._readOwner();
          if (
            !this._ownerActive(owner) ||
            (this.size && !this._bindingMatches(owner))
          ) {
            this.cancelPending(
              owner && !owner.alive ? "owner-dead" : "owner-or-world-stale"
            );
            return false;
          }
          const projectile = this.projectiles.find((entry) => entry.id === id);
          if (projectile) this._step(projectile, owner, vetoed);
        }
      }
      owner = this._readOwner();
      if (
        !this._ownerActive(owner) ||
        (this.size && !this._bindingMatches(owner))
      ) {
        this.cancelPending(
          owner && !owner.alive ? "owner-dead" : "owner-or-world-stale"
        );
        return false;
      }
      return true;
    } finally {
      this._updating = false;
    }
  }

  /** Death/respawn advance the saved life; travel only cancels the current flight. */
  cancelPending(reason = "cancelled", options = {}) {
    if (
      this._disposed ||
      this._preparing ||
      this._reading ||
      !pearlDataRecord(options, ["advanceLife"]) ||
      (options.advanceLife !== undefined &&
        typeof options.advanceLife !== "boolean")
    )
      return false;
    const ids = this.projectiles.map((entry) => entry.id);
    const plan = this._prepareState(
      {
        ...this._state,
        // Exhaustion disables subsequent throws; never wrap an owner generation.
        life: Math.min(
          MAX_PEARL_ID,
          this.life + Number(options.advanceLife === true)
        ),
        projectiles: [],
        accumulator: 0,
      },
      null,
      () => true,
      ids.length
        ? this._notify({
            type: "cancel",
            reason: String(reason).slice(0, 64),
            ownerId: this.ownerId,
            ids,
          })
        : undefined
    );
    // Even empty cancellation invalidates detached throws from the old life.
    return this.coordinator.commit([plan]).ok;
  }

  serialize() {
    return {
      version: PLAYER_PROJECTILES_VERSION,
      seed: String(this._seed),
      generatorVersion: this._generatorVersion,
      ownerId: this.ownerId,
      life: this._state.life,
      cooldown: this.cooldown,
      randomState: this._state.randomState,
      nextId: this._state.nextId,
      accumulator: this._state.accumulator,
      projectiles: this.projectiles.map(clonePearlRecord),
    };
  }

  /** staged:true instances validate/reserve without reading any live Player. */
  load(data, options = {}) {
    if (
      this._disposed ||
      this._preparing ||
      this._reading ||
      this._updating ||
      !pearlDataRecord(options, ["allowOverBudget"]) ||
      !this._worldCurrent()
    )
      return false;
    const { allowOverBudget = false } = options;
    if (typeof allowOverBudget !== "boolean") return false;
    const snapshot = normalizePlayerProjectilesSnapshot(data, this.context, {
      id: this.ownerId,
    });
    if (!snapshot) return false;
    const current = captureEntityContext(this.world, this.context);
    this._preparing = true;
    try {
      const owner = this._staged ? null : this._readOwner();
      if (
        (!this._staged &&
          (!owner ||
            owner.world !== this.world ||
            owner.dimension !== this.world.dimension ||
            (snapshot.projectiles.length && owner.life !== snapshot.life))) ||
        !current() ||
        !this._worldCurrent()
      )
        return false;
      const state = freezeState(snapshot);
      const binding = owner ? this._bind(owner) : null;
      const bytes = pearlReservedBytes(state.projectiles.length);
      if (!this.coordinator.register(this, bytes, { allowOverBudget }))
        return false;
      this._state = state;
      this._binding = binding;
      this._bytes = bytes;
      this._revision++;
      return true;
    } finally {
      this._preparing = false;
    }
  }

  /** Bind a staged packet exactly once; never automatically adopt a new owner. */
  activateOwner() {
    if (
      !this._staged ||
      this._disposed ||
      this._preparing ||
      this._reading ||
      this._updating ||
      !this._worldCurrent()
    )
      return false;
    const current = captureEntityContext(this.world, this.context);
    this._preparing = true;
    try {
      const before = this._state;
      const owner = this._readOwner();
      if (
        !owner ||
        owner.world !== this.world ||
        owner.dimension !== this.world.dimension ||
        (this.size && owner.life !== before.life) ||
        (owner.alive &&
          !isWorldPose(owner.position, this.context, owner.dimension))
      )
        return false;
      const guard = () => {
        const now = this._readOwner();
        return (
          current() &&
          this._worldCurrent() &&
          this._state === before &&
          !!now &&
          now.ref === owner.ref &&
          now.life === owner.life &&
          now.world === this.world &&
          now.dimension === owner.dimension &&
          now.alive === owner.alive &&
          (!now.alive || isWorldPose(now.position, this.context, now.dimension))
        );
      };
      const plan = this._prepareState(
        {
          ...before,
          life: owner.life,
          projectiles: owner.alive ? before.projectiles : [],
          accumulator: owner.alive ? before.accumulator : 0,
        },
        owner.alive ? this._bind(owner) : null,
        guard,
        undefined,
        false
      );
      return this.coordinator.commit([plan]).ok;
    } finally {
      this._preparing = false;
    }
  }

  dispose() {
    if (this._disposed || this._preparing || this._reading) return false;
    if (!this.coordinator.release(this)) return false;
    this._disposed = true;
    this._state = freezeState({
      ...this._state,
      projectiles: [],
      accumulator: 0,
    });
    this._binding = null;
    this._bytes = 0;
    this._revision++;
    this.getOwner = this.prepareHeldCost = this.prepareImpact = undefined;
    this.onEvent = this.requestChunks = undefined;
    return true;
  }
}
