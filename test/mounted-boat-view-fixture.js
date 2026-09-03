import assert from "node:assert/strict";
import * as THREE from "three";
import { applyVehiclePose } from "../src/game-vehicle-integration.js";
import { readVehicleOwner } from "../src/game-vehicle-owners.js";
import { GameVehicleServices } from "../src/game-vehicle-services.js";
import { ITEM } from "../src/items.js";
import { Player } from "../src/player.js";
import { restorePlayerSave } from "../src/player-save.js";
import { World } from "../src/world.js";
import { dispatch } from "./control-fixture.js";
import { vehicleHostFixture } from "./game-vehicle-services-fixture.js";

export const shortestTurn = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
export const near = (actual, expected, message = "angle") =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`);

export function boatView(player) {
  return {
    yaw: player.yaw, pitch: player.pitch, heading: player.hullHeading,
    vehicleType: player.vehicleType, seated: player.seated,
    revision: player.poseRevision, epoch: player.world.epoch,
    dimension: player.world.dimension,
    position: player.position.toArray(), velocity: player.velocity.toArray(),
    eye: player.eyePosition.toArray(), forward: player.forward.toArray(),
    cameraForward: player.camera.getWorldDirection(new THREE.Vector3()).toArray(),
  };
}

export function assertPhysicalAim(f, yaw, pitch) {
  const expected = [
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ];
  const view = boatView(f.player);
  const actor = readVehicleOwner(f.service, "player");
  assert.ok(actor, "the real host must expose its physical actor");
  near(view.yaw, yaw, "physical yaw");
  near(view.pitch, pitch, "pitch");
  for (const [index, axis] of ["x", "y", "z"].entries()) {
    near(view.forward[index], expected[index], `Player.forward.${axis}`);
    near(actor.direction[axis], expected[index], `host physical direction.${axis}`);
    near(actor.eye[axis], view.eye[index], `host physical eye.${axis}`);
    near(view.cameraForward[index],
      expected[index] * (f.player.perspective === "front" ? -1 : 1),
      `camera direction.${axis}`);
  }
}

function archivedBoats(hullYaw) {
  const boat = (id, x, yaw) => ({
    id, wood: "oak", stack: { id: ITEM.OAK_BOAT, count: 1 },
    dimension: "overworld", x, y: 8.58, z: 10.75, yaw,
    vx: 0, vy: 0, vz: 0, turnVelocity: 0,
    submergedTime: 0, bubbleTime: 0, bubbleDirection: 0, paddlePhase: 0,
    passengers: [null, null],
  });
  return {
    boats: {
      version: 1, seed: "boat-view-owner", generatorVersion: 4, nextId: 3,
      boats: [boat(1, 8.5, hullYaw), boat(2, 11.5, -1.1)],
    },
  };
}

/**
 * Small real World/Player/Gameplay/GameVehicleServices ownership case.
 * Archived boats and the existing authored ocean are initial test data, not
 * natural-generation/crafting/GUI evidence. No setHand(), terrain edits, live
 * save access, combat activation, or replacement physics/pose implementations.
 * In particular, do NOT use consumeVehiclePose()/placeAndMount(): that older
 * fixture calls setPosition() instead of exercising Player.update().
 */
export function boatViewFixture(t, { hullYaw = 0.73, saved, savedPlayer } = {}) {
  const f = vehicleHostFixture(t, {
    seed: "boat-view-owner", scene: null, activate: false,
    saved: saved ?? archivedBoats(hullYaw),
  });
  assert.ok(f.world instanceof World);
  assert.ok(f.player instanceof Player);
  assert.ok(f.service instanceof GameVehicleServices);
  assert.equal(f.player.update, Player.prototype.update);
  assert.equal(f.service.frame, GameVehicleServices.prototype.frame);
  assert.equal(f.gameplay.mode, "survival");
  if (savedPlayer)
    assert.equal(restorePlayerSave(f.player, f.world, savedPlayer), true);
  assert.equal(f.service.activate(f.game).ok, true);
  for (const method of ["ensureArea", "_generateSync", "applyCells"])
    t.mock.method(f.world, method, () => assert.fail(`boat view cannot call World.${method}`));
  t.mock.method(f.gameplay, "add", () => assert.fail("boat view cannot grant items"));
  const retained = () => ({
    world: f.world.serialize(), gameplay: f.gameplay.serialize(),
    overflow: f.overflow.serialize(), experience: f.experienceOrbs.serialize(),
    columns: [...f.world.chunks.keys()], bytes: f.coordinator.budget.totalBytes,
  });
  let advances = 0, consumptions = 0;

  return Object.assign(f, {
    retained,
    key(code, down = true) {
      return dispatch(f.controls.document, down ? "keydown" : "keyup",
        { code, target: f.controls.element, timeStamp: advances * 50 });
    },
    mount(id = 1) {
      const boat = f.service.boats.getBoat(id);
      f.aimAt({ x: boat.x, y: boat.y + 0.3, z: boat.z });
      const hit = f.service.raycast();
      assert.equal(hit?.id, id);
      assert.equal(f.service.interact(hit).ok, true);
      return f.consume();
    },
    advance(dt = 0.05) {
      assert.ok(++advances <= 24, "bounded real boat frames");
      const before = f.service.riderPose();
      const result = f.service.frame(dt, { keys: f.player.vehicleKeys });
      assert.equal(result.ok, true);
      assert.deepEqual(result.boats?.observerErrors ?? [], []);
      const rider = f.service.riderPose();
      return { before, rider, result };
    },
    consume(dt = 0, options) {
      assert.ok(++consumptions <= 32, "bounded pose consumptions");
      const riderPose = options === undefined ? f.service.riderPose() : options.riderPose ?? null;
      const before = boatView(f.player);
      // dt=0 exercises the actual input-event bridge. Positive dt follows
      // Game.frame's owner -> takeExitPose -> Player.update consumption order.
      const result = options === undefined && dt === 0
        ? applyVehiclePose(f.game)
        : f.player.update(dt, {
          recoverFromVoid: false,
          ...(options === undefined
            ? { riderPose, exitPose: f.service.takeExitPose() } : options),
        });
      const after = boatView(f.player);
      return { before, after, result, riderPose };
    },
  });
}
