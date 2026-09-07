import * as THREE from "three";
import { VoxelGame } from "../../src/game.js";
import { World } from "../../src/world.js";
import { GameRenderer } from "../../src/renderer.js";
import { BLOCK } from "../../src/blocks.js";
import { meshRevisionCurrent, sectionYs } from "../../src/mesh-snapshot.js";
import { sectionGeometryCovered } from "../../src/section-pages.js";
import { detailMeshResources } from "../../src/section-renderer.js";
import { distantDetailBatches } from "../../src/distant-detail-mask.js";
import { collectPhysicalLightMeshes, intersectPhysicalLightMeshes } from "../lighting-physical-geometry.js";
import { softwareRenderer } from "../realtime/statistics.js";
import { bufferUploadBytes, ringCensus, visibilityAt, DEFAULT_CONSTRAINTS } from "./oracles.js";
import { surfaceCensus } from "./surface-oracle.js";
import { SCENES, captureConfiguration } from "./scenes.js";
import { cameraRegionProfile } from "./scene-preconditions.js";
import { paidTransaction, publicationObserved, farLoadingWitness } from "./edit-observation.js";
import { combinedBackingResources } from "./resources.js";
import { recoveryGate } from "./recovery.js";
import { pinRaster, rasterState } from "./raster.js";
import { ownershipWitness } from "./ownership-witness.js";

const query = new URLSearchParams(location.search);
const scene = SCENES[query.get("scene") ?? "classic"];
if (!scene) throw new Error("Unknown scene");
const configuration = captureConfiguration(query.get("capture") ?? "performance", query.get("configuration") ?? "default");
const correctnessProofMs = Number(query.get("correctnessProofMs") ?? DEFAULT_CONSTRAINTS.correctnessProofMs);
if (!Number.isFinite(correctnessProofMs) || correctnessProofMs <= 0) throw new Error("Invalid physical proof timeout");
const state = window.renderBenchmark = {
  ready: false, phase: "startup", samples: [], frameIntervals: [],
  timings: { update: [], mesh: [], draw: [], gameFrame: [], observer: [] },
  longTasks: [], copy: { totalBytes: 0, maxBytes: null }, errors: [],
  edit: null, machine: null, started: performance.now(), recording: true,
  peaks: {}, bufferUploads: { calls: 0, bytes: 0, allocationBytes: 0 },
  configuration, frameNumber: 0, observations: [], preconditionChecks: [],
  contextLost: false,
  measurementVersion: 3, heavyObserverCalls: 0, pixelReadsWhileRecording: 0,
  resourceObserverCalls: 0, editRayCalls: 0, timedScreenshots: 0,
  visibilityEvents: [], contextLossEvents: [],
};
let game, lastFrame, nextSample = 0;
const now = () => performance.now() - state.started;
for (const prototype of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
  const readPixels = prototype.readPixels;
  prototype.readPixels = function(...args) {
    if (state.recording) state.pixelReadsWhileRecording++;
    return readPixels.apply(this, args);
  };
  for (const name of ["bufferData", "bufferSubData"]) {
    const original = prototype[name];
    prototype[name] = function(...args) {
      const result = original.apply(this, args);
      if (state.recording) {
        const data = args[name === "bufferData" ? 1 : 2];
        const offset = args[3] ?? 0, length = args[4] ?? 0;
        state.bufferUploads.calls++;
        state.bufferUploads.bytes += bufferUploadBytes(data, offset, length);
        if (name === "bufferData")
          state.bufferUploads.allocationBytes += typeof data === "number" ? data : bufferUploadBytes(data, offset, length);
      }
      return result;
    };
  }
}
try {
  new PerformanceObserver(list => {
    if (state.recording) state.longTasks.push(...list.getEntries().map(e => ({
      startMs: e.startTime - state.started, durationMs: e.duration,
    })));
  }).observe({ type: "longtask", buffered: true });
} catch { state.longTasksUnavailable = true; }

