import { cloneStack, isValidStack } from "./inventory-slots.js";
import { stackIdentity } from "./item-stack-data.js";
import { TransactionInvariantError } from "./transactions.js";
import { finitePoint } from "./vehicle-water.js";
import { vehicleHandSlot, vehicleSynchronous } from "./game-vehicle-state.js";

const point = ({ x, y, z }) => ({ x, y, z });

/**
 * Only the real local Player/Gameplay are bound. A committed seat/exit is the
 * authoritative physical pose until Player consumes it this frame. Render
 * camera position/yaw, virtual inventory replacements and caller-supplied rods
 * are never an actor source.
 */
export function readVehicleOwner(service, ownerId, hand = "main") {
  const game = service._candidateGame ?? service._game;
  if (
    ownerId !== "player" ||
    !["main", "offhand"].includes(hand) ||
    !game ||
    !service._leafAvailable()
  )
    return null;
  const player = game.player,
    gameplay = service.gameplay;
  const mounted = service.boats.riderPose(ownerId);
  const position =
    mounted?.position ?? service._exitPose?.position ?? player.position;
  const direction = player.forward;
  if (
    !finitePoint(position) ||
    !finitePoint(direction) ||
    !Number.isFinite(player.eyeHeight) ||
    player.eyeHeight <= 0 ||
    player.eyeHeight > 2
  )
    return null;
  const eye =
    mounted || service._exitPose
      ? { x: position.x, y: position.y + player.eyeHeight, z: position.z }
      : player.eyePosition;
  if (!finitePoint(eye)) return null;
  const side = hand === "offhand" ? -1 : 1;
  const yaw = Number.isFinite(player.yaw) ? player.yaw : 0;
  return {
    position: point(position),
    eye: point(eye),
    direction: point(direction),
    lineOrigin: {
      x: eye.x + direction.x * 0.32 + Math.cos(yaw) * side * 0.18,
      y: eye.y - 0.22 + direction.y * 0.32,
      z: eye.z + direction.z * 0.32 - Math.sin(yaw) * side * 0.18,
    },
    dimension: service.world.dimension,
    dead: gameplay.dead === true,
    poseRevision: player.poseRevision,
    stack: gameplay.getHandStack(hand),
    handRevision: gameplay.getHandRevision(hand),
    slotKey: vehicleHandSlot(gameplay, hand),
  };
}

function preparedOwner(service, owner, method, args) {
  if (!service._actionAvailable() || !vehicleSynchronous(owner?.[method]))
    return null;
  const prepare = owner[method],
    guard = service._captureGuard();
  let participant;
  try {
    participant = Reflect.apply(prepare, owner, args);
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return null;
  }
  if (
    !participant ||
    participant.owner !== owner ||
    typeof participant.then === "function" ||
    !vehicleSynchronous(participant.validate) ||
    !vehicleSynchronous(participant.publish) ||
    owner.coordinator !== service.coordinator ||
    service.coordinator.usage(owner) !== participant.beforeBytes
  )
    return null;
  return Object.freeze({
    ...participant,
    validate: () =>
      guard() && owner[method] === prepare && participant.validate(),
  });
}

export function prepareVehicleHandCost(service, request) {
  const {
    ownerId,
    hand,
    stack,
    handRevision,
    slotKey,
    count = 0,
    wear = 0,
  } = request ?? {};
  const gameplay = service.gameplay;
  if (
    ownerId !== "player" ||
    !["main", "offhand"].includes(hand) ||
    !((count === 1 && wear === 0) || (count === 0 && wear === 1)) ||
    !isValidStack(stack, service.context) ||
    handRevision !== gameplay.getHandRevision(hand) ||
    (slotKey !== undefined && slotKey !== vehicleHandSlot(gameplay, hand))
  )
    return null;
  const current = gameplay.getHandStack(hand);
  if (
    !current ||
    current.count !== stack.count ||
    current.durability !== stack.durability ||
    stackIdentity(current, service.context) !==
      stackIdentity(stack, service.context)
  )
    return null;
  // Gameplay's Creative convenience cost is unlimited. Offhand ownership is
  // finite even in Creative, so debit the real detached inventory draft there.
  if (gameplay.mode === "creative" && hand === "offhand") {
    return preparedOwner(service, gameplay, "prepareInventory", [
      (draft) => {
        const held = draft.offhand;
        if (!held || held.count < count || (wear && !held.durability))
          return false;
        if (count)
          draft.offhand =
            held.count === count
              ? null
              : { ...held, count: held.count - count };
        if (wear)
          draft.offhand =
            held.durability > wear
              ? { ...held, durability: held.durability - wear }
              : null;
        return true;
      },
      { notify: false },
    ]);
  }
  return preparedOwner(service, gameplay, "prepareHandCost", [
    hand,
    {
      stack: cloneStack(stack, service.context),
      handRevision,
      count,
      wear,
      notify: false,
    },
  ]);
}

export function prepareVehicleDrops(service, request) {
  const { stacks, position, dimension, velocity, pickupDelay } = request ?? {};
  if (
    dimension !== service.world.dimension ||
    !finitePoint(position) ||
    !finitePoint(velocity) ||
    !Array.isArray(stacks) ||
    stacks.length !== 1 ||
    !isValidStack(stacks[0], service.context) ||
    !Number.isFinite(pickupDelay)
  )
    return null;
  return preparedOwner(service, service.overflow, "prepareEnqueue", [
    stacks.map((stack) => cloneStack(stack, service.context)),
    point(position),
    dimension,
    { velocity: point(velocity), pickupDelay },
  ]);
}

export function prepareVehicleExperience(service, request) {
  const { amount, position, dimension, velocity, pickupDelay } = request ?? {};
  if (
    !Number.isInteger(amount) ||
    amount < 1 ||
    amount > 6 ||
    dimension !== service.world.dimension ||
    !finitePoint(position) ||
    !finitePoint(velocity) ||
    !Number.isFinite(pickupDelay)
  )
    return null;
  return preparedOwner(service, service.experienceOrbs, "prepareSpawn", [
    amount,
    { ...point(position), dimension },
    { velocity: point(velocity), pickupDelay },
  ]);
}
