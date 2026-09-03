import { BLOCK } from "./blocks.js";
import { cellsEqual, isValidCell, normalizeCell } from "./block-state.js";
import {
  BuildingReads,
  capturePlacementNeighborhood,
  normalFace,
} from "./building-placement.js";
import {
  FLUID_SERVICE_LIMITS,
  GameFluidServices,
} from "./game-fluid-services.js";
import { stackIdentity } from "./item-stack-data.js";
import { raycast } from "./raycast.js";
import { TransactionInvariantError } from "./transactions.js";
import { inWorldBounds } from "./world-spec.js";

const handles = (id) => id === BLOCK.KELP || id === BLOCK.SPONGE;
const refused = (reason) => Object.freeze({ ok: false, reason });
const synchronous = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";
const vector = (value) =>
  value && [value.x, value.y, value.z].every(Number.isFinite)
    ? Object.freeze({ x: value.x, y: value.y, z: value.z })
    : null;
const sameVector = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z;
// Keep GameUseActions.physicalEye's legacy fallback without importing its owner.
const physicalEye = (game) =>
  game.player.eyePosition ?? game.graphics?.camera?.position;
const sameHit = (a, b) =>
  sameVector(a, b) && cellsEqual(a, b) && sameVector(a.normal, b.normal);

function loadedGeometry(reads) {
  // Ray reach is at most five blocks and the collision apron has 245 cells.
  // BuildingReads also enforces its own hard read cap before collecting records.
  if (reads.records.size > 1024) return false;
  for (const read of reads.records.values())
    if (
      read.before === null &&
      inWorldBounds(read.x, read.y, read.z, reads.spec)
    )
      return false;
  return true;
}

function preparedOwners(action, service, gameplay) {
  const participants = action?.participants;
  if (
    !Array.isArray(participants) ||
    participants.length < 2 ||
    participants.length > FLUID_SERVICE_LIMITS.participants
  )
    return false;
  const owners = new Set(participants.map((participant) => participant?.owner));
  return (
    owners.size === participants.length &&
    owners.has(service.world) &&
    owners.has(service) &&
    !owners.has(gameplay) &&
    [...owners].every((owner) =>
      [service.world, service, service.settlement, service.overflow].includes(
        owner
      )
    )
  );
}

/**
 * null means ordinary placement (including wet sponge); a refusal is terminal.
 * The service alone plans kelp rules, absorption, plant ownership and retention.
 * This adapter adds exactly one real hand-cost participant, never another World
 * mutation or an inventory grant. Preparation does not publish any owner.
 */