const initialize = VoxelGame.prototype.initialize;
VoxelGame.prototype.initialize = function(seed, saved, options = {}) {
  if (saved) throw new Error("Benchmark requires an empty isolated archive");
  return initialize.call(this, query.get("seed") ?? "cedar-valley", null, {
    ...options, generatorVersion: Number(query.get("version") ?? 3),
  });
};
// Pin only the native spawn-search origin; retain World's ordinary chunk
// generation and collision-safe standing-space search. No terrain is authored.
const getSpawn = World.prototype.getSpawn;
World.prototype.getSpawn = function(...args) {
  if (!scene.spawnOrigin) return getSpawn.apply(this, args);
  const original = this.generator.getSpawn;
  this.generator.getSpawn = () => ({ ...scene.spawnOrigin });
  try { return getSpawn.apply(this, args); }
  finally { this.generator.getSpawn = original; }
};
const prepareWorld = VoxelGame.prototype.prepareWorld;
VoxelGame.prototype.prepareWorld = async function(...args) {
  const staged = await prepareWorld.apply(this, args);
  if (scene.spawnOrigin) Object.assign(staged.pose, { yaw: scene.yaw, pitch: scene.pitch });
  return staged;
};
const resize = GameRenderer.prototype.resize;
GameRenderer.prototype.resize = function(...args) {
  const result = resize.apply(this, args);
  pinRaster(this);
  return result;
};
const start = VoxelGame.prototype.start;
VoxelGame.prototype.start = async function(...args) {
  game = this;
  state.gameStartMs = now();
  const result = await start.apply(this, args);
  this.graphics.renderer.domElement.addEventListener("webglcontextlost", () => {
    state.contextLost = true;
    if (state.recording) state.contextLossEvents.push(now());
  });
  this.graphics.renderer.domElement.addEventListener("webglcontextrestored", () => { state.contextLost = false; });
  state.settings = {
    seed: this.world.seed, version: this.world.generatorVersion, radius: this.graphics.renderRadius,
    quality: this.quality, limits: this.graphics.meshLimits,
    waterFusion: this.graphics.waterFusionEnabled, spawn: this.player.position.toArray(),
    yaw: this.player.yaw, pitch: this.player.pitch,
    rasterPolicy: "fixed-quality-cap", fixedRaster: rasterState(this.graphics),
  };
  if (configuration.heavyCensus) {
  const leaves = new Set(Object.entries(BLOCK).filter(([name]) => name.endsWith("_LEAVES") || name === "LEAVES").map(([, id]) => id));
  const profile = { sampledColumns: 0, leafCells: 0, waterCells: 0, biomes: {} };
  const cx = Math.floor(this.player.position.x / 16), cz = Math.floor(this.player.position.z / 16);
  for (const [key, chunk] of this.world.chunks) {
    const [x, z] = key.split(",").map(Number);
    if (Math.max(Math.abs(x - cx), Math.abs(z - cz)) > 2) continue;
    const biome = this.world.generator.getBiome(x * 16 + 8, z * 16 + 8).id;
    profile.biomes[biome] = (profile.biomes[biome] ?? 0) + 1;
    if (!chunk.blocks) continue;
    profile.sampledColumns++;
    for (const id of chunk.blocks) {
      profile.leafCells += Number(leaves.has(id));
      profile.waterCells += Number(id === BLOCK.WATER);
    }
  }
  state.profile = profile;
  }
  state.readyMs = now(); state.ready = true;
  return result;
};
for (const [method, label] of [["update", "update"], ["rebuildDirty", "mesh"], ["render", "draw"]]) {
  const original = GameRenderer.prototype[method];
  GameRenderer.prototype[method] = function(...args) {
    if (configuration.experimentalPageLocalUpdates && method === "rebuildDirty")
      this.meshLimits = { ...this.meshLimits, experimentalPageLocalUpdates: true };
    const before = performance.now();
    const result = original.apply(this, args);
    if (state.recording) {
      state.timings[label].push(performance.now() - before);
      if (method === "rebuildDirty") {
        const bytes = this.meshStats?.lastSliceCopyBytes;
        if (Number.isFinite(bytes)) {
          state.copy.totalBytes += bytes;
          state.copy.maxBytes = Math.max(state.copy.maxBytes ?? 0, bytes);
        }
        for (const [key, field] of [["gpuBytes", "peakReservedGpuBytes"], ["combinedCpuBytes", "peakCombinedCpuBytes"],
          ["stagingBytes", "peakStagingBytes"], ["drawCalls", "drawCalls"]]) {
          const value = this.meshStats?.[field];
          if (Number.isFinite(value)) state.peaks[key] = Math.max(state.peaks[key] ?? 0, value);
        }
      }
      if (configuration.heavyCensus && method === "update") {
        const observed = performance.now();
        state.resourceObserverCalls++;
        const resources = combinedBackingResources(this, detailMeshResources(this));
        for (const key of ["gpuBytes", "combinedCpuBytes", "stagingBytes", "drawCalls"])
          state.peaks[key] = Math.max(state.peaks[key] ?? 0, resources[key]);
        (state.timings.resourceObserver ??= []).push(performance.now() - observed);
      }
    }
    return result;
  };
}
const frame = VoxelGame.prototype.frame;
VoxelGame.prototype.frame = function(time) {
  const before = performance.now();
  state.frameNumber++;
  const result = frame.call(this, time);
  if (!state.recording) return result;
  if (lastFrame !== undefined) state.frameIntervals.push(time - lastFrame);
  lastFrame = time;
  state.timings.gameFrame.push(performance.now() - before);
  if (state.ready && now() >= nextSample) {
    const started = performance.now();
    try {
      const sample = configuration.heavyCensus ? census(this) : telemetry(this);
      state.samples.push(sample);
      if (configuration.heavyCensus) window.__benchmarkSample?.(sample);
    } catch (e) { state.errors.push(e.stack); }
    state.timings.observer.push(performance.now() - started);
    state.observations.push({ frame: state.frameNumber, startMs: started - state.started,
      endMs: now(), heavy: configuration.heavyCensus });
    nextSample = now() + 1000;
  }
  if (state.ready) {
    const started = performance.now();
    observeEdit(this);
    state.timings.editObserver ??= [];
    state.timings.editObserver.push(performance.now() - started);
  }
  return result;
};

