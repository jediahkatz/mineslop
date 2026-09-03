import { CHUNK_SIZE } from "../../src/terrain.js";
import { chunkMeshCounts } from "./mesh-budget.js";
import { distance, summarize, summarizeFrames } from "./statistics.js";

const MOVE_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "Space",
  "ShiftLeft",
  "ShiftRight",
]);
const LOOK_CODES = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const copyPosition = ({ x, y, z }) => ({ x, y, z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const editing = (target) =>
  target?.isContentEditable ||
  Boolean(target?.closest?.("input, textarea, select, [contenteditable=true]"));

function intent(code, yaw) {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    KeyW: { x: -sin, y: 0, z: -cos },
    KeyS: { x: sin, y: 0, z: cos },
    KeyA: { x: -cos, y: 0, z: sin },
    KeyD: { x: cos, y: 0, z: -sin },
    Space: { x: 0, y: 1, z: 0 },
    ShiftLeft: { x: 0, y: -1, z: 0 },
    ShiftRight: { x: 0, y: -1, z: 0 },
  }[code];
}

function inputCounter() {
  return {
    trusted: 0,
    untrusted: 0,
    byType: {},
    byCode: {},
    mousePixels: { x: 0, y: 0 },
    pointerLockAcquisitions: 0,
    pointerLockLosses: 0,
    pointerLockErrors: 0,
  };
}

function countInput(counter, event) {
  counter[event.isTrusted ? "trusted" : "untrusted"]++;
  counter.byType[event.type] = (counter.byType[event.type] ?? 0) + 1;
  if (event.code)
    counter.byCode[event.code] = (counter.byCode[event.code] ?? 0) + 1;
  if (event.type === "mousemove" && event.isTrusted) {
    counter.mousePixels.x += Math.abs(event.movementX);
    counter.mousePixels.y += Math.abs(event.movementY);
  }
}

/**
 * Only this dedicated test page instruments instances. Production prototypes and
 * input handlers remain intact. CPU times are inclusive synchronous wall times,
 * not GPU-completion or compositor-present timings.
 */
export class BotMetrics {
  constructor(
    game,
    { probeView, clock = () => performance.now(), eventTarget = document } = {}
  ) {
    this.game = game;
    this.clock = clock;
    this.probeView = probeView;
    this.eventTarget = eventTarget;
    this.recording = false;
    this.sessionInputs = inputCounter();
    this.sessionFrames = 0;
    this.wrapped = new WeakMap();
    this.pending = [];
    this.data = null;
    this.attach();
    this.installInputObservers();
  }

  attach() {
    const game = this.game;
    this.wrap(game, "frame", "game.frame", {
      before: (now) => this.beforeFrame(now),
      after: () => this.afterFrame(),
      always: true,
    });
    this.wrap(game.player, "update", "player.update", {
      after: () => this.playerUpdated(),
    });
    for (const method of ["rebuildDirty", "update", "render"])
      this.wrap(game.graphics, method, `graphics.${method}`);
    this.wrap(game.wildlife, "update", "wildlife.update");
    this.wrap(game.archive, "snapshot", "archive.snapshot");
  }

  wrap(object, method, name, { before, after, always = false } = {}) {
    if (!object || typeof object[method] !== "function") return;
    let methods = this.wrapped.get(object);
    if (!methods) this.wrapped.set(object, (methods = new Set()));
    if (methods.has(method)) return;
    methods.add(method);
    const original = object[method];
    const metrics = this;
    object[method] = function (...args) {
      if (always) metrics.attach();
      if (!metrics.recording) {
        if (always) metrics.sessionFrames++;
        return original.apply(this, args);
      }
      before?.(...args);
      const started = metrics.clock();
      try {
        return original.apply(this, args);
      } finally {
        (metrics.data.phases[name] ??= []).push(metrics.clock() - started);
        const observedAt = metrics.clock();
        after?.();
        if (after) metrics.data.observerMs += metrics.clock() - observedAt;
      }
    };
  }

  installInputObservers() {
    for (const type of [
      "keydown",
      "keyup",
      "mousemove",
      "mousedown",
      "mouseup",
    ]) {
      this.eventTarget.addEventListener(
        type,
        (event) => this.observeInput(event),
        { capture: true }
      );
    }
    this.eventTarget.addEventListener("pointerlockchange", () => {
      const key = this.game.player?.locked
        ? "pointerLockAcquisitions"
        : "pointerLockLosses";
      this.sessionInputs[key]++;
      if (this.recording) this.data.inputs[key]++;
    });
    this.eventTarget.addEventListener("pointerlockerror", () => {
      this.sessionInputs.pointerLockErrors++;
      if (this.recording) this.data.inputs.pointerLockErrors++;
    });
  }

  observeInput(event) {
    countInput(this.sessionInputs, event);
    if (!this.recording) return;
    countInput(this.data.inputs, event);
    const player = this.game.player;
    if (
      !event.isTrusted ||
      !this.game.active ||
      !player?.enabled ||
      editing(event.target)
    )
      return;
    if (event.type === "keyup") {
      this.pending = this.pending.filter((pending) => {
        if (pending.kind !== "motion" || pending.code !== event.code)
          return true;
        this.data.latencyCancelled++;
        return false;
      });
      return;
    }
    const camera = player.camera.rotation;
    const sample = {
      receivedAt: this.clock(),
      eventTimestamp: event.timeStamp,
      code: event.code ?? "Mouse",
      cameraYaw: camera.y,
      cameraPitch: camera.x,
    };
    if (
      event.type === "mousemove" &&
      player.locked &&
      (event.movementX || event.movementY)
    ) {
      sample.kind = "mouse";
    } else if (event.type === "keydown" && !event.repeat) {
      if (
        MOVE_CODES.has(event.code) &&
        (!event.code.startsWith("Shift") || player.flying)
      ) {
        sample.kind = "motion";
        sample.direction = intent(event.code, player.yaw);
        sample.position = copyPosition(player.position);
        sample.speed = dot(player.velocity, sample.direction);
      } else if (LOOK_CODES.has(event.code)) {
        sample.kind = "arrow";
      }
    }
    if (!sample.kind) return;
    this.data.latencyEligible[sample.kind]++;
    // A stalled page cannot accumulate unbounded mouse samples.
    if (this.pending.length >= 512) {
      this.pending.shift();
      this.data.latencyOverflow++;
    }
    this.pending.push(sample);
  }

  playerUpdated() {
    const player = this.game.player;
    const now = this.clock();
    this.pending = this.pending.filter((pending) => {
      let responded;
      if (pending.kind === "motion") {
        const displacement = {
          x: player.position.x - pending.position.x,
          y: player.position.y - pending.position.y,
          z: player.position.z - pending.position.z,
        };
        // Existing forward movement must not count as a new strafe/jump response.
        responded =
          dot(displacement, pending.direction) > 0.000001 &&
          dot(player.velocity, pending.direction) > pending.speed + 0.00001;
      } else {
        responded =
          Math.abs(player.camera.rotation.y - pending.cameraYaw) > 0.000001 ||
          Math.abs(player.camera.rotation.x - pending.cameraPitch) > 0.000001;
      }
      if (responded) {
        const milliseconds = now - pending.receivedAt;
        this.data.latency[pending.kind].push(milliseconds);
        (this.data.byCode[pending.code] ??= []).push(milliseconds);
        this.data.responses.push({
          kind: pending.kind,
          code: pending.code,
          milliseconds,
          receivedAt: pending.receivedAt,
          eventTimestamp: pending.eventTimestamp,
        });
        return false;
      }
      if (now - pending.receivedAt > 2500) {
        this.data.latencyExpired++;
        return false;
      }
      return true;
    });
  }

  reset(label) {
    this.attach();
    const now = this.clock();
    const start = copyPosition(this.game.player.position);
    const chunk = [
      Math.floor(start.x / CHUNK_SIZE),
      Math.floor(start.z / CHUNK_SIZE),
    ];
    this.pending = [];
    this.data = {
      label,
      startedAt: now,
      endedAt: null,
      startWorldTime: Number.isFinite(this.game.currentTime)
        ? this.game.currentTime
        : null,
      lastWorldTime: Number.isFinite(this.game.currentTime)
        ? this.game.currentTime
        : null,
      advancedWorldTime: 0,
      clockDiscontinuities: 0,
      resolution: [],
      lastPixelRatio: null,
      start,
      end: start,
      lastRaf: null,
      intervals: [],
      phases: Object.fromEntries(
        [
          "game.frame",
          "player.update",
          "graphics.rebuildDirty",
          "graphics.update",
          "graphics.render",
          "wildlife.update",
          "archive.snapshot",
        ].map((name) => [name, []])
      ),
      observerMs: 0,
      frames: 0,
      activeFrames: 0,
      pausedFrames: 0,
      unloadedPlayerFrames: 0,
      distance: 0,
      horizontalDistance: 0,
      minAltitude: start.y,
      maxAltitude: start.y,
      lastChunk: chunk,
      chunks: new Set([chunk.join(",")]),
      chunksCrossed: 0,
      chunkRequestStart: this.game.world._nextRequestId,
      chunkRequests: 0,
      maxima: {},
      inputs: inputCounter(),
      latency: { motion: [], mouse: [], arrow: [] },
      latencyEligible: { motion: 0, mouse: 0, arrow: 0 },
      latencyExpired: 0,
      latencyCancelled: 0,
      latencyOverflow: 0,
      byCode: {},
      responses: [],
      view: { samples: 0, terrainVisible: 0, last: null },
      nextViewAt: now,
      miningProgressFrames: 0,
      maxMiningProgress: 0,
    };
    this.recording = true;
    return { label, startedAt: now };
  }

  beforeFrame(now) {
    this.sessionFrames++;
    const data = this.data;
    if (data.lastRaf !== null && now > data.lastRaf)
      data.intervals.push(now - data.lastRaf);
    data.lastRaf = now;
    data.frames++;
    if (this.game.active) data.activeFrames++;
    if (this.game.paused) data.pausedFrames++;
  }

  afterFrame() {
    const { player, world, graphics } = this.game;
    const data = this.data;
    const currentTime = this.game.currentTime;
    if (Number.isFinite(currentTime) && data.lastWorldTime !== null) {
      const advance = (((currentTime - data.lastWorldTime) % 1) + 1) % 1;
      if (advance > 0.001) data.clockDiscontinuities++;
      else data.advancedWorldTime += advance;
      data.lastWorldTime = currentTime;
    }
    const position = copyPosition(player.position);
    const pixelRatio = graphics.renderer.getPixelRatio?.();
    if (Number.isFinite(pixelRatio) && pixelRatio !== data.lastPixelRatio) {
      data.lastPixelRatio = pixelRatio;
      if (data.resolution.length < 128)
        data.resolution.push({
          elapsedMs: this.clock() - data.startedAt,
          pixelRatio,
          width: graphics.renderer.domElement?.width ?? null,
          height: graphics.renderer.domElement?.height ?? null,
        });
    }
    data.distance += distance(position, data.end);
    data.horizontalDistance += distance(position, data.end, true);
    data.end = position;
    data.minAltitude = Math.min(data.minAltitude, position.y);
    data.maxAltitude = Math.max(data.maxAltitude, position.y);
    const chunk = [
      Math.floor(position.x / CHUNK_SIZE),
      Math.floor(position.z / CHUNK_SIZE),
    ];
    if (data.lastChunk)
      data.chunksCrossed +=
        Math.abs(chunk[0] - data.lastChunk[0]) +
        Math.abs(chunk[1] - data.lastChunk[1]);
    data.lastChunk = chunk;
    data.chunks.add(chunk.join(","));
    data.chunkRequests = world._nextRequestId - data.chunkRequestStart;
    if (!world.isLoaded(position.x, position.z)) data.unloadedPlayerFrames++;
    const values = {
      cachedChunks: world.chunks.size,
      requestedChunks: world._requests.size,
      inFlightChunks: world._inFlight.size,
      dirtyChunks: world.dirtyChunks.size,
      ...chunkMeshCounts(graphics),
      // Retained for existing report readers; this is the buffer-cache count.
      renderedChunks: graphics.chunks.size,
      drawCalls: graphics.renderer.info.render.calls,
      triangles: graphics.renderer.info.render.triangles,
      geometries: graphics.renderer.info.memory.geometries,
      textures: graphics.renderer.info.memory.textures,
    };
    for (const [name, value] of Object.entries(values))
      data.maxima[name] = Math.max(data.maxima[name] ?? 0, value);
    if (this.game.miningProgress > 0) data.miningProgressFrames++;
    data.maxMiningProgress = Math.max(
      data.maxMiningProgress,
      this.game.miningProgress
    );
    if (this.probeView && this.clock() >= data.nextViewAt) {
      const view = this.probeView();
      data.view.samples++;
      if (view.terrainRaysHit > 0) data.view.terrainVisible++;
      data.view.last = view;
      data.nextViewAt = this.clock() + 500;
    }
  }

  live() {
    if (!this.data) return null;
    return {
      label: this.data.label,
      elapsedMs: (this.data.endedAt ?? this.clock()) - this.data.startedAt,
      frames: this.data.frames,
      lastFrameMs: this.data.intervals.at(-1) ?? null,
      distance: this.data.horizontalDistance,
      chunksCrossed: this.data.chunksCrossed,
    };
  }

  results({ stop = false } = {}) {
    const data = this.data;
    if (!data) return null;
    if (stop && this.recording) {
      data.endedAt = this.clock();
      this.recording = false;
    }
    const elapsedMs = (data.endedAt ?? this.clock()) - data.startedAt;
    const simulatedSeconds =
      data.startWorldTime === null ? null : data.advancedWorldTime * 1200;
    return {
      label: data.label,
      elapsedMs,
      clock: {
        available: data.startWorldTime !== null,
        configuredDaySeconds: 1200,
        startTimeOfDay: data.startWorldTime,
        endTimeOfDay: data.lastWorldTime,
        simulatedSeconds,
        wallSeconds: elapsedMs / 1000,
        observedDaySeconds:
          data.advancedWorldTime > 0
            ? elapsedMs / 1000 / data.advancedWorldTime
            : null,
        simulationRate:
          simulatedSeconds === null || elapsedMs <= 0
            ? null
            : simulatedSeconds / (elapsedMs / 1000),
        discontinuities: data.clockDiscontinuities,
      },
      frames: {
        ...summarizeFrames(data.intervals),
        callbacks: data.frames,
        active: data.activeFrames,
        paused: data.pausedFrames,
        unloadedPlayer: data.unloadedPlayerFrames,
      },
      phaseMs: Object.fromEntries(
        Object.entries(data.phases).map(([name, values]) => [
          name,
          summarize(values),
        ])
      ),
      observerCpuMs: data.observerMs,
      resolution: data.resolution,
      movement: {
        start: data.start,
        end: data.end,
        distance: data.distance,
        horizontalDistance: data.horizontalDistance,
        displacement: distance(data.start, data.end, true),
        minAltitude: data.minAltitude,
        maxAltitude: data.maxAltitude,
        chunksCrossed: data.chunksCrossed,
        uniqueChunks: data.chunks.size,
        chunkPath: [...data.chunks],
      },
      maxima: data.maxima,
      totalChunkRequests: data.chunkRequests,
      inputs: data.inputs,
      latency: {
        definition:
          "Trusted DOM event capture to the first actual player update that changes the camera or accelerates/moves in the input's direction. Excludes OS-to-DOM dispatch and compositor presentation.",
        keyToMotionMs: summarize(data.latency.motion),
        mouseToCameraMs: summarize(data.latency.mouse),
        arrowToCameraMs: summarize(data.latency.arrow),
        byCodeMs: Object.fromEntries(
          Object.entries(data.byCode).map(([name, values]) => [
            name,
            summarize(values),
          ])
        ),
        eligible: data.latencyEligible,
        expired: data.latencyExpired,
        cancelledBeforeMotion: data.latencyCancelled,
        pending: this.pending.length,
        overflow: data.latencyOverflow,
        slowest: [...data.responses]
          .sort((a, b) => b.milliseconds - a.milliseconds)
          .slice(0, 10),
      },
      view: {
        ...data.view,
        terrainVisibleFraction: data.view.samples
          ? data.view.terrainVisible / data.view.samples
          : null,
      },
      mining: {
        progressFrames: data.miningProgressFrames,
        maximumProgress: data.maxMiningProgress,
      },
    };
  }
}