export function prepareFluidBlockPlacement(game, hand, id, hit = game?.target) {
  if (!handles(id)) return null;
  try {
    const { world, gameplay, player, fluidServices: service } = game ?? {};
    if (
      !world ||
      !gameplay ||
      !player ||
      !(service instanceof GameFluidServices) ||
      !["main", "offhand"].includes(hand)
    )
      return refused("fluid-placement-unavailable");
    const method =
      id === BLOCK.KELP ? "prepareKelpPlacement" : "prepareSpongeAbsorption";
    const prepare = service[method];
    const prepareCost = gameplay.prepareHandCost;
    const collision = player.intersectsPlacement;
    if (!synchronous(collision)) return refused("fluid-collision-unavailable");
    if (!synchronous(prepare) || !synchronous(prepareCost))
      return refused("fluid-action-unavailable");

    const coordinator = world.coordinator;
    const mode = gameplay.mode;
    const selected = gameplay.selected;
    const handRevision = gameplay.getHandRevision(hand);
    const stack = gameplay.getHandStack(hand);
    const eye = vector(physicalEye(game));
    const forward = vector(player.forward);
    const position = vector(player.position);
    const height = player.height;
    if (
      stack?.id !== id ||
      !Number.isSafeInteger(handRevision) ||
      !gameplay.canPlace(id, hand) ||
      !eye ||
      !forward ||
      !position ||
      !Number.isFinite(height) ||
      height <= 0 ||
      !hit ||
      ![hit.x, hit.y, hit.z].every(Number.isSafeInteger) ||
      !normalFace(hit.normal)
    )
      return refused("invalid-fluid-placement-source");
    const identity = stackIdentity(stack, gameplay.context);
    const count = stack.count;
    const durability = stack.durability;
    const clicked = Object.freeze({
      x: hit.x,
      y: hit.y,
      z: hit.z,
      id: hit.id,
      state: hit.state,
      fluid: hit.fluid,
      normal: vector(hit.normal),
    });
    const validHit = (current) =>
      sameHit(current, clicked) &&
      (current.world === undefined || current.world === world) &&
      (current.dimension === undefined ||
        current.dimension === world.dimension) &&
      (current.epoch === undefined || current.epoch === world.epoch);
    const currentHost = () => {
      const current = gameplay.getHandStack(hand);
      return (
        game.active === true &&
        !game.mobTarget &&
        game.world === world &&
        game.gameplay === gameplay &&
        game.player === player &&
        player.world === world &&
        game.fluidServices === service &&
        service._game === game &&
        service.active &&
        service.world === world &&
        service.coordinator === coordinator &&
        world.coordinator === coordinator &&
        gameplay.coordinator === coordinator &&
        (game.coordinator === undefined || game.coordinator === coordinator) &&
        !world._disposed &&
        !gameplay._disposed &&
        !gameplay.dead &&
        !game.paused &&
        !game.building &&
        !game.failed &&
        service[method] === prepare &&
        gameplay.prepareHandCost === prepareCost &&
        player.intersectsPlacement === collision &&
        gameplay.mode === mode &&
        gameplay.selected === selected &&
        gameplay.getHandRevision(hand) === handRevision &&
        current?.count === count &&
        current?.durability === durability &&
        stackIdentity(current, gameplay.context) === identity &&
        sameVector(player.position, position) &&
        sameVector(physicalEye(game), eye) &&
        sameVector(player.forward, forward) &&
        player.height === height &&
        validHit(game.target) &&
        validHit(hit)
      );
    };
    if (!currentHost()) return refused("stale-fluid-placement-source");

    const reads = new BuildingReads(world);
    const reach = mode === "creative" ? 5 : 4.5;
    if (
      !cellsEqual(reads.at(clicked), clicked) ||
      !sameHit(raycast(reads.view, eye, forward, reach), clicked)
    )
      return refused("fluid-placement-ray-mismatch");
    // Always use the initial clicked face, never a later target or camera.
    const at = Object.freeze({
      x: clicked.x + clicked.normal.x,
      y: clicked.y + clicked.normal.y,
      z: clicked.z + clicked.normal.z,
    });
    const before = reads.at(at);
    if (!before) return refused("fluid-placement-unloaded");
    capturePlacementNeighborhood(reads, [at]);
    if (!loadedGeometry(reads)) return refused("fluid-placement-unloaded");

    const action =
      id === BLOCK.KELP
        ? prepare.call(service, at)
        : prepare.call(service, at, { place: true });
    if (!action) return refused("fluid-placement-refused");
    if (!preparedOwners(action, service, gameplay))
      return refused("invalid-fluid-placement-participants");
    const after =
      id === BLOCK.KELP
        ? normalizeCell({ id: BLOCK.KELP })
        : action.result?.spongeCell;
    if (
      !isValidCell(after) ||
      (id === BLOCK.SPONGE &&
        ![BLOCK.SPONGE, BLOCK.WET_SPONGE].includes(after.id))
    )
      return refused("fluid-collision-proposal-unavailable");
    // Only the sponge center adds collision. Absorption elsewhere removes
    // fluid/plants or preserves host geometry. Player resolves this center AND
    // its neighbors (e.g. new fence connections); no invented partial sweep.
    // Kelp's registered cell has no collision and needs no copied support rules.
    const changes = Object.freeze([
      Object.freeze({
        ...at,
        before,
        after: Object.freeze({ ...after }),
      }),
    ]);
    const currentGeometry = () =>
      currentHost() &&
      reads.validate() &&
      sameHit(
        raycast(world, physicalEye(game), player.forward, reach),
        clicked
      ) &&
      collision.call(player, changes) === false;
    if (!currentGeometry())
      return refused("fluid-placement-changed-or-colliding");
    const cost = prepareCost.call(gameplay, hand, {
      count: 1,
      stack,
      handRevision,
    });
    if (!cost || cost.owner !== gameplay || !currentGeometry())
      return refused("fluid-placement-hand-unavailable");
    return Object.freeze({
      participants: Object.freeze([
        ...action.participants,
        Object.freeze({
          ...cost,
          validate: () => currentGeometry() && cost.validate(),
        }),
      ]),
      result: action.result,
    });
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return refused("fluid-placement-unavailable");
  }
}

/** GameUseActions.place delegation: null alone permits generic fallthrough. */
export function placeFluidBlock(game, hand, id, hit = game?.target) {
  const coordinator = game?.gameplay?.coordinator;
  const action = prepareFluidBlockPlacement(game, hand, id, hit);
  if (action === null) return null;
  if (!action.participants || !coordinator.commit(action.participants).ok)
    return false;
  game.effects.sound("place", id);
  const view = hand === "offhand" ? game.effects.offhand : game.effects;
  if (view) view.swing = 1;
  game.graphics.rebuildDirty(4);
  game.scheduleSave();
  game.updateTarget();
  game.refreshHud();
  return true;
}