function fresh(world, key, sy, section) {
  return !!section && !world.dirtySectionRevisions.has(`${key},${sy}`) &&
    meshRevisionCurrent(world, { ...section.stamp, ticket: undefined });
}

function census(g) {
  if (!configuration.heavyCensus) throw new Error("Heavy census prohibited in performance capture");
  state.heavyObserverCalls++;
  const r = g.graphics, world = g.world, p = r.camera.position;
  const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16), ys = sectionYs(world);
  const columns = [];
  for (const [key, column] of r.chunks) {
    const [x, z] = key.split(",").map(Number);
    const sections = ys.map(sy => ({ sy, section: column.userData.sections?.get(sy) }));
    columns.push({
      key, ring: Math.max(Math.abs(x - cx), Math.abs(z - cz)),
      physical: sections.some(({ section }) => section?.bytes > 0 &&
        sectionGeometryCovered(column, section, r.camera)),
      fullFresh: sections.every(({ sy, section }) => sectionGeometryCovered(column, section, r.camera) &&
        fresh(world, key, sy, section)),
    });
  }
  const batches = distantDetailBatches(r.chunks, r.camera), mask = r.distant.detailMask;
  const ownershipWitnesses = [];
  let ownershipWitnessesOmitted = 0;
  let checks = 0, mismatches = 0, expectedSections = 0;
  // Include absent sections, so stale mask bits cannot pass a positive-only census.
  for (let dz = -12; dz <= 12; dz++) for (let dx = -12; dx <= 12; dx++) for (const sy of ys) {
    const key = `${cx + dx},${cz + dz},${sy}`, bits = batches.get(key) ?? 0;
    expectedSections += Number(bits !== 0);
    const point = new THREE.Vector3((cx + dx) * 16 + 8, sy * 16 + 8, (cz + dz) * 16 + 8);
    let maskBits = 0;
    for (let b = 0; b < 4; b++) {
      checks++;
      const owns = mask.owns(point, new THREE.Vector3(0, 1, 0), b);
      if (owns) maskBits |= 1 << b;
      mismatches += Number(owns !== !!(bits & (1 << b)));
    }
    if (maskBits !== bits) {
      if (ownershipWitnesses.length < 128) ownershipWitnesses.push(ownershipWitness(r, mask, key, bits, maskBits));
      else ownershipWitnessesOmitted++;
    }
  }
  const rays = [];
  const roots = [r.distant._active?.group].filter(Boolean);
  // Terrain only; distant foliage cannot conceal missing ground.
  for (const blocks of [64, 128, 192]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = p.x + dx * blocks, z = p.z + dz * blocks;
    const ray = new THREE.Raycaster(new THREE.Vector3(x, world.spec.maxY + 2, z), new THREE.Vector3(0, -1, 0));
    ray.layers.mask = r.camera.layers.mask;
    // Reuse the physical collector; apply the shader's per-batch mask to CPU hits.
    const hits = intersectPhysicalLightMeshes(r, ray, r.camera, roots);
    const hit = hits.find(h => {
      const a = h.object.geometry.attributes.lodDetailBatch;
      const batch = a ? Math.round(a.getX(h.face.a)) : h.object.material === r.distant._waterMaterial ? 3 : 0;
      const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      return !mask.owns(h.point, normal, batch);
    });
    let inView = false, terrainOccluded = null, viewTransmission = null;
    if (hit) {
      const projected = hit.point.clone().project(r.camera);
      const depth = -hit.point.clone().applyMatrix4(r.camera.matrixWorldInverse).z;
      inView = depth > 0 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && Math.abs(projected.z) <= 1;
      viewTransmission = visibilityAt(r.scene.fog.near, r.scene.fog.far, depth);
      if (inView) {
        terrainOccluded = false;
        const delta = hit.point.clone().sub(p), distance = delta.length();
        for (let d = 2; d < distance - 2; d += 2) {
          const point = p.clone().addScaledVector(delta, d / distance);
          const top = world.generator.terrainHeight(Math.floor(point.x), Math.floor(point.z));
          if (Number.isFinite(top) && point.y <= top + 1) { terrainOccluded = true; break; }
        }
      }
    }
    rays.push({ blocks, direction: [dx, dz], fallback: !!hit, height: hit?.point.y ?? null,
      inView, terrainOccluded, viewTransmission });
  }
  const nativeResources = detailMeshResources(r);
  const resources = combinedBackingResources(r, nativeResources);
  return {
    ms: now(), frame: state.frameNumber, phase: state.phase, position: p.toArray(), yaw: g.player.yaw, pitch: g.player.pitch,
    gameElapsedSeconds: g.elapsed,
    native: { available: true, ...ringCensus(columns, r.renderRadius) },
    mask: { checks, mismatches, expectedSections, coveredSections: mask.coveredSections,
      witnesses: ownershipWitnesses, witnessesOmitted: ownershipWitnessesOmitted,
      meshResourceRevision: r.meshResourceRevision ?? null, maskRevision: mask.version ?? null },
    fog: { near: r.scene.fog.near, far: r.scene.fog.far,
      visibility: Object.fromEntries([16, 64, 128, 192].map(d => [d, visibilityAt(r.scene.fog.near, r.scene.fog.far, d)])) },
    lod: { visible: r.distant.group.visible, ready: r.distant.ready,
      effectiveRadius: r.distant._active?.data.request.radius ?? null,
      pendingRadius: r.distant._job?.request.radius ?? null,
      fogDistance: r.distant.fogDistance, terrainCoverageComplete: r.distant.terrainCoverageComplete },
    surfaces: surfaceCensus(g),
    rays, resources,
    allSceneDraws: r.renderer.info.render.calls, rendererMemory: { ...r.renderer.info.memory },
    maskUploadBytes: mask.uploadedBytes, streaming: world.streamingStatus(),
    contextLost: state.contextLost, hidden: document.hidden,
    raster: rasterState(r),
  };
}

