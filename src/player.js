import * as THREE from "three";
import { UNIT_BOX, overlaps, translateBox } from "./aabb.js";
import { FLUID, isWaterFluid } from "./block-state.js";
import {
  bodyBox,
  boxCollides,
  climbContact,
  intersectsCell,
  intersectsPlacement,
  moveBody,
  sweepCameraDistance,
} from "./collision.js";
import { normalizeControlPreferences } from "./control-preferences.js";
import { createFluidQueryView } from "./fluid-query-view.js";
import { createFluidSample, sampleFluid } from "./fluid-sampling.js";
import {
  geometryWorldSpec,
  readGeometryCell,
  validBodyPosition,
} from "./geometry-world.js";
import { RemoteLook } from "./remote-look.js";

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const SNEAK_HEIGHT = 1.5;
export const SNEAK_EYE_HEIGHT = 1.27;
export const DOUBLE_TAP_MS = 350;
export const MAX_LOOK_PITCH = 1.54;
export const PLAYER_FLUID_PHYSICS = Object.freeze({
  currentAcceleration: 5.6,
  bubbleUpAcceleration: 24,
  bubbleDownAcceleration: 12,
  bubbleUpSpeed: 14,
  bubbleDownSpeed: 6,
  swimImmersion: 0.35,
  maxSwimSpeedMultiplier: 1.6,
  maxQueriesPerUpdate: 15,
  maxBodyCellsPerQuery: 12,
});
const HALF_WIDTH = PLAYER_WIDTH / 2;
const WALK_SPEED = 4.317;
const PERSPECTIVES = ["first", "back", "front"];
const UNSEATED_KEYS = new Set(["Space", "ControlLeft", "ControlRight"]);
const MOVEMENT_KEYS = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function intersectsBlock(position, x, y, z, height = PLAYER_HEIGHT) {
  return overlaps(
    bodyBox(position, HALF_WIDTH, height),
    translateBox(UNIT_BOX, x, y, z)
  );
}

export function collidesWithWorld(world, position, height = PLAYER_HEIGHT) {
  return boxCollides(world, bodyBox(position, HALF_WIDTH, height));
}

const finiteVehicleVector = (value) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Number.isFinite(value.z);

function validVehiclePose(world, pose, seated) {
  if (
    !pose ||
    typeof pose !== "object" ||
    Array.isArray(pose) ||
    !finiteVehicleVector(pose.position) ||
    !finiteVehicleVector(pose.velocity) ||
    typeof pose.grounded !== "boolean" ||
    (seated
      ? pose.seated !== true || pose.grounded
      : pose.seated !== undefined && pose.seated !== false) ||
    (pose.swimming !== undefined &&
      (typeof pose.swimming !== "boolean" ||
        (pose.swimming && (seated || pose.grounded)))) ||
    (pose.hullYaw !== undefined && !Number.isFinite(pose.hullYaw)) ||
    (pose.vehicleType !== undefined && !["boat", "horse"].includes(pose.vehicleType))
  )
    return false;
  const dimension = world.dimension ?? "overworld";
  // Seats keep the ordinary standing footprint, not the bent visual limbs.
  // Transfers/path/support are the vehicle owner's job; never require a solid
  // floor under a committed seat or a swimming exit, or generate missing cells.
  return (
    (pose.dimension === undefined || pose.dimension === dimension) &&
    (pose.position.dimension === undefined ||
      pose.position.dimension === dimension) &&
    validBodyPosition(pose.position, world, {
      radius: HALF_WIDTH,
      height: PLAYER_HEIGHT,
      dimension,
    }) &&
    !collidesWithWorld(world, pose.position)
  );
}

export function moveWithCollisions(
  world,
  initialPosition,
  displacement,
  options = {}
) {
  return moveBody(world, initialPosition, displacement, {
    radius: HALF_WIDTH,
    height: PLAYER_HEIGHT,
    ...options,
  });
}

function isEditing(event) {
  const target = event.target;
  return (
    target?.isContentEditable ||
    Boolean(
      target?.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
      )
    )
  );
}

