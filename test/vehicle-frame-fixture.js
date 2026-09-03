import assert from "node:assert/strict";
import * as THREE from "three";
import { CombatFeedback } from "../src/combat-feedback.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { VoxelGame } from "../src/game.js";
import { PlayerVisual } from "../src/player-visual.js";
import { dispatch } from "./control-fixture.js";
import {
  playerState,
  point,
  vehiclePearlFixture,
} from "./vehicle-pearl-fixture.js";

/**
 * Extend the passing real-owner fixture, not its hand-written step().
 * Native v3 terrain plus its explicitly authored finite supplies/pool/clearance.
 * Fluids have a real, initially empty sidecar; no active-flow/replay claim.
 * World streaming, owner clocks, collision, RNG and all frame methods run.
 * Only browser presentation/RAF transports are sinks. No WebGL or GUI proof.
 */
export async function vehicleFrameFixture(t) {
  const f = await vehiclePearlFixture(t);
  const { game, player } = f;
  t.after(() => game.hurtFeedback.dispose());
  assert.equal(game.frame, VoxelGame.prototype.frame);
  for (const owner of Object.values(f.owners)) {
    assert.equal(owner.coordinator, f.coordinator);
    assert.notEqual(f.coordinator.usage(owner), undefined);
  }
  const fluid = new GameFluidServices({
    world: f.world,
    overflow: f.overflow,
    settlement: game.settlement,
    context: f.context,
  });
  t.after(() => fluid.dispose());
  assert.equal(fluid.activate(game).ok, true);
  const visual = new PlayerVisual(f.scene);
  t.after(() => visual.dispose());
  Object.assign(game, {
    combatFeedback: new CombatFeedback(),
    playerVisual: visual,
    lastFrame: 0,
    portalCooldown: 3,
    streamTimer: 0,
    hudTimer: 0,
    autosaveTimer: 0,
    heldAction: null,
    lastAction: -Infinity,
    renderDirection: new THREE.Vector3(),
  });
  // The native streamer still runs. Its radius+apron fits the admitted 3x3.
  game.graphics.renderRadius = 0;
  const frames = [];
  let current = null;
  const direction = new THREE.Vector3();
  const read = () => ({
    player: playerState(player),
    seat: f.vehicles.riderPose(),
    exit: structuredClone(f.vehicles._exitPose),
    boats: f.boats.serialize(),
    fishing: f.fishing.serialize(),
    pearls: f.pearls.serialize(),
    gameplay: f.gameplay.serialize(),
    survivalClock: f.gameplay._changeClock,
    fluids: fluid.serialize(),
    overflow: f.overflow.serialize(),
    experience: f.experience.serialize(),
    camera: {
      position: point(player.camera.position),
      forward: point(player.camera.getWorldDirection(direction)),
      physicalForward: point(player.forward),
    },
    projection: {
      boatParts: f.boats.renderer.mesh.count,
      bobberParts: f.fishing.renderer.bobbers.count,
      lineVertices: f.fishing.renderer.lineGeometry.drawRange.count,
      pearls: f.projectiles.renderer?.pearls.count ?? 0,
      trails: f.projectiles.renderer?.trails.count ?? 0,
      player: visual.visible
        ? {
            position: point(visual.mesh.position),
            yaw: visual.rig.root.rotation.y,
            gait: visual.rig.gait,
            stride: visual.rig.stride,
          }
        : null,
    },
  });
  const observe = (name, args, run) => {
    if (!current) return run();
    assert.ok(current.events.length < 64, "bounded observations per frame");
    const event = {
      name,
      enter: ++current.boundary,
      now: game.lastFrame,
      args: structuredClone(args),
      before: read(),
    };
    current.events.push(event);
    const result = run();
    event.result = structuredClone(result);
    event.after = read();
    event.leave = ++current.boundary;
    return result;
  };
  for (const [owner, method, name] of [
    [fluid, "frame", "fluids"],
    [fluid.fluids, "update", "fluid-tick"],
    [f.vehicles, "frame", "vehicles"],
    [f.boats, "update", "boat-tick"],
    [f.fishing, "update", "fishing-tick"],
    [player, "update", "player"],
    [game, "updateTarget", "target"],
    [game.useActions, "update", "use"],
    [f.projectiles, "frame", "projectiles"],
    [f.pearls, "update", "pearl-tick"],
    [f.gameplay, "onHurt", "hurt"],
    [player, "gameplayEnvironment", "environment"],
    [f.gameplay, "update", "survival"],
    [visual, "update", "player-render"],
    [f.vehicles, "render", "vehicle-render"],
    [f.projectiles, "render", "pearl-render"],
  ]) {
    const original = owner[method];
    t.mock.method(owner, method, function (...args) {
      return observe(name, args, () => Reflect.apply(original, this, args));
    });
  }
  const sink = (name) => (...args) => observe(name, args, () => undefined);
  Object.assign(game.graphics, {
    observeFrame: sink("observe-frame"),
    setTarget: sink("target-view"),
    update: sink("graphics-update"),
    render: sink("draw"),
  });
  game.effects.update = sink("effects");

  const previous = new Map(
    ["document", "requestAnimationFrame"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  const requests = new Map();
  let requestId = 0;
  t.after(() => {
    current = null;
    requests.clear();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  for (const [key, value] of Object.entries({
    document: player.element.ownerDocument,
    requestAnimationFrame(callback) {
      assert.equal(typeof callback, "function");
      assert.equal(requests.size, 0, "at most one native RAF continuation");
      assert.ok(requestId < 24, "no unbounded animation loop");
      requests.set(++requestId, callback);
      return requestId;
    },
  }))
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });

  return Object.assign(f, {
    fluid,
    frames,
    read,
    key(code, down = true) {
      return dispatch(
        player.element.ownerDocument,
        down ? "keydown" : "keyup",
        { code, timeStamp: game.lastFrame }
      );
    },
    frameAt(now) {
      assert.ok(Number.isSafeInteger(now) && now > game.lastFrame);
      assert.ok(frames.length < 24);
      assert.equal(current, null);
      const rawMs = now - game.lastFrame;
      const frame = {
        now,
        rawMs,
        dt: Math.min(rawMs / 1000, 0.1),
        boundary: 0,
        events: [],
      };
      frame.before = read();
      frame.elapsedBefore = game.elapsed;
      frame.autosaveBefore = game.autosaveTimer;
      const callback = frames.length
        ? requests.get(game.animation)
        : (time) => VoxelGame.prototype.frame.call(game, time);
      assert.equal(typeof callback, "function");
      requests.delete(game.animation);
      current = frame;
      try {
        callback(now);
      } finally {
        current = null;
      }
      frame.after = read();
      frame.elapsedAfter = game.elapsed;
      frame.autosaveAfter = game.autosaveTimer;
      frames.push(frame);
      assert.equal(game.lastFrame, now);
      assert.equal(requestId, frames.length);
      assert.equal(requests.size, 1);
      assert.deepEqual(f.projectiles.observerErrors, []);
      assert.deepEqual(f.vehicles.diagnostics().observerErrors, []);
      return frame;
    },
  });
}
