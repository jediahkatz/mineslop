import { bodyBox, boxCollides, sweepBoxAxis } from "../../src/collision.js";
import { readGeometryCell } from "../../src/geometry-world.js";
import { PLAYER_HEIGHT, PLAYER_WIDTH } from "../../src/player.js";
import { CHUNK_SIZE, WORLD_HEIGHT } from "../../src/terrain.js";

export const SPATIAL32 = Object.freeze({
  mode: "spatial-32-v1", label: "generated-terrain-spatial-32-v1",
  seed: "cedar-valley", generatorVersion: 3, startX: 277.5, startZ: 446.5,
  length: 32, yaw: 0, pitch: -0.42, positionTolerance: 0.02,
  angleTolerance: 0.01, setupBand: 0.5, relayBand: 0.2, altitudeBand: 0.55,
  setupLeadSeconds: 0.2,
  stationarySpeed: 0.025, quietFrames: 4, clearance: 1,
  lateral: 0.4, speedLimit: 8.01, overshoot: 0.81, brakeTail: 3.5,
  setupMs: 60000, measuredMs: 45000, cleanupMs: 10000,
  maxFrames: 4096, maxControlTicks: 512, maxRecords: 128,
  preflightCells: 200000, frameCells: 2048,
});
const S = SPATIAL32;
const copy = ({ x, y, z }) => ({ x, y, z });
const finiteVector = (v) => v && [v.x, v.y, v.z].every(Number.isFinite);
const angleError = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

export function sourceReader(world, limit) {
  let reads = 0;
  return {
    dimension: world.dimension, minY: world.minY, maxY: world.maxY,
    get reads() { return reads; },
    isLoaded(x, z) {
      if (!world.isLoaded(x, z)) throw new Error(`unloaded column ${x},${z}`);
      return true;
    },
    getCell(x, y, z) {
      if (reads >= limit) throw new Error("cell-read cap");
      reads++;
      const cell = readGeometryCell(world, x, y, z);
      if (!cell || !Number.isInteger(cell.id) || cell.id < 0 ||
          !Number.isInteger(cell.state) || !Number.isInteger(cell.fluid))
        throw new Error(`unknown cell ${x},${y},${z}`);
      return cell;
    },
  };
}

/** Loaded cells only: no terrain admission, source mutation, or renderer calls. */
export function planSpatial32(world, position) {
  if (world.seed !== S.seed || world.generatorVersion !== S.generatorVersion ||
      world.dimension !== "overworld" || world.minY !== 0 || world.maxY !== WORLD_HEIGHT)
    throw new Error("spatial-32-v1 requires cedar-valley / overworld / generator 3");
  if (!finiteVector(position) || Math.abs(position.x - S.startX) > S.positionTolerance ||
      Math.abs(position.z - S.startZ) > S.positionTolerance ||
      position.y < world.minY || position.y > world.maxY + 4)
    throw new Error("spatial-32-v1 requires the fixed native spawn start");
  // Includes the entire straight route, braking tail, and the existing 25×25
  // menu scan after braking. This conservative apron is part of this version.
  const bounds = { minX: 260, maxX: 295, minZ: 398, maxZ: 448 };
  const chunks = [];
  for (let cx = Math.floor(bounds.minX / CHUNK_SIZE); cx <= Math.floor((bounds.maxX - 1) / CHUNK_SIZE); cx++)
    for (let cz = Math.floor(bounds.minZ / CHUNK_SIZE); cz <= Math.floor((bounds.maxZ - 1) / CHUNK_SIZE); cz++) {
      if (!world.isLoaded(cx * CHUNK_SIZE, cz * CHUNK_SIZE))
        throw new Error(`unloaded corridor chunk ${cx},${cz}`);
      chunks.push([cx, cz]);
    }
  const source = sourceReader(world, S.preflightCells), profile = [];
  let highestOccupiedY = world.minY - 1;
  for (let z = bounds.minZ; z < bounds.maxZ; z++)
    for (let x = bounds.minX; x < bounds.maxX; x++) {
      let top = world.minY - 1, topCell = { id: 0, state: 0, fluid: 0 };
      for (let y = world.maxY - 1; y >= world.minY; y--) {
        const cell = source.getCell(x, y, z);
        if (cell.id || cell.fluid) { top = y; topCell = cell; break; }
      }
      highestOccupiedY = Math.max(highestOccupiedY, top);
      profile.push([x, z, top, topCell.id, topCell.state, topCell.fluid]);
    }
  const targetFeet = highestOccupiedY + 3;
  const ascent = sweepBoxAxis(source, bodyBox(position), "y", targetFeet - position.y);
  if (boxCollides(source, bodyBox(position)) || ascent.blocked)
    throw new Error("fixed native takeoff column is obstructed; no detour or reset");
  return { bounds, chunks, highestOccupiedY, targetFeet, profile, cellReads: source.reads };
}

