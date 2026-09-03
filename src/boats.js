import { intersectRayBox } from "./aabb.js";
import {
  BOAT_ACTIVE_DISTANCE,
  BOAT_HEADER_RESERVED_BYTES,
  BOAT_HEIGHT,
  BOAT_RECORD_RESERVED_BYTES,
  BOAT_SUBMERGE_SECONDS,
  boatSeat,
  boatWoodForItem,
  MAX_ACTIVE_BOATS,
  MAX_BOATS,
  validPassengerId,
} from "./boat-definitions.js";
import {
  boatBox,
  boatPlacementPosition,
  boatRiderPathClear,
  boatWaterTarget,
  findBoatDismount,
  stepBoat,
} from "./boat-physics.js";
import { BoatRenderer } from "./boat-render.js";
import {
  cloneBoatRecord,
  normalizeBoatRecord,
  normalizeBoatSnapshot,
} from "./boat-save.js";
import { bodyBox, boxCollides, sweepCameraDistance } from "./collision.js";
import {
  captureEntityContext,
  entityContextFor,
  matchesEntityContext,
} from "./entity-context.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { stackIdentity } from "./item-stack-data.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  commitVehicleSnapshots,
  prepareVehicleSnapshot,
  vehicleDimensionCounts,
  vehicleDimensionsAfter,
} from "./vehicle-load.js";
import {
  aquaticSweepBounds,
  captureAquaticArea,
  finitePoint,
  loadedAquaticArea,
  synchronousAquaticCallback,
} from "./vehicle-water.js";
import { isDimension } from "./world-spec.js";

export {
  BOAT_ITEM_REQUIREMENTS,
  BOAT_WOODS,
  boatInput,
  boatSeat,
} from "./boat-definitions.js";
export { normalizeBoatSnapshot } from "./boat-save.js";

const failed = (reason) => ({ ok: false, reason });
const distanceSquared = (a, b) =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
const samePoint = (a, b) => a?.x === b?.x && a?.y === b?.y && a?.z === b?.z;
const hasHand = (hand) => hand === "main" || hand === "offhand";
const cloneExit = (exit) => ({
  ...exit,
  position: { ...exit.position },
  velocity: { ...exit.velocity },
});
const NO_BOATS = Object.freeze([]);
const IDLE_UPDATE = Object.freeze({
  moved: 0,
  observerErrors: Object.freeze([]),
});

/**
 * Persistent vehicles, separate from Player/World and the item registries.
 *
 * All participants MUST belong to world.coordinator. Required synchronous hooks:
 * readOwner(ownerId, hand) -> {position,dimension,dead?,eye?,stack?,handRevision?}
 * prepareHandCost({ownerId,hand,stack,handRevision,count:1}) -> participant|null
 * prepareDrops({stacks,position,dimension,velocity,pickupDelay,reason}) -> participant|null
 * onEvent(event) / onChange() are postcommit notifications, never ownership vetoes.
 *
 * preparePlace/Mount/Dismount/Break return {ok,participants,...} without mutation.
 * place/mount/dismount/break/interact commit once and return {ok,reason?,...}.
 * For item placement, pass raycastWater(eye,direction)?.point to place(); liquid
 * cells deliberately do not occur in the ordinary solid-block selection ray.
 * Game applies returned/event `exit` poses ONLY after ok, and uses riderPose()
 * every frame in place of ordinary player movement while mounted. Keep look,
 * camera and survival updates running; never feed camera yaw into boat steering.
 * update(dt,{viewer,controls:{player:boatInput(keys)}}), then render(viewer).
 * Movement changes bounded records/revisions in place, not serialized domains.
 * Archive owns serialize/load, including inactive dimensions. load restores
 * passenger IDs; after player admission, apply riderPose("player") before input.
 * On death (before reviving Gameplay) or dimension change, releasePassenger()
 * detaches that rider without a pose; respawn/travel already owns their new pose.
 */
