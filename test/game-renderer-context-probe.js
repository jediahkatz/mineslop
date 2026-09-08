// NEW validation fixture, not a recovered historical source.
// Uses the actual GameRenderer and bounded regional/lighting publication paths.
import * as T from "three";
import { GameRenderer } from "../src/renderer.js";
import { BLOCK } from "../src/blocks.js";
import { authoredColumns } from "./shape-fixture.js";
import { lightingFullyReady } from "./light-renderer-fixture.js";
import { collectPhysicalLightMeshes, intersectPhysicalLightMeshes } from "./lighting-physical-geometry.js";

export async function runCombinedContextProbe() {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const difference = (a, b) => a.reduce((n, value, i) => n + Number(value !== b[i]), 0);
  const hash = (array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return value >>> 0;
  };
  const world = authoredColumns([]);
  world.spec = { ...world.spec, minY: 0, maxY: 96 };
  for (let z = -4; z <= 4; z++) for (let x = -4; x <= 4; x++) world.admit(x, z);
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++)
    world.put(x, 7, z, (x + z) % 2 ? BLOCK.STONE : BLOCK.DIRT);
  for (let y = 8; y < 13; y++) for (let z = 6; z <= 8; z++) for (let x = 6; x <= 8; x++)
    world.put(x, y, z, BLOCK.STONE);
  world.put(11, 8, 9, BLOCK.TORCH);
  world.getBiome = () => ({ id: "plains", category: "grassland", dimension: "overworld", fogColor: "#b4d1ce" });
  world.generate = world.ensureArea = () => { throw new Error("Authored validation must never generate terrain"); };
  const container = document.querySelector("#surface-probe");
  const g = new GameRenderer(container, world);
  let stage = "setup", result = {}, failure;
  let frame = 0, engineDraws = 0, flushCalls = 0, injected = false, frozen = false;
  const ordering = [], budgets = [], paletteUploads = [];
  const gl = g.renderer.getContext();
  try {
    g.meshLimits = { regionalPages: true };
    g.setQuality("high");
    g.setRenderDistanceOverride(2);
    g.setTime(0.35);
    g.renderer.setPixelRatio(1);
    g.renderer.setSize(96, 96);
    g.camera.aspect = 1;
    g.camera.position.set(14, 18, 14);
    g.camera.lookAt(8, 8, 8);
    g.camera.updateProjectionMatrix();
    // Stable authored close-range framing; colors, lights, shadow scheduler and
    // all production shader hooks remain unchanged.
    for (const material of Object.values(g.materials)) material.fog = false;

    for (const name of ["texImage2D", "texSubImage2D"]) {
      const original = gl[name].bind(gl);
      gl[name] = (...args) => {
        const data = g.geometryPalette?.data;
        if (data && args.some((arg) => ArrayBuffer.isView(arg) && arg.buffer === data.buffer))
          paletteUploads.push({ name, frame, bytes: data.byteLength });
        return original(...args);
      };
    }
    const engineRender = g.renderer.render.bind(g.renderer);
    g.renderer.render = (...args) => {
      check(g.lightingNeedsFlush === false, "Engine draw reached before the production lighting flush latch cleared");
      ordering.push({ frame, event: "engine-draw", flushCalls });
      engineDraws++;
      return engineRender(...args);
    };
    let instrumentedLight;
    const instrument = () => {
      if (!g.daylightMaterial || instrumentedLight === g.daylightMaterial) return;
      instrumentedLight = g.daylightMaterial;
      const flush = instrumentedLight.flush.bind(instrumentedLight);
      instrumentedLight.flush = (...args) => {
        flushCalls++;
        ordering.push({ frame, event: "flush-start", flushCalls });
        if (injected) {
          injected = false;
          throw new Error("NEW regression injected flush-boundary failure");
        }
        const budget = flush(...args);
        if (budget) budgets.push({ frame, uploadedBytes: budget.uploadedBytes, copies: budget.copies });
        ordering.push({ frame, event: "flush-complete", flushCalls });
        return budget;
      };
    };
    const shadow = () => {
      const map = g.atmosphere.sunlight.shadow.map;
      return {
        dirty: g.shadowDirty, lastTime: g.lastShadowTime,
        enabled: g.renderer.shadowMap.enabled, casts: g.atmosphere.sunlight.castShadow,
        rendererNeedsUpdate: g.renderer.shadowMap.needsUpdate,
        lightNeedsUpdate: g.atmosphere.sunlight.shadow.needsUpdate,
        hasGPUFramebuffer: Boolean(map && g.renderer.properties.get(map).__webglFramebuffer),
      };
    };
    const pixels = () => {
      const data = new Uint8Array(96 * 96 * 4);
      gl.readPixels(0, 0, 96, 96, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    };
    const tick = () => {
      check(++frame <= 2000, "Bounded authored validation frame limit exceeded");
      g.rebuildDirty(Infinity);
      g.update(0, frozen ? 10 : frame / 60, g.camera.position);
      instrument();
      const before = flushCalls;
      const orderStart = ordering.length;
      check(g.render() !== false, "Unexpected render barrier in water-disabled authored fixture");
      check(flushCalls === before + 1, "Exactly one production lighting flush must occur per CPU update");
      check(ordering.slice(orderStart).map(entry => entry.event).join(",") === "flush-start,flush-complete,engine-draw",
        "The real flush must finish before the engine draw begins");
    };
    const settle = (onFirstFrame) => {
      const initial = frame, started = performance.now();
      do {
        tick();
        if (frame === initial + 1) onFirstFrame?.();
        if (lightingFullyReady(g) && !g.sectionJobs?.size && g.geometryPalette?.references > 0 &&
            g.geometryPalette.pendingUploadBytes === 0 &&
            [...g.chunks.values()].every((group) => group.userData.sections?.size === 6))
          return frame - initial;
      } while (frame - initial < 1500 && performance.now() - started < 120000);
      throw new Error(`Authored complete halo did not settle: ${JSON.stringify({
        frame, lighting: g.daylightMaterial?.resources(), jobs: g.sectionJobs?.size,
        palette: g.geometryPalette?.resources(), sections: [...g.chunks.values()].map(v => v.userData.sections?.size),
      })}`);
    };
    stage = "cold-settle";
    const initialFrames = settle();
    // Cold mesh admission is not the restoration gate. Let ordinary scheduling
    // advance during startup, then change time-of-day through its public API
    // and freeze simulation time BEFORE taking any comparison image.
    g.setTime(0.4);
    frozen = true;
    tick();
    check(g.renderRadius === 2 && g.chunks.size === 25, "Control must cover the complete authored 25-column receiver window");
    check(g.atmosphere.sunlight.castShadow && g.renderer.shadowMap.enabled, "Natural shadows must be enabled");
    check(g.blockLight.store.resources().requiredPages === 150 &&
      g.skyColumns.surfaceLight.store.resources().requiredPages === 150, "Control must cover all six vertical sections");
    const before = pixels(), beforeShadow = shadow();
    check(beforeShadow.hasGPUFramebuffer && beforeShadow.lastTime === 10 && !beforeShadow.dirty,
      "Warm frozen-time control needs a real published shadow framebuffer");
    const distinctColors = new Set(Array.from({ length: before.length / 4 },
      (_, i) => before.slice(i * 4, i * 4 + 3).join(","))).size;
    check(distinctColors > 10, "Non-vacuity: the real rendered scene must contain distinct pixel colors");
    stage = "shadow-nonvacuity";
    // Remove the light from Three's shadow list so its light-state version and
    // sampling program change. shadowMap.enabled alone only stops map updates
    // and can leave an already compiled sampling program using the cached map.
    g.atmosphere.sunlight.castShadow = false;
    g.render();
    const shadowOffDifferences = difference(before, pixels());
    const ray = new T.Raycaster();
    ray.setFromCamera(new T.Vector2(), g.camera);
    result.fixtureDiagnostic = {
      beforeShadow, shadowOffDifferences, distinctColors,
      sunlight: { intensity: g.atmosphere.sunlight.intensity, position: g.atmosphere.sunlight.position.toArray(),
        target: g.atmosphere.sunlight.target.position.toArray(), direction: g.atmosphere.lightDirection.toArray() },
      camera: { position: g.camera.position.toArray(), matrix: g.camera.matrixWorld.toArray() },
      centerHits: intersectPhysicalLightMeshes(g, ray).slice(0, 4).map(hit => ({
        point: hit.point.toArray(), distance: hit.distance, name: hit.object.name,
      })),
      meshes: collectPhysicalLightMeshes(g).map(mesh => ({
        cast: mesh.castShadow, receive: mesh.receiveShadow, name: mesh.name,
        range: mesh.geometry.drawRange, material: mesh.material.type,
        position: mesh.position.toArray(), bounds: mesh.geometry.boundingBox?.min.toArray(),
      })),
    };
    check(shadowOffDifferences > 32, "Non-vacuity: disabling only shadow sampling must alter visible pixels");
    g.atmosphere.sunlight.castShadow = true;
    g.render();
    check(difference(before, pixels()) === 0, "Returning the shadow control must exactly reproduce the warm scene");

    stage = "flush-failure-retry";
    g.update(0, 10, g.camera.position);
    const drawsBeforeFailure = engineDraws;
    injected = true;
    let caught;
    try { g.render(); } catch (error) { caught = error.message; }
    check(caught === "NEW regression injected flush-boundary failure", "The explicit injected flush error must propagate");
    check(engineDraws === drawsBeforeFailure && g.lightingNeedsFlush === true,
      "A failed flush must stop the engine draw and preserve the retry latch");
    g.render();
    check(engineDraws === drawsBeforeFailure + 1 && g.lightingNeedsFlush === false,
      "The next draw must retry publication successfully");
    check(difference(before, pixels()) === 0, "Failure/retry must not alter the frozen scene");

    const palette = g.geometryPalette, paletteData = palette.data, paletteHash = hash(palette.data);
    const references = palette.references, uploadCallsBefore = palette.uploadCalls;
    const canonical = [g.blockLight.store, g.skyColumns.surfaceLight.store]
      .flatMap((store) => [...store.pages.values()].filter(page => page.values).map(page => ({
        array: page.values, checksum: hash(page.values), store, index: page.ticket.index,
      })));
    const physicalPagesByKind = {
      block: canonical.filter(item => item.store === g.blockLight.store).length,
      surface: canonical.filter(item => item.store === g.skyColumns.surfaceLight.store).length,
    };
    check(Object.values(physicalPagesByKind).every(count => count > 0),
      "Non-vacuity: context recovery needs physical, nonconstant block AND surface pages");
    check(paletteUploads.length > 0 && references > 0, "Non-vacuity: real regional palette data must be uploaded and referenced");
    const programInfo = () => g.renderer.info.programs.map(({ program }) => {
      const names = [];
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++)
        names.push(gl.getActiveUniform(program, i).name);
      return { linked: gl.getProgramParameter(program, gl.LINK_STATUS), uniforms: names };
    });
    const beforePrograms = programInfo();
    check(beforePrograms.some(p => p.uniforms.includes("uRegionalColors") && p.uniforms.includes("uBlockLightPalette")),
      "Non-vacuity: the same real program must sample geometry and block-light palettes");
    const worldVersions = [...world.chunks].map(([key, chunk]) => [key, chunk.revision, chunk.incarnation]);
    const cpuRetained = () => palette.data === paletteData && hash(palette.data) === paletteHash &&
      palette.references === references && canonical.every(item =>
        item.store.pages.get(item.index)?.values === item.array && hash(item.array) === item.checksum);
    const waitEvent = (type) => new Promise((resolve) => g.renderer.domElement.addEventListener(type, resolve, { once: true }));
    const extension = gl.getExtension("WEBGL_lose_context");
    check(extension, "WEBGL_lose_context is required, not skipped");
    stage = "lose-context";
    g.update(0, 10, g.camera.position);
    check(g.lightingNeedsFlush === true, "Normal CPU update must leave lighting publication pending");
    let lossEventSeen = false;
    g.renderer.domElement.addEventListener("webglcontextlost", () => { lossEventSeen = true; }, { once: true });
    const lostDraws = [];
    const skippedDraw = (phase) => {
      check(gl.isContextLost(), `${phase}: the real context must be lost`);
      const flushesBefore = flushCalls, drawsBefore = engineDraws;
      const returned = g.render();
      const observation = { phase, lossEventSeen, returned,
        flushes: flushCalls - flushesBefore, draws: engineDraws - drawsBefore,
        latch: g.lightingNeedsFlush };
      lostDraws.push(observation);
      check(returned === false && observation.flushes === 0 && observation.draws === 0 && observation.latch === true,
        `${phase}: lost-context render must skip flush/draw and retain the retry latch`);
    };
    let event = waitEvent("webglcontextlost");
    extension.loseContext();
    check(!lossEventSeen, "The immediate draw must precede the context-loss event");
    skippedDraw("before-loss-event");
    await event;
    check(lossEventSeen, "The second draw must follow the real loss handler");
    skippedDraw("after-loss-event");
    const lost = {
      cpuRetained: cpuRetained(), pendingPaletteBytes: palette.pendingUploadBytes,
      handlesClosed: [g.blockLight.store, g.skyColumns.surfaceLight.store].every(store => store.mapping.every(v => v === 0)),
    };
    check(lost.cpuRetained && lost.handlesClosed && lost.pendingPaletteBytes === palette.data.byteLength,
      "Loss must retain canonical data, close handles, and queue palette upload");
    await new Promise(resolve => setTimeout(resolve, 50));
    stage = "restore-context";
    event = waitEvent("webglcontextrestored");
    extension.restoreContext();
    await event;
    check(g.lastShadowTime === -Infinity && g.shadowDirty && g.lightingNeedsFlush,
      "The actual restoration callback must rearm shadows and the flush latch");
    check([g.blockLight.store, g.skyColumns.surfaceLight.store].every(store => store.mapping.every(v => v === 0)),
      "Restored handles must remain unavailable before the first production flush");
    let firstRestoredShadow, firstRestoredPalette, firstRestoredLighting;
    const restoreFrames = settle(() => {
      firstRestoredShadow = shadow();
      firstRestoredPalette = palette.resources();
      firstRestoredLighting = {
        upload: { ...g.daylightMaterial.uploadStats }, latch: g.lightingNeedsFlush,
        pendingRequired: g.daylightMaterial.resources().pendingRequired,
      };
    });
    check(firstRestoredShadow.hasGPUFramebuffer && firstRestoredShadow.lastTime === 10 && !firstRestoredShadow.dirty,
      "The very first frozen-time restored frame must draw a real shadow framebuffer");
    check(firstRestoredPalette.pendingUploadBytes === 0 && firstRestoredPalette.uploadCalls > uploadCallsBefore,
      "The very first restored frame must upload the retained geometry palette");
    check(firstRestoredLighting.latch === false && firstRestoredLighting.upload.uploadedBytes > 0 &&
      firstRestoredLighting.upload.uploadedBytes <= 131072,
      "The first restored frame must execute bounded daylight publication before drawing");
    const after = pixels(), callsBeforeRepeated = flushCalls;
    g.render();
    const repeated = pixels();
    const pixelDifferences = difference(before, after), repeatedPixelDifferences = difference(after, repeated);
    check(flushCalls === callsBeforeRepeated, "Repeated draw must not receive another lighting upload budget");
    check(pixelDifferences === 0 && repeatedPixelDifferences === 0,
      `Frozen scene must restore without a later shadow tick: ${pixelDifferences}/${repeatedPixelDifferences} differing bytes`);
    check(cpuRetained() && palette.pendingUploadBytes === 0 && palette.uploadCalls > uploadCallsBefore,
      "The first restored draw must republish the retained geometry palette without ownership churn");
    check(JSON.stringify(worldVersions) === JSON.stringify([...world.chunks].map(([key, chunk]) => [key, chunk.revision, chunk.incarnation])),
      "GPU recovery must not mutate authored world revisions");
    check(budgets.every(b => b.uploadedBytes <= 131072 && b.copies >= 0), "Actual lighting flushes must respect the shared budget");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    result = {
      stage: "passed", initialFrames, restoreFrames, totalFrames: frame, beforeShadow, firstRestoredShadow,
      firstRestoredPalette, firstRestoredLighting,
      shadowOffDifferences, distinctColors, pixelDifferences, repeatedPixelDifferences,
      engineDraws, flushCalls, flushFailureBlockedDraw: true, cpuRetained: cpuRetained(),
      palette: palette.resources(), paletteUploads, physicalLightingPages: canonical.length,
      physicalPagesByKind, lostDraws,
      lost, lighting: g.daylightMaterial.resources(), beforePrograms, afterPrograms: programInfo(),
      ordering: ordering.slice(-24), budgets, radius: g.renderRadius, worldColumns: world.chunks.size,
      gpu: {
        renderer: gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
        version: gl.getParameter(gl.VERSION), maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
        maxArrayLayers: gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS),
        fragmentSamplers: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      },
    };
  } catch (error) {
    failure = { stage, message: error.message, stack: error.stack };
    result = { ...result, frame, engineDraws, flushCalls, ordering: ordering.slice(-32),
      paletteUploads, lighting: g.daylightMaterial?.resources(), palette: g.geometryPalette?.resources() };
  } finally {
    try { g.dispose(); } catch (error) { failure ??= { stage: "dispose", message: error.message, stack: error.stack }; }
  }
  return {
    ...result, failure, disposed: g.disposed, glErrorAfterDisposal: gl.getError(),
    glErrors: window.__glCallTrace.reports.flatMap(report => report.firstErrors),
    contextEpochs: window.__glCallTrace.reports.map(report => report.epoch),
  };
}