export class Player {
  constructor(camera, world, element, controlPreferences) {
    this.camera = camera;
    this.world = world;
    this.element = element;
    this.position = new THREE.Vector3();
    this._poseRevision = 0;
    // Stable physical aim origin. Camera bob/perspective never changes it.
    this.eyePosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this._flying = false;
    this._allowFlight = true;
    this._canSprint = true;
    this._perspective = "first";
    this.fallDistance = 0;
    this.grounded = false;
    this.moving = false;
    this.sprinting = false;
    this.sneaking = false;
    this.seated = false;
    this._vehicleType = this._vehicleId = this._hullHeading = null;
    this._boatViewContext = null;
    this.climbing = false;
    this.onStep = null;
    this.onWaterSample = null;
    this.onFlightChange = null;
    this.onFall = null;
    this.onJump = null;
    this.onInputReset = null;
    this.fluidState = createFluidSample();
    this.fluidMovementBlocked = false;
    this._fluidWorld = world;
    this._fluidQuery = createFluidQueryView(world);
    this._fluidOptions = {
      radius: HALF_WIDTH,
      height: PLAYER_HEIGHT,
      eyeHeight: EYE_HEIGHT,
    };
    this._fluidQueries = 0;
    this._fluidCells = 0;
    this._controlPreferences = normalizeControlPreferences(controlPreferences);
    this._remoteLook = new RemoteLook();
    this._captureRevision = 0;
    this._enabled = false;
    this._keys = new Set();
    this._jumpQueued = false;
    this._spaceTapAt = null;
    this._forwardTapAt = null;
    this._sprintLatched = false;
    this._stepDistance = 0;
    this._bobPhase = 0;
    this._bob = 0;
    this._baseFov = camera.fov;
    this._document = element.ownerDocument ?? document;
    this._window = this._document.defaultView ?? window;
    this._onKeyDown = (event) => {
      if (!this.enabled || isEditing(event) || !MOVEMENT_KEYS.has(event.code))
        return;
      event.preventDefault();
      // A held key can repeat after a menu/blur reset. Only a fresh press may
      // arm movement or the double-tap timers again.
      if (
        event.repeat ||
        this._keys.has(event.code) ||
        (this.seated && UNSEATED_KEYS.has(event.code) &&
          !(event.code === "Space" && this.vehicleType === "horse"))
      )
        return;
      this._keys.add(event.code);
      if (this.seated) return; // Raw vehicle input only; no walking/flight tap state.
      const at = Number.isFinite(event.timeStamp)
        ? event.timeStamp
        : performance.now();
      const secondTap = (previous) =>
        previous !== null && at >= previous && at - previous <= DOUBLE_TAP_MS;
      if (event.code === "Space") {
        this._jumpQueued = true;
        if (this.allowFlight) {
          if (secondTap(this._spaceTapAt)) this.flying = !this.flying;
          else this._spaceTapAt = at;
        }
      }
      if (event.code === "KeyW") {
        if (
          this.canSprint &&
          !this._keys.has("KeyS") &&
          !this._keys.has("ShiftLeft") &&
          !this._keys.has("ShiftRight")
        ) {
          if (secondTap(this._forwardTapAt)) {
            this._sprintLatched = true;
            this._forwardTapAt = null;
          } else this._forwardTapAt = at;
        }
      }
      if (["KeyS", "ShiftLeft", "ShiftRight"].includes(event.code))
        this._cancelSprint();
    };
    this._onKeyUp = (event) => {
      this._keys.delete(event.code);
      if (event.code === "KeyW") {
        this._sprintLatched = false;
        this.sprinting = false;
      }
    };
    this._onMouseMove = (event) => {
      if (this.inputMode === "remote") {
        if (this.enabled && !this.locked && event.buttons & 2) {
          const delta = this._remoteLook.move(event);
          this._applyLook(delta.x, delta.y);
        } else this._remoteLook.reset();
        this._syncInputCursor();
        return;
      }
      if (!this.enabled || !this.locked) return;
      this._applyLook(event.movementX, event.movementY);
    };
    this._onBlur = () => {
      this._captureRevision++;
      this._resetInput();
    };
    this._onPointerCancel = () => this._resetInput();
    this._onResize = () => this._resetInput();
    this._onFocusIn = (event) => {
      if (isEditing(event)) {
        this._captureRevision++;
        this._resetInput();
      }
    };
    this._onPointerLockChange = () => {
      // A native request already in flight must not capture Remote mode.
      if (this.locked && this.inputMode === "remote")
        this._document.exitPointerLock?.();
      if (!this.locked) this._resetInput();
    };
    this._document.addEventListener("keydown", this._onKeyDown);
    this._document.addEventListener("keyup", this._onKeyUp);
    this._document.addEventListener("mousemove", this._onMouseMove);
    this._document.addEventListener(
      "pointerlockchange",
      this._onPointerLockChange
    );
    this._document.addEventListener("pointercancel", this._onPointerCancel);
    this._document.addEventListener("focusin", this._onFocusIn);
    this._window.addEventListener("blur", this._onBlur);
    this._window.addEventListener("resize", this._onResize);
    this._syncInputCursor();
    this._syncCamera(0);
  }

  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    this._enabled = Boolean(value);
    if (!this._enabled) {
      this._captureRevision++;
      this._resetInput();
    }
  }

  get locked() {
    return this._document.pointerLockElement === this.element;
  }

  get flying() {
    return this._flying;
  }
  set flying(value) {
    const next = Boolean(value) && this.allowFlight && !this.seated;
    if (next === this._flying) return;
    this._poseRevision++;
    this._flying = next;
    this.velocity.y = 0;
    this.grounded = false;
    this.fallDistance = 0;
    this._jumpQueued = false;
    this._spaceTapAt = null;
    this._cancelSprint();
    this.onFlightChange?.(next);
  }

  get allowFlight() {
    return this._allowFlight;
  }
  set allowFlight(value) {
    const next = Boolean(value);
    if (next === this._allowFlight) return;
    this._allowFlight = next;
    this._resetInput();
    if (!next) this.flying = false;
  }

  // The game sets this before update(): Creative, or Survival hunger > 6.
  get canSprint() {
    return this._canSprint;
  }
  set canSprint(value) {
    this._canSprint = Boolean(value);
    if (!this._canSprint) this._cancelSprint();
  }

  get height() {
    return this.sneaking && !this.seated ? SNEAK_HEIGHT : PLAYER_HEIGHT;
  }

  get poseRevision() {
    return this._poseRevision;
  }

  get vehicleType() { return this.seated ? this._vehicleType : null; }
  get hullHeading() { return this.seated ? this._hullHeading : null; }

  /** Cached physical observations only; presentation must never resample water. */
  get swimming() {
    const fluid = this.fluidState;
    return !this.seated && !this.flying && !this.climbing && !this.grounded &&
      this._fluidWorld === this.world && !this.fluidMovementBlocked &&
      fluid.valid && fluid.loaded && fluid.eyeLoaded &&
      fluid.waterImmersion > 0 &&
      (fluid.waterImmersion >= PLAYER_FLUID_PHYSICS.swimImmersion ||
        fluid.bubble !== null || this._keys.has("Space"));
  }

  get eyeHeight() {
    return this.sneaking && !this.seated ? SNEAK_EYE_HEIGHT : EYE_HEIGHT;
  }

  get perspective() {
    return this._perspective;
  }
  set perspective(value) {
    if (!PERSPECTIVES.includes(value) || value === this._perspective) return;
    this._perspective = value;
    this._syncCamera(0);
  }

  cyclePerspective() {
    this.perspective =
      PERSPECTIVES[(PERSPECTIVES.indexOf(this.perspective) + 1) % 3];
    return this.perspective;
  }

  get inputReady() {
    return this.inputMode === "remote" || this.locked;
  }

  /** Borrowed keys for vehicle.frame(dt, { keys }); consumers must not mutate. */
  get vehicleKeys() {
    return this.enabled && this.inputReady ? this._keys : null;
  }

  get inputMode() {
    return this._controlPreferences.inputMode;
  }
  set inputMode(value) {
    this.setControlPreferences({ inputMode: value });
  }

  get mouseSensitivity() {
    return this._controlPreferences.mouseSensitivity;
  }
  set mouseSensitivity(value) {
    this.setControlPreferences({ mouseSensitivity: value });
  }

  setControlPreferences(preferences) {
    const next = normalizeControlPreferences({
      ...this._controlPreferences,
      ...preferences,
    });
    const modeChanged = next.inputMode !== this.inputMode;
    if (!modeChanged && next.mouseSensitivity === this.mouseSensitivity) return;
    this._controlPreferences = next;
    if (modeChanged) this.unlock();
    else this._resetInput();
    this._syncInputCursor();
  }

  _syncInputCursor() {
    if (!this.element.dataset) return;
    if (this.element.dataset.inputMode !== this.inputMode) {
      this.element.dataset.inputMode = this.inputMode;
      this.element.title =
        this.inputMode === "remote"
          ? "RIGHT-DRAG to look; short RIGHT-CLICK to place/use. Release and reposition at window edges."
          : "Move the captured mouse to look. Esc releases it.";
    }
    const looking = String(this._remoteLook.dragging);
    if (this.element.dataset.looking !== looking)
      this.element.dataset.looking = looking;
  }

  _applyLook(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this._poseRevision++;
    const sensitivity = 0.002 * this.mouseSensitivity;
    this.yaw -= x * sensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - y * sensitivity,
      -MAX_LOOK_PITCH,
      MAX_LOOK_PITCH
    );
  }

  beginRemoteLook(event) {
    if (!this.enabled || this.inputMode !== "remote" || this.locked) return;
    this._remoteLook.begin(event);
    this._syncInputCursor();
  }

  endRemoteLook(event) {
    if (!this.enabled || this.inputMode !== "remote" || this.locked)
      return false;
    const result = this._remoteLook.end(event);
    this._applyLook(result.x, result.y);
    this._syncInputCursor();
    return result.tap;
  }

  get forward() {
    return new THREE.Vector3(
      -Math.sin(this.yaw) * Math.cos(this.pitch),
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * Math.cos(this.pitch)
    );
  }

  setPosition({ x, y, z }) {
    this._poseRevision++;
    this.position.set(x, y, z);
    if (this.vehicleType === "horse") this._keys.clear();
    this.seated = false;
    this._vehicleType = this._vehicleId = this._hullHeading = null;
    this._boatViewContext = null;
    this._resetMovement();
    this._updateStance();
    this._syncCamera(0);
    this.sampleFluids();
    this._notifyWaterAudio(true);
  }

  async lock() {
    // Ready to play is separate from actual browser capture. Remote never asks
    // for pointer lock; its finite cursor needs releasing/repositioning at edges.
    if (this.inputMode === "remote") return true;
    if (this.locked) return true;
    if (typeof this.element.requestPointerLock !== "function") return false;
    // Unadjusted input asks the browser to bypass mouse acceleration. It does
    // not identify absolute/VNC input or make its intended motion recoverable.
    const revision = this._captureRevision;
    const raw = await this._requestPointerLock(true);
    if (revision !== this._captureRevision || this.inputMode !== "native")
      return false;
    if (raw.success) return true;
    if (
      raw.errorName !== "NotSupportedError" &&
      raw.errorName !== "TypeError" &&
      raw.errorName !== "LegacyPointerLockError"
    )
      return false;
    // Unsupported options (or an untyped legacy error) get one ordinary
    // capture attempt. Typed permission/cancellation errors are not retried.
    return (await this._requestPointerLock(false)).success;
  }

  _requestPointerLock(unadjustedMovement) {
    const revision = this._captureRevision;
    return new Promise((resolve) => {
      let timer;
      let settled = false;
      let promiseBacked;
      let legacyError = false;
      const finish = (success, errorName) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._document.removeEventListener("pointerlockchange", changed);
        this._document.removeEventListener("pointerlockerror", failed);
        if (revision !== this._captureRevision || this.inputMode !== "native") {
          if (this.locked) this._document.exitPointerLock?.();
          success = false;
          errorName = "AbortError";
        }
        resolve({ success, errorName });
      };
      const changed = () => {
        if (promiseBacked === false && this.locked) finish(true);
      };
      const failed = () => {
        legacyError = true;
        // Promise APIs report the reason in the rejection. Their generic
        // error event may arrive first, or belong to the preceding attempt.
        if (promiseBacked === false) finish(false, "LegacyPointerLockError");
      };
      this._document.addEventListener("pointerlockchange", changed);
      this._document.addEventListener("pointerlockerror", failed);
      timer = setTimeout(
        () => finish(this.locked, this.locked ? undefined : "TimeoutError"),
        1500
      );
      try {
        const result = unadjustedMovement
          ? this.element.requestPointerLock({ unadjustedMovement: true })
          : this.element.requestPointerLock();
        promiseBacked = typeof result?.then === "function";
        if (promiseBacked)
          result.then(
            () => finish(this.locked),
            (error) => finish(false, error?.name ?? "UnknownError")
          );
        else if (this.locked) finish(true);
        else if (legacyError) finish(false, "LegacyPointerLockError");
      } catch (error) {
        finish(false, error?.name ?? "UnknownError");
      }
    });
  }

  unlock() {
    this._captureRevision++;
    this._resetInput();
    if (this.locked) this._document.exitPointerLock?.();
  }

  intersectsBlock(x, y, z, cell) {
    if (cell)
      return intersectsCell(
        this.position,
        x,
        y,
        z,
        cell,
        (dx, dy, dz) => readGeometryCell(this.world, x + dx, y + dy, z + dz),
        { radius: HALF_WIDTH, height: this.height }
      );
    return intersectsBlock(this.position, x, y, z, this.height);
  }

  intersectsPlacement(changes) {
    return intersectsPlacement(this.world, this.position, changes, {
      radius: HALF_WIDTH,
      height: this.height,
    });
  }

  _cancelSprint() {
    this._sprintLatched = false;
    this._forwardTapAt = null;
    this.sprinting = false;
  }

  _resetMovement() {
    this.velocity.set(0, 0, 0);
    this.grounded = this.moving = this.climbing = false;
    this.fallDistance = 0;
    this._jumpQueued = false;
    this._spaceTapAt = null;
    this._cancelSprint();
    this._stepDistance = this._bobPhase = this._bob = 0;
  }

  _updateStance() {
    if (this.seated) {
      this.sneaking = false;
      return;
    }
    const requested =
      !this.flying &&
      (this._keys.has("ShiftLeft") || this._keys.has("ShiftRight"));
    // Releasing Shift never expands the collider into a low ceiling. Forced
    // crouch persists until standing is safe, including a flight transition.
    this.sneaking =
      requested ||
      (this.sneaking && collidesWithWorld(this.world, this.position));
  }

  _resetInput() {
    this._remoteLook.reset();
    this._syncInputCursor();
    this._keys.clear();
    this._jumpQueued = false;
    this._spaceTapAt = null;
    this._cancelSprint();
    this._updateStance();
    this.moving = false;
    if (!this.seated) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      if (this.flying) this.velocity.y = 0;
    }
    this.onInputReset?.();
  }

  /** Physical feet/stance/eye only; camera bob and F5 never alter breathing. */
  sampleFluids() {
    if (this._fluidWorld !== this.world) {
      this._fluidWorld = this.world;
      this._fluidQuery = createFluidQueryView(this.world);
    }
    this._fluidOptions.height = this.height;
    this._fluidOptions.eyeHeight = this.eyeHeight;
    const sample = sampleFluid(
      this._fluidQuery,
      this.position,
      this._fluidOptions,
      this.fluidState
    );
    this._fluidQueries++;
    this._fluidCells += sample.sampledCells;
    this.fluidMovementBlocked =
      !sample.valid || !sample.loaded || !sample.eyeLoaded;
    return sample;
  }

  _notifyWaterAudio(reset = false) {
    const observer = this.onWaterSample;
    const changedWorld = this._audioWorld !== this.world;
    this._audioWorld = this.world;
    if (!observer) return;
    try {
      observer(this.fluidState, {
        reset: reset || changedWorld,
        flying: this.flying,
        seated: this.seated,
        jumping: this._keys.has("Space") && this.velocity.y > 0,
      });
    } catch {
      // Disable a failed optional observer once, not on every physics substep.
      if (this.onWaterSample === observer) this.onWaterSample = null;
    }
  }

  /**
   * Refresh once after fluid/player updates (also while an inventory is open).
   * Gameplay remains the ONLY owner of air and hazard clocks. Required options:
   * airKnown=false freezes breathing/drowning, restoreAir=true restores full air
   * and clears drowning; otherwise its ordinary underwater branch runs once.
   * Parent replaces its hardcoded -10 void check with inVoid/voidY.
   */
  gameplayEnvironment(out = {}) {
    const sample = this.sampleFluids();
    out.moving = this.moving;
    out.sprinting = this.sprinting;
    out.inWater = sample.valid && sample.waterImmersion > 0;
    out.underwater = sample.valid && isWaterFluid(sample.eyeFluid);
    out.inLava =
      sample.valid &&
      (sample.lavaImmersion > 0 || sample.eyeFluid === FLUID.LAVA_SOURCE);
    out.airKnown = !this.fluidMovementBlocked;
    out.restoreAir = out.airKnown && sample.restoresAir;
    out.canBreathe = out.airKnown && sample.canBreathe;
    out.voidY = geometryWorldSpec(this.world).voidY;
    out.inVoid =
      Number.isFinite(this.position.y) && this.position.y < out.voidY;
    return out;
  }

  fluidDiagnostics() {
    return {
      queries: this._fluidQueries,
      cells: this._fluidCells,
      movementBlocked: this.fluidMovementBlocked,
      limits: PLAYER_FLUID_PHYSICS,
    };
  }

  _updateKeyboardLook(dt) {
    if (!this.enabled) return;
    const pressed = (code) => Number(this._keys.has(code));
    this.yaw += (pressed("ArrowLeft") - pressed("ArrowRight")) * dt * 1.6;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + (pressed("ArrowUp") - pressed("ArrowDown")) * dt * 1.3,
      -MAX_LOOK_PITCH,
      MAX_LOOK_PITCH
    );
  }

  // Survival hosts pass recoverFromVoid:false so their single damage/respawn
  // owner sees the actual pose. The default keeps standalone Creative recovery.
  // A committed riderPose or exitPose has finite position/velocity and explicit
  // grounded; riderPose also has seated:true. Consume exactly one even at dt=0
  // or under an overlay, with no extra physics step. Both together are invalid.
  // Return true on consumption, false on invalid input, otherwise undefined.
  // No pose means no implicit dismount: only an exit or setPosition releases it.
  // Swim assistance is a per-update input, never retained on the Player.
  update(
    dt,
    {
      recoverFromVoid = true,
      riderPose = null,
      exitPose = null,
      swimSpeedMultiplier = 1,
    } = {}
  ) {
    this._fluidQueries = this._fluidCells = 0;
    if (typeof recoverFromVoid !== "boolean" || !Number.isFinite(dt) || dt < 0)
      return false;
    const hasPose = riderPose !== null || exitPose !== null;
    if (hasPose) {
      const seated = riderPose !== null;
      const pose = seated ? riderPose : exitPose;
      if (
        (riderPose !== null && exitPose !== null) ||
        !validVehiclePose(this.world, pose, seated)
      )
        return false;
      const wasHorse = this.vehicleType === "horse";
      const sameHorse = wasHorse && seated && pose.vehicleType === "horse" &&
        pose.id === this._vehicleId;
      const boatContext = seated && pose.vehicleType === "boat"
        ? {
            world: this.world,
            epoch: this.world.epoch ?? this.world._epoch,
            dimension: this.world.dimension ?? "overworld",
          }
        : null;
      // Transport free look only between accepted poses of the same boat.
      // First mount/reload or missing identity/heading seeds without a snap.
      if (
        boatContext &&
        this.vehicleType === "boat" &&
        pose.id != null && pose.id === this._vehicleId &&
        Number.isFinite(pose.hullYaw) && Number.isFinite(this._hullHeading) &&
        this._boatViewContext?.world === boatContext.world &&
        this._boatViewContext.epoch === boatContext.epoch &&
        this._boatViewContext.dimension === boatContext.dimension
      ) {
        const turn = pose.hullYaw - this._hullHeading;
        this.yaw += Math.atan2(Math.sin(turn), Math.cos(turn));
      }
      this._boatViewContext = boatContext;
      this.seated = seated;
      this._vehicleType = seated ? pose.vehicleType ?? null : null;
      this._vehicleId = seated ? pose.id ?? null : null;
      this._hullHeading = seated ? pose.hullYaw ?? null : null;
      this.flying = false;
      this.sneaking = false;
      this._resetMovement();
      for (const code of UNSEATED_KEYS)
        if (code !== "Space" || !sameHorse) this._keys.delete(code);
      if (wasHorse && !sameHorse)
        for (const code of ["KeyW", "KeyA", "KeyS", "KeyD", "ShiftLeft", "ShiftRight"])
          this._keys.delete(code);
      this.position.copy(pose.position);
      this.velocity.copy(pose.velocity);
      this.grounded = pose.grounded;
    } else if (dt === 0) return;
    this._poseRevision++;
    dt = Math.min(dt, 0.1);
    if (hasPose || this.seated) {
      this._updateKeyboardLook(dt);
      this.sampleFluids();
      this._notifyWaterAudio(true);
      this._syncCamera(dt);
      return hasPose ? true : undefined;
    }
    if (!this.enabled) {
      this._syncCamera(dt);
      return;
    }
    const swimMultiplier =
      Number.isFinite(swimSpeedMultiplier) &&
      swimSpeedMultiplier >= 1 &&
      swimSpeedMultiplier <= PLAYER_FLUID_PHYSICS.maxSwimSpeedMultiplier
        ? swimSpeedMultiplier
        : 1;
    const keys = this._keys;
    const pressed = (code) => Number(keys.has(code));
    this._updateStance();
    this._updateKeyboardLook(dt);
    let strafe = pressed("KeyD") - pressed("KeyA");
    let ahead = pressed("KeyW") - pressed("KeyS");
    const magnitude = Math.hypot(strafe, ahead);
    if (magnitude > 1) {
      strafe /= magnitude;
      ahead /= magnitude;
    }
    this.sprinting =
      this.canSprint &&
      (this.flying
        ? magnitude > 0 ||
          keys.has("Space") ||
          keys.has("ShiftLeft") ||
          keys.has("ShiftRight")
        : ahead > 0 && !this.sneaking) &&
      (keys.has("ControlLeft") ||
        keys.has("ControlRight") ||
        this._sprintLatched);
    if (!this.flying && ahead <= 0) {
      this._sprintLatched = false;
      this.sprinting = false;
    }
    if (this.sneaking && !this.flying) this._cancelSprint();
    const speed = this.flying
      ? this.sprinting
        ? 13
        : 8
      : WALK_SPEED * (this.sneaking ? 0.3 : this.sprinting ? 1.3 : 1);
    const targetX =
      (Math.cos(this.yaw) * strafe - Math.sin(this.yaw) * ahead) * speed;
    const targetZ =
      (-Math.sin(this.yaw) * strafe - Math.cos(this.yaw) * ahead) * speed;
    const startX = this.position.x;
    const startZ = this.position.z;
    const steps = Math.ceil(dt / (1 / 120));
    const stepDt = dt / steps;
    let landedFlying = false;
    let fluid = this.sampleFluids();
    this._notifyWaterAudio();
    for (let i = 0; i < steps; i++) {
      if (this.fluidMovementBlocked) {
        this.velocity.set(0, 0, 0);
        this.grounded = this.climbing = false;
        this._jumpQueued = false;
        break;
      }
      const previousY = this.position.y;
      const inWater = fluid.waterImmersion > 0;
      const waterWeight = Math.min(1, fluid.waterImmersion * 2);
      // Held ascent lasts until the body leaves water, not just until it
      // crosses the passive buoyancy threshold. Shallow grounded jumps stay
      // on the ordinary jump path; all movement still uses the same sweeps.
      const swimming =
        inWater &&
        (fluid.waterImmersion >= PLAYER_FLUID_PHYSICS.swimImmersion ||
          fluid.bubble !== null ||
          (keys.has("Space") && !this.grounded));
      const ladder =
        !this.flying &&
        climbContact(this.world, this.position, HALF_WIDTH, this.height);
      this.climbing = !!ladder;
      const horizontalBlend = 1 - Math.exp(-18 * stepDt);
      const waterSlow = !this.flying ? 1 - waterWeight * 0.5 : 1;
      // Recheck physical swimming each substep, including water exits. Only
      // the horizontal input target changes, never buoyancy/current forces.
      const swimBoost = swimming && !this.flying && !ladder ? swimMultiplier : 1;
      this.velocity.x +=
        (targetX * waterSlow * swimBoost - this.velocity.x) * horizontalBlend;
      this.velocity.z +=
        (targetZ * waterSlow * swimBoost - this.velocity.z) * horizontalBlend;
      if (this.flying) {
        this.fallDistance = 0;
        const down = keys.has("ShiftLeft") || keys.has("ShiftRight");
        const verticalTarget = (pressed("Space") - Number(down)) * speed * 0.7;
        // A reversal should brake immediately, not drift in the old direction.
        if (verticalTarget * this.velocity.y < 0) this.velocity.y = 0;
        this.velocity.y +=
          (verticalTarget - this.velocity.y) * (1 - Math.exp(-12 * stepDt));
      } else if (ladder) {
        this.fallDistance = 0;
        const attachment = ladder.shape.attachment.offset;
        const towardsWall =
          targetX * attachment[0] + targetZ * attachment[2] > 0.01;
        const holding = keys.has("ShiftLeft") || keys.has("ShiftRight");
        this.velocity.y = holding
          ? 0
          : keys.has("Space") || towardsWall
            ? 2.8
            : Math.max(-2.4, this.velocity.y - 23 * stepDt);
        this.velocity.x = THREE.MathUtils.clamp(this.velocity.x, -2.4, 2.4);
        this.velocity.z = THREE.MathUtils.clamp(this.velocity.z, -2.4, 2.4);
      } else if (swimming) {
        this.fallDistance = 0;
        // Buoyancy counteracts gravity without ejecting swimmers from the surface.
        const verticalTarget = keys.has("Space")
          ? 3.4
          : keys.has("ShiftLeft") || keys.has("ShiftRight")
            ? -2.5
            : 0.65;
        this.velocity.y +=
          (verticalTarget - this.velocity.y) * (1 - Math.exp(-5 * stepDt));
      } else {
        if ((this._jumpQueued || keys.has("Space")) && this.grounded) {
          this.velocity.y = 8;
          this.onJump?.();
        }
        this.velocity.y = Math.max(-32, this.velocity.y - 23 * stepDt);
      }
      if (!this.flying && inWater) {
        this.fallDistance = 0;
        if (fluid.bubble) {
          this.velocity.y =
            fluid.bubble === "up"
              ? Math.min(
                  PLAYER_FLUID_PHYSICS.bubbleUpSpeed,
                  this.velocity.y +
                    PLAYER_FLUID_PHYSICS.bubbleUpAcceleration * stepDt
                )
              : Math.max(
                  -PLAYER_FLUID_PHYSICS.bubbleDownSpeed,
                  this.velocity.y -
                    PLAYER_FLUID_PHYSICS.bubbleDownAcceleration * stepDt
                );
        } else {
          const force =
            PLAYER_FLUID_PHYSICS.currentAcceleration * waterWeight * stepDt;
          this.velocity.x += fluid.current.x * force;
          this.velocity.y += fluid.current.y * force;
          this.velocity.z += fluid.current.z * force;
        }
      }
      this._jumpQueued = false;
      const movement = moveWithCollisions(
        this.world,
        this.position,
        {
          x: this.velocity.x * stepDt,
          y: this.velocity.y * stepDt,
          z: this.velocity.z * stepDt,
        },
        {
          height: this.height,
          sneaking: this.sneaking && this.grounded && !inWater,
          stepHeight: this.flying || swimming || ladder ? 0 : 0.6,
        }
      );
      this.position.set(
        movement.position.x,
        movement.position.y,
        movement.position.z
      );
      landedFlying = this.flying && movement.grounded;
      this.grounded = !this.flying && movement.grounded;
      // Reuse this post-move sample for the next substep. Even a fast landing
      // in shallow flowing water must cancel fall damage before onFall fires.
      fluid = this.sampleFluids();
      this._notifyWaterAudio();
      if (fluid.waterImmersion > 0) this.fallDistance = 0;
      if (
        !this.flying &&
        !inWater &&
        !ladder &&
        fluid.waterImmersion === 0 &&
        !this.fluidMovementBlocked
      ) {
        this.fallDistance += Math.max(0, previousY - this.position.y);
        if (this.grounded) {
          if (this.fallDistance > 3) this.onFall?.(this.fallDistance);
          this.fallDistance = 0;
        }
      }
      for (const axis of ["x", "y", "z"]) {
        if (movement.blocked[axis]) this.velocity[axis] = 0;
      }
      if (!this.flying && (movement.blocked.x || movement.blocked.z))
        this._cancelSprint();
    }
    if (landedFlying) {
      this.flying = false;
      this.grounded = true;
      this._updateStance();
      this.sampleFluids();
    }
    const distance = Math.hypot(
      this.position.x - startX,
      this.position.z - startZ
    );
    this.moving = distance > 0.0005;
    if (this.moving && this.grounded) {
      this._stepDistance += distance;
      this._bobPhase += distance * 9;
      if (this._stepDistance >= 1.7) {
        this._stepDistance %= 1.7;
        const floor = this.world.get(
          Math.floor(this.position.x),
          Math.floor(this.position.y - 0.05),
          Math.floor(this.position.z)
        );
        const observer = this.onStep;
        try {
          observer?.(floor);
        } catch {
          if (this.onStep === observer) this.onStep = null;
        }
      }
    } else {
      this._stepDistance = 0;
    }
    if (
      recoverFromVoid &&
      this.position.y < geometryWorldSpec(this.world).voidY
    )
      this.setPosition(this.world.getSpawn());
    this._syncCamera(dt);
  }

  _syncCamera(dt) {
    const bobTarget =
      this.enabled && this.moving && this.grounded
        ? Math.sin(this._bobPhase) * 0.025
        : 0;
    this._bob += (bobTarget - this._bob) * (1 - Math.exp(-12 * dt));
    this.eyePosition.copy(this.position);
    this.eyePosition.y += this.eyeHeight;
    this.camera.position.copy(this.eyePosition);
    if (this.perspective === "first") {
      this.camera.position.y += this._bob;
      this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
    } else {
      const front = this.perspective === "front";
      const direction = this.forward.multiplyScalar(front ? 1 : -1);
      const nearHeight =
        Math.tan(THREE.MathUtils.degToRad(this._baseFov + 5) / 2) *
        this.camera.near;
      const clearance = Math.max(
        0.15,
        Math.hypot(
          nearHeight,
          nearHeight * this.camera.aspect,
          this.camera.near
        ) + 0.02
      );
      this.camera.position.addScaledVector(
        direction,
        sweepCameraDistance(
          this.world,
          this.eyePosition,
          direction,
          4,
          clearance
        )
      );
      this.camera.rotation.set(
        front ? -this.pitch : this.pitch,
        front ? this.yaw + Math.PI : this.yaw,
        0,
        "YXZ"
      );
    }
    const targetFov = this._baseFov + (this.enabled && this.sprinting ? 5 : 0);
    const nextFov =
      this.camera.fov + (targetFov - this.camera.fov) * (1 - Math.exp(-8 * dt));
    if (Math.abs(nextFov - this.camera.fov) > 0.0001) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }
    this.camera.updateMatrixWorld();
  }

  dispose() {
    this.onStep = this.onWaterSample = null;
    this.enabled = false;
    this.unlock();
    this._document.removeEventListener("keydown", this._onKeyDown);
    this._document.removeEventListener("keyup", this._onKeyUp);
    this._document.removeEventListener("mousemove", this._onMouseMove);
    this._document.removeEventListener(
      "pointerlockchange",
      this._onPointerLockChange
    );
    this._document.removeEventListener("pointercancel", this._onPointerCancel);
    this._document.removeEventListener("focusin", this._onFocusIn);
    this._window.removeEventListener("blur", this._onBlur);
    this._window.removeEventListener("resize", this._onResize);
  }
}