/** Unmeasured setup only. Approximate stopping drift; convergence is observed. */
export function setupKeys(state, targetFeet) {
  const predicted = state.position.y + state.velocity.y / 12;
  if (![predicted, targetFeet].every(Number.isFinite)) throw new Error("setup requires finite altitude");
  // Lead release by up to two clamped (0.1s) Player updates. After release,
  // observe actual damping to rest before any new hold; never chase the target
  // by reversing a still-moving player based on a delayed RPC observation.
  const lead = predicted + state.velocity.y * S.setupLeadSeconds;
  if (state.keys?.includes("Space")) return lead < targetFeet - S.relayBand ? ["Space"] : [];
  if (state.keys?.includes("ShiftLeft")) return lead > targetFeet + S.relayBand ? ["ShiftLeft"] : [];
  if (Math.abs(state.velocity.y) >= S.stationarySpeed) return [];
  return Math.abs(predicted - targetFeet) <= S.setupBand ? []
    : predicted < targetFeet ? ["Space"] : ["ShiftLeft"];
}

/**
 * Test-page instance observer. It never changes Player, inputs, clocks, terrain,
 * or rendering. Before/after every real frame latch faults missed by RPC polls.
 */
export class Spatial32Guard {
  constructor(game, { hidden, clock = () => performance.now(), onStart, onStop } = {}) {
    Object.assign(this, { game, hidden, clock, onStart, onStop });
    this.phase = "idle";
    this.frame = this.quiet = this.framesMeasured = this.cpuMs = this.maxCellReads = 0;
    this.sourceWaits = this.droppedRecords = 0;
    this.records = [];
    this.failure = this.endpoint = this.last = this.start = this.plan = null;
    this.firstSourceUnknown = null;
    this.started = this.stopped = this.seenFlight = this.wSeen = false;
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    const guard = this, original = this.game.frame;
    this.game.frame = function (...args) {
      guard.inFrame = true;
      guard.frame++;
      guard.frameSource = sourceReader(guard.game.world, S.frameCells);
      guard.inspect(false);
      try {
        return original.apply(this, args);
      } catch (error) {
        guard.fail("frame-exception", error.message);
        throw error;
      } finally {
        guard.inspect(true);
        guard.inFrame = false;
        guard.flushStop();
      }
    };
  }

  prepare() {
    if (!["idle", "source-wait"].includes(this.phase)) throw new Error("route preparation cannot reset an attempt");
    this.setupAt ??= this.clock();
    if (this.clock() - this.setupAt >= S.setupMs) {
      this.fail("timeout", "source readiness deadline");
      return this.status();
    }
    try {
      this.last = this.snapshot();
      this.plan = planSpatial32(this.game.world, this.game.player.position);
      this.world = this.game.world;
      this.player = this.game.player;
      this.phase = "setup";
    } catch (error) {
      if (error.message.startsWith("unloaded")) {
        this.phase = "source-wait";
        this.sourceWaits++;
        this.firstSourceUnknown ??= { frame: this.frame, message: error.message };
      } else this.fail("preflight", error.message);
    }
    return this.status();
  }

