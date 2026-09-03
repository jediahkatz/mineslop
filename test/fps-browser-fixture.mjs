/** Only an absent option keeps production-adaptive resolution; never clamp it. */
export function readFpsPixelRatio(value) {
  if (value === undefined) return null;
  const pixelRatio = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(pixelRatio) || pixelRatio < 0.4 || pixelRatio > 2)
    throw new Error(
      "VOXELCRAFT_FPS_PIXEL_RATIO must be a finite number from 0.4 to 2"
    );
  return pixelRatio;
}

/**
 * Serialized by Playwright into the frozen realtime page. This observer never
 * changes game state, wraps a method, replaces a clock, or reads layout. The
 * existing realtime host's metrics stay unrecorded. RAF times describe callbacks
 * after a completed renderer draw, not GPU completion or compositor presentation.
 */
export function observeFpsWindow({ durationMs = 6000 } = {}) {
  if (!Number.isFinite(durationMs) || durationMs < 2000 || durationMs > 10000)
    throw new Error("FPS observation must last between 2 and 10 real seconds");
  const game = window.__voxelBot?.game;
  const hud = document.querySelector(".game-hud");
  const compact = hud?.querySelector(".compact-fps");
  const debug = hud?.querySelector(".debug-overlay .fps-indicator");
  if (!window.__voxelBot?.ready || !game?.graphics || !compact || !debug)
    throw new Error("The real game and its compact/debug FPS nodes must exist");
  const graphics = game.graphics;
  const world = game.world;
  const renderer = graphics.renderer;
  const gl = renderer.getContext();
  const frameLimit = 8192;
  const eventLimit = 128;

  // Only JS state and drawing-buffer dimensions, never CSS geometry/readbacks.
  const readResolution = () => ({
    pixelRatio: renderer.getPixelRatio(),
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
  });
  const read = () => ({
    frame: renderer.info.render.frame,
    position: game.player.position.toArray(),
    yaw: game.player.yaw,
    pitch: game.player.pitch,
    time: game.currentTime,
    wildlifeClock: game.wildlife.clock,
    active: game.active,
    simulating: game.simulating,
    hidden: document.hidden,
    showFps: game.viewPreferences.showFps,
    guiScale: game.viewPreferences.guiScale,
    fullbrightInspection: graphics.fullbrightInspection,
    quality: game.quality,
    seed: world.seed,
    dimension: world.dimension,
    requests: world._requests.size,
    inFlight: world._inFlight.size,
    dirtyChunks: world.dirtyChunks.size,
    compactText: compact.textContent,
    compactHidden: compact.hidden,
    hudHidden: hud.hidden,
    debugHidden: document.querySelector(".debug-overlay").hidden,
    fps: game.fps,
    resolution: readResolution(),
  });
  const gpu = () => ({
    contextLost: gl.isContextLost(),
    badPrograms: renderer.info.programs.filter(
      (program) => program.diagnostics?.runnable === false
    ).length,
    calls: renderer.info.render.calls,
    triangles: renderer.info.render.triangles,
  });
  const initial = read();
  const initialGpu = gpu();
  const startedAt = performance.now();
  const data = {
    requestedMs: durationMs,
    initial,
    initialGpu,
    frames: 0,
    intervals: [],
    callbacksWithoutDraw: 0,
    textMutations: 0,
    redundantTextBatches: 0,
    coalescedTextBatches: 0,
    attributeMutations: 0,
    nonTextMutations: 0,
    hudElementAdditions: 0,
    hudElementRemovals: 0,
    mutations: [],
    sampleChanges: 0,
    samples: [],
    resolution: [],
    contextLosses: 0,
    inactiveFrames: 0,
    hiddenFrames: 0,
    failedFrames: 0,
    noDrawFrames: 0,
    samplerDisagreements: 0,
    hudDisagreements: 0,
    preferenceChanges: 0,
    sameNode: true,
    sameWorldAndRenderer: true,
    maxPositionDelta: 0,
    maxAimDelta: 0,
    maxRequests: 0,
    maxInFlight: 0,
    maxDirtyChunks: 0,
    rafObserverCpuMs: 0,
    overflow: false,
  };
  let lastDraw = initial.frame;
  let lastRaf = null;
  let lastText = initial.compactText;
  let lastFps = initial.fps;
  let lastResolution = "";
  let animation;
  let timer;
  let finished = false;

  return new Promise((resolve, reject) => {
    const noteText = (records) => {
      const textRecords = records.filter(
        (record) => record.type !== "attributes"
      );
      data.attributeMutations += records.length - textRecords.length;
      if (!textRecords.length) return;
      data.textMutations += textRecords.length;
      data.coalescedTextBatches += Number(textRecords.length > 1);
      for (const record of textRecords) {
        if (record.type !== "childList") continue;
        for (const node of [...record.addedNodes, ...record.removedNodes])
          if (node.nodeType !== Node.TEXT_NODE) data.nonTextMutations++;
      }
      const text = compact.textContent;
      data.redundantTextBatches += Number(text === lastText);
      lastText = text;
      if (data.mutations.length < eventLimit)
        data.mutations.push({
          atMs: performance.now() - startedAt,
          records: textRecords.length,
          text,
          fps: game.fps,
        });
      else data.overflow = true;
    };
    const noteStructure = (records) => {
      for (const record of records) {
        for (const node of record.addedNodes)
          if (node.nodeType === Node.ELEMENT_NODE) data.hudElementAdditions++;
        for (const node of record.removedNodes)
          if (node.nodeType === Node.ELEMENT_NODE) data.hudElementRemovals++;
      }
    };
    const textObserver = new MutationObserver(noteText);
    const structureObserver = new MutationObserver(noteStructure);
    const contextLost = () => data.contextLosses++;
    renderer.domElement.addEventListener("webglcontextlost", contextLost, {
      passive: true,
    });
    textObserver.observe(compact, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });
    // Direct children only: do not observe unrelated per-frame HUD subtrees.
    structureObserver.observe(hud, { childList: true });

    const finish = (reason = "deadline", error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cancelAnimationFrame(animation);
      noteText(textObserver.takeRecords());
      noteStructure(structureObserver.takeRecords());
      textObserver.disconnect();
      structureObserver.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      if (error) return reject(error);
      try {
        const elapsedMs = performance.now() - startedAt;
        resolve({
          ...data,
          elapsedMs,
          reason,
          final: read(),
          finalGpu: gpu(),
          sameNode:
            data.sameNode &&
            compact.isConnected &&
            compact.parentNode === hud &&
            document.querySelectorAll(".compact-fps").length === 1,
        });
      } catch (failure) {
        reject(failure);
      }
    };
    const observe = (now) => {
      if (finished) return;
      const began = performance.now();
      try {
        data.sameNode &&= compact.isConnected && compact.parentNode === hud;
        data.sameWorldAndRenderer &&=
          game.world === world &&
          game.graphics === graphics &&
          graphics.renderer === renderer;
        data.inactiveFrames += Number(!game.active || !game.simulating);
        data.hiddenFrames += Number(document.hidden);
        data.failedFrames += Number(game.failed || game.building);
        const frame = renderer.info.render.frame;
        if (frame > lastDraw) {
          lastDraw = frame;
          data.frames++;
          if (lastRaf !== null) data.intervals.push(now - lastRaf);
          lastRaf = now;
          data.noDrawFrames += Number(renderer.info.render.calls === 0);
          data.samplerDisagreements += Number(game.fps !== game.frameRate.fps);
          data.preferenceChanges += Number(
            game.viewPreferences.showFps !== initial.showFps ||
              game.viewPreferences.guiScale !== initial.guiScale ||
              graphics.fullbrightInspection !== initial.fullbrightInspection
          );
          if (initial.showFps)
            data.hudDisagreements += Number(
              compact.textContent !== debug.textContent.toUpperCase()
            );
          if (game.fps !== lastFps) {
            lastFps = game.fps;
            data.sampleChanges++;
            if (data.samples.length < eventLimit)
              data.samples.push({ atMs: now - startedAt, fps: lastFps });
            else data.overflow = true;
          }
          data.maxPositionDelta = Math.max(
            data.maxPositionDelta,
            Math.hypot(
              game.player.position.x - initial.position[0],
              game.player.position.y - initial.position[1],
              game.player.position.z - initial.position[2]
            )
          );
          data.maxAimDelta = Math.max(
            data.maxAimDelta,
            Math.abs(game.player.yaw - initial.yaw),
            Math.abs(game.player.pitch - initial.pitch)
          );
          data.maxRequests = Math.max(data.maxRequests, world._requests.size);
          data.maxInFlight = Math.max(data.maxInFlight, world._inFlight.size);
          data.maxDirtyChunks = Math.max(
            data.maxDirtyChunks,
            world.dirtyChunks.size
          );
          const pixelRatio = renderer.getPixelRatio();
          const width = gl.drawingBufferWidth;
          const height = gl.drawingBufferHeight;
          const resolution = `${pixelRatio}/${width}/${height}`;
          if (resolution !== lastResolution) {
            lastResolution = resolution;
            if (data.resolution.length < eventLimit)
              data.resolution.push({
                atMs: now - startedAt,
                pixelRatio,
                width,
                height,
              });
            else data.overflow = true;
          }
        } else data.callbacksWithoutDraw++;
        data.rafObserverCpuMs += performance.now() - began;
        if (data.frames >= frameLimit || data.overflow) {
          data.overflow = true;
          finish("observation-limit");
        } else animation = requestAnimationFrame(observe);
      } catch (error) {
        finish("observer-error", error);
      }
    };
    timer = setTimeout(() => finish(), durationMs);
    animation = requestAnimationFrame(observe);
  });
}