export class Boats {
  constructor(
    scene,
    world,
    {
      coordinator = world?.coordinator,
      context = world,
      readOwner,
      canMount,
      prepareMountGuard,
      prepareHandCost,
      prepareDrops,
      sampleFluid,
      available,
      allowOverBudget = false,
      onEvent,
      onChange,
    } = {}
  ) {
    if (!world || !coordinator || coordinator !== world.coordinator)
      throw new TypeError("Boats requires the World's shared coordinator");
    for (const callback of [
      readOwner,
      canMount,
      prepareMountGuard,
      prepareHandCost,
      prepareDrops,
      sampleFluid,
      available,
      onEvent,
      onChange,
    ])
      if (callback !== undefined && !synchronousAquaticCallback(callback))
        throw new TypeError("Boat hooks must be synchronous");
    if (typeof allowOverBudget !== "boolean")
      throw new TypeError("Invalid boat admission policy");
    this.world = world;
    this.context = entityContextFor(world, context);
    if (!matchesEntityContext(world, this.context))
      throw new RangeError("Boat context belongs to another world");
    this.coordinator = coordinator;
    this.readOwner = readOwner;
    this.canMount = canMount;
    this.prepareMountGuard = prepareMountGuard;
    this.prepareHandCost = prepareHandCost;
    this.prepareDrops = prepareDrops;
    this.sampleFluid = sampleFluid;
    this.available = available;
    this.onEvent = onEvent;
    this.onChange = onChange;
    this._boats = new Map();
    this._dimensionCounts = vehicleDimensionCounts();
    this._nextId = 1;
    this._revision = 0;
    this._bytes = BOAT_HEADER_RESERVED_BYTES;
    this._disposed = this._preparing = this._updating = false;
    if (!coordinator.register(this, this._bytes, { allowOverBudget }))
      throw new RangeError("Cannot reserve boat archive header");
    this.renderer = null;
    try {
      if (scene && !this.bindRenderer(scene))
        throw new TypeError("Invalid boat scene");
    } catch (error) {
      coordinator.release(this);
      throw error;
    }
  }

  get size() {
    return this._boats.size;
  }
  get activeSize() {
    return this._dimensionCounts[this.world.dimension] ?? 0;
  }
  get revision() {
    return this._revision;
  }
  get reservedBytes() {
    return this._bytes;
  }

  _ready(loading = false) {
    return (
      !this._disposed &&
      !this._preparing &&
      this.world.coordinator === this.coordinator &&
      this.coordinator.usage(this) === this._bytes &&
      matchesEntityContext(this.world, this.context) &&
      (loading || this.available === undefined || this.available() === true)
    );
  }

  bindRenderer(scene) {
    if (!this._ready(true) || this._updating) return false;
    if (this.renderer)
      return this.renderer.scene === scene && !this.renderer._disposed;
    if (scene === null) return true;
    if (scene?.isScene !== true) return false;
    this.renderer = new BoatRenderer(scene);
    return true;
  }

  _actor(ownerId, hand = "main") {
    if (
      !validPassengerId(ownerId) ||
      !synchronousAquaticCallback(this.readOwner)
    )
      return null;
    const actor = this.readOwner(ownerId, hand);
    if (
      !actor ||
      actor.dead ||
      actor.dimension !== this.world.dimension ||
      !finitePoint(actor.position)
    )
      return null;
    return {
      ...actor,
      position: { ...actor.position },
      eye: finitePoint(actor.eye)
        ? { ...actor.eye }
        : { ...actor.position, y: actor.position.y + 1.62 },
    };
  }

  _actorGuard(ownerId, hand, actor, held = false) {
    const identity = held ? stackIdentity(actor.stack, this.context) : null;
    return () => {
      const current = this._actor(ownerId, hand);
      return (
        current !== null &&
        samePoint(current.position, actor.position) &&
        samePoint(current.eye, actor.eye) &&
        (!held ||
          (current.handRevision === actor.handRevision &&
            isValidStack(current.stack, this.context) &&
            stackIdentity(current.stack, this.context) === identity))
      );
    };
  }