function telemetry(g) {
  const r = g.graphics;
  return {
    ms: now(), frame: state.frameNumber, phase: state.phase, position: r.camera.position.toArray(),
    yaw: g.player.yaw, pitch: g.player.pitch, gameElapsedSeconds: g.elapsed,
    native: { available: false, rings: [], fullRadius: -1, fullDetailBlocks: 0 },
    fog: { near: r.scene.fog.near, far: r.scene.fog.far },
    lod: { visible: r.distant.group.visible, ready: r.distant.ready },
    resources: {}, contextLost: state.contextLost, hidden: document.hidden,
    raster: rasterState(r),
  };
}
document.addEventListener("visibilitychange", () => {
  if (state.recording && document.hidden) state.visibilityEvents.push(now());
});

state.payEdit = () => {
  if (state.edit) return state.edit;
  const g = game, r = g.graphics, p = g.player.position;
  for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const at = { x: Math.floor(p.x) + dx, y: Math.floor(p.y) + 1, z: Math.floor(p.z) + dz };
    const key = `${Math.floor(at.x / 16)},${Math.floor(at.z / 16)}`, sy = Math.floor(at.y / 16);
    const column = r.chunks.get(key), section = column?.userData.sections?.get(sy);
    if (g.world.getCell(at.x, at.y, at.z)?.id !== BLOCK.AIR ||
        !section?.stamp || g.world.dirtySectionRevisions.has(`${key},${sy}`)) continue;
    if (configuration.heavyCensus && (!fresh(g.world, key, sy, section) ||
        !sectionGeometryCovered(column, section, r.camera))) continue;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16), radius = r.renderRadius;
    const farWitness = [[radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius]]
      .map(([dx, dz]) => `${cx + dx},${cz + dz}`)
      .map(farKey => ({
        key: farKey, sy,
        requiredAbsent: !r.chunks.get(farKey)?.userData.sections?.has(sy),
        generationPending: g.world._streamWanted?.has(farKey) === true &&
          !g.world.chunks.has(farKey) && !g.world._streamErrors?.has(farKey),
        meshPending: g.world.dirtySectionRevisions.has(`${farKey},${sy}`) ||
          r.sectionJobs?.has(`${farKey},${sy}`) === true,
        lodPending: !!r.distant._job && r.distant._job.request.radius >= radius,
      }))
      .find(farLoadingWitness);
    if (!farWitness) continue;
    // Bounded stock fixture, identical to the validated live-distance test. World
    // terrain is never authored; both voxel and hand debit use the real transaction.
    if (!g.gameplay.add(BLOCK.STONE, 2) || !g.gameplay.assignSlot(0, BLOCK.STONE))
      throw new Error("Paid edit stock setup failed");
    g.gameplay.select(0);
    const stack = g.gameplay.getHandStack("main"), beforeCount = stack.count;
    const timing = paidTransaction({ now, farStillLoading: !!farWitness,
      prepare: () => {
        const cost = g.gameplay.prepareHandCost("main", {
          stack, handRevision: g.gameplay.getHandRevision("main"), count: 1, notify: false,
        });
        const mutation = g.world.prepareMutation([{ ...at, before: g.world.getCell(at.x, at.y, at.z),
          after: { id: BLOCK.STONE, state: 0, fluid: 0 } }]);
        return cost && mutation ? [mutation, cost] : null;
      },
      commit: prepared => g.world.coordinator.commit(prepared).ok,
    });
    state.edit = {
      at, key, sy, ...timing, beforeCount, afterCount: g.gameplay.getHandStack("main").count,
      ticket: g.world.dirtySectionRevisions.get(`${key},${sy}`), visibleMs: null, publicationMs: null,
      farWitness,
    };
    return state.edit;
  }
  return null;
};