  snapshot() {
    const { player: p, gameplay, graphics } = this.game;
    return {
      frame: this.frame, position: copy(p.position), velocity: copy(p.velocity),
      yaw: p.yaw, pitch: p.pitch, cameraYaw: graphics.camera.rotation.y,
      cameraPitch: graphics.camera.rotation.x, flying: p.flying, grounded: p.grounded,
      enabled: p.enabled, locked: p.locked, allowFlight: p.allowFlight,
      active: this.game.active, paused: this.game.paused, overlayOpen: this.game.overlayOpen,
      hidden: this.hidden(), dead: gameplay.dead, mode: gameplay.mode,
      keys: [...p._keys], height: p.height, perspective: p.perspective,
      progress: this.start ? this.start.position.z - p.position.z : 0,
      clearance: "unknown",
    };
  }

  baseFailure(state) {
    for (const key of ["flying", "grounded", "enabled", "locked", "allowFlight",
      "active", "paused", "overlayOpen", "hidden", "dead"])
      if (typeof state[key] !== "boolean") throw new Error(`unknown control flag: ${key}`);
    if (!finiteVector(state.position) || !finiteVector(state.velocity) ||
        ![state.yaw, state.pitch, state.cameraYaw, state.cameraPitch, state.height].every(Number.isFinite))
      return "non-finite pose";
    if (this.game.world !== this.world || this.game.player !== this.player) return "world/player replaced";
    if (!state.active || !state.enabled || !state.locked || state.paused ||
        state.overlayOpen || state.hidden || state.dead || this.game.failed ||
        !state.allowFlight || state.mode !== "creative" || state.perspective !== "first")
      return "active native Creative controls lost";
    if (this.seenFlight && (!state.flying || state.grounded)) return "airborne flight lost";
    if (state.flying && !state.grounded) this.seenFlight = true;
    return null;
  }

  aligned(state) {
    return [angleError(state.yaw, S.yaw), angleError(state.cameraYaw, S.yaw),
      Math.abs(state.pitch - S.pitch), Math.abs(state.cameraPitch - S.pitch)]
      .every((delta) => delta <= S.angleTolerance);
  }

  stationary(state) {
    return state.keys.length === 0 && Math.hypot(...Object.values(state.velocity)) < S.stationarySpeed;
  }