  _reachable(actor, point, reach = 6) {
    if (!actor || distanceSquared(actor.eye, point) > reach * reach)
      return false;
    const direction = {
      x: point.x - actor.eye.x,
      y: point.y - actor.eye.y,
      z: point.z - actor.eye.z,
    };
    const distance = Math.hypot(direction.x, direction.y, direction.z);
    return (
      distance < 0.001 ||
      sweepCameraDistance(this.world, actor.eye, direction, distance, 0.02) >=
        distance - 0.04
    );
  }

  _notify(events) {
    const errors = [];
    for (const event of events) {
      try {
        this.onEvent?.(event);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.onChange?.();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Boat observers failed");
  }

  _prepareRecord(
    id,
    value,
    { prerequisite = () => true, nextId = this._nextId, events = [] } = {}
  ) {
    if (!this._ready()) return null;
    const next =
      value === null ? null : normalizeBoatRecord(value, this.context);
    if (value !== null && next === null) return null;
    const entries = this._boats;
    const before = entries.get(id);
    const counts = this._dimensionCounts;
    const nextCounts = vehicleDimensionsAfter(counts, before, next);
    const size =
      entries.size + Number(next !== null) - Number(before !== undefined);
    if (size > MAX_BOATS || size < 0) return null;
    const revision = this._revision,
      beforeBytes = this._bytes;
    const afterBytes =
      BOAT_HEADER_RESERVED_BYTES + size * BOAT_RECORD_RESERVED_BYTES;
    const current = captureEntityContext(this.world, this.context);
    const oldNextId = this._nextId,
      coordinator = this.coordinator,
      world = this.world,
      context = this.context;
    let used = false,
      notified = false;
    return {
      owner: this,
      beforeBytes,
      afterBytes,
      validate: () =>
        !used &&
        this._ready() &&
        this._boats === entries &&
        this._dimensionCounts === counts &&
        this.world === world &&
        this.context === context &&
        this.coordinator === coordinator &&
        this._revision === revision &&
        this._bytes === beforeBytes &&
        this._nextId === oldNextId &&
        entries.get(id) === before &&
        coordinator.usage(this) === beforeBytes &&
        current() &&
        prerequisite(),
      publish: () => {
        used = true;
        if (next === null) entries.delete(id);
        else entries.set(id, next);
        this._dimensionCounts = nextCounts;
        this._nextId = nextId;
        this._bytes = afterBytes;
        this._revision++;
      },
      notify: () => {
        if (!used || notified) return;
        notified = true;
        this._notify(events);
      },
    };
  }

  _callback(name, request) {
    const callback = this[name];
    if (!synchronousAquaticCallback(callback)) return null;
    this._preparing = true;
    try {
      const participant = callback(request);
      return participant &&
        typeof participant.then !== "function" &&
        this.coordinator.usage(participant.owner) !== undefined &&
        (participant.owner?.coordinator === undefined ||
          participant.owner.coordinator === this.coordinator)
        ? participant
        : null;
    } catch (error) {
      if (error instanceof TransactionInvariantError) throw error;
      return null;
    } finally {
      this._preparing = false;
    }
  }

  commit(plan) {
    if (!plan?.ok || !Array.isArray(plan.participants))
      return plan ?? failed("invalid-plan");
    const result = this.coordinator.commit(plan.participants);
    if (!result.ok) return result;
    const { participants, ...details } = plan;
    return { ...details, ...result };
  }

  preparePlace({ ownerId = "player", hand = "main", point, yaw = 0 } = {}) {
    if (
      !this._ready() ||
      !hasHand(hand) ||
      !finitePoint(point) ||
      !Number.isFinite(yaw)
    )
      return failed("invalid-placement");
    point = { x: point.x, y: point.y, z: point.z };
    if (!synchronousAquaticCallback(this.prepareHandCost))
      return failed("missing-hand-cost");
    const actor = this._actor(ownerId, hand);
    if (
      !actor ||
      !isValidStack(actor.stack, this.context) ||
      !Number.isSafeInteger(actor.handRevision) ||
      actor.handRevision < 0
    )
      return failed("invalid-hand");
    const wood = boatWoodForItem(actor.stack.id);
    if (wood === null) return failed("not-a-boat-item");
    if (this.size >= MAX_BOATS || this._nextId >= Number.MAX_SAFE_INTEGER)
      return failed("boat-capacity");
    const position = boatPlacementPosition(this.world, point, this.sampleFluid);
    if (!position || !this._reachable(actor, point))
      return failed("water-or-clearance");
    for (const other of this._boats.values())
      if (
        other.dimension === this.world.dimension &&
        Math.abs(other.x - position.x) < 1.375 &&
        Math.abs(other.y - position.y) < BOAT_HEIGHT &&
        Math.abs(other.z - position.z) < 1.375
      )
        return failed("occupied");
    const id = this._nextId;
    const boat = {
      id,
      wood,
      stack: { ...cloneStack(actor.stack, this.context), count: 1 },
      dimension: this.world.dimension,
      ...position,
      yaw,
      vx: 0,
      vy: 0,
      vz: 0,
      turnVelocity: 0,
      submergedTime: 0,
      bubbleTime: 0,
      bubbleDirection: 0,
      paddlePhase: 0,
      passengers: [null, null],
    };
    const worldGuard = captureAquaticArea(
      this.world,
      this.context,
      boatBox(boat)
    );
    if (!worldGuard) return failed("frontier");
    const actorGuard = this._actorGuard(ownerId, hand, actor, true);
    const own = this._prepareRecord(id, boat, {
      nextId: id + 1,
      prerequisite: () =>
        worldGuard() && actorGuard() && this._reachable(actor, point),
      events: [{ type: "place", id, ownerId, position: { ...position } }],
    });
    if (!own) return failed("invalid-boat");
    const cost = this._callback("prepareHandCost", {
      ownerId,
      hand,
      stack: cloneStack(actor.stack, this.context),
      handRevision: actor.handRevision,
      slotKey: actor.slotKey,
      count: 1,
    });
    return cost
      ? { ok: true, action: "place", id, participants: [own, cost] }
      : failed("hand-cost-rejected");
  }

  place(request) {
    return this.commit(this.preparePlace(request));
  }

  mountFor(ownerId = "player") {
    if (!this.size) return null;
    for (const boat of this._boats.values()) {
      const slot = boat.passengers.indexOf(ownerId);
      if (slot >= 0) return { id: boat.id, slot, dimension: boat.dimension };
    }
    return null;
  }

  getBoat(id) {
    const boat = this._boats.get(id);
    return boat ? cloneBoatRecord(boat, this.context) : null;
  }

  riderPose(ownerId = "player") {
    const mount = this.mountFor(ownerId);
    if (!mount || mount.dimension !== this.world.dimension) return null;
    const boat = this._boats.get(mount.id);
    return {
      ...mount,
      vehicleType: "boat",
      position: boatSeat(boat, mount.slot),
      velocity: { x: boat.vx, y: boat.vy, z: boat.vz },
      hullYaw: boat.yaw,
      grounded: false,
      seated: true,
    };
  }

  prepareMount(id, ownerId = "player") {
    if (!this._ready()) return failed("unavailable");
    const boat = this._boats.get(id),
      actor = this._actor(ownerId);
    if (!boat || boat.dimension !== this.world.dimension || !actor)
      return failed("inactive-boat");
    const canMount = this.canMount;
    const crossMountAllowed = () => this.canMount === canMount &&
      (canMount === undefined || canMount(ownerId, id) === true);
    if (this.mountFor(ownerId) || !crossMountAllowed()) return failed("already-mounted");
    // The host may borrow the other mount owner's reservation as a read-only
    // peer. Two independently prepared raw mounts then collide on that owner
    // if composed into ONE transaction, before either seat can publish.
    const prepareMountGuard = this.prepareMountGuard;
    const peer = prepareMountGuard ? this._callback("prepareMountGuard", { ownerId, id }) : null;
    if (prepareMountGuard && (!peer || peer.owner === this ||
        this.coordinator.usage(peer.owner) !== peer.beforeBytes ||
        peer.afterBytes !== peer.beforeBytes ||
        !synchronousAquaticCallback(peer.validate) ||
        !synchronousAquaticCallback(peer.publish)))
      return failed("cross-mount-guard-rejected");
    if (boat.submergedTime >= BOAT_SUBMERGE_SECONDS) return failed("submerged");
    const slot = boat.passengers.indexOf(null);
    if (slot < 0) return failed("full");
    if (!this._reachable(actor, { ...boat, y: boat.y + BOAT_HEIGHT }))
      return failed("out-of-reach");
    const position = boatSeat(boat, slot);
    if (
      boxCollides(this.world, bodyBox(position)) ||
      !boatRiderPathClear(this.world, actor.position, position)
    )
      return failed("no-seat-clearance");
    const next = cloneBoatRecord(boat, this.context);
    next.passengers[slot] = ownerId;
    const worldGuard = captureAquaticArea(
      this.world,
      this.context,
      aquaticSweepBounds(actor.position, position, 0.7, 2.2)
    );
    if (!worldGuard) return failed("frontier");
    const actorGuard = this._actorGuard(ownerId, "main", actor);
    const own = this._prepareRecord(id, next, {
      prerequisite: () =>
        worldGuard() &&
        actorGuard() &&
        crossMountAllowed() &&
        this.prepareMountGuard === prepareMountGuard &&
        this._reachable(actor, { ...boat, y: boat.y + BOAT_HEIGHT }) &&
        boatRiderPathClear(this.world, actor.position, position),
      events: [{ type: "mount", id, ownerId, slot, position }],
    });
    return own
      ? {
          ok: true,
          action: "mount",
          id,
          slot,
          position: { ...position },
          participants: peer ? [own, peer] : [own],
        }
      : failed("invalid-mount");
  }

  mount(id, ownerId) {
    return this.commit(this.prepareMount(id, ownerId));
  }

  prepareDismount(ownerId = "player", { submerged = false } = {}) {
    if (!this._ready()) return failed("unavailable");
    const mount = this.mountFor(ownerId),
      actor = this._actor(ownerId);
    if (!mount || !actor || mount.dimension !== this.world.dimension)
      return failed("not-mounted");
    const boat = this._boats.get(mount.id);
    const exit = findBoatDismount(this.world, boat, {
      slot: mount.slot,
      sampleFluid: this.sampleFluid,
      allowSubmerged: submerged,
      otherBoats: [...this._boats.values()],
    });
    if (!exit) return failed("no-safe-exit");
    const next = cloneBoatRecord(boat, this.context);
    next.passengers = next.passengers.filter(
      (id) => id !== ownerId && id !== null
    );
    while (next.passengers.length < 2) next.passengers.push(null);
    const bounds = aquaticSweepBounds(boat, exit.position, 0.7, 2.2);
    const worldGuard = captureAquaticArea(this.world, this.context, bounds);
    if (!worldGuard) return failed("frontier");
    const actorGuard = this._actorGuard(ownerId, "main", actor);
    const own = this._prepareRecord(boat.id, next, {
      prerequisite: () => worldGuard() && actorGuard(),
      events: [{ type: "dismount", id: boat.id, ownerId, exit }],
    });
    return own
      ? {
          ok: true,
          action: "dismount",
          id: boat.id,
          exit: cloneExit(exit),
          participants: [own],
        }
      : failed("invalid-dismount");
  }

  dismount(ownerId, options) {
    return this.commit(this.prepareDismount(ownerId, options));
  }

  /** Lifecycle detach only. travelling is the host's accepted travel intent,
   * never an unsafe fallback for an ordinary alive rider's Shift input. */
  preparePassengerRelease(ownerId = "player", { travelling = false } = {}) {
    if (!this._ready() || !synchronousAquaticCallback(this.readOwner))
      return failed("unavailable");
    if (typeof travelling !== "boolean") return failed("invalid-departure");
    const mount = this.mountFor(ownerId);
    if (!mount) return failed("not-mounted");
    const departed = () => {
      const actor = this.readOwner(ownerId, "main");
      return (
        !!actor &&
        (travelling ||
          actor.dead === true ||
          (isDimension(actor.dimension) && actor.dimension !== mount.dimension))
      );
    };
    if (!departed()) return failed("use-safe-dismount");
    const boat = this._boats.get(mount.id),
      next = cloneBoatRecord(boat, this.context);
    next.passengers = next.passengers.filter(
      (id) => id !== ownerId && id !== null
    );
    while (next.passengers.length < 2) next.passengers.push(null);
    const own = this._prepareRecord(boat.id, next, {
      prerequisite: departed,
      events: [{ type: "release", id: boat.id, ownerId }],
    });
    return own
      ? { ok: true, action: "release", id: boat.id, participants: [own] }
      : failed("release-rejected");
  }

  releasePassenger(ownerId, options) {
    return this.commit(this.preparePassengerRelease(ownerId, options));
  }

  prepareBreak(id, { ownerId = "player" } = {}) {
    if (!this._ready()) return failed("unavailable");
    if (!synchronousAquaticCallback(this.prepareDrops))
      return failed("missing-prepared-drops");
    const boat = this._boats.get(id),
      actor = this._actor(ownerId);
    if (!boat || boat.dimension !== this.world.dimension)
      return failed("inactive-boat");
    if (!this._reachable(actor, { ...boat, y: boat.y + BOAT_HEIGHT }))
      return failed("out-of-reach");
    const exits = [];
    const obstacles = [...this._boats.values()];
    for (let slot = 0; slot < boat.passengers.length; slot++) {
      const passenger = boat.passengers[slot];
      if (passenger === null) continue;
      const exit = findBoatDismount(this.world, boat, {
        slot,
        sampleFluid: this.sampleFluid,
        allowSubmerged: true,
        otherBoats: obstacles,
      });
      if (!exit) return failed("no-safe-exit");
      exits.push({ ownerId: passenger, exit });
      obstacles.push({
        ...exit.position,
        id: `exit:${slot}`,
        dimension: boat.dimension,
      });
    }
    const guard = captureAquaticArea(this.world, this.context, [
      boat.x - 2.4,
      boat.y - 1.3,
      boat.z - 2.4,
      boat.x + 2.4,
      boat.y + 3,
      boat.z + 2.4,
    ]);
    if (!guard) return failed("frontier");
    const actorGuard = this._actorGuard(ownerId, "main", actor);
    const own = this._prepareRecord(id, null, {
      prerequisite: () =>
        guard() &&
        actorGuard() &&
        this._reachable(actor, { ...boat, y: boat.y + BOAT_HEIGHT }),
      events: [
        ...exits.map(({ ownerId: rider, exit }) => ({
          type: "dismount",
          id,
          ownerId: rider,
          exit,
        })),
        { type: "break", id, ownerId },
      ],
    });
    const drop = this._callback("prepareDrops", {
      stacks: [cloneStack(boat.stack, this.context)],
      position: { x: boat.x, y: boat.y + BOAT_HEIGHT + 0.15, z: boat.z },
      dimension: boat.dimension,
      pickupDelay: 0.3,
      velocity: { x: boat.vx * 0.25, y: 1.5, z: boat.vz * 0.25 },
      reason: "boat-break",
    });
    return own && drop
      ? {
          ok: true,
          action: "break",
          id,
          exits: exits.map(({ ownerId, exit }) => ({
            ownerId,
            exit: cloneExit(exit),
          })),
          participants: [own, drop],
        }
      : failed("drop-rejected");
  }

  break(id, options) {
    return this.commit(this.prepareBreak(id, options));
  }

  raycastWater(origin, direction, maxDistance = 6) {
    return this._ready()
      ? boatWaterTarget(
          this.world,
          origin,
          direction,
          maxDistance,
          this.sampleFluid
        )
      : null;
  }

  /** Caller supplies the nearest block hit's distance to prevent click-through. */
  raycast(origin, direction, maxDistance = 6) {
    if (
      !this._ready() ||
      !finitePoint(origin) ||
      !finitePoint(direction) ||
      !Number.isFinite(maxDistance) ||
      maxDistance < 0
    )
      return null;
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!length) return null;
    const vector = [
      direction.x / length,
      direction.y / length,
      direction.z / length,
    ];
    let best = null;
    for (const boat of this._active(origin)) {
      const hit = intersectRayBox(
        [origin.x, origin.y, origin.z],
        vector,
        boatBox(boat),
        Math.min(6, maxDistance)
      );
      if (hit && (!best || hit.distance < best.distance))
        best = {
          type: "boat",
          id: boat.id,
          distance: hit.distance,
          point: {
            x: origin.x + vector[0] * hit.distance,
            y: origin.y + vector[1] * hit.distance,
            z: origin.z + vector[2] * hit.distance,
          },
          normal: { x: hit.normal[0], y: hit.normal[1], z: hit.normal[2] },
        };
    }
    return best;
  }

  interact(hit, { ownerId = "player" } = {}) {
    if (hit?.type !== "boat") return failed("not-a-boat");
    return this.mountFor(ownerId)?.id === hit.id
      ? this.dismount(ownerId)
      : this.mount(hit.id, ownerId);
  }

  _active(viewer) {
    if (!this.activeSize || !finitePoint(viewer)) return NO_BOATS;
    return [...this._boats.values()]
      .filter(
        (boat) =>
          boat.dimension === this.world.dimension &&
          (boat.x - viewer.x) ** 2 + (boat.z - viewer.z) ** 2 <=
            BOAT_ACTIVE_DISTANCE ** 2 &&
          loadedAquaticArea(this.world, boatBox(boat))
      )
      .sort(
        (a, b) =>
          Number(b.passengers.includes("player")) -
            Number(a.passengers.includes("player")) ||
          distanceSquared(a, viewer) - distanceSquared(b, viewer) ||
          a.id - b.id
      )
      .slice(0, MAX_ACTIVE_BOATS);
  }

  update(dt, { viewer, controls = {} } = {}) {
    if (
      !this.activeSize ||
      !this._ready() ||
      this._updating ||
      !Number.isFinite(dt) ||
      dt <= 0 ||
      !finitePoint(viewer)
    )
      return IDLE_UPDATE;
    const current = captureEntityContext(this.world, this.context);
    const observerErrors = [];
    let moved = 0;
    this._updating = true;
    try {
      const active = this._active(viewer);
      for (const selected of active) {
        if (!current()) break;
        let boat = this._boats.get(selected.id);
        if (!boat) continue;
        for (const passenger of [...boat.passengers])
          if (passenger !== null && controls[passenger]?.dismount)
            this.dismount(passenger);
        boat = this._boats.get(selected.id);
        if (!boat) continue;
        for (
          let remaining = Math.min(dt, 0.2);
          remaining > 1e-8;
          remaining -= 0.05
        ) {
          if (!current() || this._boats.get(boat.id) !== boat) break;
          // Motion never edits the immutable recovery stack or passenger list.
          const next = { ...boat };
          const result = stepBoat(
            this.world,
            next,
            Math.min(remaining, 0.05),
            controls[boat.passengers[0]] ?? {},
            { sampleFluid: this.sampleFluid, otherBoats: active }
          );
          if (result.lost) {
            const removal = this._prepareRecord(boat.id, null, {
              events: [
                {
                  type: "void",
                  id: boat.id,
                  passengers: [...boat.passengers],
                  position: boatSeat(boat),
                },
              ],
            });
            if (removal) this.coordinator.commit([removal]);
            break;
          }
          if (!result.moved) break;
          Object.assign(boat, next);
          this._revision++;
          moved++;
          if (result.bubbleImpulse) {
            try {
              this.onEvent?.({
                type: "bubble",
                id: boat.id,
                direction: result.bubbleImpulse,
              });
            } catch (error) {
              observerErrors.push(error);
            }
          }
          if (result.eject) {
            for (const passenger of [...boat.passengers])
              if (passenger !== null)
                this.dismount(passenger, { submerged: true });
            boat = this._boats.get(selected.id);
            if (!boat) break;
          }
        }
      }
      if (moved) {
        try {
          this.onChange?.();
        } catch (error) {
          observerErrors.push(error);
        }
      }
    } finally {
      this._updating = false;
    }
    return { moved, observerErrors };
  }

  render(viewer) {
    if (!this.renderer || (!this.activeSize && this.renderer.mesh.count === 0))
      return;
    this.renderer.render(
      this._ready() ? this._active(viewer) : NO_BOATS,
      viewer
    );
  }

  serialize() {
    return {
      version: 1,
      seed: String(this.context.seed),
      generatorVersion: this.context.generatorVersion,
      nextId: this._nextId,
      boats: [...this._boats.values()].map((boat) =>
        cloneBoatRecord(boat, this.context)
      ),
    };
  }

  prepareLoad(data, { context = this.context } = {}) {
    if (!this._ready(true) || this._updating) return null;
    const nextContext = entityContextFor(this.world, context);
    if (!matchesEntityContext(this.world, nextContext)) return null;
    const parsed = normalizeBoatSnapshot(data, nextContext);
    if (!parsed) return null;
    const canMount = this.canMount;
    const crossMountAllowed = () => this.canMount === canMount &&
      (canMount === undefined ||
        parsed.boats.every((boat) => boat.passengers.every((rider) =>
          rider === null || canMount(rider, boat.id, { loading: true }) === true)));
    if (!crossMountAllowed()) return null;
    const bytes =
      BOAT_HEADER_RESERVED_BYTES +
      parsed.boats.length * BOAT_RECORD_RESERVED_BYTES;
    const participant = prepareVehicleSnapshot(
      this,
      {
        _boats: new Map(parsed.boats.map((boat) => [boat.id, boat])),
        _dimensionCounts: vehicleDimensionCounts(parsed.boats),
        _nextId: parsed.nextId,
        context: nextContext,
      },
      bytes
    );
    return participant && {
      ...participant,
      validate: () => crossMountAllowed() && participant.validate(),
    };
  }

  load(data, { context = this.context, allowOverBudget = false } = {}) {
    const participant = this.prepareLoad(data, { context });
    if (
      !participant ||
      !commitVehicleSnapshots(this.coordinator, [participant], allowOverBudget)
    )
      return false;
    this.renderer?.render(NO_BOATS, null);
    return true;
  }

  diagnostics() {
    return {
      records: this.size,
      activeDimensionRecords: this.activeSize,
      limit: MAX_BOATS,
      activeLimit: MAX_ACTIVE_BOATS,
      reservedBytes: this._bytes,
      renderer: this.renderer?.diagnostics() ?? null,
    };
  }

  dispose() {
    if (
      this._disposed ||
      this._preparing ||
      this._updating ||
      !this.coordinator.release(this)
    )
      return;
    this._disposed = true;
    this._revision++;
    this._boats.clear();
    this._dimensionCounts = vehicleDimensionCounts();
    this._bytes = 0;
    this.renderer?.dispose();
    this.readOwner =
      this.prepareHandCost =
      this.prepareDrops =
      this.available =
      this.onEvent =
      this.onChange =
        null;
  }
}