function observeEdit(g) {
  const e = state.edit;
  if (!e || (configuration.heavyCensus ? e.visibleMs !== null : e.publicationMs !== null)) return;
  if (configuration.heavyCensus && now() - e.startedMs > correctnessProofMs) {
    e.proofTimedOut = true; e.proofTimeoutMs = correctnessProofMs;
    return;
  }
  const column = g.graphics.chunks.get(e.key), section = column?.userData.sections?.get(e.sy);
  if (!configuration.heavyCensus) {
    if (publicationObserved(e, section, g.world.dirtySectionRevisions.has(`${e.key},${e.sy}`), state.contextLost))
      e.publicationMs = now() - e.startedMs;
    return;
  }
  if (!fresh(g.world, e.key, e.sy, section) || section.stamp.ticket !== e.ticket ||
      !sectionGeometryCovered(column, section, g.graphics.camera)) return;
  state.editRayCalls++;
  const ray = new THREE.Raycaster(new THREE.Vector3(e.at.x + 0.5, e.at.y + 1.1, e.at.z + 0.5),
    new THREE.Vector3(0, -1, 0), 0, 0.2);
  const hits = intersectPhysicalLightMeshes(g.graphics, ray);
  if (hits.some(h => Math.abs(h.point.y - (e.at.y + 1)) < 0.01) &&
      e.beforeCount - e.afterCount === 1 && g.world.get(e.at.x, e.at.y, e.at.z) === BLOCK.STONE)
    e.visibleMs = now() - e.startedMs;
}