  inspect(after) {
    if (!["setup", "measured", "braking"].includes(this.phase)) return;
    const began = this.clock();
    try {
      const state = this.snapshot();
      this.last = state;
      const failure = this.baseFailure(state);
      if (failure) return this.fail("invalid", failure);
      for (const [cx, cz] of this.plan.chunks)
        this.frameSource.isLoaded(cx * CHUNK_SIZE, cz * CHUNK_SIZE);
      const setup = this.phase === "setup";
      if (setup && this.clock() - this.setupAt >= S.setupMs) return this.fail("timeout", "setup deadline");
      if (setup && (Math.abs(state.position.x - S.startX) > S.positionTolerance ||
          Math.abs(state.position.z - S.startZ) > S.positionTolerance))
        return this.fail("invalid", "setup horizontal drift");
      const altitudeError = Math.abs(state.position.y - this.plan.targetFeet);
      const clear = !boxCollides(this.frameSource, bodyBox(
        { ...state.position, y: state.position.y - S.clearance },
        PLAYER_WIDTH / 2, PLAYER_HEIGHT + 2 * S.clearance));
      state.clearance = clear ? "verified" : "blocked";
      if (setup) {
        const quiet = state.flying && !state.grounded && clear && this.aligned(state) &&
          altitudeError <= S.setupBand && this.stationary(state);
        if (!quiet) this.quiet = 0;
        else if (after) this.quiet++;
        return;
      }
      if (!state.flying || state.grounded || !clear || !this.aligned(state) ||
          state.height !== PLAYER_HEIGHT || altitudeError > S.altitudeBand ||
          Math.abs(state.velocity.y) >= S.stationarySpeed ||
          Math.abs(state.position.x - this.start.position.x) > S.lateral ||
          Math.hypot(state.velocity.x, state.velocity.z) > S.speedLimit ||
          state.progress < -S.positionTolerance)
        return this.fail("invalid", "flight/clearance/pose envelope lost");
      if (state.keys.some((key) => key !== "KeyW")) return this.fail("invalid", "unexpected measured key");
      if (this.phase === "measured") {
        if (state.keys.includes("KeyW")) this.wSeen = true;
        else if (this.wSeen) return this.fail("invalid", "forward input lost before endpoint");
        if (this.clock() - this.measuredAt >= S.measuredMs) return this.fail("timeout", "32-block deadline");
        if (after && ++this.framesMeasured >= S.maxFrames) return this.fail("cap", "measured frame cap");
        if (state.progress > S.length + S.overshoot) return this.fail("invalid", "endpoint overshoot");
        if (after && state.progress >= S.length) {
          this.endpoint = structuredClone(state);
          this.phase = "braking";
          this.brakingAt = this.clock();
          this.quiet = 0;
        }
      } else {
        if (state.progress > S.length + S.brakeTail) return this.fail("invalid", "native braking tail exceeded");
        if (this.clock() - this.brakingAt >= S.cleanupMs) return this.fail("timeout", "native key release/braking deadline");
        if (!this.stationary(state)) this.quiet = 0;
        else if (after && ++this.quiet >= S.quietFrames) this.phase = "complete";
      }
      if (after && (!this.records.length || Math.floor(state.progress) > this.records.at(-1).progress ||
          this.phase !== "measured")) {
        if (this.records.length < S.maxRecords) this.records.push(structuredClone(state));
        else this.droppedRecords++;
      }
    } catch (error) {
      this.fail("unknown", error.message);
    } finally {
      this.maxCellReads = Math.max(this.maxCellReads, this.frameSource?.reads ?? 0);
      this.cpuMs += this.clock() - began;
    }
  }

  begin() {
    if (this.beginAttempted) throw new Error("measurement may begin only once");
    this.beginAttempted = true;
    if (this.phase !== "setup" || this.quiet < S.quietFrames) {
      this.fail("invalid", "native airborne setup has not converged");
      throw new Error("native airborne setup has not converged");
    }
    this.frameSource = sourceReader(this.game.world, S.frameCells);
    this.inspect(false); // Reject changes between the last frame and this RPC.
    if (this.phase !== "setup" || this.quiet < S.quietFrames) {
      this.fail("invalid", "native airborne setup is no longer converged");
      throw new Error("native airborne setup is no longer converged");
    }
    this.start = structuredClone(this.last);
    this.started = true;
    this.phase = "measured";
    this.measuredAt = this.clock();
    this.onStart();
    return this.status();
  }

  fail(kind, message) {
    this.failure ??= { kind, message, phase: this.phase, frame: this.frame,
      state: this.last ? structuredClone(this.last) : null };
    this.phase = "failed";
    if (!this.inFrame) this.flushStop();
  }

  flushStop() {
    if (this.started && !this.stopped && ["braking", "complete", "failed"].includes(this.phase)) {
      this.stopped = true;
      this.onStop();
    }
  }

  status() {
    return { mode: S.mode, phase: this.phase, frame: this.frame,
      ready: this.phase === "setup" && this.quiet >= S.quietFrames,
      quietFrames: this.quiet, targetFeet: this.plan?.targetFeet ?? null,
      failure: this.failure, progress: this.last?.progress ?? 0 };
  }

  results() {
    return { ...this.status(), limits: { ...S }, plan: this.plan, start: this.start,
      endpoint: this.endpoint, end: this.last, framesMeasured: this.framesMeasured,
      sourceWaits: this.sourceWaits, firstSourceUnknown: this.firstSourceUnknown,
      observerCpuMs: this.cpuMs, maxCellReads: this.maxCellReads,
      records: this.records.slice(), droppedRecords: this.droppedRecords };
  }
}
