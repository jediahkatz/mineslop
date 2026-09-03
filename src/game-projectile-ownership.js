import { captureEntityContext } from "./entity-context.js";
import { finitePearlVector } from "./pearl-physics.js";
import { PLAYER_WIDTH } from "./player.js";
import { PEARL_TELEPORT_DAMAGE } from "./player-projectiles.js";
import { isWorldPose } from "./world-spec.js";

const point = ({ x, y, z }) => ({ x, y, z });
const samePoint = (a, b) => a?.x === b.x && a?.y === b.y && a?.z === b.z;
const poseFields = [
  "yaw",
  "pitch",
  "height",
  "eyeHeight",
  "seated",
  "sneaking",
  "flying",
  "allowFlight",
  "grounded",
  "fallDistance",
  "moving",
  "sprinting",
  "climbing",
  "poseRevision",
  "_captureRevision",
  "_jumpQueued",
  "_spaceTapAt",
  "_forwardTapAt",
  "_sprintLatched",
  "_stepDistance",
  "_bob",
];

/** The domain adds its actual swept-impact/read-set and retirement participant. */
export function prepareHostedPearlImpact(service, request) {
  const game = service.game;
  const player = game?.player;
  const gameplay = service.gameplay;
  const world = service.world;
  if (
    !service.running ||
    !player ||
    request?.world !== world ||
    request.ownerRef !== player ||
    request.ownerId !== service.projectiles.ownerId ||
    request.life !== service.projectiles.life ||
    request.dimension !== world.dimension ||
    request.body?.radius !== PLAYER_WIDTH / 2 ||
    request.body?.height !== player.height ||
    !isWorldPose(request.position, service.context, world.dimension) ||
    !finitePearlVector(request.velocity) ||
    [request.velocity.x, request.velocity.y, request.velocity.z].some(
      (v) => v !== 0
    ) ||
    request.fallDistance !== 0 ||
    request.resetMovement !== true ||
    request.damage?.amount !== PEARL_TELEPORT_DAMAGE ||
    request.damage.cause !== "ender-pearl" ||
    request.damage.bypassArmor !== true ||
    request.damage.bypassShield !== true ||
    request.damage.creativeImmune !== true ||
    ![player.position, player.velocity, player.eyePosition].every(
      finitePearlVector
    ) ||
    !(player._keys instanceof Set) ||
    !Number.isSafeInteger(player.poseRevision) ||
    !Number.isSafeInteger(player.poseRevision + 1) ||
    !service.projectiles.projectiles.some(
      (entry) =>
        entry.id === request.projectileId && entry.life === request.life
    )
  )
    return null;

  const vehicles = game.vehicleServices;
  const departure =
    vehicles == null ? null : vehicles.prepareDeparture?.("travel");
  if (
    vehicles != null &&
    (!departure?.ok ||
      !Array.isArray(departure.participants) ||
      !departure.participants.length)
  )
    return null;
  const current = captureEntityContext(world, service.context);
  const position = player.position;
  const velocity = player.velocity;
  const eye = player.eyePosition;
  const before = {
    position: point(position),
    velocity: point(velocity),
    eye: point(eye),
    fields: poseFields.map((field) => player[field]),
  };
  const keys = player._keys;
  const pressed = [...keys];
  const destination = point(request.position);
  const nextRevision = player.poseRevision + 1;
  let poseUsed = false;
  let poseNotified = false;
  const pose = Object.freeze({
    owner: service,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () =>
      !poseUsed &&
      service.running &&
      service.game === game &&
      game.player === player &&
      game.vehicleServices === vehicles &&
      player.world === world &&
      service.projectiles.life === request.life &&
      current() &&
      player.position === position &&
      player.velocity === velocity &&
      player.eyePosition === eye &&
      samePoint(position, before.position) &&
      samePoint(velocity, before.velocity) &&
      samePoint(eye, before.eye) &&
      poseFields.every((field, index) =>
        Object.is(player[field], before.fields[index])
      ) &&
      player._keys === keys &&
      keys.size === pressed.length &&
      pressed.every((key) => keys.has(key)),
    publish() {
      poseUsed = true;
      position.x = eye.x = destination.x;
      position.y = destination.y;
      eye.y = destination.y + player.eyeHeight;
      position.z = eye.z = destination.z;
      velocity.x = velocity.y = velocity.z = 0;
      player.grounded =
        player.moving =
        player.sprinting =
        player.climbing =
        player.seated =
          false;
      player.fallDistance = player._stepDistance = player._bob = 0;
      player._jumpQueued = player._sprintLatched = false;
      player._spaceTapAt = player._forwardTapAt = null;
      player._poseRevision = nextRevision;
    },
    notify() {
      if (!poseUsed || poseNotified) return;
      poseNotified = true;
      if (!service.active || service.game !== game || game.player !== player)
        return;
      // Derived camera/fluid work runs only after pose, health and removal publish.
      player._syncCamera(0);
      player.sampleFluids();
    },
  });

  let died = false;
  const health = gameplay._prepareState(
    (draft) => {
      if (gameplay.mode !== "creative") {
        draft.health = Math.max(0, draft.health - PEARL_TELEPORT_DAMAGE);
        draft.timers.regen = 0;
        died = draft.health === 0;
        if (died) {
          draft.dead = true;
          draft.deathCause = "ender-pearl";
        }
      }
      return true;
    },
    { notify: false }
  );
  if (!health) return null;
  let healthPublished = false;
  let healthNotified = false;
  const damage = Object.freeze({
    ...health,
    validate: () =>
      service.running &&
      service.game === game &&
      game.player === player &&
      game.vehicleServices === vehicles &&
      health.validate(),
    publish() {
      health.publish();
      healthPublished = true;
    },
    notify() {
      if (!healthPublished || healthNotified) return;
      healthNotified = true;
      try {
        health.notify?.();
      } finally {
        if (
          died &&
          service.active &&
          game.gameplay === gameplay &&
          gameplay.dead
        )
          gameplay.onDeath("ender-pearl");
      }
    },
  });
  return { pose, damage, extraParticipants: departure?.participants ?? [] };
}