state.stop = () => {
  state.recording = false;
  return JSON.parse(JSON.stringify(state));
};

state.checkScenePrecondition = () => {
  if (!configuration.heavyCensus) throw new Error("Region census prohibited during performance capture");
  if (!scene.region) return { passed: true, applicable: false };
  const before = now();
  const profile = cameraRegionProfile(game.world, game.graphics.camera, scene.region);
  state.preconditionChecks.push({ ms: before, ...profile });
  state.scenePrecondition = profile;
  return profile;
};

// All GL metadata queries occur after timing stops. No benchmark readPixels,
// getParameter, getError, or getExtension runs in the timed RAF observer.
state.inspectMachine = () => {
  if (state.recording) throw new Error("GL metadata inspection is post-timing only");
  const r = game.graphics, gl = r.renderer.getContext(), ext = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  return {
    renderer, softwareRenderer: softwareRenderer(renderer), webgl: gl.getParameter(gl.VERSION),
    vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight], pixelRatio: r.renderer.getPixelRatio(),
    userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
  };
};

// These explicit negative controls run AFTER the timing window. They never
// advance generation or mesh readiness. A/B/A is one synchronous scene snapshot.
state.pixelControl = (controlled = false) => {
  if (state.recording) throw new Error("Pixel controls are post-timing only");
  const r = game.graphics, gl = r.renderer.getContext();
  const savedPose = { position: r.camera.position.clone(), quaternion: r.camera.quaternion.clone() };
  if (controlled) {
    if (!state.edit) throw new Error("Recovery requires a paid native surface, not an empty scene");
    const at = state.edit.at;
    r.camera.position.set(at.x + 0.5, at.y + 2.5, at.z + 3);
    r.camera.lookAt(at.x + 0.5, at.y + 0.5, at.z + 0.5);
    r.camera.updateMatrixWorld(true);
  }
  try {
  const poseKey = JSON.stringify([r.camera.position.toArray(), r.camera.quaternion.toArray()]);
  const capture = () => {
    const rendered = r.render();
    const bytes = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return { bytes, rendered, draws: r.renderer.info.render.calls, png: r.renderer.domElement.toDataURL("image/png") };
  };
  const roots = [...r.chunks.values(), ...(r.sectionRegions?.values() ?? [])];
  const visibility = roots.map(root => root.visible);
  const a = capture();
  let b;
  try {
    for (const root of roots) root.visible = false;
    b = capture();
  } finally {
    roots.forEach((root, i) => { root.visible = visibility[i]; });
  }
  const restored = capture();
  const ray = new THREE.Raycaster();
  ray.setFromCamera(new THREE.Vector2(0, 0), r.camera);
  ray.far = 8;
  const hits = intersectPhysicalLightMeshes(r, ray);
  const at = state.edit?.at;
  const positiveSurface = hits.some(hit => !controlled || (at &&
    ["x", "y", "z"].every(axis => hit.point[axis] >= at[axis] - 0.01 && hit.point[axis] <= at[axis] + 1.01)));
  const difference = (a, b) => a.reduce((n, v, i) => n + Number(v !== b[i]), 0);
  const changedChannels = difference(a.bytes, b.bytes), restoredChannels = difference(a.bytes, restored.bytes);
  const glError = gl.getError(), nonzeroChannels = a.bytes.filter((v, i) => i % 4 < 3 && v > 0).length;
  return {
    scope: "frozen real-scene native-hidden negative control; not proof of no temporal flicker",
    changedChannels, restoredChannels, glError, nonzeroChannels, positiveSurface, poseKey, draws: a.draws,
    status: a.rendered !== false && a.draws > 0 && nonzeroChannels > 0 &&
      changedChannels > 0 && restoredChannels === 0 && glError === 0 ? "pass" : "fail",
    images: { normal: a.png, nativeHidden: b.png, restored: restored.png },
  };
  } finally {
    r.camera.position.copy(savedPose.position); r.camera.quaternion.copy(savedPose.quaternion);
    r.camera.updateMatrixWorld(true);
  }
};

state.lifecycleControl = async () => {
  const r = game.graphics, gl = r.renderer.getContext(), ext = gl.getExtension("WEBGL_lose_context");
  if (!ext) return { status: "unavailable", reason: "WEBGL_lose_context unavailable" };
  const meshes = collectPhysicalLightMeshes(r);
  const before = state.pixelControl(true);
  delete before.images;
  const errors = [];
  const onError = event => { errors.push(event.message || String(event.error)); };
  window.addEventListener("error", onError);
  let disposals = 0;
  const geometries = [...new Set(meshes.map(m => m.geometry))];
  const onDispose = () => { disposals++; };
  for (const geometry of geometries) geometry.addEventListener("dispose", onDispose);
  const event = name => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out: ${name}`)), 10000);
    r.renderer.domElement.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  try {
    const lost = event("webglcontextlost"); ext.loseContext(); await lost;
    const sawLost = gl.isContextLost();
    // Restore only after the browser finishes dispatching the loss event.
    await new Promise(requestAnimationFrame);
    const restored = event("webglcontextrestored"); ext.restoreContext(); await restored;
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    const contextRestored = !gl.isContextLost();
    const after = state.pixelControl(true);
    delete after.images;
    const recoveryDisposals = disposals;
    // Real replacement lifecycle exercises the actual old-renderer teardown.
    await game.initialize(game.world.seed, null, { generatorVersion: game.world.generatorVersion });
    const retired = r.disposed === true && r.chunks.size === 0 && !r.renderer.domElement.isConnected;
    const result = {
      scope: "native real-context loss/recovery, then real Game world replacement/disposal",
      sawLost, contextRestored, recoveryDisposals, retired, before, after, errors,
    };
    result.status = recoveryGate(result) ? "pass" : "fail";
    return result;
  } finally {
    window.removeEventListener("error", onError);
    for (const geometry of geometries) geometry.removeEventListener("dispose", onDispose);
  }
};
